"""Gridded wind / air-quality map fields for the WorldView weather relay.

Registers extra read-only GET routes on the existing, disabled-by-default
``/api/v1/worldview-weather`` relay (``UCAS_WORLDVIEW_WEATHER_ENABLED=1``) and
reuses all of its guards: same-origin + ``X-SignalWarden-Weather: enabled``
header, fixed HTTPS host allowlist, no redirects, no env proxies, 1 MB response
cap, 4-way concurrency limit, per-family throttles and a bounded cache.

* ``open-meteo/wind-grid``  Open-Meteo forecast at a server-built grid of at most
  100 points (10 m / 80 m / 120 m / 850 / 500 / 250 hPa wind, 10 m gusts, MSL
  pressure).  Uses ``UCAS_OPEN_METEO_API_KEY`` (customer host) when set.
* ``open-meteo/air-grid``   Open-Meteo Air Quality (CAMS, modelled) at the same
  kind of grid.
* ``openaq/bbox``           OpenAQ v3 measured stations inside a bounding box;
  ``not_configured`` unless ``UCAS_OPENAQ_API_KEY`` is set.

The browser never chooses arbitrary sample points: it sends a bbox and a grid
shape, and the server derives the (rounded) cell centres itself.  Keys are only
ever added to the upstream URL and are never echoed in ``sourceUrl``.
"""
from __future__ import annotations

from typing import Any
from urllib.parse import urlencode

import worldview_weather as ww

MAX_GRID_POINTS = 100
MAX_GRID_SIDE = 10
GRID_HOURS = 24
GRID_CACHE_SECONDS = 900
GRID_MIN_INTERVAL = 30.0
OPENAQ_BBOX_MAX_STATIONS = 8
OPENAQ_BBOX_MAX_SPAN = 4.0  # degrees; keeps station counts and per-station reads bounded

WIND_GRID_VARIABLES = (
    "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m",
    "wind_speed_80m", "wind_direction_80m", "wind_speed_120m", "wind_direction_120m",
    "wind_speed_850hPa", "wind_direction_850hPa", "wind_speed_500hPa", "wind_direction_500hPa",
    "wind_speed_250hPa", "wind_direction_250hPa", "pressure_msl",
)
AIR_GRID_VARIABLES = ("pm2_5", "pm10", "ozone", "nitrogen_dioxide", "us_aqi", "dust", "aerosol_optical_depth")


def _wrap(lon: float) -> float:
    return ((lon + 180.0) % 360.0) - 180.0


def parse_bbox(value: str, *, max_lat_span: float = 180.0, max_lon_span: float = 360.0) -> tuple[float, float, float, float]:
    """``west,south,east,north``; east may exceed 180 (antimeridian unwrapped, east - west <= 360)."""
    parts = value.split(",")
    if len(parts) != 4:
        raise ww.WeatherRelayError(400, "invalid_bbox", "bbox must be west,south,east,north")
    west = ww._coord(parts[0], -180, 180, "west")
    south = ww._coord(parts[1], -90, 90, "south")
    east = ww._coord(parts[2], -180, 540, "east")
    north = ww._coord(parts[3], -90, 90, "north")
    if south >= north or west >= east or east - west > 360:
        raise ww.WeatherRelayError(400, "invalid_bbox", "bbox must have south < north and west < east (east may be unwrapped past 180)")
    if north - south > max_lat_span or east - west > max_lon_span:
        raise ww.WeatherRelayError(400, "bbox_too_large", f"bbox spans must be <= {max_lat_span:g} x {max_lon_span:g} degrees")
    return west, south, east, north


def parse_shape(value: str) -> tuple[int, int]:
    parts = value.split("x")
    if len(parts) != 2 or not all(p.isdigit() and len(p) <= 2 for p in parts):
        raise ww.WeatherRelayError(400, "invalid_grid", "grid must be ROWSxCOLS, e.g. 8x10")
    rows, cols = int(parts[0]), int(parts[1])
    if not (2 <= rows <= MAX_GRID_SIDE and 2 <= cols <= MAX_GRID_SIDE) or rows * cols > MAX_GRID_POINTS:
        raise ww.WeatherRelayError(400, "invalid_grid", f"grid sides must be 2-{MAX_GRID_SIDE} and at most {MAX_GRID_POINTS} points")
    return rows, cols


def grid_points(bbox: tuple[float, float, float, float], rows: int, cols: int) -> list[tuple[float, float]]:
    """Cell centres, row-major from south to north, west to east; 2-decimal rounding (same as the client)."""
    west, south, east, north = bbox
    points = []
    for i in range(rows):
        lat = round(south + (i + 0.5) * (north - south) / rows, 2)
        for j in range(cols):
            lon = round(_wrap(west + (j + 0.5) * (east - west) / cols), 2)
            points.append((lat, lon))
    return points


def _trim_locations(body: Any, variables: tuple[str, ...], count: int) -> list[dict[str, Any]]:
    rows = body if isinstance(body, list) else [body]
    if len(rows) != count:
        raise ww.WeatherRelayError(502, "provider_invalid_schema", "Open-Meteo returned a different number of locations")
    out = []
    for row in rows:
        trimmed = ww._trim_hourly(row, variables)
        trimmed["hourly"]["time"] = trimmed["hourly"]["time"][:GRID_HOURS]
        for name in variables:
            if name in trimmed["hourly"]:
                trimmed["hourly"][name] = trimmed["hourly"][name][:GRID_HOURS]
        out.append(trimmed)
    return out


def open_meteo_grid(kind: str, query: dict[str, list[str]]) -> dict[str, Any]:
    wind = kind == "wind"
    ww._only(query, {"bbox", "grid", "model"} if wind else {"bbox", "grid"})
    bbox = parse_bbox(ww._one(query, "bbox"))
    rows, cols = parse_shape(ww._one(query, "grid"))
    model = ww._one(query, "model") if wind else "cams"
    if wind and model not in ww.MODELS:
        raise ww.WeatherRelayError(400, "invalid_model", "model must be one of " + ", ".join(sorted(ww.MODELS)))
    points = grid_points(bbox, rows, cols)
    key = ww._env("UCAS_OPEN_METEO_API_KEY")
    cache_key = f"omgrid:{kind}:{model}:{bool(key)}:{rows}x{cols}:" + ";".join(f"{a},{b}" for a, b in points)
    hit = ww._cached(cache_key, GRID_CACHE_SECONDS)
    if hit:
        return hit
    ww._throttle(f"open-meteo-{kind}-grid", GRID_MIN_INTERVAL)
    lats = ",".join(f"{a:.2f}" for a, _ in points)
    lons = ",".join(f"{b:.2f}" for _, b in points)
    if wind:
        host = "customer-api.open-meteo.com" if key else "api.open-meteo.com"
        params = {"latitude": lats, "longitude": lons, "hourly": ",".join(WIND_GRID_VARIABLES), "models": model,
                  "forecast_hours": GRID_HOURS, "wind_speed_unit": "ms", "timezone": "GMT"}
        path, variables = "/v1/forecast", WIND_GRID_VARIABLES
        attribution = f"{ww.ATTRIBUTION['open-meteo']}; {ww.ATTRIBUTION[model]}"
    else:
        host = "customer-air-quality-api.open-meteo.com" if key else "air-quality-api.open-meteo.com"
        params = {"latitude": lats, "longitude": lons, "hourly": ",".join(AIR_GRID_VARIABLES),
                  "forecast_hours": GRID_HOURS, "timezone": "GMT"}
        path, variables = "/v1/air-quality", AIR_GRID_VARIABLES
        attribution = ww.ATTRIBUTION["open-meteo-aq"]
    public_url = f"https://{host}{path}?{urlencode(params)}"
    upstream = public_url + ("&" + urlencode({"apikey": key}) if key else "")
    body = ww._fetch_json(upstream, provider="Open-Meteo")
    result = {
        "provider": "open-meteo" if wind else "open-meteo-aq", "kind": f"{kind}-grid", "model": model,
        "tier": "commercial" if key else "free_non_commercial",
        "sourceUrl": public_url,  # never contains the API key
        "retrievedAt": ww._iso(),
        "modelRun": ww._model_run(model) if wind else None,
        "attribution": attribution, "termsUrl": ww.TERMS["open-meteo"], "licenseUrl": ww.TERMS["open-meteo-licence"],
        "dataKind": "model_forecast" if wind else "modelled_air_quality",
        "grid": {"rows": rows, "cols": cols, "bbox": list(bbox), "points": [[a, b] for a, b in points]},
        "locations": _trim_locations(body, variables, len(points)),
    }
    return ww._store(cache_key, result)


def openaq_bbox(query: dict[str, list[str]]) -> dict[str, Any]:
    ww._only(query, {"bbox"})
    west, south, east, north = parse_bbox(ww._one(query, "bbox"), max_lat_span=OPENAQ_BBOX_MAX_SPAN, max_lon_span=OPENAQ_BBOX_MAX_SPAN)
    if east > 180:
        raise ww.WeatherRelayError(400, "invalid_bbox", "OpenAQ bbox cannot cross the antimeridian")
    key = ww._env("UCAS_OPENAQ_API_KEY")
    if not key:
        raise ww.WeatherRelayError(503, "not_configured",
                                   "OpenAQ is not configured; set UCAS_OPENAQ_API_KEY on the API server (free key from explore.openaq.org)")
    bbox = f"{west:.4f},{south:.4f},{east:.4f},{north:.4f}"
    cache_key = f"openaq-bbox:{west:.2f}:{south:.2f}:{east:.2f}:{north:.2f}"
    hit = ww._cached(cache_key, 300)
    if hit:
        return hit
    ww._throttle("openaq-bbox", 30.0)
    auth = {"X-API-Key": key}
    params = {"bbox": bbox, "limit": 50}
    body = ww._fetch_json(f"https://api.openaq.org/v3/locations?{urlencode(params)}", headers=auth, provider="OpenAQ")
    results = body.get("results") if isinstance(body, dict) else None
    if not isinstance(results, list):
        raise ww.WeatherRelayError(502, "provider_invalid_schema", "OpenAQ locations response has no results")
    locations = [loc for loc in map(ww._openaq_location, results[:50]) if loc and loc["_sensors"]
                 and south <= loc["lat"] <= north and west <= loc["lon"] <= east]
    # Reference monitors first, then low-cost sensors; bounded per-station reads.
    locations.sort(key=lambda loc: (not loc["isMonitor"], loc["locationId"]))
    stations = []
    for loc in locations[:OPENAQ_BBOX_MAX_STATIONS]:
        latest = ww._fetch_json(f"https://api.openaq.org/v3/locations/{loc['locationId']}/latest", headers=auth, provider="OpenAQ")
        rows = latest.get("results") if isinstance(latest, dict) else None
        measurements = []
        for row in rows if isinstance(rows, list) else []:
            if not isinstance(row, dict) or row.get("sensorsId") not in loc["_sensors"]:
                continue
            value = ww._num(row.get("value"))
            when = row.get("datetime", {}).get("utc") if isinstance(row.get("datetime"), dict) else None
            if value is None or not isinstance(when, str) or len(when) > 40:
                continue
            parameter, units = loc["_sensors"][row["sensorsId"]]
            measurements.append({"parameter": parameter, "units": units, "value": value, "datetimeUtc": when})
        station = {k: v for k, v in loc.items() if k not in {"_sensors", "distanceM"}}
        station["measurements"] = measurements[:12]
        stations.append(station)
    result = {
        "provider": "openaq", "dataKind": "measured", "retrievedAt": ww._iso(),
        "sourceUrl": f"https://api.openaq.org/v3/locations?{urlencode(params)}",
        "attribution": ww.ATTRIBUTION["openaq"], "termsUrl": ww.TERMS["openaq"], "stations": stations,
        "truncated": len(locations) > OPENAQ_BBOX_MAX_STATIONS,
    }
    return ww._store(cache_key, result)


ROUTES = {
    ("open-meteo", "wind-grid"): lambda q: open_meteo_grid("wind", q),
    ("open-meteo", "air-grid"): lambda q: open_meteo_grid("air", q),
    ("openaq", "bbox"): openaq_bbox,
}


def register(module: Any = ww) -> None:
    """Attach the grid routes to the weather relay's route table (idempotent)."""
    module.ROUTES.update(ROUTES)


register()
