"""Disabled-by-default, read-only relay for keyed basemap providers.

Esri World Imagery and Google Map Tiles (2D) need an API key. The key is read
from the server environment only (``UCAS_ESRI_API_KEY`` /
``UCAS_GOOGLE_MAPS_API_KEY``) and is never returned, logged or echoed in an
error. The relay is off unless ``UCAS_PUBLIC_BASEMAP_RELAY_ENABLED=1``; it then
accepts only integer z/x/y tile coordinates (z <= 8, matching the globe's
coarse zoom range), builds a fixed upstream URL, refuses redirects, bounds
bytes/time/concurrency/rate, and returns image bytes ``no-store``.

Google Photorealistic 3D Tiles are reported as ``not_implemented``: the
Three.js globe has no 3D Tiles renderer, so only 2D Map Tiles are relayed.
"""
from __future__ import annotations

import json
import os
import threading
import time
from email.message import Message
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

MAX_BYTES = 2 * 1024 * 1024
MAX_JSON_BYTES = 64 * 1024
TIMEOUT_SECONDS = 10.0
MAX_ZOOM = 8
RATE_PER_MINUTE = 240
USER_AGENT = "SignalWarden-WorldView-basemap-relay/0.1 (read-only; self-hosted)"
ESRI_TILE = "https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
GOOGLE_SESSION = "https://tile.googleapis.com/v1/createSession"
GOOGLE_TILE = "https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}"
GOOGLE_VIEWPORT = "https://tile.googleapis.com/tile/v1/viewport"
ESRI_ATTRIBUTION = "Powered by Esri · Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community"
GOOGLE_ATTRIBUTION = "Google (logo and viewport copyright required)"
_ALLOWED_HOSTS = frozenset({"ibasemaps-api.arcgis.com", "tile.googleapis.com"})
_IMAGE_TYPES = frozenset({"image/jpeg", "image/png", "image/webp"})


class BasemapError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


class TileImage:
    def __init__(self, payload: bytes, mime: str):
        self.payload = payload
        self.mime = mime


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req: Request, fp: Any, code: int, msg: str, headers: Message, newurl: str) -> None:
        return None


_slots = threading.BoundedSemaphore(4)
_rate_lock = threading.Lock()
_stamps: dict[str, list[float]] = {"esri": [], "google": []}
_session_lock = threading.Lock()
_google_session: dict[str, Any] = {}


def _truthy(name: str) -> bool:
    return os.getenv(name, "0").strip().lower() in {"1", "true", "yes"}


def relay_enabled() -> bool:
    return _truthy("UCAS_PUBLIC_BASEMAP_RELAY_ENABLED")


def _key(name: str) -> str:
    value = os.getenv(name, "").strip()
    # A key is opaque; reject obviously malformed values without echoing them.
    if not value or len(value) > 512 or any(c.isspace() for c in value):
        return ""
    return value


def status() -> dict[str, Any]:
    enabled = relay_enabled()

    def entry(env: str, attribution: str, label: str) -> dict[str, Any]:
        configured = bool(_key(env))
        if not enabled:
            state, detail = "disabled", f"Relay disabled; set UCAS_PUBLIC_BASEMAP_RELAY_ENABLED=1 and {env} on the server."
        elif configured:
            state, detail = "configured", f"{label} key present on the server (value never exposed)."
        else:
            state, detail = "not_configured", f"{env} is not set on the server; no tiles will be requested."
        return {"status": state, "detail": detail, "envVar": env, "attribution": attribution}

    return {
        "relayEnabled": enabled,
        "providers": {
            "esri": entry("UCAS_ESRI_API_KEY", ESRI_ATTRIBUTION, "Esri"),
            "google2d": entry("UCAS_GOOGLE_MAPS_API_KEY", GOOGLE_ATTRIBUTION, "Google Map Tiles"),
            "google3d": {
                "status": "not_implemented",
                "detail": "Photorealistic 3D Tiles are not rendered by the Three.js globe; Google support is limited to 2D Map Tiles.",
                "envVar": "UCAS_GOOGLE_MAPS_API_KEY",
            },
        },
    }


def _same_origin(headers: Any) -> bool:
    origin = headers.get("Origin")
    if origin:
        try:
            parsed = urlsplit(origin)
        except ValueError:
            return False
        if parsed.scheme not in {"http", "https"} or parsed.path or parsed.query or parsed.fragment:
            return False
        if parsed.netloc.lower() != (headers.get("Host") or "").lower():
            return False
    return (headers.get("Sec-Fetch-Site") or "").lower() != "cross-site"


def authorize(headers: Any) -> None:
    if headers.get("X-SignalWarden-Basemap") != "enabled":
        raise BasemapError(403, "basemap_header_required", "X-SignalWarden-Basemap: enabled is required")
    if not _same_origin(headers):
        raise BasemapError(403, "origin_not_allowed", "cross-site basemap relay requests are not allowed")


def _single_int(query: dict[str, list[str]], name: str, low: int, high: int) -> int:
    values = query.get(name, [])
    if len(values) != 1 or not (values[0].isascii() and values[0].isdigit()) or len(values[0]) > 7:
        raise BasemapError(400, "invalid_tile", f"{name} must be supplied once as a non-negative integer")
    value = int(values[0])
    if value < low or value > high:
        raise BasemapError(400, "invalid_tile", f"{name} is out of range")
    return value


def validate_tile(query: dict[str, list[str]]) -> tuple[int, int, int]:
    if set(query) != {"z", "x", "y"}:
        raise BasemapError(400, "invalid_tile", "only z, x and y query parameters are accepted")
    z = _single_int(query, "z", 0, MAX_ZOOM)
    limit = 2 ** z - 1
    return z, _single_int(query, "x", 0, limit), _single_int(query, "y", 0, limit)


def _validate_viewport(query: dict[str, list[str]]) -> dict[str, str]:
    if set(query) != {"zoom", "north", "south", "east", "west"}:
        raise BasemapError(400, "invalid_viewport", "zoom, north, south, east and west are required")
    out: dict[str, str] = {"zoom": str(_single_int(query, "zoom", 0, MAX_ZOOM))}
    for name, bound in (("north", 90.0), ("south", 90.0), ("east", 180.0), ("west", 180.0)):
        values = query[name]
        try:
            value = float(values[0]) if len(values) == 1 and len(values[0]) <= 16 else float("nan")
        except ValueError:
            value = float("nan")
        if not (-bound <= value <= bound):
            raise BasemapError(400, "invalid_viewport", f"{name} is out of range")
        out[name] = f"{value:.4f}"
    if float(out["south"]) >= float(out["north"]):
        raise BasemapError(400, "invalid_viewport", "south must be less than north")
    return out


def _allow_rate(provider: str) -> None:
    now = time.monotonic()
    with _rate_lock:
        stamps = [t for t in _stamps[provider] if now - t < 60.0]
        if len(stamps) >= RATE_PER_MINUTE:
            _stamps[provider] = stamps
            raise BasemapError(429, "basemap_rate_limited", "basemap relay rate limit reached; try again shortly")
        stamps.append(now)
        _stamps[provider] = stamps


def _open(request: Request, deadline: float | None = None) -> Any:
    host = urlsplit(request.full_url).hostname
    if host not in _ALLOWED_HOSTS or not request.full_url.startswith("https://"):
        raise BasemapError(502, "basemap_host_rejected", "upstream host is not allowlisted")
    opener = build_opener(ProxyHandler({}), _NoRedirect())
    try:
        remaining = TIMEOUT_SECONDS if deadline is None else deadline - time.monotonic()
        if remaining <= 0:
            raise BasemapError(504, "basemap_provider_timeout", "upstream provider exceeded the total request deadline")
        return opener.open(request, timeout=min(TIMEOUT_SECONDS, remaining))
    except HTTPError as exc:
        code = exc.code
        exc.close()
        if code in {401, 403}:
            raise BasemapError(502, "basemap_provider_auth", "upstream provider rejected the configured credential") from None
        if code == 429:
            raise BasemapError(503, "basemap_provider_quota", "upstream provider quota or rate limit reached") from None
        if code in {301, 302, 303, 307, 308}:
            raise BasemapError(502, "basemap_redirect_rejected", "upstream redirect was rejected") from None
        raise BasemapError(502, "basemap_provider_error", f"upstream provider returned HTTP {code}") from None
    except (URLError, TimeoutError, OSError):
        # Never include the exception text: it can contain the request URL (and key).
        raise BasemapError(502, "basemap_provider_unreachable", "upstream provider could not be reached") from None


def _read(response: Any, limit: int, deadline: float | None = None) -> bytes:
    deadline = deadline if deadline is not None else time.monotonic() + TIMEOUT_SECONDS
    length = response.headers.get("Content-Length")
    try:
        if length is not None and int(length) > limit:
            raise BasemapError(413, "basemap_too_large", "upstream response exceeds the size limit")
    except ValueError:
        raise BasemapError(502, "basemap_provider_error", "upstream returned an invalid length") from None
    data = bytearray()
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise BasemapError(504, "basemap_provider_timeout", "upstream provider exceeded the total response deadline")
            sock = getattr(getattr(getattr(response, "fp", None), "raw", None), "_sock", None)
            if sock is not None and hasattr(sock, "settimeout"):
                sock.settimeout(remaining)
            chunk = response.read(min(64 * 1024, limit + 1 - len(data)))
            if time.monotonic() > deadline:
                raise BasemapError(504, "basemap_provider_timeout", "upstream provider exceeded the total response deadline")
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > limit:
                raise BasemapError(413, "basemap_too_large", "upstream response exceeds the size limit")
    except BasemapError:
        raise
    except (URLError, TimeoutError, OSError):
        raise BasemapError(502, "basemap_provider_unreachable", "upstream provider could not be read") from None
    finally:
        response.close()
    return bytes(data)


def _image(request: Request) -> TileImage:
    deadline = time.monotonic() + TIMEOUT_SECONDS
    response = _open(request, deadline)
    mime = response.headers.get_content_type().lower()
    if mime not in _IMAGE_TYPES:
        response.close()
        raise BasemapError(502, "basemap_invalid_content_type", "upstream returned a non-image tile")
    return TileImage(_read(response, MAX_BYTES, deadline), mime)


def _json(request: Request) -> Any:
    deadline = time.monotonic() + TIMEOUT_SECONDS
    response = _open(request, deadline)
    if response.headers.get_content_type().lower() != "application/json":
        response.close()
        raise BasemapError(502, "basemap_invalid_content_type", "upstream returned non-JSON metadata")
    try:
        return json.loads(_read(response, MAX_JSON_BYTES, deadline).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise BasemapError(502, "basemap_provider_error", "upstream returned invalid JSON") from None


def _require(env: str) -> str:
    if not relay_enabled():
        raise BasemapError(404, "basemap_relay_disabled", "basemap relay is disabled")
    key = _key(env)
    if not key:
        raise BasemapError(503, "not_configured", f"{env} is not configured on the server")
    return key


def esri_tile(z: int, x: int, y: int) -> TileImage:
    key = _require("UCAS_ESRI_API_KEY")
    _allow_rate("esri")
    url = ESRI_TILE.format(z=z, x=x, y=y) + "?" + urlencode({"token": key})
    return _image(Request(url, headers={"Accept": "image/*", "User-Agent": USER_AGENT}))


def _session(key: str) -> str:
    now = time.time()
    with _session_lock:
        token, expiry = _google_session.get("token"), float(_google_session.get("expiry", 0))
        if token and expiry - now > 3600:
            return str(token)
        body = json.dumps({"mapType": "satellite", "language": "en-US", "region": "US"}).encode()
        request = Request(GOOGLE_SESSION + "?" + urlencode({"key": key}), data=body, method="POST",
                          headers={"Content-Type": "application/json", "Accept": "application/json", "User-Agent": USER_AGENT})
        payload = _json(request)
        token = payload.get("session") if isinstance(payload, dict) else None
        if not isinstance(token, str) or not token or len(token) > 2048:
            raise BasemapError(502, "basemap_provider_error", "Google Map Tiles session response was invalid")
        try:
            expiry = float(payload.get("expiry", now + 86400))
        except (TypeError, ValueError):
            expiry = now + 86400
        _google_session.update({"token": token, "expiry": expiry})
        return token


def google_tile(z: int, x: int, y: int) -> TileImage:
    key = _require("UCAS_GOOGLE_MAPS_API_KEY")
    _allow_rate("google")
    session = _session(key)
    url = GOOGLE_TILE.format(z=z, x=x, y=y) + "?" + urlencode({"session": session, "key": key})
    return _image(Request(url, headers={"Accept": "image/*", "User-Agent": USER_AGENT}))


def google_attribution(viewport: dict[str, str]) -> dict[str, Any]:
    key = _require("UCAS_GOOGLE_MAPS_API_KEY")
    _allow_rate("google")
    session = _session(key)
    url = GOOGLE_VIEWPORT + "?" + urlencode({**viewport, "session": session, "key": key})
    payload = _json(Request(url, headers={"Accept": "application/json", "User-Agent": USER_AGENT}))
    copyright_text = payload.get("copyright") if isinstance(payload, dict) else None
    if not isinstance(copyright_text, str):
        copyright_text = ""
    return {"provider": "Google Map Tiles", "copyright": copyright_text[:300], "retrievedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}


def handle(suffix: list[str], query: dict[str, list[str]], headers: Any) -> Any:
    """Route GET /api/v1/public-imagery/basemap/<suffix>."""
    authorize(headers)
    if suffix == ["status"]:
        if query:
            raise BasemapError(400, "invalid_query", "status accepts no query parameters")
        return status()
    if suffix in (["esri", "tile"], ["google", "tile"]):
        z, x, y = validate_tile(query)
        if not _slots.acquire(blocking=False):
            raise BasemapError(503, "basemap_relay_busy", "basemap relay concurrency limit reached")
        try:
            return esri_tile(z, x, y) if suffix[0] == "esri" else google_tile(z, x, y)
        finally:
            _slots.release()
    if suffix == ["google", "attribution"]:
        viewport = _validate_viewport(query)
        return google_attribution(viewport)
    raise BasemapError(404, "not_found", "basemap relay route was not found")
