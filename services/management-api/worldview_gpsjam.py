"""Opt-in, read-only WorldView relay for GPSJAM daily GNSS-interference hex maps.

Disabled unless ``UCAS_WORLDVIEW_GPSJAM_ENABLED=1``.  GPSJAM (John Wiseman,
https://gpsjam.org) publishes one CSV per UTC day of H3 resolution-4 cells with
the number of aircraft that reported good vs. low navigation accuracy
(ADS-B NIC/NACp) while flying through each cell, aggregated from airplanes.live
and/or ADS-B Exchange receiver data.  gpsjam.org sends no CORS headers, so the
browser cannot read the files directly.

This relay fetches only fixed HTTPS paths on ``gpsjam.org``:
``/data/manifest.csv`` and ``/data[/<source>]/<YYYY-MM-DD>-h3_4.csv`` where
the date and source must come from the manifest.  It never follows redirects,
ignores environment proxies, bounds compressed and decompressed size and time,
throttles upstream calls and caches the manifest and a few days in memory.

What the data is NOT: it is an inferred, daily-aggregated indicator of
possible GNSS interference from aircraft-reported accuracy.  It does not detect
or locate jammers, is not real time, does not attribute a source, and can also
reflect spoofing, aircraft manoeuvres, avionics faults or coverage gaps.
Civilian situational awareness only; no targeting, no control path.

Reuse terms: gpsjam.org states no data licence.  Its upstream ADS-B networks
restrict redistribution/derivative/commercial use of their data.  The relay
proxies on demand for the operator's own viewing and keeps short-lived responses
in memory only (never on disk), with attribution and that uncertainty.
"""
from __future__ import annotations

import os
import re
import socket
import threading
import time
import zlib
from collections import OrderedDict
from datetime import date as _date, datetime, timezone
from email.message import Message
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

HEADER = "X-SignalWarden-GpsJam"
ENV_FLAG = "UCAS_WORLDVIEW_GPSJAM_ENABLED"
USER_AGENT = "SignalWarden-WorldView/0.1 (read-only GNSS interference context relay)"
TIMEOUT_SECONDS = 20.0
MAX_COMPRESSED_BYTES = 3_000_000
MAX_DECOMPRESSED_BYTES = 6_000_000
MAX_MANIFEST_BYTES = 400_000
MAX_CELLS = 120_000
MAX_COUNT = 1_000_000
MANIFEST_CACHE_SECONDS = 3600.0
MANIFEST_MIN_INTERVAL = 120.0
DAY_CACHE_SECONDS = 6 * 3600.0
DAY_MIN_INTERVAL = 60.0
DAY_CACHE_ENTRIES = 4
DAY_FETCHES_PER_HOUR = 20

HOST = "gpsjam.org"
ALLOWED_HOSTS = frozenset({HOST})
BASE_URL = "https://gpsjam.org"
MANIFEST_URL = f"{BASE_URL}/data/manifest.csv"
FAQ_URL = "https://gpsjam.org/faq/"
SITE_URL = "https://gpsjam.org/"
# manifest "source" -> data sub-directory (mirrors gpsjam.org's own client: adsbexchange lives at /data/).
SOURCE_DIRS = {"adsbexchange": "", "airplaneslive": "airplaneslive", "merged": "merged"}
SOURCE_LABELS = {
    "adsbexchange": "ADS-B Exchange",
    "airplaneslive": "airplanes.live",
    "merged": "airplanes.live and ADS-B Exchange (de-duplicated per aircraft)",
}
ATTRIBUTION = "GPSJAM by John Wiseman (gpsjam.org); aircraft navigation-accuracy reports from airplanes.live and/or ADS-B Exchange"
TERMS_NOTE = ("gpsjam.org publishes no explicit data licence; upstream ADS-B Exchange/airplanes.live terms restrict "
              "redistribution and commercial use. Fetched on demand for the operator's own viewing; transient in-memory cache only, never persisted or redistributed.")
DISCLOSURE = ("Inferred indicator of possible GNSS interference: the share of aircraft in each H3 cell that reported low "
              "navigation accuracy over one UTC day. Not a jammer detection or location, not real time, no source attribution; "
              "may also reflect spoofing, manoeuvres or avionics issues, and blank areas mean no ADS-B coverage, not 'no interference'.")

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
HEX_RE = re.compile(r"^84[0-9a-f]{13}$")


class GpsJamRelayError(Exception):
    def __init__(self, status: int, code: str, message: str, retry_after: int | None = None):
        super().__init__(message)
        self.status, self.code, self.message, self.retry_after = status, code, message, retry_after


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req: Request, fp: Any, code: int, msg: str, headers: Message, newurl: str) -> None:
        return None


def _default_opener() -> Any:
    return build_opener(ProxyHandler({}), _NoRedirect())


# Tests replace these; production never follows redirects or env proxies.
opener_factory: Callable[[], Any] = _default_opener
clock: Callable[[], float] = time.monotonic
wall: Callable[[], float] = time.time

_lock = threading.Lock()
_slots = threading.BoundedSemaphore(2)
_last_upstream: dict[str, float] = {}
_day_stamps: list[float] = []
_manifest_cache: list[tuple[float, Any]] = []
_day_cache: "OrderedDict[tuple[str, str], tuple[float, Any]]" = OrderedDict()


def reset_state() -> None:
    with _lock:
        _last_upstream.clear()
        _day_stamps.clear()
        _manifest_cache.clear()
        _day_cache.clear()


def enabled() -> bool:
    return (os.getenv(ENV_FLAG) or "").strip().lower() in {"1", "true", "yes"}


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat().replace("+00:00", "Z")


def status() -> dict[str, Any]:
    return {
        "enabled": enabled(), "readOnly": True,
        "providers": {"gpsjam": {"status": "keyless", "endpoint": MANIFEST_URL, "termsUrl": FAQ_URL, "termsNote": TERMS_NOTE}},
        "inferredIndicator": True, "realTime": False,
    }


def _same_origin(headers: Any) -> bool:
    origin = headers.get("Origin")
    if origin:
        try:
            parsed = urlsplit(origin)
            if parsed.scheme not in {"http", "https"} or parsed.path or parsed.query or parsed.fragment:
                return False
            if parsed.netloc.lower() != (headers.get("Host") or "").lower():
                return False
        except ValueError:
            return False
    return (headers.get("Sec-Fetch-Site") or "").lower() != "cross-site"


def authorize(headers: Any) -> None:
    if not enabled():
        raise GpsJamRelayError(404, "gpsjam_relay_disabled", "WorldView GPSJAM relay is disabled")
    if headers.get(HEADER) != "enabled":
        raise GpsJamRelayError(403, "gpsjam_header_required", f"{HEADER}: enabled is required")
    if not _same_origin(headers):
        raise GpsJamRelayError(403, "origin_not_allowed", "cross-site relay requests are not allowed")


# ---------------------------------------------------------------- transport

def _allowed_url(url: str) -> bool:
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS or parsed.port not in (None, 443) \
            or parsed.username or parsed.password or parsed.query or parsed.fragment:
        return False
    if parsed.path == "/data/manifest.csv":
        return True
    match = re.fullmatch(r"/data/(?:(airplaneslive|merged)/)?(\d{4}-\d{2}-\d{2})-h3_4\.csv", parsed.path)
    return bool(match)


def _decompress(body: bytes, limit: int) -> bytes:
    try:
        stream = zlib.decompressobj(16 + zlib.MAX_WBITS)
        out = stream.decompress(body, limit + 1)
        if len(out) > limit or stream.unconsumed_tail:
            raise GpsJamRelayError(502, "provider_too_large", "GPSJAM response exceeds the decompressed size limit")
        if not stream.eof or stream.unused_data:
            raise GpsJamRelayError(502, "provider_invalid_encoding", "GPSJAM response could not be decompressed")
        return out
    except zlib.error:
        raise GpsJamRelayError(502, "provider_invalid_encoding", "GPSJAM response could not be decompressed") from None


def _read_response(response: Any, limit: int, deadline: float) -> bytes:
    """Read in bounded chunks, re-applying the remaining total deadline to the socket."""
    try:
        sock = response.fp.raw._sock
    except AttributeError:
        sock = None
    chunks: list[bytes] = []
    total = 0
    while total <= limit:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise GpsJamRelayError(502, "provider_timeout", "GPSJAM response exceeded the time limit")
        if sock is not None:
            sock.settimeout(remaining)
        read = getattr(response, "read1", response.read)
        try:
            part = read(min(64 * 1024, limit + 1 - total))
        except (socket.timeout, TimeoutError):
            raise GpsJamRelayError(502, "provider_timeout", "GPSJAM response exceeded the time limit") from None
        if time.monotonic() >= deadline:
            raise GpsJamRelayError(502, "provider_timeout", "GPSJAM response exceeded the time limit")
        if not part:
            break
        chunks.append(part)
        total += len(part)
        if total > limit:
            raise GpsJamRelayError(502, "provider_too_large", "GPSJAM response exceeds the size limit")
    return b"".join(chunks)


def _fetch_text(url: str, limit: int) -> str:
    if not _allowed_url(url):
        raise GpsJamRelayError(500, "host_not_allowlisted", "upstream URL is not allowlisted")
    request = Request(url, method="GET", headers={"Accept": "text/csv", "Accept-Encoding": "gzip", "User-Agent": USER_AGENT})
    if not _slots.acquire(blocking=False):
        raise GpsJamRelayError(503, "relay_busy", "relay concurrency limit reached")
    try:
        deadline = time.monotonic() + TIMEOUT_SECONDS
        try:
            response = opener_factory().open(request, timeout=TIMEOUT_SECONDS)
        except HTTPError as exc:
            try:
                if exc.code == 404:
                    raise GpsJamRelayError(404, "provider_not_found", "GPSJAM has no file for that date") from None
                if exc.code == 429:
                    raise GpsJamRelayError(429, "provider_quota", "GPSJAM rate limit reached") from None
                raise GpsJamRelayError(502, "provider_error", f"GPSJAM returned HTTP {exc.code}") from None
            finally:
                exc.close()
        except (URLError, TimeoutError, OSError):
            raise GpsJamRelayError(502, "provider_unreachable", "GPSJAM could not be reached") from None
        try:
            length = response.headers.get("Content-Length")
            if length is not None and str(length).isdigit() and int(length) > MAX_COMPRESSED_BYTES:
                raise GpsJamRelayError(502, "provider_too_large", "GPSJAM response exceeds the size limit")
            body = _read_response(response, MAX_COMPRESSED_BYTES, deadline)
            encoding = (response.headers.get("Content-Encoding") or "").strip().lower()
        except GpsJamRelayError:
            raise
        except (URLError, TimeoutError, OSError):
            raise GpsJamRelayError(502, "provider_unreachable", "GPSJAM could not be read") from None
        finally:
            response.close()
    finally:
        _slots.release()
    if encoding == "gzip" or body[:2] == b"\x1f\x8b":
        body = _decompress(body, limit)
    elif encoding not in ("", "identity"):
        raise GpsJamRelayError(502, "provider_invalid_encoding", "GPSJAM used an unsupported content encoding")
    if len(body) > limit:
        raise GpsJamRelayError(502, "provider_too_large", "GPSJAM response exceeds the size limit")
    try:
        return body.decode("utf-8")
    except UnicodeDecodeError:
        raise GpsJamRelayError(502, "provider_invalid_schema", "GPSJAM response is not UTF-8 text") from None


def _may_call(family: str, min_interval: float) -> bool:
    with _lock:
        now = clock()
        last = _last_upstream.get(family)
        if last is not None and now - last < min_interval:
            return False
        _last_upstream[family] = now
        return True


def _day_budget() -> bool:
    with _lock:
        now = clock()
        _day_stamps[:] = [t for t in _day_stamps if now - t < 3600.0]
        if len(_day_stamps) >= DAY_FETCHES_PER_HOUR:
            return False
        _day_stamps.append(now)
        return True


# ---------------------------------------------------------------- parsing

def _valid_date(text: str) -> bool:
    if not DATE_RE.match(text or ""):
        return False
    try:
        _date.fromisoformat(text)
    except ValueError:
        return False
    return True


def parse_manifest(text: str) -> list[dict[str, Any]]:
    """Parse manifest.csv: date,suspect,num_bad_aircraft_hexes,source."""
    lines = text.splitlines()
    if not lines or lines[0].strip().split(",")[:4] != ["date", "suspect", "num_bad_aircraft_hexes", "source"]:
        raise GpsJamRelayError(502, "provider_invalid_schema", "GPSJAM manifest header was not recognised")
    out: dict[str, dict[str, Any]] = {}
    for line in lines[1:20_000]:
        parts = line.strip().split(",")
        if len(parts) < 4:
            continue
        day, suspect, bad, source = parts[0], parts[1].lower(), parts[2], parts[3]
        if not _valid_date(day) or source not in SOURCE_DIRS or suspect not in ("true", "false"):
            continue
        try:
            bad_hexes = int(bad)
        except ValueError:
            bad_hexes = None
        if bad_hexes is not None and not 0 <= bad_hexes <= MAX_CELLS:
            bad_hexes = None
        out[day] = {"date": day, "suspect": suspect == "true", "badHexes": bad_hexes, "source": source}
    return [out[d] for d in sorted(out)]


def parse_day(text: str) -> tuple[list[list[Any]], int]:
    """Parse <date>-h3_4.csv: hex,count_good_aircraft,count_bad_aircraft -> [[hex, good, bad]], skipped."""
    lines = text.splitlines()
    if not lines or lines[0].strip().split(",")[:3] != ["hex", "count_good_aircraft", "count_bad_aircraft"]:
        raise GpsJamRelayError(502, "provider_invalid_schema", "GPSJAM day file header was not recognised")
    cells: list[list[Any]] = []
    skipped = 0
    seen: set[str] = set()
    for line in lines[1:]:
        if not line.strip():
            continue
        parts = line.strip().split(",")
        if len(parts) != 3 or not HEX_RE.match(parts[0]) or parts[0] in seen:
            skipped += 1
            continue
        try:
            good, bad = int(parts[1]), int(parts[2])
        except ValueError:
            skipped += 1
            continue
        if not (0 <= good <= MAX_COUNT and 0 <= bad <= MAX_COUNT) or good + bad == 0:
            skipped += 1
            continue
        if len(cells) >= MAX_CELLS:
            raise GpsJamRelayError(502, "provider_too_large", f"GPSJAM day file exceeds {MAX_CELLS} cells")
        seen.add(parts[0])
        cells.append([parts[0], good, bad])
    if not cells:
        raise GpsJamRelayError(502, "provider_invalid_schema", "GPSJAM day file had no parseable cells")
    return cells, skipped


# ---------------------------------------------------------------- routes

def _manifest() -> tuple[list[dict[str, Any]], str, bool]:
    with _lock:
        hit = _manifest_cache[0] if _manifest_cache else None
    if hit and clock() - hit[0] <= MANIFEST_CACHE_SECONDS:
        return hit[1][0], hit[1][1], True
    if not _may_call("manifest", MANIFEST_MIN_INTERVAL):
        if hit:
            return hit[1][0], hit[1][1], True
        raise GpsJamRelayError(429, "relay_throttled", "GPSJAM manifest refresh throttled; retry in 120s", 120)
    try:
        rows = parse_manifest(_fetch_text(MANIFEST_URL, MAX_MANIFEST_BYTES))
    except GpsJamRelayError:
        if hit:  # serve the previous manifest rather than failing
            return hit[1][0], hit[1][1], True
        raise
    if not rows:
        raise GpsJamRelayError(502, "provider_invalid_schema", "GPSJAM manifest listed no dates")
    retrieved = _iso(wall())
    with _lock:
        _manifest_cache[:] = [(clock(), (rows, retrieved))]
    return rows, retrieved, False


def manifest(query: dict[str, list[str]]) -> dict[str, Any]:
    if query:
        raise GpsJamRelayError(400, "invalid_query", "unexpected query parameter")
    rows, retrieved, cached = _manifest()
    return {
        "provider": "gpsjam", "sourceUrl": MANIFEST_URL, "retrievedAt": retrieved, "cache": "hit" if cached else "miss",
        "attribution": ATTRIBUTION, "termsUrl": FAQ_URL, "termsNote": TERMS_NOTE, "disclosure": DISCLOSURE,
        "latest": rows[-1]["date"], "earliest": rows[0]["date"], "dates": rows,
    }


def day_url(day: str, source: str) -> str:
    sub = SOURCE_DIRS[source]
    return f"{BASE_URL}/data/{sub + '/' if sub else ''}{day}-h3_4.csv"


def day(query: dict[str, list[str]]) -> dict[str, Any]:
    if set(query) - {"date"} or len(query.get("date", [])) != 1:
        raise GpsJamRelayError(400, "invalid_query", "date must be supplied exactly once")
    requested = query["date"][0]
    if not _valid_date(requested):
        raise GpsJamRelayError(400, "invalid_date", "date must be YYYY-MM-DD")
    rows, _, _ = _manifest()
    entry = next((r for r in rows if r["date"] == requested), None)
    if entry is None:
        raise GpsJamRelayError(404, "date_not_in_manifest", "GPSJAM has no data for that date")
    url = day_url(requested, entry["source"])
    with _lock:
        cache_key = (requested, entry["source"])
        hit = _day_cache.get(cache_key)
        if hit:
            _day_cache.move_to_end(cache_key)
    if hit and clock() - hit[0] <= DAY_CACHE_SECONDS:
        return {**hit[1], "cache": "hit"}
    if not _may_call(f"day:{requested}", DAY_MIN_INTERVAL) or not _day_budget():
        if hit:
            return {**hit[1], "cache": "stale"}
        raise GpsJamRelayError(429, "relay_throttled", "GPSJAM day download throttled; retry in 60s", 60)
    cells, skipped = parse_day(_fetch_text(url, MAX_DECOMPRESSED_BYTES))
    body = {
        "provider": "gpsjam", "date": requested, "timeZone": "UTC", "periodStart": f"{requested}T00:00:00Z",
        "periodHours": 24, "source": entry["source"], "sourceLabel": SOURCE_LABELS[entry["source"]],
        "suspect": entry["suspect"], "manifestBadHexes": entry["badHexes"], "sourceUrl": url, "retrievedAt": _iso(wall()),
        "h3Resolution": 4, "columns": ["hex", "goodAircraft", "badAircraft"], "cells": cells, "cellCount": len(cells),
        "skippedRows": skipped, "attribution": ATTRIBUTION, "termsUrl": FAQ_URL, "termsNote": TERMS_NOTE,
        "disclosure": DISCLOSURE, "faqUrl": FAQ_URL,
    }
    with _lock:
        _day_cache[cache_key] = (clock(), body)
        _day_cache.move_to_end(cache_key)
        while len(_day_cache) > DAY_CACHE_ENTRIES:
            _day_cache.popitem(last=False)
    return {**body, "cache": "miss"}


def handle(suffix: list[str], query: dict[str, list[str]], headers: Any) -> dict[str, Any]:
    """Entry point for GET /api/v1/worldview-gpsjam/<suffix>."""
    authorize(headers)
    if suffix == ["status"]:
        if query:
            raise GpsJamRelayError(400, "invalid_query", "unexpected query parameter")
        return status()
    if suffix == ["manifest"]:
        return manifest(query)
    if suffix == ["day"]:
        return day(query)
    raise GpsJamRelayError(404, "not_found", "GPSJAM relay route was not found")
