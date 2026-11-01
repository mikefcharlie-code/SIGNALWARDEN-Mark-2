"""Opt-in, read-only WorldView weather / air-quality / aviation enrichment relay.

Disabled unless ``UCAS_WORLDVIEW_WEATHER_ENABLED=1``.  Every route is a bounded
GET to a fixed HTTPS host allowlist.  Provider credentials are read from
environment variables on the server only and are never echoed in responses,
source URLs, errors or logs:

* ``UCAS_OPEN_METEO_API_KEY``   optional Open-Meteo commercial customer key
* ``UCAS_OPENAQ_API_KEY``       required for OpenAQ v3 station measurements
* ``UCAS_OPENSKY_CLIENT_ID`` / ``UCAS_OPENSKY_CLIENT_SECRET``
                                optional OpenSky OAuth2 client credentials

Identity minimisation follows the existing adsb.lol adapter policy: aircraft
are keyed only by the opaque ICAO 24-bit hex supplied by the source; callsign,
squawk, origin country, registration, owner/operator and photos are removed
here, before anything reaches the browser.  There is no write, command or
control path.
"""
from __future__ import annotations

import json
import math
import os
import re
import threading
import time
from datetime import date, datetime, timezone
from email.message import Message
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

MAX_BYTES = 1_000_000
TIMEOUT_SECONDS = 10.0
HEADER = "X-SignalWarden-Weather"
USER_AGENT = "SignalWarden-WorldView/0.1 (read-only weather/aviation context)"

ALLOWED_HOSTS = frozenset({
    "api.open-meteo.com",
    "customer-api.open-meteo.com",
    "air-quality-api.open-meteo.com",
    "customer-air-quality-api.open-meteo.com",
    "api.openaq.org",
    "opensky-network.org",
    "auth.opensky-network.org",
    "api.adsbdb.com",
})

FORECAST_VARIABLES = (
    "temperature_2m", "wind_speed_10m", "wind_direction_10m", "wind_speed_80m", "wind_direction_80m",
    "wind_speed_120m", "wind_direction_120m", "wind_gusts_10m", "cloud_cover", "precipitation",
)
AIR_QUALITY_VARIABLES = ("pm2_5", "pm10", "ozone", "nitrogen_dioxide", "us_aqi")
# Open-Meteo model id -> static metadata path giving the model-run time.
MODELS = {
    "gfs_seamless": "ncep_gfs025",
    "ecmwf_ifs025": "ecmwf_ifs025",
    "icon_seamless": "dwd_icon",
}
FORECAST_HOURS = 48
OPENAQ_RADIUS_M = 25_000  # OpenAQ v3 maximum radius
OPENAQ_MAX_LOCATIONS = 3
OPENAQ_PARAMETERS = frozenset({"pm25", "pm10", "o3", "no2", "so2", "co"})
OPENSKY_MAX_SPAN_DEG = 5.0  # 5 x 5 = 25 sq deg -> 1 API credit per request
OPENSKY_MAX_STATES = 500
ADSBDB_CACHE_SECONDS = 24 * 3600
ADSBDB_CACHE_MAX = 256
TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token"

ATTRIBUTION = {
    "open-meteo": "Weather data by Open-Meteo.com (CC BY 4.0)",
    "gfs_seamless": "NOAA Global Forecast System (GFS) via Open-Meteo; NOAA does not endorse this product",
    "ecmwf_ifs025": (
        "© ECMWF. Source: www.ecmwf.int. ECMWF IFS open data, CC BY 4.0, served and re-gridded by Open-Meteo "
        "(modified: point-sampled and unit-converted). ECMWF does not accept any liability whatsoever for any error "
        "or omission in the data, their availability, or for any loss or damage arising from their use."
    ),
    "icon_seamless": "Deutscher Wetterdienst (DWD) ICON via Open-Meteo, CC BY 4.0",
    "open-meteo-aq": "Air quality: CAMS / Copernicus Atmosphere Monitoring Service via Open-Meteo.com (CC BY 4.0); modelled, not measured",
    "openaq": "OpenAQ (openaq.org); per-station licence and attribution listed with each measurement",
    "opensky": "The OpenSky Network, https://opensky-network.org",
    "adsbdb": "Aircraft type from adsbdb.com",
}
TERMS = {
    "open-meteo": "https://open-meteo.com/en/terms",
    "open-meteo-licence": "https://open-meteo.com/en/licence",
    "ecmwf": "https://apps.ecmwf.int/datasets/licences/general/",
    "openaq": "https://docs.openaq.org/about/terms",
    "opensky": "https://opensky-network.org/about/terms-of-use",
    "adsbdb": "https://www.adsbdb.com/",
}


class WeatherRelayError(Exception):
    def __init__(self, status: int, code: str, message: str, retry_after: int | None = None):
        super().__init__(message)
        self.status, self.code, self.message, self.retry_after = status, code, message, retry_after


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req: Request, fp: Any, code: int, msg: str, headers: Message, newurl: str) -> None:
        return None


def _default_opener() -> Any:
    return build_opener(ProxyHandler({}), _NoRedirect())


# Tests replace this factory; production never follows redirects or env proxies.
opener_factory: Callable[[], Any] = _default_opener
clock: Callable[[], float] = time.monotonic

_lock = threading.Lock()
_slots = threading.BoundedSemaphore(4)
_last_upstream: dict[str, float] = {}
_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_token: dict[str, Any] = {}


def reset_state() -> None:
    with _lock:
        _last_upstream.clear(); _cache.clear(); _token.clear()


def _env(name: str) -> str:
    return (os.getenv(name) or "").strip()


def enabled() -> bool:
    return _env("UCAS_WORLDVIEW_WEATHER_ENABLED").lower() in {"1", "true", "yes"}


def _iso(ts: float | None = None) -> str:
    moment = datetime.now(timezone.utc) if ts is None else datetime.fromtimestamp(ts, timezone.utc)
    return moment.isoformat().replace("+00:00", "Z")


def _opensky_mode() -> str:
    return "oauth" if _env("UCAS_OPENSKY_CLIENT_ID") and _env("UCAS_OPENSKY_CLIENT_SECRET") else "anonymous"


def status() -> dict[str, Any]:
    """Configuration state only; never key material or key length."""
    return {
        "enabled": enabled(),
        "readOnly": True,
        "providers": {
            "openMeteo": {"status": "configured" if _env("UCAS_OPEN_METEO_API_KEY") else "keyless",
                           "tier": "commercial" if _env("UCAS_OPEN_METEO_API_KEY") else "free_non_commercial"},
            "openMeteoAirQuality": {"status": "configured" if _env("UCAS_OPEN_METEO_API_KEY") else "keyless"},
            "openAq": {"status": "configured" if _env("UCAS_OPENAQ_API_KEY") else "not_configured"},
            "openSky": {"status": "configured" if _opensky_mode() == "oauth" else "keyless", "mode": _opensky_mode()},
            "adsbdb": {"status": "keyless", "fields": ["type", "icaoType", "manufacturer"]},
        },
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
        raise WeatherRelayError(404, "weather_relay_disabled", "WorldView weather/aviation relay is disabled")
    if headers.get(HEADER) != "enabled":
        raise WeatherRelayError(403, "weather_header_required", f"{HEADER}: enabled is required")
    if not _same_origin(headers):
        raise WeatherRelayError(403, "origin_not_allowed", "cross-site relay requests are not allowed")


# ---------------------------------------------------------------- transport

def _fetch_json(url: str, *, headers: dict[str, str] | None = None, data: bytes | None = None,
                provider: str = "provider") -> Any:
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS or parsed.port not in (None, 443) \
            or parsed.username or parsed.password:
        raise WeatherRelayError(500, "host_not_allowlisted", "upstream host is not allowlisted")
    request = Request(url, data=data, method="POST" if data is not None else "GET",
                      headers={"Accept": "application/json", "User-Agent": USER_AGENT, **(headers or {})})
    if not _slots.acquire(blocking=False):
        raise WeatherRelayError(503, "relay_busy", "relay concurrency limit reached")
    try:
        try:
            response = opener_factory().open(request, timeout=TIMEOUT_SECONDS)
        except HTTPError as exc:
            try:
                if exc.code == 429:
                    retry = exc.headers.get("X-Rate-Limit-Retry-After-Seconds") if exc.headers else None
                    raise WeatherRelayError(429, "provider_quota", f"{provider} quota or rate limit reached",
                                            int(retry) if retry and str(retry).isdigit() else None) from None
                if exc.code in (401, 403):
                    raise WeatherRelayError(502, "provider_auth_failed",
                                            f"{provider} rejected the server-side credential or requires one") from None
                if exc.code == 404:
                    raise WeatherRelayError(404, "provider_not_found", f"{provider} has no record") from None
                raise WeatherRelayError(502, "provider_error", f"{provider} returned HTTP {exc.code}") from None
            finally:
                exc.close()
        except (URLError, TimeoutError, OSError):
            # Never include the exception text: it may contain the request URL.
            raise WeatherRelayError(502, "provider_unreachable", f"{provider} could not be reached") from None
        try:
            length = response.headers.get("Content-Length")
            if length is not None and length.isdigit() and int(length) > MAX_BYTES:
                raise WeatherRelayError(502, "provider_too_large", f"{provider} response exceeds 1 MB")
            body = response.read(MAX_BYTES + 1)
            if len(body) > MAX_BYTES:
                raise WeatherRelayError(502, "provider_too_large", f"{provider} response exceeds 1 MB")
        except (URLError, TimeoutError, OSError):
            raise WeatherRelayError(502, "provider_unreachable", f"{provider} could not be read") from None
        finally:
            response.close()
        try:
            return json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError, RecursionError):
            raise WeatherRelayError(502, "provider_invalid_json", f"{provider} returned invalid JSON") from None
    finally:
        _slots.release()


def _cached(key: str, ttl: float) -> dict[str, Any] | None:
    with _lock:
        hit = _cache.get(key)
        if hit and clock() - hit[0] <= ttl:
            return {**hit[1], "cache": "hit"}
    return None


def _store(key: str, value: dict[str, Any]) -> dict[str, Any]:
    with _lock:
        _cache[key] = (clock(), value)
        if len(_cache) > 512:
            for old in sorted(_cache, key=lambda k: _cache[k][0])[:128]:
                _cache.pop(old, None)
    return {**value, "cache": "miss"}


def _throttle(family: str, min_interval: float) -> None:
    with _lock:
        now = clock()
        last = _last_upstream.get(family)
        if last is not None and now - last < min_interval:
            wait = int(math.ceil(min_interval - (now - last)))
            raise WeatherRelayError(429, "relay_throttled", f"{family} refresh throttled; retry in {wait}s", wait)
        _last_upstream[family] = now


# ---------------------------------------------------------------- validation

def _one(query: dict[str, list[str]], name: str) -> str:
    values = query.get(name, [])
    if len(values) != 1:
        raise WeatherRelayError(400, "invalid_query", f"{name} must be supplied exactly once")
    return values[0]


def _only(query: dict[str, list[str]], allowed: set[str]) -> None:
    if set(query) - allowed:
        raise WeatherRelayError(400, "invalid_query", "unexpected query parameter")


def _coord(value: str, low: float, high: float, name: str) -> float:
    try:
        number = float(value)
    except ValueError:
        raise WeatherRelayError(400, "invalid_coordinate", f"{name} must be a number") from None
    if not math.isfinite(number) or number < low or number > high:
        raise WeatherRelayError(400, "invalid_coordinate", f"{name} is out of range")
    return round(number, 4)


def _point(query: dict[str, list[str]]) -> tuple[float, float]:
    return _coord(_one(query, "lat"), -90, 90, "lat"), _coord(_one(query, "lon"), -180, 180, "lon")


def _num(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


# ---------------------------------------------------------------- Open-Meteo

def _model_run(model: str) -> str | None:
    meta = MODELS.get(model)
    if not meta:
        return None
    try:
        body = _fetch_json(f"https://api.open-meteo.com/data/{meta}/static/meta.json", provider="Open-Meteo metadata")
    except WeatherRelayError:
        return None
    init = _num(body.get("last_run_initialisation_time")) if isinstance(body, dict) else None
    return _iso(init) if init else None


def _trim_hourly(body: Any, variables: tuple[str, ...]) -> dict[str, Any]:
    if not isinstance(body, dict) or not isinstance(body.get("hourly"), dict):
        raise WeatherRelayError(502, "provider_invalid_schema", "Open-Meteo response has no hourly block")
    hourly = body["hourly"]
    times = hourly.get("time")
    if not isinstance(times, list) or not times or not all(isinstance(t, str) and len(t) <= 32 for t in times):
        raise WeatherRelayError(502, "provider_invalid_schema", "Open-Meteo response has no valid times")
    times = times[:FORECAST_HOURS]
    out: dict[str, Any] = {"time": times}
    for name in variables:
        series = hourly.get(name)
        if isinstance(series, list):
            out[name] = [_num(v) for v in series[: len(times)]]
    units = body.get("hourly_units") if isinstance(body.get("hourly_units"), dict) else {}
    return {
        "latitude": _num(body.get("latitude")), "longitude": _num(body.get("longitude")),
        "elevation": _num(body.get("elevation")),
        "hourly_units": {k: str(v)[:16] for k, v in units.items() if k in out},
        "hourly": out,
    }


def open_meteo(kind: str, query: dict[str, list[str]]) -> dict[str, Any]:
    allowed = {"lat", "lon", "model"} if kind == "forecast" else {"lat", "lon"}
    _only(query, allowed)
    lat, lon = _point(query)
    model = _one(query, "model") if kind == "forecast" else "cams"
    if kind == "forecast" and model not in MODELS:
        raise WeatherRelayError(400, "invalid_model", "model must be one of " + ", ".join(sorted(MODELS)))
    key = _env("UCAS_OPEN_METEO_API_KEY")
    cache_key = f"om:{kind}:{lat:.2f}:{lon:.2f}:{model}:{bool(key)}"
    hit = _cached(cache_key, 600)
    if hit:
        return hit
    _throttle(f"open-meteo-{kind}", 2.0)
    if kind == "forecast":
        host = "customer-api.open-meteo.com" if key else "api.open-meteo.com"
        params = {"latitude": lat, "longitude": lon, "hourly": ",".join(FORECAST_VARIABLES), "models": model,
                  "forecast_hours": FORECAST_HOURS, "wind_speed_unit": "ms", "timezone": "GMT"}
        path, variables, attribution = "/v1/forecast", FORECAST_VARIABLES, ATTRIBUTION[model]
    else:
        host = "customer-air-quality-api.open-meteo.com" if key else "air-quality-api.open-meteo.com"
        params = {"latitude": lat, "longitude": lon, "hourly": ",".join(AIR_QUALITY_VARIABLES),
                  "forecast_hours": FORECAST_HOURS, "timezone": "GMT"}
        path, variables, attribution = "/v1/air-quality", AIR_QUALITY_VARIABLES, ATTRIBUTION["open-meteo-aq"]
    public_url = f"https://{host}{path}?{urlencode(params)}"
    upstream = public_url + ("&" + urlencode({"apikey": key}) if key else "")
    body = _fetch_json(upstream, provider="Open-Meteo")
    result = {
        "provider": "open-meteo", "kind": kind, "model": model,
        "tier": "commercial" if key else "free_non_commercial",
        "sourceUrl": public_url,  # never contains the API key
        "retrievedAt": _iso(),
        "modelRun": _model_run(model) if kind == "forecast" else None,
        "attribution": f"{ATTRIBUTION['open-meteo']}; {attribution}",
        "termsUrl": TERMS["open-meteo"], "licenseUrl": TERMS["open-meteo-licence"],
        "dataKind": "model_forecast",
        "data": _trim_hourly(body, variables),
    }
    return _store(cache_key, result)


# ---------------------------------------------------------------- OpenAQ

def _openaq_location(loc: Any) -> dict[str, Any] | None:
    if not isinstance(loc, dict) or not isinstance(loc.get("id"), int) or isinstance(loc.get("id"), bool):
        return None
    coords = loc.get("coordinates") if isinstance(loc.get("coordinates"), dict) else {}
    lat, lon = _num(coords.get("latitude")), _num(coords.get("longitude"))
    if lat is None or lon is None or abs(lat) > 90 or abs(lon) > 180:
        return None
    sensors: dict[int, tuple[str, str]] = {}
    for sensor in loc.get("sensors") or []:
        if isinstance(sensor, dict) and isinstance(sensor.get("id"), int) and isinstance(sensor.get("parameter"), dict):
            name = sensor["parameter"].get("name")
            if name in OPENAQ_PARAMETERS:
                sensors[sensor["id"]] = (name, str(sensor["parameter"].get("units") or "")[:16])
    monitor = loc.get("isMonitor") is True
    licenses = []
    for lic in (loc.get("licenses") or [])[:3]:
        if isinstance(lic, dict) and isinstance(lic.get("id"), int) and not isinstance(lic.get("id"), bool):
            attribution = lic.get("attribution") if isinstance(lic.get("attribution"), dict) else {}
            licenses.append({"id": lic["id"], "name": str(lic.get("name") or "")[:80],
                             "attribution": str(attribution.get("name") or "")[:120],
                             "attributionUrl": str(attribution.get("url") or "")[:200] if str(attribution.get("url") or "").startswith("https://") else "",
                             "dateFrom": str(lic.get("dateFrom") or "")[:10], "dateTo": str(lic.get("dateTo") or "")[:10]})
    provider = loc.get("provider") if isinstance(loc.get("provider"), dict) else {}
    return {
        "locationId": loc["id"],
        # Low-cost/community sensor names can identify a household; label generically.
        "label": str(loc.get("name") or "Reference monitor")[:80] if monitor else "Low-cost / community sensor",
        "isMonitor": monitor, "isMobile": loc.get("isMobile") is True,
        "dataProvider": str(provider.get("name") or "")[:80],
        "lat": lat, "lon": lon, "distanceM": _num(loc.get("distance")),
        "licenses": licenses, "_sensors": sensors,
        "sourceUrl": f"https://explore.openaq.org/locations/{loc['id']}",
    }


def _openaq_license(license_id: int, auth: dict[str, str]) -> dict[str, Any] | None:
    """Return complete, explicit rights metadata; unknown terms are not display permission."""
    key = f"openaq-license:{license_id}"
    hit = _cached(key, 24 * 3600)
    if hit:
        rows = hit.get("results")
    else:
        body = _fetch_json(f"https://api.openaq.org/v3/licenses/{license_id}", headers=auth, provider="OpenAQ license")
        rows = body.get("results") if isinstance(body, dict) else None
        if isinstance(rows, list):
            _store(key, {"results": rows[:1]})
    lic = next((item for item in rows or [] if isinstance(item, dict) and item.get("id") == license_id), None)
    if not isinstance(lic, dict):
        return None
    source_url = lic.get("sourceUrl")
    if not isinstance(source_url, str) or not source_url.startswith("https://") or len(source_url) > 500:
        return None
    rights = ("commercialUseAllowed", "attributionRequired", "shareAlikeRequired", "modificationAllowed", "redistributionAllowed")
    if any(type(lic.get(field)) is not bool for field in rights):
        return None
    return {
        "id": license_id, "name": str(lic.get("name") or "")[:80], "sourceUrl": source_url,
        "commercialUseAllowed": lic.get("commercialUseAllowed") is True,
        "attributionRequired": lic.get("attributionRequired") is True,
        "shareAlikeRequired": lic.get("shareAlikeRequired") is True,
        "modificationAllowed": lic.get("modificationAllowed") is True,
        "redistributionAllowed": lic.get("redistributionAllowed") is True,
    }


def _license_covers(lic: dict[str, Any], when: str) -> bool:
    try:
        observed = date.fromisoformat(when[:10])
        start = date.fromisoformat(lic["dateFrom"])
        end = date.fromisoformat(lic["dateTo"]) if lic.get("dateTo") else None
        return start <= observed and (end is None or observed <= end)
    except (TypeError, ValueError, KeyError):
        return False


def openaq_latest(query: dict[str, list[str]]) -> dict[str, Any]:
    _only(query, {"lat", "lon"})
    lat, lon = _point(query)
    key = _env("UCAS_OPENAQ_API_KEY")
    if not key:
        raise WeatherRelayError(503, "not_configured",
                                "OpenAQ is not configured; set UCAS_OPENAQ_API_KEY on the API server (free key from explore.openaq.org)")
    cache_key = f"openaq:{lat:.2f}:{lon:.2f}"
    hit = _cached(cache_key, 300)
    if hit:
        return hit
    _throttle("openaq", 10.0)
    auth = {"X-API-Key": key}
    params = {"coordinates": f"{lat},{lon}", "radius": OPENAQ_RADIUS_M, "limit": 10}
    body = _fetch_json(f"https://api.openaq.org/v3/locations?{urlencode(params)}", headers=auth, provider="OpenAQ")
    results = body.get("results") if isinstance(body, dict) else None
    if not isinstance(results, list):
        raise WeatherRelayError(502, "provider_invalid_schema", "OpenAQ locations response has no results")
    locations = [loc for loc in map(_openaq_location, results[:10]) if loc and loc["_sensors"] and loc["licenses"]]
    locations.sort(key=lambda loc: loc["distanceM"] if loc["distanceM"] is not None else 1e12)
    stations = []
    for loc in locations:
        if len(stations) >= OPENAQ_MAX_LOCATIONS:
            break
        eligible = []
        for source_license in loc["licenses"]:
            try:
                details = _openaq_license(source_license["id"], auth)
            except WeatherRelayError:
                details = None
            if not details or not (details["commercialUseAllowed"] and details["redistributionAllowed"]
                                   and details["modificationAllowed"] and not details["shareAlikeRequired"]):
                continue
            attribution = source_license.get("attribution") or ""
            if details["attributionRequired"] and not attribution:
                continue
            eligible.append({**details, "attribution": attribution, "attributionUrl": source_license.get("attributionUrl") or "",
                             "dateFrom": source_license["dateFrom"], "dateTo": source_license["dateTo"]})
        if not eligible:
            continue
        latest = _fetch_json(f"https://api.openaq.org/v3/locations/{loc['locationId']}/latest", headers=auth, provider="OpenAQ")
        rows = latest.get("results") if isinstance(latest, dict) else None
        measurements = []
        for row in rows if isinstance(rows, list) else []:
            if not isinstance(row, dict) or row.get("sensorsId") not in loc["_sensors"]:
                continue
            value = _num(row.get("value"))
            when = row.get("datetime", {}).get("utc") if isinstance(row.get("datetime"), dict) else None
            if value is None or not isinstance(when, str) or len(when) > 40:
                continue
            license_for_time = next((lic for lic in eligible if _license_covers(lic, when)), None)
            if not license_for_time:
                continue
            parameter, units = loc["_sensors"][row["sensorsId"]]
            measurements.append({"parameter": parameter, "units": units, "value": value, "datetimeUtc": when,
                                 "licenseId": license_for_time["id"]})
        if not measurements:
            continue
        station = {k: v for k, v in loc.items() if k != "_sensors"}
        station["measurements"] = measurements[:12]
        used_ids = {m["licenseId"] for m in station["measurements"]}
        station["licenses"] = [lic for lic in eligible if lic["id"] in used_ids]
        stations.append(station)
    result = {
        "provider": "openaq", "dataKind": "measured", "retrievedAt": _iso(),
        "sourceUrl": f"https://api.openaq.org/v3/locations?{urlencode(params)}",
        "attribution": ATTRIBUTION["openaq"], "termsUrl": TERMS["openaq"], "stations": stations,
    }
    return _store(cache_key, result)


# ---------------------------------------------------------------- OpenSky

def _opensky_token() -> str | None:
    client_id, secret = _env("UCAS_OPENSKY_CLIENT_ID"), _env("UCAS_OPENSKY_CLIENT_SECRET")
    if not (client_id and secret):
        return None
    with _lock:
        if _token.get("value") and clock() < _token.get("expires", 0):
            return str(_token["value"])
    data = urlencode({"grant_type": "client_credentials", "client_id": client_id, "client_secret": secret}).encode()
    body = _fetch_json(TOKEN_URL, data=data, headers={"Content-Type": "application/x-www-form-urlencoded"},
                       provider="OpenSky auth")
    token = body.get("access_token") if isinstance(body, dict) else None
    if not isinstance(token, str) or not token or len(token) > 8192:
        raise WeatherRelayError(502, "provider_auth_failed", "OpenSky auth returned no access token")
    expires_in = _num(body.get("expires_in")) or 1800
    with _lock:
        _token.update(value=token, expires=clock() + max(60.0, expires_in - 60))
    return token


def _opensky_state(row: Any, now: float) -> dict[str, Any] | None:
    if not isinstance(row, list) or len(row) < 17:
        return None
    icao24 = row[0]
    if not isinstance(icao24, str) or not re.fullmatch(r"[0-9a-fA-F]{6}", icao24):
        return None
    lon, lat = _num(row[5]), _num(row[6])
    if lat is None or lon is None or abs(lat) > 90 or abs(lon) > 180:
        return None
    time_position, last_contact = _num(row[3]), _num(row[4])
    if time_position is None or time_position > now + 5:
        return None
    alt = _num(row[7])
    return {
        "icao24": icao24.lower(),  # opaque transponder hex, as with adsb.lol
        "lat": lat, "lon": lon,
        "baroAltitudeM": alt if alt is not None and -600 <= alt <= 30_000 else None,
        "geoAltitudeM": _num(row[13]),
        "onGround": row[8] is True,
        "velocityMs": _num(row[9]), "trueTrackDeg": _num(row[10]), "verticalRateMs": _num(row[11]),
        "timePosition": int(time_position),
        "lastContact": int(last_contact) if last_contact is not None else None,
        "positionSource": row[16] if isinstance(row[16], int) and not isinstance(row[16], bool) else None,
        # Intentionally removed: callsign (1), origin_country (2), sensors (12), squawk (14), spi (15).
    }


def opensky_states(query: dict[str, list[str]]) -> dict[str, Any]:
    _only(query, {"lamin", "lomin", "lamax", "lomax"})
    lamin, lamax = _coord(_one(query, "lamin"), -90, 90, "lamin"), _coord(_one(query, "lamax"), -90, 90, "lamax")
    lomin, lomax = _coord(_one(query, "lomin"), -180, 180, "lomin"), _coord(_one(query, "lomax"), -180, 180, "lomax")
    if lamin >= lamax or lomin >= lomax:
        raise WeatherRelayError(400, "invalid_bbox", "bbox minimums must be below maximums (antimeridian crossing unsupported)")
    if lamax - lamin > OPENSKY_MAX_SPAN_DEG or lomax - lomin > OPENSKY_MAX_SPAN_DEG:
        raise WeatherRelayError(400, "bbox_too_large", "bbox spans must be <= 5 degrees (one OpenSky credit)")
    mode = _opensky_mode()
    interval = 15.0 if mode == "oauth" else 60.0
    params = {"lamin": lamin, "lomin": lomin, "lamax": lamax, "lomax": lomax}
    cache_key = f"opensky:{mode}:{lamin:.2f}:{lomin:.2f}:{lamax:.2f}:{lomax:.2f}"
    hit = _cached(cache_key, interval)
    if hit:
        return hit
    _throttle("opensky", interval)
    token = _opensky_token()
    url = f"https://opensky-network.org/api/states/all?{urlencode(params)}"
    body = _fetch_json(url, headers={"Authorization": f"Bearer {token}"} if token else None, provider="OpenSky")
    if not isinstance(body, dict) or not isinstance(body.get("time"), int):
        raise WeatherRelayError(502, "provider_invalid_schema", "OpenSky response has no time")
    now = time.time()
    if body["time"] > now + 30:
        raise WeatherRelayError(502, "provider_invalid_time", "OpenSky timestamp is in the future")
    raw = body.get("states") or []
    if not isinstance(raw, list):
        raise WeatherRelayError(502, "provider_invalid_schema", "OpenSky states is not a list")
    states = {}
    for row in raw[:OPENSKY_MAX_STATES]:
        state = _opensky_state(row, now)
        if state:
            states[state["icao24"]] = state
    result = {
        "provider": "opensky", "mode": mode, "dataKind": "crowdsourced_ads_b", "retrievedAt": _iso(),
        "providerTime": _iso(body["time"]), "sourceUrl": url,
        "attribution": ATTRIBUTION["opensky"], "termsUrl": TERMS["opensky"],
        "states": list(states.values()), "truncated": len(raw) > OPENSKY_MAX_STATES,
    }
    return _store(cache_key, result)


# ---------------------------------------------------------------- adsbdb

def adsbdb_type(query: dict[str, list[str]]) -> dict[str, Any]:
    _only(query, {"icao24"})
    icao24 = _one(query, "icao24").lower()
    if not re.fullmatch(r"[0-9a-f]{6}", icao24):
        raise WeatherRelayError(400, "invalid_icao24", "icao24 must be a 6-digit hex transponder address")
    cache_key = f"adsbdb:{icao24}"
    hit = _cached(cache_key, ADSBDB_CACHE_SECONDS)
    if hit:
        return hit
    _throttle("adsbdb", 2.0)
    url = f"https://api.adsbdb.com/v0/aircraft/{icao24}"
    base = {"provider": "adsbdb", "icao24": icao24, "retrievedAt": _iso(), "sourceUrl": url,
            "attribution": ATTRIBUTION["adsbdb"], "termsUrl": TERMS["adsbdb"],
            "policy": "Aircraft type only; registration, owner/operator, country and photos are discarded server-side"}
    try:
        body = _fetch_json(url, provider="adsbdb")
    except WeatherRelayError as error:
        if error.code != "provider_not_found":
            raise
        return _store(cache_key, {**base, "found": False})
    aircraft = body.get("response", {}).get("aircraft") if isinstance(body, dict) and isinstance(body.get("response"), dict) else None
    if not isinstance(aircraft, dict):
        return _store(cache_key, {**base, "found": False})
    clean = lambda v, n: str(v)[:n] if isinstance(v, str) else None  # noqa: E731
    result = {**base, "found": True, "type": clean(aircraft.get("type"), 80),
              "icaoType": clean(aircraft.get("icao_type"), 8), "manufacturer": clean(aircraft.get("manufacturer"), 80)}
    with _lock:
        adsbdb_keys = [k for k in _cache if k.startswith("adsbdb:")]
        if len(adsbdb_keys) >= ADSBDB_CACHE_MAX:
            _cache.pop(min(adsbdb_keys, key=lambda k: _cache[k][0]), None)
    return _store(cache_key, result)


ROUTES: dict[tuple[str, ...], Callable[[dict[str, list[str]]], dict[str, Any]]] = {
    ("open-meteo", "forecast"): lambda q: open_meteo("forecast", q),
    ("open-meteo", "air-quality"): lambda q: open_meteo("air-quality", q),
    ("openaq", "latest"): openaq_latest,
    ("opensky", "states"): opensky_states,
    ("adsbdb", "aircraft"): adsbdb_type,
}


def handle(suffix: list[str], query: dict[str, list[str]], headers: Any) -> dict[str, Any]:
    """Entry point for GET /api/v1/worldview-weather/<suffix>."""
    authorize(headers)
    if suffix == ["status"]:
        _only(query, set())
        return status()
    route = ROUTES.get(tuple(suffix))
    if route is None:
        raise WeatherRelayError(404, "not_found", "weather relay route was not found")
    return route(query)
