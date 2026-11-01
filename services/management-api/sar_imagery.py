"""Safe, opt-in Sentinel-1 browse-image retrieval from ASF."""
from __future__ import annotations

import os
import threading
import time
from email.message import Message
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

MAX_BYTES = 8 * 1024 * 1024
DEADLINE_SECONDS = 20.0
MAX_REDIRECTS = 3
_ALLOWED_QUERY_KEYS = frozenset({"A-userid", "Expires", "Signature", "Key-Pair-Id"})
_CDN_PREFIX = "/s3-06b3213905ebfa9144871d6c7f9306f0/asf-ngap2w-p-s1-img-c6fc3715.s3.us-west-2.amazonaws.com/"
_PRODUCT_RE = __import__("re").compile(
    r"^S1(?P<platform>[ABCD])_(?:IW|EW|S[1-6])_GRDH_1S(?:SV|SH|DV|DH)_"
    r"\d{8}T\d{6}_\d{8}T\d{6}_\d{6}_[0-9A-F]{6}_[0-9A-F]{4}$"
)

class SarImageryError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message

class BrowseImage:
    def __init__(self, payload: bytes):
        self.payload = payload
        self.mime = "image/jpeg"

class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req: Request, fp: Any, code: int, msg: str, headers: Message, newurl: str) -> None:
        return None

_transport_slots = threading.BoundedSemaphore(2)


def _enabled() -> bool:
    return os.getenv("UCAS_PUBLIC_SAR_ENABLED", "0").lower() in {"1", "true", "yes"}


def validate_product(product: str) -> str:
    if not isinstance(product, str) or not _PRODUCT_RE.fullmatch(product):
        raise SarImageryError(400, "invalid_sar_product", "product must be a Sentinel-1 scene name without -GRD_HD")
    return product


def _same_origin(headers: Any) -> bool:
    origin = headers.get("Origin")
    if origin:
        try:
            parsed = urlsplit(origin)
            host = headers.get("Host", "")
            # Origin has no path/query; compare normalized scheme/authority to Host.
            if parsed.scheme not in {"http", "https"} or parsed.path or parsed.query or parsed.fragment:
                return False
            if parsed.netloc.lower() != host.lower():
                return False
        except ValueError:
            return False
    fetch_site = (headers.get("Sec-Fetch-Site") or "").lower()
    if fetch_site == "cross-site":
        return False
    return True


def authorize_request(headers: Any) -> None:
    if not _enabled():
        raise SarImageryError(404, "sar_imagery_disabled", "public SAR imagery is disabled")
    if headers.get("X-SignalWarden-SAR") != "enabled":
        raise SarImageryError(403, "sar_header_required", "X-SignalWarden-SAR: enabled is required")
    if not _same_origin(headers):
        raise SarImageryError(403, "origin_not_allowed", "cross-site SAR imagery requests are not allowed")


def _url_for(product: str) -> str:
    return f"https://datapool.asf.alaska.edu/BROWSE/S{product[2]}/{product}.jpg"


def _allowed_redirect(url: str, product: str, previous: str) -> bool:
    try:
        parsed = urlsplit(url)
        # An explicit port is allowed only when it is HTTPS's standard port.
        if parsed.port not in (None, 443):
            return False
    except ValueError:
        return False
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.fragment:
        return False
    filename = product + ".jpg"
    expected_path = f"/BROWSE/S{product[2]}/" + filename
    if parsed.hostname == "datapool.asf.alaska.edu":
        return parsed.path == expected_path and not parsed.query
    if parsed.hostname == "sentinel1.asf.alaska.edu":
        return parsed.path == expected_path and not parsed.query
    if parsed.hostname == "dy4owt9f80bz7.cloudfront.net":
        if parsed.path != _CDN_PREFIX + filename:
            return False
        query = parse_qs(parsed.query, keep_blank_values=True, strict_parsing=False)
        return set(query) == _ALLOWED_QUERY_KEYS and all(len(v) == 1 for v in query.values())
    return False


def _request_image(product: str) -> bytes:
    opener = build_opener(ProxyHandler({}), _NoRedirect())
    url = _url_for(product)
    deadline = time.monotonic() + DEADLINE_SECONDS
    for _ in range(MAX_REDIRECTS + 1):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise SarImageryError(504, "sar_provider_timeout", "SAR imagery provider timed out")
        try:
            response = opener.open(Request(url, headers={"Accept": "image/jpeg"}), timeout=remaining)
        except HTTPError as exc:
            try:
                if exc.code not in {301, 302, 303, 307, 308}:
                    raise SarImageryError(502, "sar_provider_error", "SAR imagery provider returned an error") from exc
                location = exc.headers.get("Location")
                if not location or not _allowed_redirect(location, product, url):
                    raise SarImageryError(502, "sar_redirect_rejected", "SAR imagery provider redirect was rejected")
                url = location
                continue
            finally:
                exc.close()
        except (URLError, TimeoutError, OSError) as exc:
            raise SarImageryError(502, "sar_provider_error", "SAR imagery provider could not be reached") from exc
        content_type = response.headers.get_content_type().lower()
        if content_type != "image/jpeg":
            response.close()
            raise SarImageryError(502, "sar_invalid_content_type", "SAR provider returned a non-JPEG image")
        length = response.headers.get("Content-Length")
        if length is not None:
            try:
                if int(length) > MAX_BYTES:
                    response.close()
                    raise SarImageryError(413, "sar_image_too_large", "SAR browse image exceeds the size limit")
            except ValueError:
                response.close()
                raise SarImageryError(502, "sar_provider_error", "SAR provider returned an invalid length")
        data = bytearray()
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise SarImageryError(504, "sar_provider_timeout", "SAR imagery provider timed out")
                # urllib responses expose the socket through fp.raw.  Refresh
                # its timeout before every read so one blocking read cannot
                # outlive the overall request deadline.
                raw = getattr(getattr(response, "fp", None), "raw", None)
                sock = getattr(raw, "_sock", None)
                if sock is not None and hasattr(sock, "settimeout"):
                    sock.settimeout(remaining)
                read = getattr(response, "read1", response.read)
                chunk = read(min(64 * 1024, MAX_BYTES + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
                if len(data) > MAX_BYTES:
                    raise SarImageryError(413, "sar_image_too_large", "SAR browse image exceeds the size limit")
        except SarImageryError:
            raise
        except (URLError, TimeoutError, OSError) as exc:
            raise SarImageryError(502, "sar_provider_error", "SAR imagery provider could not be read") from exc
        finally:
            response.close()
        return bytes(data)
    raise SarImageryError(502, "sar_redirect_limit", "SAR imagery provider redirected too many times")


def fetch_browse(product: str, headers: Any) -> BrowseImage:
    authorize_request(headers)
    product = validate_product(product)
    if not _transport_slots.acquire(blocking=False):
        raise SarImageryError(503, "sar_provider_busy", "SAR imagery provider concurrency limit reached")
    try:
        return BrowseImage(_request_image(product))
    finally:
        _transport_slots.release()
