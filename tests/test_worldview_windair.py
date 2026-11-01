import io
import json
import os
import sys
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "management-api"))
import worldview_weather as ww  # noqa: E402
import worldview_windair as wa  # noqa: E402

ENV_KEYS = ("UCAS_WORLDVIEW_WEATHER_ENABLED", "UCAS_OPEN_METEO_API_KEY", "UCAS_OPENAQ_API_KEY")
HEADERS = {"X-SignalWarden-Weather": "enabled", "Host": "127.0.0.1:8000", "Origin": "http://127.0.0.1:8000"}


class Headers(dict):
    def get(self, key, default=None):
        for k, v in self.items():
            if k.lower() == key.lower():
                return v
        return default


class Response(io.BytesIO):
    def __init__(self, body):
        data = json.dumps(body).encode()
        super().__init__(data)
        self.headers = Headers({"Content-Length": str(len(data))})


class Opener:
    def __init__(self, routes):
        self.routes, self.requests = routes, []

    def open(self, request, timeout=None):
        self.requests.append(request)
        for needle, reply in self.routes:
            if needle in request.full_url:
                return reply(request) if callable(reply) else reply
        raise AssertionError("unexpected upstream URL " + request.full_url)


def om_location(i, variables, hours=2):
    return {"latitude": 10 + i, "longitude": 20 + i, "elevation": 5.0, **({"location_id": i} if i else {}),
            "hourly_units": {"time": "iso8601", **{v: "m/s" for v in variables}},
            "hourly": {"time": [f"2026-10-31T{21 + h:02d}:00" for h in range(hours)], **{v: [1.5 + i, "bad"][:hours] for v in variables}}}


def grid_reply(variables):
    def reply(request):
        q = parse_qs(urlsplit(request.full_url).query)
        n = len(q["latitude"][0].split(","))
        assert n == len(q["longitude"][0].split(","))
        return Response([om_location(i, variables) for i in range(n)])
    return reply


class WindAirRelayTests(unittest.TestCase):
    def setUp(self):
        self.saved = {k: os.environ.get(k) for k in ENV_KEYS}
        for k in ENV_KEYS:
            os.environ.pop(k, None)
        os.environ["UCAS_WORLDVIEW_WEATHER_ENABLED"] = "1"
        ww.reset_state()
        self.saved_opener, self.saved_clock = ww.opener_factory, ww.clock
        self.t = 1000.0
        ww.clock = lambda: self.t

    def tearDown(self):
        ww.opener_factory, ww.clock = self.saved_opener, self.saved_clock
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        ww.reset_state()

    def use(self, routes):
        opener = Opener(routes)
        ww.opener_factory = lambda: opener
        return opener

    def test_routes_registered_on_weather_relay(self):
        for key in [("open-meteo", "wind-grid"), ("open-meteo", "air-grid"), ("openaq", "bbox")]:
            self.assertIn(key, ww.ROUTES)

    def test_disabled_relay_makes_no_request(self):
        os.environ.pop("UCAS_WORLDVIEW_WEATHER_ENABLED")
        opener = self.use([])
        with self.assertRaises(ww.WeatherRelayError) as ctx:
            ww.handle(["open-meteo", "wind-grid"], {"bbox": ["-80,30,-70,40"], "grid": ["3x3"], "model": ["gfs_seamless"]}, Headers(HEADERS))
        self.assertEqual(ctx.exception.code, "weather_relay_disabled")
        self.assertEqual(opener.requests, [])

    def test_grid_points_are_server_built_rounded_and_antimeridian_safe(self):
        pts = wa.grid_points((170.0, -10.0, 190.0, 10.0), 2, 4)
        self.assertEqual(len(pts), 8)
        self.assertEqual(pts[0], (-5.0, 172.5))
        self.assertEqual(pts[3], (-5.0, -172.5))
        self.assertTrue(all(-180 <= lon <= 180 for _, lon in pts))

    def test_validation(self):
        bad = [
            {"bbox": ["-80,30,-70"], "grid": ["3x3"], "model": ["gfs_seamless"]},
            {"bbox": ["-80,40,-70,30"], "grid": ["3x3"], "model": ["gfs_seamless"]},
            {"bbox": ["-80,30,-70,40"], "grid": ["11x9"], "model": ["gfs_seamless"]},
            {"bbox": ["-80,30,-70,40"], "grid": ["10x11"], "model": ["gfs_seamless"]},
            {"bbox": ["-80,30,-70,40"], "grid": ["1x5"], "model": ["gfs_seamless"]},
            {"bbox": ["-80,30,-70,40"], "grid": ["3x3"], "model": ["evil"]},
            {"bbox": ["-80,30,-70,40"], "grid": ["3x3"], "model": ["gfs_seamless"], "latitude": ["1"]},
            {"bbox": ["nan,30,-70,40"], "grid": ["3x3"], "model": ["gfs_seamless"]},
        ]
        opener = self.use([])
        for q in bad:
            with self.assertRaises(ww.WeatherRelayError):
                ww.handle(["open-meteo", "wind-grid"], q, Headers(HEADERS))
        self.assertEqual(opener.requests, [])

    def test_wind_grid_keyless_shape_cache_and_throttle(self):
        opener = self.use([("/data/ncep_gfs025/static/meta.json", lambda r: Response({"last_run_initialisation_time": 1793476800})),
                           ("api.open-meteo.com/v1/forecast", grid_reply(wa.WIND_GRID_VARIABLES))])
        q = {"bbox": ["-80,30,-70,40"], "grid": ["3x4"], "model": ["gfs_seamless"]}
        body = ww.handle(["open-meteo", "wind-grid"], q, Headers(HEADERS))
        self.assertEqual(body["tier"], "free_non_commercial")
        self.assertEqual(body["grid"]["rows"], 3)
        self.assertEqual(len(body["locations"]), 12)
        self.assertEqual(body["locations"][1]["hourly"]["wind_speed_250hPa"], [2.5, None])
        self.assertEqual(body["modelRun"], "2026-10-31T20:00:00Z")
        self.assertTrue(body["sourceUrl"].startswith("https://api.open-meteo.com/v1/forecast?"))
        upstream = [r.full_url for r in opener.requests if "/v1/forecast" in r.full_url][0]
        qs = parse_qs(urlsplit(upstream).query)
        self.assertEqual(qs["forecast_hours"], ["24"])
        self.assertEqual(qs["wind_speed_unit"], ["ms"])
        self.assertIn("wind_direction_850hPa", qs["hourly"][0])
        self.assertEqual(body["cache"], "miss")
        self.assertEqual(ww.handle(["open-meteo", "wind-grid"], q, Headers(HEADERS))["cache"], "hit")
        other = {"bbox": ["-81,30,-70,40"], "grid": ["3x4"], "model": ["gfs_seamless"]}
        with self.assertRaises(ww.WeatherRelayError) as ctx:
            ww.handle(["open-meteo", "wind-grid"], other, Headers(HEADERS))
        self.assertEqual(ctx.exception.status, 429)
        self.t += 31
        ww.handle(["open-meteo", "wind-grid"], other, Headers(HEADERS))

    def test_wind_grid_commercial_key_never_echoed(self):
        os.environ["UCAS_OPEN_METEO_API_KEY"] = "SECRETKEY123"
        opener = self.use([("/static/meta.json", Response({})), ("customer-api.open-meteo.com/v1/forecast", grid_reply(wa.WIND_GRID_VARIABLES))])
        body = ww.handle(["open-meteo", "wind-grid"], {"bbox": ["-80,30,-70,40"], "grid": ["2x2"], "model": ["ecmwf_ifs025"]}, Headers(HEADERS))
        self.assertEqual(body["tier"], "commercial")
        self.assertNotIn("SECRETKEY123", json.dumps(body))
        self.assertTrue(any("apikey=SECRETKEY123" in r.full_url for r in opener.requests))
        self.assertIn("ECMWF", body["attribution"])

    def test_location_count_mismatch_rejected(self):
        self.use([("air-quality-api.open-meteo.com", Response(om_location(0, wa.AIR_GRID_VARIABLES)))])
        with self.assertRaises(ww.WeatherRelayError) as ctx:
            ww.handle(["open-meteo", "air-grid"], {"bbox": ["-80,30,-70,40"], "grid": ["2x2"]}, Headers(HEADERS))
        self.assertEqual(ctx.exception.code, "provider_invalid_schema")

    def test_air_grid(self):
        self.use([("air-quality-api.open-meteo.com/v1/air-quality", grid_reply(wa.AIR_GRID_VARIABLES))])
        body = ww.handle(["open-meteo", "air-grid"], {"bbox": ["-80,30,-70,40"], "grid": ["2x3"]}, Headers(HEADERS))
        self.assertEqual(body["dataKind"], "modelled_air_quality")
        self.assertIn("modelled", body["attribution"])
        self.assertEqual(len(body["locations"]), 6)
        self.assertIn("aerosol_optical_depth", body["locations"][0]["hourly"])

    def test_openaq_bbox_not_configured_and_bounded(self):
        opener = self.use([])
        with self.assertRaises(ww.WeatherRelayError) as ctx:
            ww.handle(["openaq", "bbox"], {"bbox": ["-77.2,38.8,-76.9,39.0"]}, Headers(HEADERS))
        self.assertEqual(ctx.exception.code, "not_configured")
        self.assertEqual(ctx.exception.status, 503)
        os.environ["UCAS_OPENAQ_API_KEY"] = "OAQKEY"
        with self.assertRaises(ww.WeatherRelayError) as ctx:
            ww.handle(["openaq", "bbox"], {"bbox": ["-80,30,-70,40"]}, Headers(HEADERS))
        self.assertEqual(ctx.exception.code, "bbox_too_large")
        self.assertEqual(opener.requests, [])

    def test_openaq_bbox_measurements(self):
        os.environ["UCAS_OPENAQ_API_KEY"] = "OAQKEY"
        locations = {"results": [
            {"id": 7, "name": "Backyard of someone", "isMonitor": False, "provider": {"name": "PurpleAir"},
             "coordinates": {"latitude": 38.9, "longitude": -77.0}, "sensors": [{"id": 70, "parameter": {"name": "pm25", "units": "µg/m³"}}]},
            {"id": 3, "name": "River Terrace", "isMonitor": True, "provider": {"name": "AirNow"},
             "coordinates": {"latitude": 38.89, "longitude": -76.95}, "sensors": [{"id": 30, "parameter": {"name": "no2", "units": "ppm"}}],
             "licenses": [{"name": "US Public Domain", "attribution": {"name": "EPA", "url": "https://www.epa.gov"}}]},
            {"id": 9, "name": "Outside bbox", "isMonitor": True, "coordinates": {"latitude": 45.0, "longitude": -77.0},
             "sensors": [{"id": 90, "parameter": {"name": "pm25", "units": "µg/m³"}}]},
        ]}
        latest = lambda sid, v: Response({"results": [{"sensorsId": sid, "value": v, "datetime": {"utc": "2026-10-31T20:00:00Z"}}, {"sensorsId": 999, "value": 1}]})  # noqa: E731
        opener = self.use([("/v3/locations?", Response(locations)), ("/v3/locations/3/latest", latest(30, 0.012)), ("/v3/locations/7/latest", latest(70, 8.4))])
        body = ww.handle(["openaq", "bbox"], {"bbox": ["-77.2,38.8,-76.9,39.0"]}, Headers(HEADERS))
        self.assertEqual([s["locationId"] for s in body["stations"]], [3, 7])
        self.assertEqual(body["stations"][1]["label"], "Low-cost / community sensor")
        self.assertEqual(body["stations"][0]["measurements"], [{"parameter": "no2", "units": "ppm", "value": 0.012, "datetimeUtc": "2026-10-31T20:00:00Z"}])
        self.assertNotIn("OAQKEY", json.dumps(body))
        self.assertTrue(all(r.headers.get("X-api-key") == "OAQKEY" for r in opener.requests))
        self.assertNotIn("/v3/locations/9/latest", " ".join(r.full_url for r in opener.requests))


if __name__ == "__main__":
    unittest.main()
