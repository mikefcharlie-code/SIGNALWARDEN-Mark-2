"""Disabled-by-default, read-only relay for public fire and tropical-cyclone feeds.

Two upstreams are served through this relay because they either need a
server-side credential or do not send CORS headers:

* NASA FIRMS active-fire (thermal anomaly) detections.  With
  ``UCAS_NASA_FIRMS_MAP_KEY`` set, the FIRMS area API is used.  Without a key
  the relay reports ``keyStatus: not_configured`` and, where possible, falls
  back to FIRMS' keyless public regional 24h/48h CSV files (NASA open data),
  filtered to the requested bounding box.  It never fabricates detections.
* NOAA/NWS NHC/CPHC active tropical cyclones (``CurrentStorms.json``) plus the
  forecast points/track/cone layers of NOAA's public NHC ArcGIS MapServer.

Guards mirror ``sar_imagery``: ``UCAS_PUBLIC_HAZARDS_ENABLED`` must be set, the
request must carry ``X-SignalWarden-Hazards: enabled`` and be same-origin; the
upstream hosts are fixed, redirects are refused, responses are size/time
bounded and requests are throttled and cached.  The MAP_KEY is read only from
the environment and is never echoed in responses, error messages or logs.
Read-only: there is no write, command or control path here.
"""
from __future__ import annotations

import csv
import io
import json
import os
import re
import threading
import time
from datetime import datetime, timezone
from email.message import Message
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

DEADLINE_SECONDS = 20.0
FIRMS_MAX_BYTES = 8 * 1024 * 1024
JSON_MAX_BYTES = 1024 * 1024
MAX_DETECTIONS = 2000
MAX_STORMS = 10
MAX_BBOX_SPAN_DEG = 20.0
FIRMS_CACHE_SECONDS = 300.0
NHC_CACHE_SECONDS = 120.0
# Well under the FIRMS MAP_KEY limit of 5000 transactions / 10 minutes.
UPSTREAM_BUDGET = 30
UPSTREAM_WINDOW_SECONDS = 600.0
USER_AGENT = "SignalWarden-WorldView/0.1 (read-only hazard relay)"

FIRMS_HOST = "firms.modaps.eosdis.nasa.gov"
NHC_HOST = "www.nhc.noaa.gov"
NHC_GIS_HOST = "mapservices.weather.noaa.gov"
ALLOWED_HOSTS = frozenset({FIRMS_HOST, NHC_HOST, NHC_GIS_HOST})

FIRMS_SOURCES = ("VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT", "MODIS_NRT")
# Keyless public files: https://firms.modaps.eosdis.nasa.gov/active_fire/
_PUBLIC_FILE_PREFIX = {
    "VIIRS_SNPP_NRT": "suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2",
    "VIIRS_NOAA20_NRT": "noaa-20-viirs-c2/csv/J1_VIIRS_C2",
    "VIIRS_NOAA21_NRT": "noaa-21-viirs-c2/csv/J2_VIIRS_C2",
    "MODIS_NRT": "modis-c6.1/csv/MODIS_C6_1",
}
# Approximate public-region extents (west, south, east, north), checked against
# the detections present in each regional file.  A bbox must sit fully inside
# one region for the keyless fallback; otherwise configure a MAP_KEY.
FIRMS_REGIONS: tuple[tuple[str, tuple[float, float, float, float]], ...] = (
    ("USA_contiguous_and_Hawaii", (-160.5, 17.5, -66.0, 50.0)),
    ("Alaska", (-180.0, 50.5, -129.0, 72.0)),
    ("Canada", (-150.0, 40.0, -49.0, 80.0)),
    ("Central_America", (-119.5, 7.0, -58.4, 33.5)),
    ("South_America", (-105.0, -57.0, -34.0, 13.0)),
    ("Europe", (-26.0, 34.0, 35.0, 72.0)),
    ("Northern_and_Central_Africa", (-27.0, -10.0, 52.0, 38.0)),
    ("Southern_Africa", (10.0, -36.0, 58.0, -4.0)),
    ("Russia_Asia", (26.0, 9.0, 180.0, 83.0)),
    ("South_Asia", (54.0, 5.0, 102.0, 40.0)),
    ("SouthEast_Asia", (88.0, -12.0, 163.0, 31.0)),
    ("Australia_NewZealand", (110.0, -55.0, 180.0, -10.0)),
)
NHC_LAYERS: dict[str, tuple[int, int, int]] = {}
for _basin, _first in (("AT", 6), ("EP", 136), ("CP", 266)):
    for _n in range(5):
        _base = _first + 26 * _n
        NHC_LAYERS[f"{_basin}{_n + 1}"] = (_base, _base + 1, _base + 2)  # points, track, cone

FIRMS_ATTRIBUTION = (
    "NASA FIRMS (LANCE/ESDIS) active fire data; satellite thermal anomalies, not confirmed fires"
)
FIRMS_TERMS_URL = "https://www.earthdata.nasa.gov/data/tools/firms"
NHC_ATTRIBUTION = "NOAA/NWS National Hurricane Center / Central Pacific Hurricane Center; no endorsement"
NHC_TERMS_URL = "https://www.weather.gov/disclaimer"
_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$")
_STORM_ID = re.compile(r"^(al|ep|cp)\d{6}$")
_ADVISORY_URL = re.compile(r"^https://www\.nhc\.noaa\.gov/[A-Za-z0-9_./-]{1,200}$")


class HazardFeedError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req: Request, fp: Any, code: int, msg: str, headers: Message, newurl: str) -> None:
        return None


def _default_opener() -> Any:
    # Like sar_imagery, ignore ambient proxy variables and refuse redirects.
    return build_opener(ProxyHandler({}), _NoRedirect())


opener_factory: Callable[[], Any] = _default_opener
_lock = threading.Lock()
_slots = threading.BoundedSemaphore(2)
_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_upstream_calls: list[float] = []


def enabled() -> bool:
    return os.getenv("UCAS_PUBLIC_HAZARDS_ENABLED", "0").lower() in {"1", "true", "yes"}


def _map_key() -> str | None:
    key = os.getenv("UCAS_NASA_FIRMS_MAP_KEY", "").strip()
    return key if re.fullmatch(r"[A-Za-z0-9]{8,64}", key) else None


def _same_origin(headers: Any) -> bool:
    origin = headers.get("Origin")
    if origin:
        try:
            parsed = urlsplit(origin)
            if parsed.scheme not in {"http", "https"} or parsed.path or parsed.query or parsed.fragment:
                return False
            if parsed.netloc.lower() != headers.get("Host", "").lower():
                return False
        except ValueError:
            return False
    return (headers.get("Sec-Fetch-Site") or "").lower() != "cross-site"


def authorize_request(headers: Any) -> None:
    if not enabled():
        raise HazardFeedError(404, "hazard_relay_disabled", "public hazard relay is disabled")
    if headers.get("X-SignalWarden-Hazards") != "enabled":
        raise HazardFeedError(403, "hazard_header_required", "X-SignalWarden-Hazards: enabled is required")
    if not _same_origin(headers):
        raise HazardFeedError(403, "origin_not_allowed", "cross-site hazard relay requests are not allowed")


def reset_state() -> None:
    """Clear cache and throttle state (tests)."""
    with _lock:
        _cache.clear()
        _upstream_calls.clear()


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _reserve_upstream() -> None:
    now = time.monotonic()
    with _lock:
        while _upstream_calls and now - _upstream_calls[0] > UPSTREAM_WINDOW_SECONDS:
            _upstream_calls.pop(0)
        if len(_upstream_calls) >= UPSTREAM_BUDGET:
            raise HazardFeedError(429, "hazard_relay_throttled", "hazard relay upstream budget reached; retry later")
        _upstream_calls.append(now)


def _get(url: str, max_bytes: int, accept: str) -> bytes:
    """Fetch an allowlisted HTTPS URL; errors never include the URL (it may hold the MAP_KEY)."""
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS or parsed.port not in (None, 443) or parsed.username:
        raise HazardFeedError(500, "hazard_host_rejected", "upstream host is not allowlisted")
    _reserve_upstream()
    deadline = time.monotonic() + DEADLINE_SECONDS
    try:
        response = opener_factory().open(Request(url, headers={"Accept": accept, "User-Agent": USER_AGENT}), timeout=DEADLINE_SECONDS)
    except HTTPError as exc:
        status = exc.code
        exc.close()
        if status in {301, 302, 303, 307, 308}:
            raise HazardFeedError(502, "hazard_redirect_rejected", "upstream redirect was rejected") from None
        if status in {401, 403}:
            raise HazardFeedError(502, "hazard_upstream_denied", "upstream denied the request (check provider key/terms)") from None
        if status == 429:
            raise HazardFeedError(429, "hazard_upstream_throttled", "upstream rate limit reached") from None
        raise HazardFeedError(502, "hazard_upstream_error", f"upstream returned HTTP {status}") from None
    except (URLError, TimeoutError, OSError):
        raise HazardFeedError(502, "hazard_upstream_unreachable", "upstream could not be reached") from None
    try:
        length = response.headers.get("Content-Length")
        if length is not None and length.isdigit() and int(length) > max_bytes:
            raise HazardFeedError(413, "hazard_response_too_large", "upstream response exceeds the size limit")
        data = bytearray()
        while True:
            if time.monotonic() > deadline:
                raise HazardFeedError(504, "hazard_upstream_timeout", "upstream timed out")
            read = getattr(response, "read1", response.read)
            chunk = read(min(64 * 1024, max_bytes + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > max_bytes:
                raise HazardFeedError(413, "hazard_response_too_large", "upstream response exceeds the size limit")
        return bytes(data)
    except HazardFeedError:
        raise
    except (URLError, TimeoutError, OSError):
        raise HazardFeedError(502, "hazard_upstream_unreachable", "upstream could not be read") from None
    finally:
        response.close()


def _cached(key: str, ttl: float, build: Callable[[], dict[str, Any]]) -> dict[str, Any]:
    now = time.monotonic()
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < ttl:
            return {**hit[1], "cached": True}
    if not _slots.acquire(blocking=False):
        raise HazardFeedError(503, "hazard_relay_busy", "hazard relay concurrency limit reached")
    try:
        value = build()
    finally:
        _slots.release()
    with _lock:
        _cache[key] = (time.monotonic(), value)
        if len(_cache) > 64:
            _cache.pop(next(iter(_cache)))
    return {**value, "cached": False}


# ---------------------------------------------------------------- FIRMS

def parse_bbox(raw: str) -> tuple[float, float, float, float]:
    parts = raw.split(",") if isinstance(raw, str) else []
    try:
        west, south, east, north = (float(p) for p in parts)
    except ValueError:
        raise HazardFeedError(400, "invalid_bbox", "bbox must be west,south,east,north in degrees") from None
    if not all(map(lambda v: v == v and abs(v) != float("inf"), (west, south, east, north))):
        raise HazardFeedError(400, "invalid_bbox", "bbox must be finite")
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise HazardFeedError(400, "invalid_bbox", "bbox must satisfy -180<=west<east<=180 and -90<=south<north<=90 (no antimeridian wrap)")
    if east - west > MAX_BBOX_SPAN_DEG or north - south > MAX_BBOX_SPAN_DEG:
        raise HazardFeedError(400, "bbox_too_large", f"bbox span is capped at {MAX_BBOX_SPAN_DEG:g} degrees per side")
    return round(west, 4), round(south, 4), round(east, 4), round(north, 4)


def validate_firms_query(query: dict[str, list[str]]) -> tuple[str, tuple[float, float, float, float], int]:
    if set(query) - {"source", "bbox", "days"} or any(len(v) != 1 for v in query.values()) or "bbox" not in query:
        raise HazardFeedError(400, "invalid_firms_query", "use exactly one each of bbox, optional source and optional days")
    source = query.get("source", ["VIIRS_NOAA20_NRT"])[0]
    if source not in FIRMS_SOURCES:
        raise HazardFeedError(400, "invalid_firms_source", "source must be one of " + ", ".join(FIRMS_SOURCES))
    days_raw = query.get("days", ["1"])[0]
    if not days_raw.isdigit() or not 1 <= int(days_raw) <= 5:
        raise HazardFeedError(400, "invalid_firms_days", "days must be an integer from 1 to 5")
    return source, parse_bbox(query["bbox"][0]), int(days_raw)


def _region_for(bbox: tuple[float, float, float, float]) -> str | None:
    w, s, e, n = bbox
    for name, (rw, rs, re_, rn) in FIRMS_REGIONS:
        if rw <= w and rs <= s and e <= re_ and n <= rn:
            return name
    return None


def _acq_iso(date: str, hhmm: str) -> str | None:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date or "") or not re.fullmatch(r"\d{1,4}", hhmm or ""):
        return None
    hhmm = hhmm.zfill(4)
    try:
        moment = datetime.strptime(f"{date} {hhmm}", "%Y-%m-%d %H%M").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return moment.strftime("%Y-%m-%dT%H:%M:00Z")


_SAT = {"N": "Suomi NPP", "N20": "NOAA-20", "1": "NOAA-20", "N21": "NOAA-21", "2": "NOAA-21",
        "T": "Terra", "TERRA": "Terra", "A": "Aqua", "AQUA": "Aqua"}
_VIIRS_CONF = {"l": "low", "n": "nominal", "h": "high", "low": "low", "nominal": "nominal", "high": "high"}


def _num(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and abs(number) != float("inf") else None


def parse_firms_csv(text: str, bbox: tuple[float, float, float, float], source: str) -> tuple[list[dict[str, Any]], bool, int]:
    w, s, e, n = bbox
    reader = csv.DictReader(io.StringIO(text))
    required = {"latitude", "longitude", "acq_date", "acq_time", "satellite", "confidence", "frp", "daynight"}
    if not reader.fieldnames or not required.issubset(set(reader.fieldnames)):
        raise HazardFeedError(502, "firms_invalid_schema", "FIRMS response did not contain the expected CSV columns")
    out: list[dict[str, Any]] = []
    skipped = 0
    truncated = False
    modis = source == "MODIS_NRT"
    for row in reader:
        lat, lon = _num(row.get("latitude")), _num(row.get("longitude"))
        acquired = _acq_iso(row.get("acq_date", ""), row.get("acq_time", ""))
        if lat is None or lon is None or acquired is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
            skipped += 1
            continue
        if not (w <= lon <= e and s <= lat <= n):
            continue
        if len(out) >= MAX_DETECTIONS:
            truncated = True
            break
        raw_conf = (row.get("confidence") or "").strip()
        if modis:
            conf_value = _num(raw_conf)
            confidence = f"{int(conf_value)}%" if conf_value is not None and 0 <= conf_value <= 100 else "unknown"
        else:
            confidence = _VIIRS_CONF.get(raw_conf.lower(), "unknown")
        frp = _num(row.get("frp"))
        sat_code = (row.get("satellite") or "").strip()
        day_night = (row.get("daynight") or "").strip().upper()
        out.append({
            "lat": round(lat, 5), "lon": round(lon, 5), "acquiredAt": acquired,
            "confidence": confidence,
            "frpMw": round(frp, 2) if frp is not None and frp >= 0 else None,
            "satellite": _SAT.get(sat_code.upper(), _SAT.get(sat_code, sat_code[:16] or "unknown")),
            "instrument": "MODIS" if modis else "VIIRS",
            "dayNight": "day" if day_night == "D" else "night" if day_night == "N" else "unknown",
            "version": (row.get("version") or "")[:16],
        })
    return out, truncated, skipped


def fetch_firms(query: dict[str, list[str]], headers: Any) -> dict[str, Any]:
    authorize_request(headers)
    source, bbox, days = validate_firms_query(query)
    key = _map_key()
    bbox_text = ",".join(f"{v:g}" for v in bbox)
    if key:
        mode = "map_key_area_api"
        url = f"https://{FIRMS_HOST}/api/area/csv/{quote(key, safe='')}/{source}/{bbox_text}/{days}"
        public_url = f"https://{FIRMS_HOST}/api/area/csv/[MAP_KEY]/{source}/{bbox_text}/{days}"
        region = None
    else:
        region = _region_for(bbox)
        if days > 2 or region is None:
            reason = "days>2" if days > 2 else "bbox is not inside a single FIRMS public region"
            raise HazardFeedError(
                503, "firms_not_configured",
                f"UCAS_NASA_FIRMS_MAP_KEY is not configured and the keyless public-file fallback cannot serve this request ({reason})",
            )
        mode = "keyless_public_file"
        window = "24h" if days == 1 else "48h"
        url = f"https://{FIRMS_HOST}/data/active_fire/{_PUBLIC_FILE_PREFIX[source]}_{region}_{window}.csv"
        public_url = url

    def build() -> dict[str, Any]:
        body = _get(url, FIRMS_MAX_BYTES, "text/csv, text/plain")
        text = body.decode("utf-8", errors="replace")
        if text.strip().lower().startswith("invalid map_key"):
            raise HazardFeedError(502, "firms_key_rejected", "FIRMS rejected the configured MAP_KEY")
        if not text.lstrip().lower().startswith("latitude"):
            raise HazardFeedError(502, "firms_invalid_schema", "FIRMS returned a non-CSV response")
        detections, truncated, skipped = parse_firms_csv(text, bbox, source)
        return {
            "provider": "nasa-firms", "mode": mode, "keyStatus": "configured" if key else "not_configured",
            "source": source, "bbox": list(bbox), "days": days, "region": region,
            "sourceUrl": public_url, "retrievedAt": _now_iso(), "count": len(detections),
            "truncated": truncated, "skippedRows": skipped, "detections": detections,
            "attribution": FIRMS_ATTRIBUTION, "termsUrl": FIRMS_TERMS_URL,
            "disclosure": "Satellite-detected thermal anomalies (hotspots) at pixel centroids; may include non-fire heat sources and miss fires under cloud/canopy. Not confirmed fires or perimeters.",
        }

    return _cached(f"firms|{mode}|{source}|{bbox_text}|{days}", FIRMS_CACHE_SECONDS, build)


# ---------------------------------------------------------------- NHC

def _iso_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) and _ISO.fullmatch(value) else None


def _safe_url(value: Any) -> str | None:
    return value if isinstance(value, str) and _ADVISORY_URL.fullmatch(value) else None


def _round_coords(geometry: Any, depth: int = 0) -> Any:
    if depth > 6:
        raise ValueError("geometry too deep")
    if isinstance(geometry, list):
        if len(geometry) >= 2 and all(isinstance(v, (int, float)) for v in geometry[:2]):
            lon, lat = float(geometry[0]), float(geometry[1])
            if not (-180 <= lon <= 180 and -90 <= lat <= 90):
                raise ValueError("coordinate out of range")
            return [round(lon, 3), round(lat, 3)]
        return [_round_coords(item, depth + 1) for item in geometry[:2000]]
    raise ValueError("invalid geometry")


def _gis_features(layer: int, kind: str) -> list[dict[str, Any]]:
    params = {"where": "1=1", "outFields": "stormname,advisnum,advdate,tau,validtime,maxwind,gust,mslp,stormtype,fldatelbl,datelbl,idp_filedate",
              "returnGeometry": "true", "outSR": "4326", "f": "geojson", "resultRecordCount": "200"}
    if kind != "points":
        params["outFields"] = "stormname,advisnum,advdate,idp_filedate"
        params["maxAllowableOffset"] = "0.02"
        params["geometryPrecision"] = "3"
    url = f"https://{NHC_GIS_HOST}/tropical/rest/services/tropical/NHC_tropical_weather/MapServer/{layer}/query?{urlencode(params)}"
    try:
        doc = json.loads(_get(url, JSON_MAX_BYTES, "application/geo+json, application/json"))
    except ValueError:
        raise HazardFeedError(502, "nhc_gis_invalid", "NHC GIS returned invalid JSON") from None
    features = doc.get("features") if isinstance(doc, dict) else None
    if not isinstance(features, list):
        raise HazardFeedError(502, "nhc_gis_invalid", "NHC GIS returned an unexpected schema")
    out = []
    for feature in features[:200]:
        if not isinstance(feature, dict) or not isinstance(feature.get("geometry"), dict):
            continue
        geometry = feature["geometry"]
        props = feature.get("properties") if isinstance(feature.get("properties"), dict) else {}
        try:
            coords = _round_coords(geometry.get("coordinates"))
        except (ValueError, TypeError):
            continue
        keep = {k: props.get(k) for k in ("stormname", "advisnum", "advdate", "tau", "validtime", "maxwind", "gust", "mslp", "stormtype", "fldatelbl", "datelbl", "idp_filedate")
                if isinstance(props.get(k), (str, int, float)) and not isinstance(props.get(k), bool)}
        for k, v in list(keep.items()):
            if isinstance(v, str):
                keep[k] = v[:80]
        out.append({"type": str(geometry.get("type"))[:20], "coordinates": coords, "properties": keep})
    return out


def parse_current_storms(doc: Any) -> list[dict[str, Any]]:
    storms = doc.get("activeStorms") if isinstance(doc, dict) else None
    if not isinstance(storms, list):
        raise HazardFeedError(502, "nhc_invalid_schema", "NHC CurrentStorms.json had an unexpected schema")
    out = []
    for storm in storms[:MAX_STORMS]:
        if not isinstance(storm, dict):
            continue
        sid = storm.get("id") if isinstance(storm.get("id"), str) else ""
        lat, lon = _num(storm.get("latitudeNumeric")), _num(storm.get("longitudeNumeric"))
        updated = _iso_or_none(storm.get("lastUpdate"))
        if not _STORM_ID.fullmatch(sid.lower()) or lat is None or lon is None or updated is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
            continue
        bin_number = storm.get("binNumber") if storm.get("binNumber") in NHC_LAYERS else None
        public = storm.get("publicAdvisory") if isinstance(storm.get("publicAdvisory"), dict) else {}
        graphics = storm.get("forecastGraphics") if isinstance(storm.get("forecastGraphics"), dict) else {}
        out.append({
            "id": sid.lower(), "binNumber": bin_number,
            "name": str(storm.get("name") or "Unnamed")[:40],
            "classification": str(storm.get("classification") or "")[:8],
            "intensityKt": _num(storm.get("intensity")), "pressureMb": _num(storm.get("pressure")),
            "lat": lat, "lon": lon,
            "movementDirDeg": _num(storm.get("movementDir")), "movementSpeedMph": _num(storm.get("movementSpeed")),
            "lastUpdate": updated,
            "advisoryNumber": str(public.get("advNum") or "")[:8] or None,
            "advisoryIssued": _iso_or_none(public.get("issuance")),
            "publicAdvisoryUrl": _safe_url(public.get("url")),
            "graphicsUrl": _safe_url(graphics.get("url")),
            "centralPacific": sid.lower().startswith("cp"),
        })
    return out


def fetch_nhc(query: dict[str, list[str]], headers: Any) -> dict[str, Any]:
    authorize_request(headers)
    if query:
        raise HazardFeedError(400, "invalid_nhc_query", "the NHC route takes no query parameters")

    def build() -> dict[str, Any]:
        try:
            doc = json.loads(_get(f"https://{NHC_HOST}/CurrentStorms.json", JSON_MAX_BYTES, "application/json"))
        except ValueError:
            raise HazardFeedError(502, "nhc_invalid_json", "NHC returned invalid JSON") from None
        storms = parse_current_storms(doc)
        gis_errors = 0
        for storm in storms:
            storm["forecast"] = {"points": [], "track": [], "cone": []}
            if not storm["binNumber"]:
                continue
            points, track, cone = NHC_LAYERS[storm["binNumber"]]
            for kind, layer in (("points", points), ("track", track), ("cone", cone)):
                try:
                    storm["forecast"][kind] = _gis_features(layer, kind)
                except HazardFeedError:
                    gis_errors += 1
        return {
            "provider": "noaa-nhc", "sourceUrl": f"https://{NHC_HOST}/CurrentStorms.json",
            "gisSourceUrl": f"https://{NHC_GIS_HOST}/tropical/rest/services/tropical/NHC_tropical_weather/MapServer",
            "retrievedAt": _now_iso(), "count": len(storms), "storms": storms, "gisErrors": gis_errors,
            "attribution": NHC_ATTRIBUTION, "termsUrl": NHC_TERMS_URL,
            "disclosure": "Advisory positions and forecast cone/track from NHC/CPHC products. The cone shows probable track of the center only, not the extent of hazards. Use official advisories for decisions.",
        }

    return _cached("nhc", NHC_CACHE_SECONDS, build)


def status(headers: Any) -> dict[str, Any]:
    authorize_request(headers)
    return {
        "enabled": True,
        "firms": {"keyStatus": "configured" if _map_key() else "not_configured",
                  "env": "UCAS_NASA_FIRMS_MAP_KEY",
                  "fallback": "keyless public regional 24h/48h CSV files (bbox inside one region)",
                  "sources": list(FIRMS_SOURCES)},
        "nhc": {"keyStatus": "not_required"},
        "limits": {"maxBboxSpanDeg": MAX_BBOX_SPAN_DEG, "maxDetections": MAX_DETECTIONS,
                   "upstreamBudget": f"{UPSTREAM_BUDGET} per {int(UPSTREAM_WINDOW_SECONDS)}s",
                   "firmsCacheSeconds": FIRMS_CACHE_SECONDS, "nhcCacheSeconds": NHC_CACHE_SECONDS},
    }


ROUTES = {"status": status, "firms": fetch_firms, "nhc": fetch_nhc}


def dispatch(name: str, query: dict[str, list[str]], headers: Any) -> dict[str, Any]:
    handler = ROUTES.get(name)
    if handler is None:
        raise HazardFeedError(404, "not_found", "hazard route was not found")
    if handler is status:
        if query:
            raise HazardFeedError(400, "invalid_query", "status takes no query parameters")
        return status(headers)
    return handler(query, headers)
