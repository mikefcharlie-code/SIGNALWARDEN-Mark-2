import importlib.util
import io
import json
import os
import sys
import threading
import unittest
from http.client import HTTPConnection
from pathlib import Path
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[1]
MOD = ROOT / "services" / "management-api" / "worldview_weather.py"
spec = importlib.util.spec_from_file_location("worldview_weather_test_module", MOD)
ww = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = ww
spec.loader.exec_module(ww)

ENV_KEYS = ("UCAS_WORLDVIEW_WEATHER_ENABLED", "UCAS_OPEN_METEO_API_KEY", "UCAS_OPENAQ_API_KEY",
            "UCAS_OPENSKY_CLIENT_ID", "UCAS_OPENSKY_CLIENT_SECRET")
HEADERS = {"X-SignalWarden-Weather": "enabled", "Host": "127.0.0.1:8000", "Origin": "http://127.0.0.1:8000"}
NOW = 1793397378  # fixture provider epoch seconds


class Headers(dict):
    def get(self, key, default=None):
        for k, v in self.items():
            if k.lower() == key.lower():
                return v
        return default


class Response(io.BytesIO):
    def __init__(self, body, length=True):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        super().__init__(data)
        self.headers = Headers({"Content-Length": str(len(data))} if length else {})


class Opener:
    """Fake urllib opener: routes by URL substring, records every request."""
    def __init__(self, routes):
        self.routes, self.requests = routes, []

    def open(self, request, timeout=None):
        self.requests.append(request)
        for needle, reply in self.routes:
            if needle in request.full_url:
                if isinstance(reply, Exception):
                    raise reply
                return reply() if callable(reply) else reply
        raise AssertionError("unexpected upstream URL " + request.full_url)


def http_error(url, code, headers=None):
    return HTTPError(url, code, "err", Headers(headers or {}), io.BytesIO(b"{}"))


FORECAST = {"latitude": 38.91, "longitude": -76.99, "elevation": 15.0,
            "hourly_units": {"time": "iso8601", "wind_speed_10m": "m/s", "wind_speed_120m": "m/s"},
            "hourly": {"time": ["2026-10-30T21:00", "2026-10-30T22:00"], "wind_speed_10m": [3.85, 4.34],
                       "wind_speed_120m": [8.49, "bad"], "temperature_2m": [23.0, 20.0], "unexpected": [1, 2]}}
META = {"last_run_initialisation_time": 1793361600}
OPENSKY = {"time": NOW, "states": [
    ["aa2b21", "RPA3583 ", "United States", NOW - 6, NOW - 1, -77.4727, 38.945, 1440.18, False, 112.7, 357.6, -3.9, None, 1516.4, "7147", False, 0],
    ["a33332", "N305PH  ", "United States", NOW - 1, NOW - 1, -77.4645, 38.5768, 205.74, False, 45.39, 336.6, -0.65, None, 251.46, None, False, 0],
    ["zzzzzz", "BAD", "X", NOW, NOW, 0, 0, 0, False, 0, 0, 0, None, 0, None, False, 0],
    ["abc123", "NOPOS", "X", None, NOW, None, None, None, True, 0, 0, 0, None, 0, None, False, 0],
]}
ADSBDB = {"response": {"aircraft": {"type": "ERJ 170-200 LR", "icao_type": "E75L", "manufacturer": "Embraer", "mode_s": "AA2B21",
                                    "registration": "N754YX", "registered_owner": "Republic Airways", "registered_owner_country_name": "United States",
                                    "url_photo": "https://image.airport-data.com/aircraft/1.jpg"}}}
OPENAQ_LOCATIONS = {"meta": {"found": 2}, "results": [
    {"id": 2178, "name": "Del Norte", "isMonitor": True, "isMobile": False, "provider": {"id": 119, "name": "AirNow"},
     "owner": {"id": 4, "name": "Unknown Governmental Organization"},
     "coordinates": {"latitude": 35.1353, "longitude": -106.584702}, "distance": 1200.5,
     "sensors": [{"id": 3920, "parameter": {"name": "pm25", "units": "µg/m³"}}, {"id": 3917, "parameter": {"name": "o3", "units": "ppm"}},
                  {"id": 25227, "parameter": {"name": "co", "units": "ppm"}}, {"id": 99, "parameter": {"name": "bc", "units": "x"}}],
     "licenses": [{"id": 10, "name": "CC BY 4.0", "dateFrom": "2020-01-01", "dateTo": None,
                   "attribution": {"name": "AirNow", "url": "https://www.airnow.gov/"}}]},
    {"id": 555, "name": "Jane Doe backyard", "isMonitor": False, "provider": {"name": "PurpleAir"},
     "coordinates": {"latitude": 35.14, "longitude": -106.58}, "distance": 300.0,
     "sensors": [{"id": 7, "parameter": {"name": "pm25", "units": "µg/m³"}}], "licenses": []},
]}
OPENAQ_LATEST_2178 = {"results": [
    {"datetime": {"utc": "2026-10-30T21:00:00Z"}, "value": 4.4, "sensorsId": 3920, "locationsId": 2178},
    {"datetime": {"utc": "2026-10-30T21:00:00Z"}, "value": 0.031, "sensorsId": 3917, "locationsId": 2178},
    {"datetime": {"utc": "2026-10-30T21:00:00Z"}, "value": 1.0, "sensorsId": 12345, "locationsId": 2178},
]}
OPENAQ_LATEST_555 = {"results": [{"datetime": {"utc": "2026-10-30T20:50:00Z"}, "value": 6.1, "sensorsId": 7, "locationsId": 555}]}
OPENAQ_LICENSE_10 = {"results": [{"id": 10, "name": "CC BY 4.0", "sourceUrl": "https://creativecommons.org/licenses/by/4.0/",
                                   "commercialUseAllowed": True, "attributionRequired": True, "shareAlikeRequired": False,
                                   "modificationAllowed": True, "redistributionAllowed": True}]}


class Base(unittest.TestCase):
    def setUp(self):
        self.saved = {k: os.environ.get(k) for k in ENV_KEYS}
        for k in ENV_KEYS:
            os.environ.pop(k, None)
        os.environ["UCAS_WORLDVIEW_WEATHER_ENABLED"] = "1"
        self.factory, self.clock_value = ww.opener_factory, [1000.0]
        ww.clock = lambda: self.clock_value[0]
        ww.reset_state()

    def tearDown(self):
        ww.opener_factory = self.factory
        ww.clock = __import__("time").monotonic
        ww.reset_state()
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def use(self, routes):
        opener = Opener(routes)
        ww.opener_factory = lambda: opener
        return opener

    def advance(self, seconds):
        self.clock_value[0] += seconds


class GuardTests(Base):
    def test_disabled_header_and_origin_guards_precede_transport(self):
        opener = self.use([])
        os.environ["UCAS_WORLDVIEW_WEATHER_ENABLED"] = "0"
        with self.assertRaises(ww.WeatherRelayError) as ctx:
            ww.handle(["status"], {}, HEADERS)
        self.assertEqual((ctx.exception.status, ctx.exception.code), (404, "weather_relay_disabled"))
        os.environ["UCAS_WORLDVIEW_WEATHER_ENABLED"] = "1"
        with self.assertRaisesRegex(ww.WeatherRelayError, "required"):
            ww.handle(["status"], {}, {"Host": "a"})
        with self.assertRaisesRegex(ww.WeatherRelayError, "cross-site"):
            ww.handle(["status"], {}, {**HEADERS, "Origin": "https://evil.example"})
        with self.assertRaisesRegex(ww.WeatherRelayError, "cross-site"):
            ww.handle(["status"], {}, {**HEADERS, "Sec-Fetch-Site": "cross-site"})
        with self.assertRaisesRegex(ww.WeatherRelayError, "not found"):
            ww.handle(["opensky", "tracks"], {}, HEADERS)
        self.assertEqual(opener.requests, [])

    def test_status_reports_configuration_without_secret_material(self):
        os.environ.update(UCAS_OPEN_METEO_API_KEY="om-secret-123", UCAS_OPENAQ_API_KEY="aq-secret-456",
                          UCAS_OPENSKY_CLIENT_ID="sky-id", UCAS_OPENSKY_CLIENT_SECRET="sky-secret-789")
        body = ww.handle(["status"], {}, HEADERS)
        text = json.dumps(body)
        for secret in ("om-secret-123", "aq-secret-456", "sky-id", "sky-secret-789"):
            self.assertNotIn(secret, text)
        self.assertEqual(body["providers"]["openMeteo"]["tier"], "commercial")
        self.assertEqual(body["providers"]["openAq"]["status"], "configured")
        self.assertEqual(body["providers"]["openSky"]["mode"], "oauth")
        for k in ENV_KEYS[1:]:
            os.environ.pop(k)
        body = ww.handle(["status"], {}, HEADERS)
        self.assertEqual(body["providers"]["openAq"]["status"], "not_configured")
        self.assertEqual(body["providers"]["openSky"]["mode"], "anonymous")

    def test_host_allowlist_and_query_validation(self):
        with self.assertRaisesRegex(ww.WeatherRelayError, "allowlisted"):
            ww._fetch_json("https://evil.example/x")
        with self.assertRaisesRegex(ww.WeatherRelayError, "allowlisted"):
            ww._fetch_json("http://api.open-meteo.com/v1/forecast")
        for query in ({"lat": ["91"], "lon": ["0"], "model": ["gfs_seamless"]}, {"lat": ["nan"], "lon": ["0"], "model": ["gfs_seamless"]},
                      {"lat": ["1"], "lon": ["0"], "model": ["evil"]}, {"lat": ["1"], "lon": ["0"], "model": ["gfs_seamless"], "url": ["x"]},
                      {"lat": ["1", "2"], "lon": ["0"], "model": ["gfs_seamless"]}):
            with self.subTest(query=query), self.assertRaises(ww.WeatherRelayError) as ctx:
                ww.handle(["open-meteo", "forecast"], query, HEADERS)
            self.assertEqual(ctx.exception.status, 400)
        self.assertIsNone(ww._NoRedirect().redirect_request(None, None, 302, "", {}, "https://evil.example"))


class OpenMeteoTests(Base):
    def test_free_tier_forecast_is_trimmed_attributed_and_cached(self):
        opener = self.use([("static/meta.json", lambda: Response(META)), ("/v1/forecast", lambda: Response(FORECAST))])
        body = ww.handle(["open-meteo", "forecast"], {"lat": ["38.912345"], "lon": ["-77"], "model": ["ecmwf_ifs025"]}, HEADERS)
        url = opener.requests[0].full_url
        self.assertTrue(url.startswith("https://api.open-meteo.com/v1/forecast?latitude=38.9123&"))
        for part in ("models=ecmwf_ifs025", "forecast_hours=48", "wind_speed_80m", "wind_direction_120m", "wind_gusts_10m", "cloud_cover", "precipitation"):
            self.assertIn(part, url)
        self.assertNotIn("apikey", url)
        self.assertIn("meta.json", opener.requests[1].full_url)
        self.assertEqual(body["tier"], "free_non_commercial")
        self.assertEqual(body["modelRun"], "2026-10-30T12:00:00Z")
        self.assertIn("ECMWF", body["attribution"]); self.assertIn("CC BY 4.0", body["attribution"]); self.assertIn("liability", body["attribution"])
        self.assertNotIn("unexpected", body["data"]["hourly"])
        self.assertEqual(body["data"]["hourly"]["wind_speed_120m"], [8.49, None])
        self.assertEqual(body["dataKind"], "model_forecast")
        again = ww.handle(["open-meteo", "forecast"], {"lat": ["38.912345"], "lon": ["-77"], "model": ["ecmwf_ifs025"]}, HEADERS)
        self.assertEqual(again["cache"], "hit"); self.assertEqual(len(opener.requests), 2)

    def test_commercial_key_is_upstream_only_never_in_response_or_errors(self):
        os.environ["UCAS_OPEN_METEO_API_KEY"] = "om-secret-123"
        opener = self.use([("static/meta.json", lambda: Response(META)), ("/v1/forecast", lambda: Response(FORECAST)),
                           ("/v1/air-quality", http_error("https://customer-air-quality-api.open-meteo.com/v1/air-quality?apikey=om-secret-123", 400))])
        body = ww.handle(["open-meteo", "forecast"], {"lat": ["38.9"], "lon": ["-77"], "model": ["gfs_seamless"]}, HEADERS)
        self.assertTrue(opener.requests[0].full_url.startswith("https://customer-api.open-meteo.com/"))
        self.assertIn("apikey=om-secret-123", opener.requests[0].full_url)
        self.assertNotIn("om-secret-123", json.dumps(body))
        self.assertEqual(body["tier"], "commercial")
        self.assertIn("NOAA Global Forecast System", body["attribution"])
        with self.assertRaises(ww.WeatherRelayError) as ctx:
            ww.handle(["open-meteo", "air-quality"], {"lat": ["38.9"], "lon": ["-77"]}, HEADERS)
        self.assertNotIn("om-secret-123", ctx.exception.message)
        self.assertNotIn("apikey", ctx.exception.message)

    def test_throttle_quota_and_size_limits(self):
        self.use([("static/meta.json", lambda: Response(META)), ("/v1/forecast", lambda: Response(FORECAST))])
        ww.handle(["open-meteo", "forecast"], {"lat": ["1"], "lon": ["1"], "model": ["gfs_seamless"]}, HEADERS)
        with self.assertRaises(ww.WeatherRelayError) as ctx:
            ww.handle(["open-meteo", "forecast"], {"lat": ["2"], "lon": ["2"], "model": ["gfs_seamless"]}, HEADERS)
        self.assertEqual((ctx.exception.status, ctx.exception.code), (429, "relay_throttled"))
        self.advance(3)
        self.use([("/v1/forecast", http_error("https://api.open-meteo.com/v1/forecast", 429))])
        with self.assertRaises(ww.WeatherRelayError) as ctx:
            ww.handle(["open-meteo", "forecast"], {"lat": ["3"], "lon": ["3"], "model": ["gfs_seamless"]}, HEADERS)
        self.assertEqual(ctx.exception.code, "provider_quota")
        self.advance(3)
        self.use([("/v1/air-quality", lambda: Response(b"{" + b" " * (ww.MAX_BYTES + 10) + b"}", length=False))])
        with self.assertRaisesRegex(ww.WeatherRelayError, "exceeds 1 MB"):
            ww.handle(["open-meteo", "air-quality"], {"lat": ["3"], "lon": ["3"]}, HEADERS)


class OpenAqTests(Base):
    def test_not_configured_without_key_makes_no_request(self):
        opener = self.use([])
        with self.assertRaises(ww.WeatherRelayError) as ctx:
            ww.handle(["openaq", "latest"], {"lat": ["35.1"], "lon": ["-106.6"]}, HEADERS)
        self.assertEqual((ctx.exception.status, ctx.exception.code), (503, "not_configured"))
        self.assertIn("UCAS_OPENAQ_API_KEY", ctx.exception.message)
        self.assertEqual(opener.requests, [])

    def test_measurements_joined_measured_label_and_household_names_hidden(self):
        os.environ["UCAS_OPENAQ_API_KEY"] = "aq-secret-456"
        opener = self.use([("/v3/locations?", lambda: Response(OPENAQ_LOCATIONS)), ("/v3/licenses/10", lambda: Response(OPENAQ_LICENSE_10)),
                           ("/v3/locations/2178/latest", lambda: Response(OPENAQ_LATEST_2178))])
        body = ww.handle(["openaq", "latest"], {"lat": ["35.1"], "lon": ["-106.6"]}, HEADERS)
        self.assertEqual(opener.requests[0].get_header("X-api-key"), "aq-secret-456")
        self.assertIn("radius=25000", opener.requests[0].full_url)
        self.assertIn("/v3/licenses/10", opener.requests[1].full_url)
        self.assertNotIn("aq-secret-456", json.dumps(body))
        self.assertEqual(body["dataKind"], "measured")
        self.assertEqual(len(body["stations"]), 1)  # unlicensed community location is omitted
        station = body["stations"][0]
        self.assertEqual(station["locationId"], 2178)
        self.assertEqual(station["label"], "Del Norte")
        self.assertNotIn("Jane Doe", json.dumps(body))
        self.assertEqual({m["parameter"] for m in station["measurements"]}, {"pm25", "o3"})
        self.assertNotIn("owner", station)
        self.assertEqual(station["licenses"][0]["name"], "CC BY 4.0")
        self.assertTrue(station["licenses"][0]["commercialUseAllowed"])
        self.assertEqual(station["licenses"][0]["attribution"], "AirNow")
        self.assertEqual(station["licenses"][0]["sourceUrl"], "https://creativecommons.org/licenses/by/4.0/")
        self.assertEqual(station["sourceUrl"], "https://explore.openaq.org/locations/2178")

    def test_noncommercial_license_is_default_denied(self):
        os.environ["UCAS_OPENAQ_API_KEY"] = "aq-secret-456"
        denied = {"results": [{**OPENAQ_LICENSE_10["results"][0], "commercialUseAllowed": False}]}
        opener = self.use([("/v3/locations?", lambda: Response(OPENAQ_LOCATIONS)), ("/v3/licenses/10", lambda: Response(denied))])
        body = ww.handle(["openaq", "latest"], {"lat": ["35.1"], "lon": ["-106.6"]}, HEADERS)
        self.assertEqual(body["stations"], [])
        self.assertEqual(len(opener.requests), 2)  # no measurement fetch for rejected rights

    def test_observation_outside_license_dates_is_omitted(self):
        os.environ["UCAS_OPENAQ_API_KEY"] = "aq-secret-456"
        locations = {"results": [{**OPENAQ_LOCATIONS["results"][0], "licenses": [
            {"id": 10, "name": "CC BY 4.0", "dateFrom": "2026-10-31", "dateTo": "2026-10-31",
             "attribution": {"name": "AirNow"}}]}]}
        opener = self.use([("/v3/locations?", lambda: Response(locations)), ("/v3/licenses/10", lambda: Response(OPENAQ_LICENSE_10)),
                           ("/v3/locations/2178/latest", lambda: Response(OPENAQ_LATEST_2178))])
        body = ww.handle(["openaq", "latest"], {"lat": ["35.1"], "lon": ["-106.6"]}, HEADERS)
        self.assertEqual(body["stations"], [])
        self.assertEqual(len(opener.requests), 3)

    def test_rejected_key_is_reported_without_echo(self):
        os.environ["UCAS_OPENAQ_API_KEY"] = "aq-secret-456"
        self.use([("/v3/locations?", http_error("https://api.openaq.org/v3/locations", 401))])
        with self.assertRaises(ww.WeatherRelayError) as ctx:
            ww.handle(["openaq", "latest"], {"lat": ["35.1"], "lon": ["-106.6"]}, HEADERS)
        self.assertEqual(ctx.exception.code, "provider_auth_failed")
        self.assertNotIn("aq-secret", ctx.exception.message)


class OpenSkyTests(Base):
    BOX = {"lamin": ["38.5"], "lomin": ["-77.5"], "lamax": ["39.2"], "lomax": ["-76.7"]}

    def test_anonymous_states_strip_identity_fields(self):
        opener = self.use([("/api/states/all", lambda: Response(OPENSKY))])
        body = ww.handle(["opensky", "states"], self.BOX, HEADERS)
        self.assertIsNone(opener.requests[0].get_header("Authorization"))
        self.assertEqual(body["mode"], "anonymous")
        self.assertEqual([s["icao24"] for s in body["states"]], ["aa2b21", "a33332"])
        text = json.dumps(body)
        for forbidden in ("RPA3583", "N305PH", "United States", "7147", "callsign", "squawk", "origin"):
            self.assertNotIn(forbidden, text)
        self.assertEqual(body["attribution"], "The OpenSky Network, https://opensky-network.org")
        self.assertEqual(body["providerTime"][:4], "2026")
        with self.assertRaises(ww.WeatherRelayError) as ctx:  # 60 s anonymous throttle (cache key differs)
            ww.handle(["opensky", "states"], {**self.BOX, "lamax": ["39.0"]}, HEADERS)
        self.assertEqual(ctx.exception.code, "relay_throttled")

    def test_bbox_bounds(self):
        for box in ({**self.BOX, "lamax": ["44.0"]}, {**self.BOX, "lomin": ["-76"]}, {**self.BOX, "extended": ["1"]}):
            with self.subTest(box=box), self.assertRaises(ww.WeatherRelayError) as ctx:
                ww.handle(["opensky", "states"], box, HEADERS)
            self.assertEqual(ctx.exception.status, 400)

    def test_oauth_client_credentials_token_cached_and_secret_hidden(self):
        os.environ.update(UCAS_OPENSKY_CLIENT_ID="sky-id", UCAS_OPENSKY_CLIENT_SECRET="sky-secret-789")
        opener = self.use([("openid-connect/token", lambda: Response({"access_token": "tok-abc", "expires_in": 1800})),
                           ("/api/states/all", lambda: Response(OPENSKY))])
        body = ww.handle(["opensky", "states"], self.BOX, HEADERS)
        token_request, states_request = opener.requests
        self.assertEqual(token_request.get_method(), "POST")
        self.assertIn(b"grant_type=client_credentials", token_request.data)
        self.assertEqual(states_request.get_header("Authorization"), "Bearer tok-abc")
        self.assertEqual(body["mode"], "oauth")
        self.assertNotIn("sky-secret", json.dumps(body)); self.assertNotIn("tok-abc", json.dumps(body))
        self.advance(16)
        ww.handle(["opensky", "states"], {**self.BOX, "lamax": ["39.0"]}, HEADERS)
        self.assertEqual(sum("token" in r.full_url for r in opener.requests), 1)

    def test_future_timestamp_rejected(self):
        self.use([("/api/states/all", lambda: Response({"time": 4102444800, "states": []}))])
        with self.assertRaisesRegex(ww.WeatherRelayError, "future"):
            ww.handle(["opensky", "states"], self.BOX, HEADERS)


class AdsbdbTests(Base):
    def test_type_only_and_negative_cache(self):
        opener = self.use([("/v0/aircraft/aa2b21", lambda: Response(ADSBDB)), ("/v0/aircraft/a0b1c2", http_error("https://api.adsbdb.com/v0/aircraft/a0b1c2", 404))])
        body = ww.handle(["adsbdb", "aircraft"], {"icao24": ["AA2B21"]}, HEADERS)
        self.assertEqual((body["type"], body["icaoType"], body["manufacturer"], body["found"]), ("ERJ 170-200 LR", "E75L", "Embraer", True))
        text = json.dumps(body)
        for forbidden in ("N754YX", "Republic", "airport-data", "United States", "registration\":", "owner\":"):
            self.assertNotIn(forbidden, text)
        self.advance(3)
        missing = ww.handle(["adsbdb", "aircraft"], {"icao24": ["a0b1c2"]}, HEADERS)
        self.assertFalse(missing["found"])
        self.assertEqual(ww.handle(["adsbdb", "aircraft"], {"icao24": ["a0b1c2"]}, HEADERS)["cache"], "hit")
        self.assertEqual(len(opener.requests), 2)
        for bad in ("zzzzzz", "a0b1c2d", "../x"):
            with self.subTest(bad=bad), self.assertRaises(ww.WeatherRelayError):
                ww.handle(["adsbdb", "aircraft"], {"icao24": [bad]}, HEADERS)


class RouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app_path = ROOT / "services/management-api/app.py"
        sys.path.insert(0, str(app_path.parent))
        spec = importlib.util.spec_from_file_location("weather_route_app", app_path)
        cls.app = importlib.util.module_from_spec(spec); sys.modules[spec.name] = cls.app; spec.loader.exec_module(cls.app)
        cls.app.STORE = cls.app.InMemoryStore(); cls.server = cls.app.create_server("127.0.0.1", 0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True); cls.thread.start(); cls.port = cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join(timeout=2)

    def request(self, path, headers=None, method="GET"):
        conn = HTTPConnection("127.0.0.1", self.port, timeout=3); conn.request(method, path, headers=headers or {})
        response = conn.getresponse(); body = response.read(); conn.close(); return response.status, json.loads(body)

    def test_disabled_then_enabled_status_route(self):
        old = os.environ.pop("UCAS_WORLDVIEW_WEATHER_ENABLED", None)
        try:
            status, body = self.request("/api/v1/worldview-weather/status")
            self.assertEqual((status, body["error"]["code"]), (404, "weather_relay_disabled"))
            os.environ["UCAS_WORLDVIEW_WEATHER_ENABLED"] = "1"
            status, body = self.request("/api/v1/worldview-weather/status", {"X-SignalWarden-Weather": "enabled", "Host": f"127.0.0.1:{self.port}"})
            self.assertEqual(status, 200); self.assertTrue(body["readOnly"])
            status, body = self.request("/api/v1/worldview-weather/status", {"X-SignalWarden-Weather": "enabled", "Host": f"127.0.0.1:{self.port}", "Origin": "https://foreign.example"})
            self.assertEqual((status, body["error"]["code"]), (403, "origin_not_allowed"))
            status, _ = self.request("/api/v1/worldview-weather/status", {"X-SignalWarden-Weather": "enabled"}, method="POST")
            self.assertNotEqual(status, 200)
        finally:
            os.environ.pop("UCAS_WORLDVIEW_WEATHER_ENABLED", None)
            if old is not None:
                os.environ["UCAS_WORLDVIEW_WEATHER_ENABLED"] = old


if __name__ == "__main__":
    unittest.main()
