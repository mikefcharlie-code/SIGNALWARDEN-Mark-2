"""Opt-in, read-only WorldView ocean relay: NOAA NDBC buoy latest observations.

Disabled unless ``UCAS_WORLDVIEW_OCEAN_ENABLED=1``.  NOAA's National Data Buoy
Center publishes ``latest_obs.txt`` (one row per reporting station) and
``activestations.xml`` (names/owners) without CORS headers, so the browser
cannot read them directly.  This relay fetches only those two fixed HTTPS
files from ``www.ndbc.noaa.gov``, never follows redirects, bounds size and
time, throttles upstream requests and caches results.  It returns the
stations inside a bounded bounding box with provider, source URL, retrieval
time, provider timestamp, attribution and terms on every record.

No credentials are used (NDBC is keyless public NOAA data).  There is no
write, command or control path.  NDBC data are provisional, quality-control
varies by station, and they are NOT for navigation.

Other ocean sources used by WorldView (Open-Meteo Marine, NOAA CO-OPS,
NASA GIBS, GEBCO WMS, NOAA NCEI and NOAA ENC Direct) send CORS headers and are
read by the browser directly after the operator opts in.
"""
from __future__ import annotations

import math
import os
import re
import threading
import time
from datetime import datetime, timezone
from email.message import Message
from email.utils import parsedate_to_datetime
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

HEADER = "X-SignalWarden-Ocean"
USER_AGENT = "SignalWarden-WorldView/0.1 (read-only ocean context relay)"
TIMEOUT_SECONDS = 15.0
MAX_BYTES = 1_500_000
MAX_STATIONS = 300
MAX_SPAN_DEG = 60.0
LATEST_CACHE_SECONDS = 300.0
LATEST_MIN_INTERVAL = 60.0
STATIONS_CACHE_SECONDS = 24 * 3600.0
STATIONS_MIN_INTERVAL = 300.0

NDBC_HOST = "www.ndbc.noaa.gov"
ALLOWED_HOSTS = frozenset({NDBC_HOST})
LATEST_URL = "https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt"
STATIONS_URL = "https://www.ndbc.noaa.gov/activestations.xml"
ATTRIBUTION = "NOAA National Data Buoy Center (NDBC) and partner station owners; provisional real-time data"
TERMS_URL = "https://www.ndbc.noaa.gov/disclaimer.shtml"
DISCLOSURE = ("Latest automated report per station; provisional, not all stations report every field, "
              "quality control varies by owner. Not for navigation.")

# Column -> (output field, unit).  Wind speeds are m/s, wave height m, periods s, pressure hPa, temps degC.
COLUMNS = ("STN", "LAT", "LON", "YYYY", "MM", "DD", "hh", "mm", "WDIR", "WSPD", "GST", "WVHT", "DPD", "APD",
           "MWD", "PRES", "PTDY", "ATMP", "WTMP", "DEWP", "VIS", "TIDE")
FIELDS = {
    "WDIR": ("windDirDeg", "degT"), "WSPD": ("windSpeedMs", "m/s"), "GST": ("gustMs", "m/s"),
    "WVHT": ("waveHeightM", "m"), "DPD": ("dominantPeriodS", "s"), "APD": ("averagePeriodS", "s"),
    "MWD": ("meanWaveDirDeg", "degT"), "PRES": ("pressureHpa", "hPa"), "PTDY": ("pressureTendencyHpa", "hPa"),
    "ATMP": ("airTempC", "degC"), "WTMP": ("waterTempC", "degC"), "DEWP": ("dewPointC", "degC"),
    "VIS": ("visibilityNmi", "nmi"), "TIDE": ("tideFt", "ft"),
}
STATION_ID = re.compile(r"^[A-Z0-9]{3,8}$")
_STATION_TAG = re.compile(r"<station\s+([^<>]{1,2000}?)/?>")
_ATTR = re.compile(r'([a-zA-Z_]{1,20})="([^"<>]{0,300})"')


class OceanRelayError(Exception):
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
_cache: dict[str, tuple[float, Any]] = {}


def reset_state() -> None:
    with _lock:
        _last_upstream.clear()
        _cache.clear()


def enabled() -> bool:
    return (os.getenv("UCAS_WORLDVIEW_OCEAN_ENABLED") or "").strip().lower() in {"1", "true", "yes"}


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat().replace("+00:00", "Z")


def status() -> dict[str, Any]:
    return {
        "enabled": enabled(), "readOnly": True,
        "providers": {"ndbc": {"status": "keyless", "endpoint": LATEST_URL, "termsUrl": TERMS_URL}},
        "notForNavigation": True,
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
        raise OceanRelayError(404, "ocean_relay_disabled", "WorldView ocean relay is disabled")
    if headers.get(HEADER) != "enabled":
        raise OceanRelayError(403, "ocean_header_required", f"{HEADER}: enabled is required")
    if not _same_origin(headers):
        raise OceanRelayError(403, "origin_not_allowed", "cross-site relay requests are not allowed")


# ---------------------------------------------------------------- transport

def _fetch_text(url: str, provider: str) -> tuple[str, str | None]:
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS or parsed.port not in (None, 443) \
            or parsed.username or parsed.password:
        raise OceanRelayError(500, "host_not_allowlisted", "upstream host is not allowlisted")
    request = Request(url, method="GET", headers={"Accept": "text/plain, text/xml", "User-Agent": USER_AGENT})
    if not _slots.acquire(blocking=False):
        raise OceanRelayError(503, "relay_busy", "relay concurrency limit reached")
    try:
        try:
            response = opener_factory().open(request, timeout=TIMEOUT_SECONDS)
        except HTTPError as exc:
            try:
                if exc.code == 429:
                    raise OceanRelayError(429, "provider_quota", f"{provider} rate limit reached") from None
                raise OceanRelayError(502, "provider_error", f"{provider} returned HTTP {exc.code}") from None
            finally:
                exc.close()
        except (URLError, TimeoutError, OSError):
            raise OceanRelayError(502, "provider_unreachable", f"{provider} could not be reached") from None
        try:
            length = response.headers.get("Content-Length")
            if length is not None and str(length).isdigit() and int(length) > MAX_BYTES:
                raise OceanRelayError(502, "provider_too_large", f"{provider} response exceeds the size limit")
            body = response.read(MAX_BYTES + 1)
            if len(body) > MAX_BYTES:
                raise OceanRelayError(502, "provider_too_large", f"{provider} response exceeds the size limit")
            modified = response.headers.get("Last-Modified")
        except (URLError, TimeoutError, OSError):
            raise OceanRelayError(502, "provider_unreachable", f"{provider} could not be read") from None
        finally:
            response.close()
        return body.decode("latin-1"), modified
    finally:
        _slots.release()


def _cached(key: str, ttl: float) -> Any:
    with _lock:
        hit = _cache.get(key)
        if hit and clock() - hit[0] <= ttl:
            return hit[1]
    return None


def _stale(key: str) -> Any:
    with _lock:
        hit = _cache.get(key)
        return hit[1] if hit else None


def _store(key: str, value: Any) -> Any:
    with _lock:
        _cache[key] = (clock(), value)
    return value


def _may_call(family: str, min_interval: float) -> bool:
    with _lock:
        now = clock()
        last = _last_upstream.get(family)
        if last is not None and now - last < min_interval:
            return False
        _last_upstream[family] = now
        return True


# ---------------------------------------------------------------- parsing

def _num(text: str) -> float | None:
    if text in ("MM", "", "-"):
        return None
    try:
        value = float(text)
    except ValueError:
        return None
    return value if math.isfinite(value) else None


def parse_latest_obs(text: str, now: float) -> list[dict[str, Any]]:
    """Parse NDBC latest_obs.txt (whitespace table, 'MM' = missing)."""
    rows: list[dict[str, Any]] = []
    for line in text.splitlines()[:5000]:
        if not line.strip() or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) != len(COLUMNS):
            continue
        cell = dict(zip(COLUMNS, parts))
        station = cell["STN"].upper()
        if not STATION_ID.match(station) or station.startswith("SHIP"):
            continue
        lat, lon = _num(cell["LAT"]), _num(cell["LON"])
        if lat is None or lon is None or abs(lat) > 90 or abs(lon) > 180:
            continue
        try:
            observed = datetime(int(cell["YYYY"]), int(cell["MM"]), int(cell["DD"]), int(cell["hh"]), int(cell["mm"]),
                                tzinfo=timezone.utc).timestamp()
        except ValueError:
            continue
        if observed > now + 600:  # future timestamps are invalid
            continue
        values: dict[str, float | None] = {}
        for column, (name, _unit) in FIELDS.items():
            values[name] = _num(cell[column])
        rows.append({"station": station, "lat": lat, "lon": lon, "observedAt": _iso(observed), "values": values})
    return rows


def parse_active_stations(xml: str) -> dict[str, dict[str, str]]:
    """Regex attribute scan of activestations.xml (no DTD/entity processing)."""
    out: dict[str, dict[str, str]] = {}
    for match in _STATION_TAG.finditer(xml[:MAX_BYTES]):
        attrs = dict(_ATTR.findall(match.group(1)))
        station = (attrs.get("id") or "").upper()
        if not STATION_ID.match(station):
            continue
        out[station] = {
            "name": (attrs.get("name") or "")[:120],
            "owner": (attrs.get("owner") or "")[:120],
            "type": (attrs.get("type") or "")[:24],
        }
        if len(out) >= 5000:
            break
    return out


# ---------------------------------------------------------------- routes

def _bbox(query: dict[str, list[str]]) -> tuple[float, float, float, float]:
    if set(query) - {"west", "south", "east", "north"}:
        raise OceanRelayError(400, "invalid_query", "unexpected query parameter")
    values = []
    for name, low, high in (("west", -180, 180), ("south", -90, 90), ("east", -180, 180), ("north", -90, 90)):
        raw = query.get(name, [])
        if len(raw) != 1:
            raise OceanRelayError(400, "invalid_query", f"{name} must be supplied exactly once")
        try:
            number = float(raw[0])
        except ValueError:
            raise OceanRelayError(400, "invalid_bbox", f"{name} must be a number") from None
        if not math.isfinite(number) or number < low or number > high:
            raise OceanRelayError(400, "invalid_bbox", f"{name} is out of range")
        values.append(round(number, 4))
    west, south, east, north = values
    if west >= east or south >= north:
        raise OceanRelayError(400, "invalid_bbox", "bbox must have west<east and south<north (no antimeridian wrap)")
    if east - west > MAX_SPAN_DEG or north - south > MAX_SPAN_DEG:
        raise OceanRelayError(400, "invalid_bbox", f"bbox span is capped at {MAX_SPAN_DEG:g} degrees per side")
    return west, south, east, north


def _latest() -> tuple[list[dict[str, Any]], str, str | None, bool]:
    hit = _cached("ndbc:latest", LATEST_CACHE_SECONDS)
    if hit:
        return hit[0], hit[1], hit[2], True
    if not _may_call("ndbc:latest", LATEST_MIN_INTERVAL):
        stale = _stale("ndbc:latest")
        if stale:
            return stale[0], stale[1], stale[2], True
        raise OceanRelayError(429, "relay_throttled", "NDBC refresh throttled; retry in 60s", 60)
    text, modified = _fetch_text(LATEST_URL, "NDBC")
    now = wall()
    rows = parse_latest_obs(text, now)
    if not rows:
        raise OceanRelayError(502, "provider_invalid_schema", "NDBC latest_obs.txt had no parseable rows")
    file_time = None
    if modified:
        try:
            file_time = _iso(parsedate_to_datetime(modified).timestamp())
        except (TypeError, ValueError, OverflowError):
            file_time = None
    value = (rows, _iso(now), file_time)
    _store("ndbc:latest", value)
    return rows, value[1], file_time, False


def _stations() -> dict[str, dict[str, str]]:
    hit = _cached("ndbc:stations", STATIONS_CACHE_SECONDS)
    if hit is not None:
        return hit
    if not _may_call("ndbc:stations", STATIONS_MIN_INTERVAL):
        return _stale("ndbc:stations") or {}
    try:
        text, _ = _fetch_text(STATIONS_URL, "NDBC station list")
    except OceanRelayError:
        return _stale("ndbc:stations") or {}  # names are optional context; observations still flow
    return _store("ndbc:stations", parse_active_stations(text))


def ndbc_latest(query: dict[str, list[str]]) -> dict[str, Any]:
    west, south, east, north = _bbox(query)
    rows, retrieved, file_time, cached = _latest()
    names = _stations()
    cx, cy = (west + east) / 2, (south + north) / 2
    inside = [r for r in rows if west <= r["lon"] <= east and south <= r["lat"] <= north]
    inside.sort(key=lambda r: (r["lat"] - cy) ** 2 + (r["lon"] - cx) ** 2)
    stations = []
    for row in inside[:MAX_STATIONS]:
        meta = names.get(row["station"], {})
        stations.append({
            **row,
            "name": meta.get("name") or None, "owner": meta.get("owner") or None, "stationType": meta.get("type") or None,
            "sourceUrl": f"https://www.ndbc.noaa.gov/station_page.php?station={row['station'].lower()}",
        })
    return {
        "provider": "noaa-ndbc", "sourceUrl": LATEST_URL, "retrievedAt": retrieved, "fileLastModified": file_time,
        "cache": "hit" if cached else "miss", "attribution": ATTRIBUTION, "termsUrl": TERMS_URL,
        "disclosure": DISCLOSURE, "units": {name: unit for name, unit in FIELDS.values()},
        "truncated": len(inside) > MAX_STATIONS, "stations": stations, "notForNavigation": True,
    }


def handle(suffix: list[str], query: dict[str, list[str]], headers: Any) -> dict[str, Any]:
    """Entry point for GET /api/v1/worldview-ocean/<suffix>."""
    authorize(headers)
    if suffix == ["status"]:
        if query:
            raise OceanRelayError(400, "invalid_query", "unexpected query parameter")
        return status()
    if suffix == ["ndbc", "latest"]:
        return ndbc_latest(query)
    raise OceanRelayError(404, "not_found", "ocean relay route was not found")
