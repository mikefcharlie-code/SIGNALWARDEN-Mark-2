import importlib.util
import io
import json
import os
import sys
import threading
import unittest
from datetime import datetime, timezone
from http.client import HTTPConnection
from pathlib import Path
from urllib.error import HTTPError, URLError

ROOT = Path(__file__).resolve().parents[1]
MOD = ROOT / "services" / "management-api" / "ocean_relay.py"
spec = importlib.util.spec_from_file_location("ocean_relay_test_module", MOD)
oc = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = oc
spec.loader.exec_module(oc)

HEADERS = {"X-SignalWarden-Ocean": "enabled", "Host": "127.0.0.1:8000", "Origin": "http://127.0.0.1:8000"}
NOW = datetime(2026, 10, 31, 21, 15, tzinfo=timezone.utc).timestamp()
BOX = {"west": ["-80"], "south": ["30"], "east": ["-60"], "north": ["45"]}

# Hand-written excerpt in the live latest_obs.txt layout (22 whitespace columns, MM = missing).
LATEST = """#STN       LAT      LON  YYYY MM DD hh mm WDIR WSPD   GST WVHT  DPD APD MWD   PRES  PTDY  ATMP  WTMP  DEWP  VIS   TIDE
#text      deg      deg   yr mo day hr mn degT  m/s   m/s   m   sec sec degT   hPa   hPa  degC  degC  degC  nmi     ft
44008    40.500  -69.254 2026 10 31 20 40 330   6.0   8.0   MM   MM  MM  MM 1028.1    MM  10.4  16.3   4.1   MM     MM
44097    40.966  -71.123 2026 10 31 20 30  MM    MM    MM  0.7   9   4 144     MM    MM  11.1  15.2    MM   MM     MM
SHIP1    39.000  -70.000 2026 10 31 20 00  10   5.0    MM   MM   MM  MM  MM     MM    MM    MM    MM    MM   MM     MM
41001    34.700  -72.700 2026 10 31 23 50  10   5.0    MM   MM   MM  MM  MM     MM    MM    MM    MM    MM   MM     MM
22101    37.24   126.02  2026 10 31 20 00 350   5.0    MM  0.0   0   MM  MM     MM    MM  13.6  19.2    MM   MM     MM
BADROW   1 2 3
99999    95.000  -70.000 2026 10 31 20 00  10   5.0    MM   MM   MM  MM  MM     MM    MM    MM    MM    MM   MM     MM
"""
STATIONS = """<?xml version="1.0" encoding="utf-8"?><stations created="2026-10-31T21:05:03UTC" count="3">
  <station id="44008" lat="40.496" lon="-69.236" elev="0" name="NANTUCKET 54 NM Southeast of Nantucket" owner="NDBC" pgm="NDBC Meteorological/Ocean" type="buoy" met="y" currents="n" waterquality="n" dart="n"/>
  <station id="44097" lat="40.967" lon="-71.126" name="Block Island, RI  (154)" owner="SCRIPPS" pgm="IOOS Partners" type="buoy" met="n" currents="n" waterquality="n" dart="n"/>
  <station id="bad id" name="x"/>
</stations>"""


class Headers(dict):
    def get(self, key, default=None):
        for k, v in self.items():
            if k.lower() == key.lower():
                return v
        return default


class Response(io.BytesIO):
    def __init__(self, body, headers=None):
        data = body.encode("latin-1") if isinstance(body, str) else body
        super().__init__(data)
        self.headers = Headers({"Content-Length": str(len(data)), **(headers or {})})


class Opener:
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


class Base(unittest.TestCase):
    def setUp(self):
        self.saved = os.environ.get("UCAS_WORLDVIEW_OCEAN_ENABLED")
        os.environ["UCAS_WORLDVIEW_OCEAN_ENABLED"] = "1"
        self.factory, self.clock_value = oc.opener_factory, [1000.0]
        oc.clock = lambda: self.clock_value[0]
        oc.wall = lambda: NOW
        oc.reset_state()

    def tearDown(self):
        oc.opener_factory = self.factory
        oc.clock = __import__("time").monotonic
        oc.wall = __import__("time").time
        oc.reset_state()
        if self.saved is None:
            os.environ.pop("UCAS_WORLDVIEW_OCEAN_ENABLED", None)
        else:
            os.environ["UCAS_WORLDVIEW_OCEAN_ENABLED"] = self.saved

    def use(self, routes):
        opener = Opener(routes)
        oc.opener_factory = lambda: opener
        return opener

    def standard(self):
        return self.use([
            ("latest_obs.txt", lambda: Response(LATEST, {"Last-Modified": "Sat, 31 Oct 2026 21:05:55 GMT"})),
            ("activestations.xml", lambda: Response(STATIONS)),
        ])


class GuardTests(Base):
    def test_disabled_header_and_origin_guards_precede_transport(self):
        opener = self.use([])
        os.environ["UCAS_WORLDVIEW_OCEAN_ENABLED"] = "0"
        with self.assertRaises(oc.OceanRelayError) as ctx:
            oc.handle(["status"], {}, HEADERS)
        self.assertEqual((ctx.exception.status, ctx.exception.code), (404, "ocean_relay_disabled"))
        os.environ["UCAS_WORLDVIEW_OCEAN_ENABLED"] = "1"
        with self.assertRaisesRegex(oc.OceanRelayError, "required"):
            oc.handle(["status"], {}, {"Host": "a"})
        with self.assertRaisesRegex(oc.OceanRelayError, "cross-site"):
            oc.handle(["status"], {}, {**HEADERS, "Origin": "https://evil.example"})
        with self.assertRaisesRegex(oc.OceanRelayError, "cross-site"):
            oc.handle(["status"], {}, {**HEADERS, "Sec-Fetch-Site": "cross-site"})
        with self.assertRaisesRegex(oc.OceanRelayError, "not found"):
            oc.handle(["ndbc", "history"], BOX, HEADERS)
        self.assertEqual(opener.requests, [])

    def test_status_is_keyless_and_read_only(self):
        body = oc.handle(["status"], {}, HEADERS)
        self.assertTrue(body["enabled"]); self.assertTrue(body["readOnly"]); self.assertTrue(body["notForNavigation"])
        self.assertEqual(body["providers"]["ndbc"]["status"], "keyless")
        with self.assertRaises(oc.OceanRelayError):
            oc.handle(["status"], {"x": ["1"]}, HEADERS)

    def test_bbox_validation(self):
        opener = self.use([])
        for bad in ({**BOX, "west": ["-200"]}, {**BOX, "east": ["-90"]}, {**BOX, "west": ["-150"]}, {**BOX, "north": ["nan"]},
                    {**BOX, "extra": ["1"]}, {k: v for k, v in BOX.items() if k != "south"}, {**BOX, "west": ["-80", "-79"]}):
            with self.subTest(bad=bad), self.assertRaises(oc.OceanRelayError) as ctx:
                oc.handle(["ndbc", "latest"], bad, HEADERS)
            self.assertEqual(ctx.exception.status, 400)
        self.assertEqual(opener.requests, [])

    def test_host_allowlist(self):
        with self.assertRaisesRegex(oc.OceanRelayError, "allowlisted"):
            oc._fetch_text("https://evil.example/latest_obs.txt", "x")
        with self.assertRaisesRegex(oc.OceanRelayError, "allowlisted"):
            oc._fetch_text("http://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt", "x")


class NdbcTests(Base):
    def test_parses_filters_names_and_labels_provenance(self):
        opener = self.standard()
        body = oc.handle(["ndbc", "latest"], BOX, HEADERS)
        self.assertEqual(body["provider"], "noaa-ndbc")
        self.assertEqual(body["sourceUrl"], "https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt")
        self.assertEqual(body["termsUrl"], "https://www.ndbc.noaa.gov/disclaimer.shtml")
        self.assertEqual(body["fileLastModified"], "2026-10-31T21:05:55Z")
        self.assertTrue(body["notForNavigation"]); self.assertIn("Not for navigation", body["disclosure"])
        ids = [s["station"] for s in body["stations"]]
        self.assertEqual(sorted(ids), ["44008", "44097"], "ship rows, future rows, out-of-box, bad lat and malformed rows dropped")
        first = next(s for s in body["stations"] if s["station"] == "44008")
        self.assertEqual(first["observedAt"], "2026-10-31T20:40:00Z")
        self.assertEqual(first["values"]["windSpeedMs"], 6.0); self.assertIsNone(first["values"]["waveHeightM"])
        self.assertEqual(first["values"]["waterTempC"], 16.3)
        self.assertEqual(first["name"], "NANTUCKET 54 NM Southeast of Nantucket"); self.assertEqual(first["owner"], "NDBC")
        self.assertEqual(first["sourceUrl"], "https://www.ndbc.noaa.gov/station_page.php?station=44008")
        self.assertEqual(body["units"]["waveHeightM"], "m")
        request = opener.requests[0]
        self.assertEqual(request.get_method(), "GET"); self.assertIn("SignalWarden", request.get_header("User-agent"))

    def test_cached_and_throttled_upstream(self):
        opener = self.standard()
        oc.handle(["ndbc", "latest"], BOX, HEADERS)
        self.assertEqual(oc.handle(["ndbc", "latest"], {**BOX, "west": ["-75"]}, HEADERS)["cache"], "hit")
        self.assertEqual(len([r for r in opener.requests if "latest_obs" in r.full_url]), 1)
        self.clock_value[0] += oc.LATEST_CACHE_SECONDS + 1
        oc.handle(["ndbc", "latest"], BOX, HEADERS)
        self.assertEqual(len([r for r in opener.requests if "latest_obs" in r.full_url]), 2)
        self.assertEqual(len([r for r in opener.requests if "activestations" in r.full_url]), 1, "station names cached for a day")

    def test_station_names_are_optional(self):
        self.use([("latest_obs.txt", lambda: Response(LATEST)), ("activestations.xml", HTTPError("u", 500, "x", Headers(), io.BytesIO(b"")))])
        body = oc.handle(["ndbc", "latest"], BOX, HEADERS)
        self.assertEqual(len(body["stations"]), 2); self.assertIsNone(body["stations"][0]["name"])

    def test_upstream_failures_are_sanitised(self):
        cases = [(URLError("https://www.ndbc.noaa.gov/secret-path"), "provider_unreachable"),
                 (HTTPError("u", 503, "x", Headers(), io.BytesIO(b"")), "provider_error"),
                 (lambda: Response("x" * 10, {"Content-Length": str(oc.MAX_BYTES + 1)}), "provider_too_large"),
                 (lambda: Response("# header only\n"), "provider_invalid_schema")]
        for reply, code in cases:
            with self.subTest(code=code):
                oc.reset_state()
                self.use([("latest_obs.txt", reply)])
                with self.assertRaises(oc.OceanRelayError) as ctx:
                    oc.handle(["ndbc", "latest"], BOX, HEADERS)
                self.assertEqual(ctx.exception.code, code)
                self.assertNotIn("secret-path", ctx.exception.message)

    def test_throttle_without_cache_reports_retry(self):
        self.use([("latest_obs.txt", URLError("down"))])
        with self.assertRaises(oc.OceanRelayError):
            oc.handle(["ndbc", "latest"], BOX, HEADERS)
        with self.assertRaises(oc.OceanRelayError) as ctx:
            oc.handle(["ndbc", "latest"], BOX, HEADERS)
        self.assertEqual((ctx.exception.status, ctx.exception.code, ctx.exception.retry_after), (429, "relay_throttled", 60))

    def test_station_xml_parser_ignores_entities_and_bad_ids(self):
        parsed = oc.parse_active_stations('<!DOCTYPE x [<!ENTITY a "aaaa">]><stations><station id="ABC12" name="&a;" owner="o" type="buoy"/><station id="../x" name="n"/></stations>')
        self.assertEqual(list(parsed), ["ABC12"]); self.assertEqual(parsed["ABC12"]["name"], "&a;")


class RouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app_path = ROOT / "services/management-api/app.py"
        sys.path.insert(0, str(app_path.parent))
        spec = importlib.util.spec_from_file_location("ocean_route_app", app_path)
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
        old = os.environ.pop("UCAS_WORLDVIEW_OCEAN_ENABLED", None)
        try:
            status, body = self.request("/api/v1/worldview-ocean/status")
            self.assertEqual((status, body["error"]["code"]), (404, "ocean_relay_disabled"))
            os.environ["UCAS_WORLDVIEW_OCEAN_ENABLED"] = "1"
            status, body = self.request("/api/v1/worldview-ocean/status", {"X-SignalWarden-Ocean": "enabled", "Host": f"127.0.0.1:{self.port}"})
            self.assertEqual(status, 200); self.assertTrue(body["readOnly"])
            status, body = self.request("/api/v1/worldview-ocean/status", {"X-SignalWarden-Ocean": "enabled", "Host": f"127.0.0.1:{self.port}", "Origin": "https://foreign.example"})
            self.assertEqual((status, body["error"]["code"]), (403, "origin_not_allowed"))
            status, _ = self.request("/api/v1/worldview-ocean/status", {"X-SignalWarden-Ocean": "enabled"}, method="POST")
            self.assertNotEqual(status, 200)
        finally:
            os.environ.pop("UCAS_WORLDVIEW_OCEAN_ENABLED", None)
            if old is not None:
                os.environ["UCAS_WORLDVIEW_OCEAN_ENABLED"] = old


if __name__ == "__main__":
    unittest.main()
