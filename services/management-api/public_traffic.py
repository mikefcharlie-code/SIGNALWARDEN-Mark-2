"""Opt-in, read-only relay for public traffic-camera catalogs and TomTom traffic.

Design rules (see docs/worldview-public-traffic.md):

* Disabled unless ``UCAS_PUBLIC_TRAFFIC_ENABLED=1``.  Every request also needs
  ``X-SignalWarden-Traffic: enabled`` and must not be cross-site.
* Each road authority is one small adapter in ``PROVIDERS``.  Adapters only
  normalise a public catalog into camera id/name/road/direction/lat/lon plus the
  authority's own snapshot URL.  No adapter analyses images.
* Catalog JSON is cached in memory for ``CATALOG_TTL`` seconds so one viewport
  query does not re-download a statewide list; snapshots are fetched only for a
  single selected camera, never cached or mirrored, and only from the host the
  provider's catalog itself names (pinned per adapter).  The client never
  supplies a URL.
* Keys live only in server environment variables.  They are put in upstream
  query strings and are never returned, logged, or included in error text;
  source URLs are reported with the key parameter removed.
* No plate reading, face recognition, image analysis, or cross-camera vehicle
  tracking exists here.  Snapshots are relayed bytes for display only.
"""
from __future__ import annotations

import base64
import json
import math
import os
import threading
import time
import zlib
from dataclasses import dataclass
from datetime import datetime, timezone
from email.message import Message
from email.utils import parsedate_to_datetime
from typing import Any, Callable, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from zoneinfo import ZoneInfo

ENABLE_ENV = "UCAS_PUBLIC_TRAFFIC_ENABLED"
PROVIDER_FILTER_ENV = "UCAS_PUBLIC_CAMERA_PROVIDERS"
TXDOT_DISTRICTS_ENV = "UCAS_TXDOT_DISTRICTS"
TOMTOM_KEY_ENV = "UCAS_TOMTOM_API_KEY"
TOMTOM_ENABLE_ENV = "UCAS_TOMTOM_TRAFFIC_ENABLED"
HEADER = "X-SignalWarden-Traffic"
USER_AGENT = "SignalWarden-WorldView/0.1 (read-only public traffic camera catalog relay)"

MAX_CATALOG_BYTES = 6 * 1024 * 1024
MAX_SNAPSHOT_BYTES = 3 * 1024 * 1024
MAX_TRAFFIC_BYTES = 2 * 1024 * 1024
DEADLINE_SECONDS = 20.0
CATALOG_TTL = 600.0
CATALOG_MIN_INTERVAL = 60.0
SNAPSHOT_MIN_INTERVAL = 10.0
SNAPSHOT_PER_MINUTE = 30
TOMTOM_MIN_INTERVAL = 30.0
MAX_CAMERAS = 300
MAX_HALF_SPAN_DEG = 3.0
TOMTOM_MAX_AREA_KM2 = 10_000.0
MAX_INCIDENTS = 200


class PublicTrafficError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Message, newurl: str) -> None:
        return None


def _default_opener() -> Any:
    # Like the SAR relay, ignore ambient proxy variables and refuse redirects:
    # every upstream URL is a pinned HTTPS host.
    return build_opener(ProxyHandler({}), _NoRedirect())


# Tests replace this factory; production never takes a URL from the client.
opener_factory: Callable[[], Any] = _default_opener
clock: Callable[[], float] = time.time


@dataclass(frozen=True)
class Fetched:
    body: bytes
    content_type: str
    last_modified: str | None


def _host_allowed(url: str, hosts: Iterable[str]) -> bool:
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return False
    return (
        parts.scheme == "https"
        and not parts.username
        and not parts.password
        and not parts.fragment
        and port in (None, 443)
        and (parts.hostname or "").lower() in {h.lower() for h in hosts}
    )


def _gunzip(data: bytes, max_bytes: int) -> bytes:
    inflater = zlib.decompressobj(16 + zlib.MAX_WBITS)
    try:
        out = inflater.decompress(data, max_bytes + 1)
    except zlib.error:
        raise PublicTrafficError(502, "upstream_invalid_encoding", "provider returned invalid gzip data") from None
    if len(out) > max_bytes or inflater.unconsumed_tail:
        raise PublicTrafficError(413, "upstream_too_large", "provider response exceeds the size limit")
    return out


def _http_get(url: str, hosts: Iterable[str], max_bytes: int, accept: str, extra_headers: dict[str, str] | None = None,
              gzip: bool = False) -> Fetched:
    if not _host_allowed(url, hosts):
        raise PublicTrafficError(502, "upstream_host_rejected", "provider URL is not on the pinned host allowlist")
    headers = {"Accept": accept, "User-Agent": USER_AGENT, **(extra_headers or {})}
    if gzip:
        headers["Accept-Encoding"] = "gzip"
    deadline = time.monotonic() + DEADLINE_SECONDS
    try:
        response = opener_factory().open(Request(url, headers=headers), timeout=DEADLINE_SECONDS)
    except HTTPError as exc:
        status = exc.code
        exc.close()
        if status in (401, 403):
            raise PublicTrafficError(502, "upstream_unauthorized", "provider rejected the request (credential missing, invalid, or not permitted)") from None
        if status == 429:
            raise PublicTrafficError(503, "upstream_rate_limited", "provider rate limit reached; try again later") from None
        if status in (301, 302, 303, 307, 308):
            raise PublicTrafficError(502, "upstream_redirect_rejected", "provider redirect was rejected") from None
        raise PublicTrafficError(502, "upstream_error", f"provider returned HTTP {status}") from None
    except (URLError, TimeoutError, OSError):
        raise PublicTrafficError(502, "upstream_unreachable", "provider could not be reached") from None
    try:
        length = response.headers.get("Content-Length")
        if length is not None:
            try:
                if int(length) > max_bytes:
                    raise PublicTrafficError(413, "upstream_too_large", "provider response exceeds the size limit")
            except ValueError:
                raise PublicTrafficError(502, "upstream_error", "provider returned an invalid length") from None
        data = bytearray()
        while True:
            if time.monotonic() > deadline:
                raise PublicTrafficError(504, "upstream_timeout", "provider timed out")
            read = getattr(response, "read1", response.read)
            chunk = read(min(64 * 1024, max_bytes + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > max_bytes:
                raise PublicTrafficError(413, "upstream_too_large", "provider response exceeds the size limit")
        content_type = (response.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        body = bytes(data)
        encoding = (response.headers.get("Content-Encoding") or "").strip().lower()
        if encoding == "gzip" and gzip:
            body = _gunzip(body, max_bytes)
        elif encoding not in ("", "identity"):
            raise PublicTrafficError(502, "upstream_invalid_encoding", "provider used an unsupported content encoding")
        return Fetched(body, content_type, response.headers.get("Last-Modified"))
    except PublicTrafficError:
        raise
    except (URLError, TimeoutError, OSError):
        raise PublicTrafficError(502, "upstream_unreachable", "provider response could not be read") from None
    finally:
        response.close()


def _json(fetched: Fetched, encoding: str = "utf-8") -> Any:
    try:
        return json.loads(fetched.body.decode(encoding))
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise PublicTrafficError(502, "upstream_invalid_json", "provider did not return valid JSON") from None


# ---------------------------------------------------------------- utilities

def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return None
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_iso(value: Any, assume_tz: str | None = None) -> str | None:
    if not isinstance(value, str) or not value or len(value) > 64:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        if not assume_tz:
            return None
        dt = dt.replace(tzinfo=ZoneInfo(assume_tz))
    return _iso(dt)


def _http_date(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return _iso(parsedate_to_datetime(value))
    except (TypeError, ValueError, IndexError):
        return None


def _now_iso() -> str:
    return _iso(datetime.fromtimestamp(clock(), timezone.utc)) or ""


def _not_future(iso: str | None) -> str | None:
    if iso is None:
        return None
    try:
        ts = datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None
    return iso if ts <= clock() + 120 else None


def _text(value: Any, limit: int = 160) -> str:
    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        return ""
    return " ".join(str(value).split())[:limit]


def _coord(lat: Any, lon: Any) -> tuple[float, float] | None:
    try:
        la, lo = float(lat), float(lon)
    except (TypeError, ValueError):
        return None
    if not (math.isfinite(la) and math.isfinite(lo)) or abs(la) > 90 or abs(lo) > 180 or (la == 0 and lo == 0):
        return None
    return la, lo


def _safe_id(value: Any) -> str | None:
    text = _text(value, 96)
    if not text:
        return None
    cleaned = "".join(ch if ch.isalnum() or ch in "-_.:@ " else "_" for ch in text).strip()
    return cleaned or None


def _strip_key(url: str, *key_params: str) -> str:
    """Return a provenance URL with credential parameters removed."""
    parts = urlsplit(url)
    if not parts.query:
        return url
    kept = [p for p in parts.query.split("&") if p.split("=", 1)[0].lower() not in {k.lower() for k in key_params}]
    return parts._replace(query="&".join(kept)).geturl()


def _bbox_intersects(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> bool:
    return not (a[2] < b[0] or a[0] > b[2] or a[3] < b[1] or a[1] > b[3])


def _distance_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    r = math.pi / 180
    dlat, dlon = (b[0] - a[0]) * r, (b[1] - a[1]) * r
    q = math.sin(dlat / 2) ** 2 + math.cos(a[0] * r) * math.cos(b[0] * r) * math.sin(dlon / 2) ** 2
    return 6371.0088 * 2 * math.atan2(math.sqrt(q), math.sqrt(1 - q))


def _camera(provider: "Provider", cam_id: Any, name: Any, road: Any, direction: Any, coord: tuple[float, float] | None,
            snapshot_url: str | None, updated: str | None = None, status: str = "reported_active") -> dict[str, Any] | None:
    ident = _safe_id(cam_id)
    if not ident or coord is None:
        return None
    if snapshot_url is not None and (
        not _host_allowed(snapshot_url, provider.snapshot_hosts)
        or not urlsplit(snapshot_url).path.startswith(provider.snapshot_path_prefix)
    ):
        snapshot_url = None  # a frame outside the pinned host is never relayed or hotlinked
    return {
        "id": ident,
        "name": _text(name) or ident,
        "road": _text(road, 80) or None,
        "direction": _text(direction, 40) or None,
        "lat": round(coord[0], 6),
        "lon": round(coord[1], 6),
        "authority": provider.authority,
        "snapshotUrl": snapshot_url,
        "providerUpdatedAt": _not_future(updated),
        "status": status,
    }


# ---------------------------------------------------------------- providers

Loader = Callable[["Provider", "Context"], tuple[list[dict[str, Any]], str | None, str]]


@dataclass(frozen=True)
class Provider:
    id: str
    name: str
    authority: str
    region: str
    coverage: tuple[float, float, float, float]  # west, south, east, north (coarse)
    catalog_hosts: tuple[str, ...]
    snapshot_hosts: tuple[str, ...]
    attribution: str
    license: str
    terms_url: str
    loader: Loader
    snapshot_path_prefix: str = "/"
    snapshot_mode: str = "relay"  # relay | relay_base64_json | hotlink
    key_env: str | None = None
    key_url: str | None = None
    key_free: bool | None = None
    verified: str = "unverified"
    notes: str = ""
    snapshot_fetch: Callable[["Provider", dict[str, Any]], tuple[bytes, str, str | None, str]] | None = None


@dataclass
class Context:
    bbox: tuple[float, float, float, float]
    key: str | None = None
    districts: list[int] | None = None  # Caltrans snapshot lookup: read only the named district


def _cached_fetch(provider: Provider, url: str, part: str, accept: str = "application/json", encoding: str = "utf-8",
                  extra_headers: dict[str, str] | None = None, gzip: bool = False) -> tuple[Any, str | None]:
    """Return parsed JSON for one catalog part, honouring TTL and min interval."""
    key = (provider.id, part)
    now = clock()
    with _lock:
        hit = _catalog_cache.get(key)
        if hit and now - hit[0] < CATALOG_TTL:
            return hit[1], hit[2]
        last = _catalog_attempts.get(key, 0.0)
        if now - last < CATALOG_MIN_INTERVAL:
            if hit:
                return hit[1], hit[2]
            raise PublicTrafficError(429, "catalog_throttled", "catalog refresh throttled; wait at least 60 seconds")
        _catalog_attempts[key] = now
    fetched = _http_get(url, provider.catalog_hosts, MAX_CATALOG_BYTES, accept, extra_headers, gzip)
    parsed = _json(fetched, encoding)
    with _lock:
        _catalog_cache[key] = (now, parsed, _http_date(fetched.last_modified))
    return parsed, _http_date(fetched.last_modified)


# Caltrans: one JSON per district.  Coarse district boxes (padded) were derived
# from the live catalogs on 2026-10-30 only to choose which district files to
# request for a viewport; no camera data is bundled.
CALTRANS_DISTRICTS: dict[int, tuple[float, float, float, float]] = {
    1: (-124.5, 38.5, -122.3, 42.2), 2: (-123.3, 39.5, -119.8, 42.2), 3: (-122.4, 37.8, -119.7, 40.0),
    4: (-123.1, 36.7, -121.3, 38.8), 5: (-122.3, 34.2, -119.2, 37.4), 6: (-121.0, 34.6, -118.5, 37.6),
    7: (-119.6, 33.5, -117.4, 35.0), 8: (-118.0, 33.2, -114.3, 35.8), 9: (-119.7, 34.7, -117.6, 38.6),
    10: (-121.9, 36.7, -119.7, 38.7), 11: (-117.6, 32.4, -115.3, 33.6), 12: (-118.3, 33.2, -117.4, 34.2),
}


def _caltrans_loader(provider: Provider, ctx: Context) -> tuple[list[dict[str, Any]], str | None, str]:
    districts = ctx.districts or [d for d, box in CALTRANS_DISTRICTS.items() if _bbox_intersects(box, ctx.bbox)][:4]
    cameras: list[dict[str, Any]] = []
    newest: str | None = None
    urls = []
    for d in districts:
        url = f"https://cwwp2.dot.ca.gov/data/d{d}/cctv/cctvStatusD{d:02d}.json"
        urls.append(url)
        doc, _ = _cached_fetch(provider, url, f"d{d}")
        rows = doc.get("data") if isinstance(doc, dict) else None
        if not isinstance(rows, list):
            raise PublicTrafficError(502, "upstream_schema", "Caltrans catalog schema was not recognised")
        for row in rows:
            cctv = row.get("cctv") if isinstance(row, dict) else None
            if not isinstance(cctv, dict) or cctv.get("inService") != "true":
                continue
            loc = cctv.get("location") or {}
            static = ((cctv.get("imageData") or {}).get("static") or {})
            image = static.get("currentImageURL") if isinstance(static, dict) else None
            slug = image.rstrip("/").rsplit("/", 1)[-1].rsplit(".", 1)[0] if isinstance(image, str) and image else cctv.get("index")
            stamp = (cctv.get("recordTimestamp") or {}).get("recordEpoch")
            updated = None
            try:
                updated = _iso(datetime.fromtimestamp(int(stamp), timezone.utc)) if stamp else None
            except (TypeError, ValueError, OverflowError, OSError):
                updated = None
            cam = _camera(provider, f"D{d:02d}:{slug}", loc.get("locationName"), loc.get("route"), loc.get("direction"),
                          _coord(loc.get("latitude"), loc.get("longitude")), image if isinstance(image, str) else None, updated)
            if cam:
                cameras.append(cam)
                if cam["providerUpdatedAt"] and (newest is None or cam["providerUpdatedAt"] > newest):
                    newest = cam["providerUpdatedAt"]
    return cameras, newest, ", ".join(urls) or "https://cwwp2.dot.ca.gov/data/"


def _tfl_loader(provider: Provider, ctx: Context) -> tuple[list[dict[str, Any]], str | None, str]:
    url = "https://api.tfl.gov.uk/Place/Type/JamCam"
    doc, _ = _cached_fetch(provider, url, "all")
    if not isinstance(doc, list):
        raise PublicTrafficError(502, "upstream_schema", "TfL JamCam schema was not recognised")
    cameras, newest = [], None
    for row in doc:
        if not isinstance(row, dict):
            continue
        props = {p.get("key"): p for p in row.get("additionalProperties") or [] if isinstance(p, dict)}
        if (props.get("available") or {}).get("value") != "true":
            continue
        image = (props.get("imageUrl") or {}).get("value")
        updated = _parse_iso((props.get("imageUrl") or {}).get("modified"))
        cam = _camera(provider, row.get("id"), row.get("commonName"), None, (props.get("view") or {}).get("value"),
                      _coord(row.get("lat"), row.get("lon")), image if isinstance(image, str) else None, updated)
        if cam:
            cameras.append(cam)
            if cam["providerUpdatedAt"] and (newest is None or cam["providerUpdatedAt"] > newest):
                newest = cam["providerUpdatedAt"]
    return cameras, newest, url


def _austin_loader(provider: Provider, ctx: Context) -> tuple[list[dict[str, Any]], str | None, str]:
    url = "https://data.austintexas.gov/resource/b4k4-adkb.json?" + urlencode({
        "camera_status": "TURNED_ON",
        "$select": "camera_id,location_name,primary_st,modified_date,screenshot_address,location",
        "$limit": "2000",
    })
    doc, last_modified = _cached_fetch(provider, url, "all")
    if not isinstance(doc, list):
        raise PublicTrafficError(502, "upstream_schema", "Austin camera schema was not recognised")
    cameras = []
    for row in doc:
        if not isinstance(row, dict):
            continue
        coords = (row.get("location") or {}).get("coordinates") if isinstance(row.get("location"), dict) else None
        coord = _coord(coords[1], coords[0]) if isinstance(coords, list) and len(coords) >= 2 else None
        image = row.get("screenshot_address")
        cam = _camera(provider, row.get("camera_id"), row.get("location_name"), row.get("primary_st"), None, coord,
                      image if isinstance(image, str) else None, _parse_iso(row.get("modified_date"), "America/Chicago"))
        if cam:
            cameras.append(cam)
    return cameras, last_modified, url


TXDOT_DISTRICTS = {
    "ABL", "AMA", "ATL", "AUS", "BMT", "BWD", "BRY", "CHS", "CRP", "DAL", "ELP", "FTW", "HOU", "LBB", "LFK",
    "LRD", "ODA", "PAR", "PHR", "SJT", "SAT", "TYL", "WAC", "WFS", "YKM",
}


def _txdot_districts() -> list[str]:
    raw = os.getenv(TXDOT_DISTRICTS_ENV, "AUS,SAT")
    picked = [d.strip().upper() for d in raw.split(",") if d.strip().upper() in TXDOT_DISTRICTS]
    return picked[:6] or ["AUS", "SAT"]


def _txdot_loader(provider: Provider, ctx: Context) -> tuple[list[dict[str, Any]], str | None, str]:
    cameras, urls = [], []
    for district in _txdot_districts():
        url = "https://its.txdot.gov/its/DistrictIts/GetCctvStatusListByDistrict?" + urlencode({"districtCode": district})
        urls.append(url)
        doc, _ = _cached_fetch(provider, url, district)
        groups = doc.get("roadwayCctvStatuses") if isinstance(doc, dict) else None
        if not isinstance(groups, dict):
            raise PublicTrafficError(502, "upstream_schema", "TxDOT camera schema was not recognised")
        for roadway, rows in groups.items():
            for row in rows if isinstance(rows, list) else []:
                if not isinstance(row, dict) or row.get("statusDescription") != "Device Online" or row.get("hasSnapshot") is not True:
                    continue
                icd = row.get("icd_Id")
                if not isinstance(icd, str) or not icd or len(icd) > 96:
                    continue
                snap = "https://its.txdot.gov/its/DistrictIts/GetCctvSnapshotByIcdId?" + urlencode({"icdId": icd, "districtCode": district})
                cam = _camera(provider, f"{district}:{icd}", row.get("name") or icd, roadway, row.get("dirDescription"),
                              _coord(row.get("latitude"), row.get("longitude")), snap)
                if cam:
                    cameras.append(cam)
    return cameras, None, ", ".join(urls)


def _txdot_snapshot(provider: Provider, camera: dict[str, Any]) -> tuple[bytes, str, str | None, str]:
    fetched = _http_get(camera["snapshotUrl"], provider.snapshot_hosts, MAX_SNAPSHOT_BYTES * 2, "application/json")
    doc = _json(fetched)
    data = doc.get("snippet") if isinstance(doc, dict) else None
    if not isinstance(data, str) or len(data) > MAX_SNAPSHOT_BYTES * 2:
        raise PublicTrafficError(502, "upstream_schema", "TxDOT snapshot schema was not recognised")
    try:
        image = base64.b64decode(data, validate=True)
    except ValueError:
        raise PublicTrafficError(502, "upstream_schema", "TxDOT snapshot was not valid base64") from None
    district = camera["id"].split(":", 1)[0]
    zone = "America/Denver" if district == "ELP" else "America/Chicago"
    stamp = None
    raw = doc.get("timestampFormatted")
    if isinstance(raw, str) and len(raw) < 40:
        try:
            stamp = _iso(datetime.strptime(raw.strip(), "%m/%d/%Y %I:%M %p").replace(tzinfo=ZoneInfo(zone)))
        except ValueError:
            stamp = None
    return image, _sniff(image), _not_future(stamp), "provider-json" if stamp else "unknown"


def _nsw_loader(provider: Provider, ctx: Context) -> tuple[list[dict[str, Any]], str | None, str]:
    url = "https://data.livetraffic.com/cameras/traffic-cam.json"
    doc, last_modified = _cached_fetch(provider, url, "all")
    features = doc.get("features") if isinstance(doc, dict) else None
    if not isinstance(features, list):
        raise PublicTrafficError(502, "upstream_schema", "Live Traffic NSW camera schema was not recognised")
    cameras = []
    for f in features:
        if not isinstance(f, dict):
            continue
        props = f.get("properties") or {}
        coords = (f.get("geometry") or {}).get("coordinates")
        coord = _coord(coords[1], coords[0]) if isinstance(coords, list) and len(coords) >= 2 else None
        cam = _camera(provider, f.get("id"), props.get("title"), props.get("view"), props.get("direction"), coord,
                      props.get("href") if isinstance(props.get("href"), str) else None)
        if cam:
            cameras.append(cam)
    return cameras, last_modified, url


def _digitraffic_loader(provider: Provider, ctx: Context) -> tuple[list[dict[str, Any]], str | None, str]:
    url = "https://tie.digitraffic.fi/api/weathercam/v1/stations"
    doc, _ = _cached_fetch(provider, url, "all", extra_headers={"Digitraffic-User": "SignalWarden/WorldView"}, gzip=True)
    features = doc.get("features") if isinstance(doc, dict) else None
    if not isinstance(features, list):
        raise PublicTrafficError(502, "upstream_schema", "Digitraffic weathercam schema was not recognised")
    cameras = []
    for f in features:
        if not isinstance(f, dict):
            continue
        props = f.get("properties") or {}
        if props.get("collectionStatus") != "GATHERING":
            continue
        coords = (f.get("geometry") or {}).get("coordinates")
        coord = _coord(coords[1], coords[0]) if isinstance(coords, list) and len(coords) >= 2 else None
        for preset in props.get("presets") or []:
            pid = preset.get("id") if isinstance(preset, dict) else None
            if not isinstance(pid, str) or not pid.isalnum() or preset.get("inCollection") is not True:
                continue
            cam = _camera(provider, pid, f"{_text(props.get('name'))} (preset {pid[-2:]})", None, None, coord,
                          f"https://weathercam.digitraffic.fi/{pid}.jpg", _parse_iso(props.get("dataUpdatedTime")))
            if cam:
                cameras.append(cam)
    return cameras, _parse_iso(doc.get("dataUpdatedTime")), url


def _ibi_loader(host: str) -> Loader:
    """IBI/"511" v2 platform (Ontario 511, FL511, 511NY): key in query string."""

    def load(provider: Provider, ctx: Context) -> tuple[list[dict[str, Any]], str | None, str]:
        url = f"https://{host}/api/v2/get/cameras?" + urlencode({"key": ctx.key or "", "format": "json"})
        doc, _ = _cached_fetch(provider, url, "all")
        if not isinstance(doc, list):
            raise PublicTrafficError(502, "upstream_schema", f"{provider.name} schema was not recognised")
        cameras = []
        for row in doc:
            if not isinstance(row, dict):
                continue
            for view in row.get("Views") or []:
                if not isinstance(view, dict) or str(view.get("Status", "")).lower() != "enabled":
                    continue
                image = view.get("Url")
                cam = _camera(provider, f"{row.get('Id')}-{view.get('Id')}", row.get("Location"), row.get("Roadway"),
                              row.get("Direction"), _coord(row.get("Latitude"), row.get("Longitude")),
                              image if isinstance(image, str) else None)
                if cam:
                    cameras.append(cam)
        return cameras, None, _strip_key(url, "key")

    return load


def _wsdot_loader(provider: Provider, ctx: Context) -> tuple[list[dict[str, Any]], str | None, str]:
    url = "https://wsdot.wa.gov/Traffic/api/HighwayCameras/HighwayCamerasREST.svc/GetCamerasAsJson?" + urlencode({"AccessCode": ctx.key or ""})
    doc, _ = _cached_fetch(provider, url, "all")
    if not isinstance(doc, list):
        raise PublicTrafficError(502, "upstream_schema", "WSDOT camera schema was not recognised")
    cameras = []
    for row in doc:
        if not isinstance(row, dict) or row.get("IsActive") is not True:
            continue
        loc = row.get("CameraLocation") or {}
        coord = _coord(row.get("DisplayLatitude"), row.get("DisplayLongitude")) or _coord(loc.get("Latitude"), loc.get("Longitude"))
        image = row.get("ImageURL")
        cam = _camera(provider, row.get("CameraID"), row.get("Title"), loc.get("RoadName"), loc.get("Direction"), coord,
                      image if isinstance(image, str) else None)
        if cam:
            cameras.append(cam)
    return cameras, None, _strip_key(url, "AccessCode")


PROVIDERS: dict[str, Provider] = {p.id: p for p in [
    Provider(
        id="caltrans", name="Caltrans CCTV", authority="California Department of Transportation (Caltrans)", region="California, US",
        coverage=(-124.5, 32.4, -114.3, 42.2), catalog_hosts=("cwwp2.dot.ca.gov",), snapshot_hosts=("cwwp2.dot.ca.gov",), snapshot_path_prefix="/data/d",
        attribution="Caltrans — cwwp2.dot.ca.gov (courtesy)", license="Public Caltrans CWWP2 data; no separate license text published",
        terms_url="https://cwwp2.dot.ca.gov/documentation/cctv/cctv.htm", loader=_caltrans_loader,
        verified="catalog and snapshot verified live 2026-10-30",
        notes="Per-district catalogs; only districts overlapping the requested area are read (max 4).",
    ),
    Provider(
        id="tfl", name="TfL JamCams", authority="Transport for London", region="London, UK",
        coverage=(-0.6, 51.25, 0.35, 51.75), catalog_hosts=("api.tfl.gov.uk",), snapshot_hosts=("s3-eu-west-1.amazonaws.com",), snapshot_path_prefix="/jamcams.tfl.gov.uk/",
        attribution="Powered by TfL Open Data. Contains OS data © Crown copyright and database rights",
        license="TfL Open Data terms (attribution required)", terms_url="https://tfl.gov.uk/corporate/terms-and-conditions/transport-data-service",
        loader=_tfl_loader, verified="catalog and snapshot verified live 2026-10-30",
    ),
    Provider(
        id="austin", name="City of Austin traffic cameras", authority="City of Austin Transportation and Public Works", region="Austin, TX, US",
        coverage=(-98.2, 29.9, -97.4, 30.7), catalog_hosts=("data.austintexas.gov",), snapshot_hosts=("cctv.austinmobility.io",), snapshot_path_prefix="/image/",
        attribution="City of Austin, TX — data.austintexas.gov", license="City of Austin Open Data Terms of Use",
        terms_url="https://data.austintexas.gov/stories/s/ranj-cccq", loader=_austin_loader,
        verified="catalog and snapshot verified live 2026-10-30", notes="Only cameras with camera_status=TURNED_ON are listed.",
    ),
    Provider(
        id="txdot", name="TxDOT ITS cameras", authority="Texas Department of Transportation", region="Texas, US (configured districts)",
        coverage=(-106.7, 25.8, -93.5, 36.6), catalog_hosts=("its.txdot.gov",), snapshot_hosts=("its.txdot.gov",), snapshot_path_prefix="/its/DistrictIts/GetCctvSnapshotByIcdId",
        attribution="Texas Department of Transportation (courtesy)", license="Public TxDOT ITS traffic camera data; no separate license text published",
        terms_url="https://its.txdot.gov/", loader=_txdot_loader, snapshot_mode="relay_base64_json", snapshot_fetch=_txdot_snapshot,
        verified="catalog and snapshot verified live 2026-10-30",
        notes=f"Districts from {TXDOT_DISTRICTS_ENV} (default AUS,SAT; max 6). Only 'Device Online' cameras with snapshots.",
    ),
    Provider(
        id="nsw", name="Live Traffic NSW cameras", authority="Transport for NSW", region="New South Wales, AU",
        coverage=(140.9, -37.6, 153.7, -28.1), catalog_hosts=("data.livetraffic.com",), snapshot_hosts=("webcams.transport.nsw.gov.au",), snapshot_path_prefix="/livetraffic-webcams/cameras/",
        attribution="Live Traffic NSW — Transport for NSW", license="CC BY 4.0 (Transport for NSW open data)",
        terms_url="https://opendata.transport.nsw.gov.au/dataset/live-traffic-cameras", loader=_nsw_loader, snapshot_mode="hotlink",
        verified="catalog verified live 2026-10-30; image host serves non-browser clients an HTML placeholder, so frames are shown by direct browser image load (not relayed, no User-Agent spoofing)",
    ),
    Provider(
        id="digitraffic", name="Fintraffic weathercams", authority="Fintraffic / Digitraffic", region="Finland",
        coverage=(19.0, 59.5, 31.7, 70.2), catalog_hosts=("tie.digitraffic.fi",), snapshot_hosts=("weathercam.digitraffic.fi",),
        attribution="Fintraffic / digitraffic.fi, license CC BY 4.0", license="CC BY 4.0",
        terms_url="https://www.digitraffic.fi/en/terms-of-service/", loader=_digitraffic_loader,
        verified="catalog and snapshot verified live 2026-10-30", notes="Road-weather camera presets, typically refreshed about every 10 minutes.",
    ),
    Provider(
        id="wsdot", name="WSDOT highway cameras", authority="Washington State Department of Transportation", region="Washington, US",
        coverage=(-124.9, 45.5, -116.9, 49.1), catalog_hosts=("wsdot.wa.gov",), snapshot_hosts=("images.wsdot.wa.gov",),
        attribution="Washington State Department of Transportation (Travel Center)", license="WSDOT Traveler Information API terms",
        terms_url="https://wsdot.wa.gov/traffic/api/", loader=_wsdot_loader, key_env="UCAS_WSDOT_ACCESS_CODE",
        key_url="https://wsdot.wa.gov/traffic/api/", key_free=True,
        verified="endpoint reachable (401 without access code) 2026-10-30; image host verified; catalog shape from WSDOT documentation, not verified with a code",
    ),
    Provider(
        id="ontario511", name="Ontario 511 cameras", authority="Ontario Ministry of Transportation (Ontario 511)", region="Ontario, CA",
        coverage=(-95.2, 41.6, -74.3, 56.9), catalog_hosts=("511on.ca",), snapshot_hosts=("511on.ca",), snapshot_path_prefix="/map/Cctv/",
        attribution="Ontario 511. Contains information licensed under the Open Government Licence – Ontario",
        license="Open Government Licence – Ontario; Ontario 511 Developer's Access Agreement",
        terms_url="https://511on.ca/developers/doc", loader=_ibi_loader("511on.ca"), key_env="UCAS_ONTARIO511_API_KEY",
        key_url="https://511on.ca/developers/doc", key_free=True,
        verified="endpoint now requires a developer key ('Invalid Key' without one) 2026-10-30; shape from 511on.ca API documentation, not verified with a key",
        notes="Provider throttle: 10 calls per 60 seconds; the 10-minute catalog cache stays well under it.",
    ),
    Provider(
        id="ny511", name="511NY cameras", authority="New York State DOT (511NY)", region="New York, US",
        coverage=(-79.8, 40.4, -71.8, 45.1), catalog_hosts=("511ny.org",), snapshot_hosts=("511ny.org",), snapshot_path_prefix="/map/Cctv/",
        attribution="511NY / NYSDOT", license="511NY Developer's Access Agreement",
        terms_url="https://511ny.org/developers/doc", loader=_ibi_loader("511ny.org"), key_env="UCAS_511NY_API_KEY",
        key_url="https://511ny.org/developers/doc", key_free=True,
        verified="NOT verified: 511ny.org moved to a new platform in late Sep 2026 and every API path tested returned the website HTML on 2026-10-30; adapter follows the documented v2 shape and reports an error rather than guessing",
    ),
    Provider(
        id="fl511", name="FL511 cameras", authority="Florida Department of Transportation (FL511)", region="Florida, US",
        coverage=(-87.7, 24.4, -79.9, 31.1), catalog_hosts=("fl511.com",), snapshot_hosts=("fl511.com",), snapshot_path_prefix="/map/Cctv/",
        attribution="Florida DOT — FL511.com (courtesy)", license="FL511 terms: individual personal use; other use needs FDOT written consent",
        terms_url="https://fl511.com/privacy#disclaimer", loader=_ibi_loader("fl511.com"), key_env="UCAS_FL511_API_KEY",
        key_url="https://fl511.com/developers/doc", key_free=True,
        verified="endpoint reachable ('Invalid Key' without a key) 2026-10-30; shape from the shared 511 v2 documentation, not verified with a key",
    ),
]}

TOMTOM = {
    "id": "tomtom",
    "name": "TomTom Traffic (incidents + flow segment)",
    "keyEnv": TOMTOM_KEY_ENV,
    "keyUrl": "https://developer.tomtom.com/user/register",
    "attribution": "Traffic data © TomTom",
    "license": "TomTom developer terms; your own key, quota and billing",
    "termsUrl": "https://developer.tomtom.com/terms-and-conditions",
    "verified": "endpoints reachable (401 without key) 2026-10-30; response shape from TomTom Traffic API documentation, not verified with a key",
}

_lock = threading.Lock()
_catalog_cache: dict[tuple[str, str], tuple[float, Any, str | None]] = {}
_catalog_attempts: dict[tuple[str, str], float] = {}
_snapshot_attempts: dict[tuple[str, str], float] = {}
_snapshot_window: list[float] = []
_tomtom_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_tomtom_attempts: dict[str, float] = {}
_slots = threading.BoundedSemaphore(2)


def reset_state() -> None:
    with _lock:
        _catalog_cache.clear(); _catalog_attempts.clear(); _snapshot_attempts.clear()
        _snapshot_window.clear(); _tomtom_cache.clear(); _tomtom_attempts.clear()


# ---------------------------------------------------------------- guards

def enabled() -> bool:
    return os.getenv(ENABLE_ENV, "0").lower() in {"1", "true", "yes"}


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
    if not enabled():
        raise PublicTrafficError(404, "public_traffic_disabled", f"public traffic relay is disabled; set {ENABLE_ENV}=1")
    if headers.get(HEADER) != "enabled":
        raise PublicTrafficError(403, "traffic_header_required", f"{HEADER}: enabled is required")
    if not _same_origin(headers):
        raise PublicTrafficError(403, "origin_not_allowed", "cross-site public traffic requests are not allowed")


def _key(env: str | None) -> str | None:
    if not env:
        return None
    value = os.getenv(env, "").strip()
    return value if value and len(value) <= 256 and value.isprintable() else None


def _allowed_ids() -> set[str]:
    raw = os.getenv(PROVIDER_FILTER_ENV, "").strip()
    return {p.strip().lower() for p in raw.split(",") if p.strip()}


def provider_status(provider: Provider) -> str:
    allowed = _allowed_ids()
    if provider.id not in allowed:
        return "disabled"
    if provider.key_env and not _key(provider.key_env):
        return "not_configured"
    return "available"


def _public_provider(p: Provider) -> dict[str, Any]:
    return {
        "id": p.id, "name": p.name, "authority": p.authority, "region": p.region, "coverage": list(p.coverage),
        "status": provider_status(p), "keyEnv": p.key_env, "keyUrl": p.key_url, "keyFree": p.key_free,
        "snapshotMode": p.snapshot_mode, "attribution": p.attribution, "license": p.license, "termsUrl": p.terms_url,
        "verified": p.verified, "notes": p.notes,
    }


def providers() -> dict[str, Any]:
    if os.getenv(TOMTOM_ENABLE_ENV, "0").lower() not in {"1", "true", "yes"}:
        tomtom_status = "disabled"
    else:
        tomtom_status = "available" if _key(TOMTOM_KEY_ENV) else "not_configured"
    return {
        "cameraProviders": [_public_provider(p) for p in PROVIDERS.values()],
        "traffic": {**TOMTOM, "status": tomtom_status},
        "limits": {"maxCameras": MAX_CAMERAS, "maxHalfSpanDegrees": MAX_HALF_SPAN_DEG, "catalogTtlSeconds": CATALOG_TTL,
                   "snapshotMinIntervalSeconds": SNAPSHOT_MIN_INTERVAL, "tomtomMaxAreaKm2": TOMTOM_MAX_AREA_KM2},
        "privacy": "Catalog metadata and on-demand display snapshots only. No plate reading, face recognition, image analysis, or cross-camera tracking.",
    }


def _bbox(query: dict[str, list[str]], max_half_span: float) -> tuple[float, float, float, float]:
    values = []
    for name in ("west", "south", "east", "north"):
        raw = query.get(name, [])
        if len(raw) != 1:
            raise PublicTrafficError(400, "invalid_bbox", "west, south, east and north must each be supplied once")
        try:
            v = float(raw[0])
        except ValueError:
            raise PublicTrafficError(400, "invalid_bbox", "bbox values must be numbers") from None
        if not math.isfinite(v):
            raise PublicTrafficError(400, "invalid_bbox", "bbox values must be finite")
        values.append(v)
    w, s, e, n = values
    if not (-180 <= w < e <= 180 and -90 <= s < n <= 90):
        raise PublicTrafficError(400, "invalid_bbox", "bbox must satisfy -180<=west<east<=180 and -90<=south<north<=90")
    if (e - w) > 2 * max_half_span or (n - s) > 2 * max_half_span:
        raise PublicTrafficError(400, "bbox_too_large", f"bbox spans at most {2 * max_half_span:g} degrees per side; zoom in")
    return w, s, e, n


def _provider(query: dict[str, list[str]]) -> Provider:
    raw = query.get("provider", [])
    if len(raw) != 1 or raw[0] not in PROVIDERS:
        raise PublicTrafficError(400, "invalid_provider", "provider must name one registered camera provider")
    provider = PROVIDERS[raw[0]]
    status = provider_status(provider)
    if status == "not_configured":
        raise PublicTrafficError(503, "not_configured", f"{provider.name} needs {provider.key_env} on the server; no data is shown")
    if status == "disabled":
        raise PublicTrafficError(404, "provider_disabled", f"{provider.name} is disabled by {PROVIDER_FILTER_ENV}")
    return provider


def _only(query: dict[str, list[str]], names: set[str]) -> None:
    if not set(query) <= names:
        raise PublicTrafficError(400, "invalid_query", "unexpected query parameter")


# ---------------------------------------------------------------- catalog / snapshot

def catalog(query: dict[str, list[str]]) -> dict[str, Any]:
    _only(query, {"provider", "west", "south", "east", "north"})
    provider = _provider(query)
    bbox = _bbox(query, MAX_HALF_SPAN_DEG)
    if not _bbox_intersects(provider.coverage, bbox):
        return {**_envelope(provider), "status": "out_of_coverage", "cameras": [], "totalInArea": 0, "truncated": False,
                "retrievedAt": _now_iso(), "providerUpdatedAt": None, "sourceUrl": None}
    if not _slots.acquire(blocking=False):
        raise PublicTrafficError(503, "relay_busy", "public traffic relay concurrency limit reached")
    try:
        ctx = Context(bbox=bbox, key=_key(provider.key_env))
        cameras, provider_updated, source_url = provider.loader(provider, ctx)
    finally:
        _slots.release()
    w, s, e, n = bbox
    inside = [c for c in cameras if w <= c["lon"] <= e and s <= c["lat"] <= n]
    center = ((s + n) / 2, (w + e) / 2)
    inside.sort(key=lambda c: (_distance_km(center, (c["lat"], c["lon"])), c["id"]))
    unique: dict[str, dict[str, Any]] = {}
    for cam in inside:
        unique.setdefault(cam["id"], cam)
    chosen = list(unique.values())[:MAX_CAMERAS]
    return {
        **_envelope(provider), "status": "ok", "cameras": chosen, "totalInArea": len(unique), "truncated": len(unique) > MAX_CAMERAS,
        "retrievedAt": _now_iso(), "providerUpdatedAt": _not_future(provider_updated), "sourceUrl": source_url,
    }


def _envelope(provider: Provider) -> dict[str, Any]:
    return {"provider": provider.id, "providerName": provider.name, "authority": provider.authority,
            "attribution": provider.attribution, "license": provider.license, "termsUrl": provider.terms_url,
            "verified": provider.verified, "snapshotMode": provider.snapshot_mode}


def _sniff(data: bytes) -> str:
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    raise PublicTrafficError(502, "snapshot_not_image", "provider did not return a JPEG, PNG or GIF image")


def _find_camera(provider: Provider, camera_id: str) -> dict[str, Any]:
    ctx = Context(bbox=provider.coverage, key=_key(provider.key_env))
    if provider.id == "caltrans":
        # Only read the one district named in the id.
        try:
            district = int(camera_id.split(":", 1)[0].lstrip("D"))
        except ValueError:
            raise PublicTrafficError(404, "camera_not_found", "camera is not in the provider catalog") from None
        if district not in CALTRANS_DISTRICTS:
            raise PublicTrafficError(404, "camera_not_found", "camera is not in the provider catalog")
        ctx.districts = [district]
        cameras = provider.loader(provider, ctx)[0]
    else:
        cameras = provider.loader(provider, ctx)[0]
    for cam in cameras:
        if cam["id"] == camera_id:
            return cam
    raise PublicTrafficError(404, "camera_not_found", "camera is not in the provider catalog")


def snapshot(query: dict[str, list[str]]) -> dict[str, Any]:
    _only(query, {"provider", "id"})
    provider = _provider(query)
    ids = query.get("id", [])
    if len(ids) != 1 or not ids[0] or len(ids[0]) > 120 or _safe_id(ids[0]) != ids[0]:
        raise PublicTrafficError(400, "invalid_camera_id", "id must be one catalog camera id")
    camera_id = ids[0]
    if provider.snapshot_mode == "hotlink":
        raise PublicTrafficError(409, "snapshot_hotlink_only", "this provider's frames load directly from the authority host in the browser")
    now = clock()
    with _lock:
        last = _snapshot_attempts.get((provider.id, camera_id), 0.0)
        if now - last < SNAPSHOT_MIN_INTERVAL:
            raise PublicTrafficError(429, "snapshot_throttled", f"wait {SNAPSHOT_MIN_INTERVAL:g} seconds between snapshots of one camera")
        _snapshot_window[:] = [t for t in _snapshot_window if now - t < 60]
        if len(_snapshot_window) >= SNAPSHOT_PER_MINUTE:
            raise PublicTrafficError(429, "snapshot_rate_limited", f"at most {SNAPSHOT_PER_MINUTE} snapshots per minute")
    camera = _find_camera(provider, camera_id)
    if not camera.get("snapshotUrl"):
        raise PublicTrafficError(404, "snapshot_unavailable", "provider lists no snapshot for this camera")
    if not _slots.acquire(blocking=False):
        raise PublicTrafficError(503, "relay_busy", "public traffic relay concurrency limit reached")
    try:
        with _lock:
            _snapshot_attempts[(provider.id, camera_id)] = now
            _snapshot_window.append(now)
        if provider.snapshot_fetch:
            data, mime, stamp, stamp_source = provider.snapshot_fetch(provider, camera)
        else:
            fetched = _http_get(camera["snapshotUrl"], provider.snapshot_hosts, MAX_SNAPSHOT_BYTES, "image/jpeg,image/png,image/gif")
            data = fetched.body
            mime = _sniff(data)
            if fetched.content_type and not fetched.content_type.startswith("image/"):
                raise PublicTrafficError(502, "snapshot_not_image", "provider did not return an image")
            stamp = _not_future(_http_date(fetched.last_modified))
            stamp_source = "http-last-modified" if stamp else "unknown"
    finally:
        _slots.release()
    if len(data) > MAX_SNAPSHOT_BYTES:
        raise PublicTrafficError(413, "upstream_too_large", "snapshot exceeds the size limit")
    _sniff(data)
    return {
        **_envelope(provider), "cameraId": camera_id, "cameraName": camera["name"], "mime": mime,
        "bytes": len(data), "dataBase64": base64.b64encode(data).decode("ascii"),
        "imageTime": stamp, "imageTimeSource": stamp_source, "retrievedAt": _now_iso(),
        "sourceUrl": camera["snapshotUrl"],
        "disclosure": "Authority snapshot relayed for display only; not stored, analysed, or matched across cameras.",
    }


# ---------------------------------------------------------------- TomTom

def _bbox_area_km2(b: tuple[float, float, float, float]) -> float:
    w, s, e, n = b
    mid = math.radians((s + n) / 2)
    return abs(n - s) * 111.32 * abs(e - w) * 111.32 * max(0.01, math.cos(mid))


_INCIDENT_CATEGORIES = {
    0: "Unknown", 1: "Accident", 2: "Fog", 3: "Dangerous conditions", 4: "Rain", 5: "Ice", 6: "Jam", 7: "Lane closed",
    8: "Road closed", 9: "Road works", 10: "Wind", 11: "Flooding", 14: "Broken down vehicle",
}
_FIELDS = "{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description,code},startTime,endTime,from,to,length,delay,roadNumbers,lastReportTime}}}"


def _first_coord(geometry: Any) -> tuple[float, float] | None:
    if not isinstance(geometry, dict):
        return None
    coords = geometry.get("coordinates")
    if geometry.get("type") == "Point" and isinstance(coords, list) and len(coords) >= 2:
        return _coord(coords[1], coords[0])
    if geometry.get("type") == "LineString" and isinstance(coords, list) and coords and isinstance(coords[0], list) and len(coords[0]) >= 2:
        return _coord(coords[0][1], coords[0][0])
    return None


def _incident(item: Any) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    props = item.get("properties") or {}
    coord = _first_coord(item.get("geometry"))
    ident = _safe_id(props.get("id"))
    if not coord or not ident:
        return None
    events = [e for e in props.get("events") or [] if isinstance(e, dict)]
    category = props.get("iconCategory")
    roads = [r for r in props.get("roadNumbers") or [] if isinstance(r, str)][:4]

    def num(v: Any) -> float | None:
        return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else None

    return {
        "id": ident, "lat": round(coord[0], 6), "lon": round(coord[1], 6),
        "category": _INCIDENT_CATEGORIES.get(category, "Other") if isinstance(category, int) else "Unknown",
        "description": _text(events[0].get("description")) if events else "",
        "magnitudeOfDelay": num(props.get("magnitudeOfDelay")), "delaySeconds": num(props.get("delay")),
        "lengthMeters": num(props.get("length")), "from": _text(props.get("from"), 120) or None, "to": _text(props.get("to"), 120) or None,
        "roadNumbers": ", ".join(_text(r, 20) for r in roads) or None,
        "startTime": _not_future(_parse_iso(props.get("startTime"))), "endTime": _parse_iso(props.get("endTime")),
        "lastReportTime": _not_future(_parse_iso(props.get("lastReportTime"))),
    }


def _flow(doc: Any) -> dict[str, Any] | None:
    data = doc.get("flowSegmentData") if isinstance(doc, dict) else None
    if not isinstance(data, dict):
        return None
    pts = ((data.get("coordinates") or {}).get("coordinate") or []) if isinstance(data.get("coordinates"), dict) else []
    coord = _coord(pts[0].get("latitude"), pts[0].get("longitude")) if pts and isinstance(pts[0], dict) else None

    def num(v: Any) -> float | None:
        return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else None

    current, free = num(data.get("currentSpeed")), num(data.get("freeFlowSpeed"))
    if coord is None or current is None or free is None:
        return None
    return {"lat": round(coord[0], 6), "lon": round(coord[1], 6), "currentSpeedKmh": current, "freeFlowSpeedKmh": free,
            "currentTravelTimeSeconds": num(data.get("currentTravelTime")), "freeFlowTravelTimeSeconds": num(data.get("freeFlowTravelTime")),
            "confidence": num(data.get("confidence")), "roadClosure": data.get("roadClosure") is True,
            "functionalRoadClass": _text(data.get("frc"), 8) or None}


def tomtom(query: dict[str, list[str]]) -> dict[str, Any]:
    _only(query, {"west", "south", "east", "north"})
    if os.getenv(TOMTOM_ENABLE_ENV, "0").lower() not in {"1", "true", "yes"}:
        raise PublicTrafficError(404, "provider_disabled", f"TomTom traffic is disabled; set {TOMTOM_ENABLE_ENV}=1 only after reviewing its current terms")
    key = _key(TOMTOM_KEY_ENV)
    if not key:
        raise PublicTrafficError(503, "not_configured", f"TomTom traffic needs {TOMTOM_KEY_ENV} on the server; no data is shown")
    bbox = _bbox(query, 1.0)
    if _bbox_area_km2(bbox) > TOMTOM_MAX_AREA_KM2:
        raise PublicTrafficError(400, "bbox_too_large", "TomTom incident bbox must be at most 10,000 km²; zoom in")
    cache_key = ",".join(f"{v:.3f}" for v in bbox)
    now = clock()
    with _lock:
        hit = _tomtom_cache.get(cache_key)
        if hit and now - hit[0] < TOMTOM_MIN_INTERVAL:
            return {**hit[1], "cached": True}
        if now - _tomtom_attempts.get("global", 0.0) < 5.0:
            raise PublicTrafficError(429, "traffic_throttled", "TomTom requests are throttled; wait a few seconds")
        _tomtom_attempts["global"] = now
    w, s, e, n = bbox
    hosts = ("api.tomtom.com",)
    inc_url = "https://api.tomtom.com/traffic/services/5/incidentDetails?" + urlencode({
        "bbox": f"{w:.5f},{s:.5f},{e:.5f},{n:.5f}", "fields": _FIELDS, "language": "en-GB", "timeValidityFilter": "present", "key": key,
    })
    lat, lon = (s + n) / 2, (w + e) / 2
    flow_url = f"https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json?" + urlencode({
        "point": f"{lat:.5f},{lon:.5f}", "unit": "KMPH", "key": key,
    })
    if not _slots.acquire(blocking=False):
        raise PublicTrafficError(503, "relay_busy", "public traffic relay concurrency limit reached")
    try:
        incidents_doc = _json(_http_get(inc_url, hosts, MAX_TRAFFIC_BYTES, "application/json"))
        flow_error = None
        try:
            flow = _flow(_json(_http_get(flow_url, hosts, MAX_TRAFFIC_BYTES, "application/json")))
        except PublicTrafficError as exc:  # no road near the centre is a normal outcome
            flow, flow_error = None, exc.code
    finally:
        _slots.release()
    raw = incidents_doc.get("incidents") if isinstance(incidents_doc, dict) else None
    if not isinstance(raw, list):
        raise PublicTrafficError(502, "upstream_schema", "TomTom incident schema was not recognised")
    incidents = [i for i in (_incident(x) for x in raw[:MAX_INCIDENTS * 2]) if i][:MAX_INCIDENTS]
    result = {
        "provider": "tomtom", "providerName": TOMTOM["name"], "attribution": TOMTOM["attribution"], "license": TOMTOM["license"],
        "termsUrl": TOMTOM["termsUrl"], "verified": TOMTOM["verified"], "status": "ok", "retrievedAt": _now_iso(),
        "incidents": incidents, "truncated": len(raw) > MAX_INCIDENTS, "flow": flow, "flowError": flow_error,
        "sourceUrl": _strip_key(inc_url, "key"), "flowSourceUrl": _strip_key(flow_url, "key"),
        "disclosure": "Aggregate road-segment traffic and reported incidents; not individual vehicle tracking.",
    }
    with _lock:
        _tomtom_cache[cache_key] = (now, result)
    return result


# ---------------------------------------------------------------- dispatch

def dispatch(method: str, suffix: list[str], query: dict[str, list[str]], headers: Any) -> dict[str, Any]:
    """Handle ``/api/v1/public-traffic/<suffix>``.  GET only."""
    authorize(headers)
    if method != "GET":
        raise PublicTrafficError(405, "read_only_integration", "public traffic routes are GET-only")
    if suffix == ["providers"]:
        _only(query, set())
        return providers()
    if suffix == ["cameras", "catalog"]:
        return catalog(query)
    if suffix == ["cameras", "snapshot"]:
        return snapshot(query)
    if suffix == ["tomtom"]:
        return tomtom(query)
    raise PublicTrafficError(404, "not_found", "public traffic route was not found")
