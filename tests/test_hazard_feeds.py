import importlib.util
import io
import json
import os
import sys
import threading
import unittest
from http.client import HTTPConnection
from pathlib import Path
from urllib.error import HTTPError, URLError

ROOT = Path(__file__).resolve().parents[1]
MOD = ROOT / "services" / "management-api" / "hazard_feeds.py"
spec = importlib.util.spec_from_file_location("hazard_feeds_test_module", MOD)
hz = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = hz
spec.loader.exec_module(hz)

FAKE_KEY = "abcdef0123456789abcdef0123456789"
HEADERS = {"X-SignalWarden-Hazards": "enabled", "Host": "127.0.0.1:8000", "Origin": "http://127.0.0.1:8000"}

# Hand-written fixtures in the real FIRMS column layouts (no upstream data copied).
VIIRS_API_CSV = (
    "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight\n"
    "40.5,-120.25,330.1,0.4,0.4,2026-10-30,839,N20,VIIRS,n,2.0NRT,280.1,3.06,N\n"
    "40.6,-120.30,345.0,0.4,0.4,2026-10-30,2015,N20,VIIRS,h,2.0NRT,290.0,12.5,D\n"
    "10.0,10.0,300,0.4,0.4,2026-10-30,0100,N20,VIIRS,l,2.0NRT,280,1,N\n"
    "bad,row,,,,,,,,,,,,\n"
)
MODIS_PUBLIC_CSV = (
    "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,confidence,version,bright_t31,frp,daynight\n"
    "41.0,-121.0,315.7,1.3,1.1,2026-10-29,0434,A,86,6.1NRT,279.6,24.72,D\n"
)
STORMS = {"activeStorms": [{
    "id": "al052026", "binNumber": "AT5", "name": "Testy", "classification": "HU",
    "intensity": "90", "pressure": "970", "latitudeNumeric": 25.5, "longitudeNumeric": -70.1,
    "movementDir": 315, "movementSpeed": 12, "lastUpdate": "2026-10-30T15:00:00.000Z",
    "publicAdvisory": {"advNum": "013", "issuance": "2026-10-30T15:00:00.000Z", "url": "https://www.nhc.noaa.gov/text/MIATCPAT5.shtml"},
    "forecastGraphics": {"url": "javascript:alert(1)"},
}, {"id": "bogus", "latitudeNumeric": 1, "longitudeNumeric": 1, "lastUpdate": "2026-10-30T15:00:00Z"}]}
POINTS = {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-71.12345, 26.5]},
          "properties": {"stormname": "Testy", "tau": 12, "maxwind": 95, "validtime": "31/0000", "evil": "x"}}]}
CONE = {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[[-70, 25], [-72, 27], [-69, 28], [-70, 25]]]}, "properties": {"advisnum": "13"}}]}


class Headers(dict):
    pass


class Response(io.BytesIO):
    def __init__(self, data: bytes):
        super().__init__(data)
        self.headers = Headers({"Content-Length": str(len(data))})


class Opener:
    def __init__(self, routes):
        self.routes, self.seen = routes, []

    def open(self, request, timeout=None):
        url = request.full_url
        self.seen.append(url)
        for needle, value in self.routes:
            if needle in url:
                if isinstance(value, Exception):
                    raise value
                return Response(value if isinstance(value, bytes) else json.dumps(value).encode())
        raise AssertionError("unexpected URL")


class HazardFeedTests(unittest.TestCase):
    def setUp(self):
        self.saved = {k: os.environ.get(k) for k in ("UCAS_PUBLIC_HAZARDS_ENABLED", "UCAS_NASA_FIRMS_MAP_KEY")}
        os.environ["UCAS_PUBLIC_HAZARDS_ENABLED"] = "1"
        os.environ.pop("UCAS_NASA_FIRMS_MAP_KEY", None)
        hz.reset_state()
        self.addCleanup(setattr, hz, "opener_factory", hz._default_opener)

    def tearDown(self):
        for key, value in self.saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def use(self, routes):
        opener = Opener(routes)
        hz.opener_factory = lambda: opener
        return opener

    def test_guards_before_any_transport(self):
        opener = self.use([])
        os.environ["UCAS_PUBLIC_HAZARDS_ENABLED"] = "0"
        with self.assertRaisesRegex(hz.HazardFeedError, "disabled"):
            hz.dispatch("firms", {"bbox": ["-121,40,-120,41"]}, HEADERS)
        os.environ["UCAS_PUBLIC_HAZARDS_ENABLED"] = "1"
        with self.assertRaisesRegex(hz.HazardFeedError, "X-SignalWarden-Hazards"):
            hz.dispatch("nhc", {}, {"Host": "127.0.0.1:8000"})
        with self.assertRaisesRegex(hz.HazardFeedError, "cross-site"):
            hz.dispatch("nhc", {}, {**HEADERS, "Origin": "https://evil.example"})
        for bad in ({"bbox": ["-130,30,-100,41"]}, {"bbox": ["1,2,3"]}, {"bbox": ["10,0,5,1"]}, {"bbox": ["nan,0,1,1"]},
                    {"bbox": ["0,0,1,1"], "days": ["6"]}, {"bbox": ["0,0,1,1"], "source": ["LANDSAT_NRT"]},
                    {"bbox": ["0,0,1,1"], "url": ["https://evil"]}, {"bbox": ["0,0,1,1", "0,0,1,1"]}):
            with self.assertRaises(hz.HazardFeedError):
                hz.dispatch("firms", bad, HEADERS)
        self.assertEqual(opener.seen, [])

    def test_firms_with_key_uses_area_api_and_never_leaks_key(self):
        os.environ["UCAS_NASA_FIRMS_MAP_KEY"] = FAKE_KEY
        opener = self.use([("/api/area/csv/", VIIRS_API_CSV.encode())])
        result = hz.dispatch("firms", {"bbox": ["-121,40,-120,41"], "source": ["VIIRS_NOAA20_NRT"], "days": ["2"]}, HEADERS)
        self.assertEqual(opener.seen[0], f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{FAKE_KEY}/VIIRS_NOAA20_NRT/-121,40,-120,41/2")
        self.assertNotIn(FAKE_KEY, json.dumps(result))
        self.assertIn("[MAP_KEY]", result["sourceUrl"])
        self.assertEqual(result["mode"], "map_key_area_api")
        self.assertEqual(result["keyStatus"], "configured")
        self.assertEqual(result["count"], 2)  # out-of-bbox and malformed rows dropped
        first, second = result["detections"]
        self.assertEqual(first["acquiredAt"], "2026-10-30T08:39:00Z")  # unpadded acq_time
        self.assertEqual(first["confidence"], "nominal")
        self.assertEqual(first["satellite"], "NOAA-20")
        self.assertEqual(first["dayNight"], "night")
        self.assertEqual(second["confidence"], "high")
        self.assertEqual(second["frpMw"], 12.5)
        self.assertIn("Not confirmed fires", result["disclosure"])
        # Cached second call does not hit the network again.
        again = hz.dispatch("firms", {"bbox": ["-121,40,-120,41"], "source": ["VIIRS_NOAA20_NRT"], "days": ["2"]}, HEADERS)
        self.assertTrue(again["cached"])
        self.assertEqual(len(opener.seen), 1)

    def test_firms_errors_do_not_echo_key(self):
        os.environ["UCAS_NASA_FIRMS_MAP_KEY"] = FAKE_KEY
        self.use([("/api/area/csv/", b"Invalid MAP_KEY.")])
        with self.assertRaises(hz.HazardFeedError) as ctx:
            hz.dispatch("firms", {"bbox": ["-121,40,-120,41"]}, HEADERS)
        self.assertEqual(ctx.exception.code, "firms_key_rejected")
        self.assertNotIn(FAKE_KEY, ctx.exception.message)
        hz.reset_state()
        self.use([("/api/area/csv/", URLError("boom " + FAKE_KEY))])
        with self.assertRaises(hz.HazardFeedError) as ctx:
            hz.dispatch("firms", {"bbox": ["-121,40,-120,41"]}, HEADERS)
        self.assertNotIn(FAKE_KEY, ctx.exception.message)
        hz.reset_state()
        self.use([("/api/area/csv/", HTTPError("https://x/" + FAKE_KEY, 302, "r", {"Location": "https://evil"}, io.BytesIO()))])
        with self.assertRaisesRegex(hz.HazardFeedError, "redirect"):
            hz.dispatch("firms", {"bbox": ["-121,40,-120,41"]}, HEADERS)

    def test_firms_without_key_reports_not_configured_and_uses_public_file(self):
        opener = self.use([("/data/active_fire/", MODIS_PUBLIC_CSV.encode())])
        self.assertEqual(hz.dispatch("status", {}, HEADERS)["firms"]["keyStatus"], "not_configured")
        result = hz.dispatch("firms", {"bbox": ["-122,40,-120,42"], "source": ["MODIS_NRT"]}, HEADERS)
        self.assertEqual(opener.seen[0], "https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_USA_contiguous_and_Hawaii_24h.csv")
        self.assertEqual(result["keyStatus"], "not_configured")
        self.assertEqual(result["mode"], "keyless_public_file")
        self.assertEqual(result["detections"][0]["confidence"], "86%")
        self.assertEqual(result["detections"][0]["satellite"], "Aqua")
        # Cannot serve: no key, and bbox spans regions or days > 2.
        for query in ({"bbox": ["-70,45,-55,55"], "days": ["3"]}, {"bbox": ["-10,30,5,40"]}):
            with self.assertRaises(hz.HazardFeedError) as ctx:
                hz.dispatch("firms", query, HEADERS)
            self.assertEqual(ctx.exception.code, "firms_not_configured")
        self.assertEqual(len(opener.seen), 1)

    def test_firms_size_cap_and_schema(self):
        self.use([("/data/active_fire/", b"<html>maintenance</html>")])
        with self.assertRaisesRegex(hz.HazardFeedError, "non-CSV"):
            hz.dispatch("firms", {"bbox": ["-122,40,-120,42"]}, HEADERS)
        hz.reset_state()
        big = Response(b"x")
        big.headers["Content-Length"] = str(hz.FIRMS_MAX_BYTES + 1)
        hz.opener_factory = lambda: type("O", (), {"open": lambda self, r, timeout=None: big})()
        with self.assertRaisesRegex(hz.HazardFeedError, "size limit"):
            hz.dispatch("firms", {"bbox": ["-122,40,-120,42"]}, HEADERS)

    def test_upstream_budget_throttles(self):
        self.use([("/data/active_fire/", MODIS_PUBLIC_CSV.encode())])
        for i in range(hz.UPSTREAM_BUDGET):
            hz.dispatch("firms", {"bbox": [f"-122,40,-120,{41 + i * 0.01:.2f}"], "source": ["MODIS_NRT"]}, HEADERS)
        with self.assertRaisesRegex(hz.HazardFeedError, "budget"):
            hz.dispatch("firms", {"bbox": ["-122,40,-121,41"], "source": ["MODIS_NRT"]}, HEADERS)

    def test_nhc_storms_and_gis(self):
        opener = self.use([("CurrentStorms.json", STORMS), ("/MapServer/110/", POINTS), ("/MapServer/111/", {"features": []}), ("/MapServer/112/", CONE)])
        result = hz.dispatch("nhc", {}, HEADERS)
        self.assertEqual(result["count"], 1)
        storm = result["storms"][0]
        self.assertEqual((storm["name"], storm["intensityKt"], storm["pressureMb"], storm["binNumber"]), ("Testy", 90.0, 970.0, "AT5"))
        self.assertEqual(storm["publicAdvisoryUrl"], "https://www.nhc.noaa.gov/text/MIATCPAT5.shtml")
        self.assertIsNone(storm["graphicsUrl"])
        self.assertEqual(storm["forecast"]["points"][0]["coordinates"], [-71.123, 26.5])
        self.assertNotIn("evil", storm["forecast"]["points"][0]["properties"])
        self.assertEqual(storm["forecast"]["cone"][0]["type"], "Polygon")
        self.assertTrue(all(u.startswith(("https://www.nhc.noaa.gov/", "https://mapservices.weather.noaa.gov/")) for u in opener.seen))
        self.assertIn("not the extent of hazards", result["disclosure"])

    def test_nhc_empty_and_invalid(self):
        self.use([("CurrentStorms.json", {"activeStorms": []})])
        self.assertEqual(hz.dispatch("nhc", {}, HEADERS)["storms"], [])
        hz.reset_state()
        self.use([("CurrentStorms.json", {"nope": 1})])
        with self.assertRaisesRegex(hz.HazardFeedError, "schema"):
            hz.dispatch("nhc", {}, HEADERS)
        with self.assertRaises(hz.HazardFeedError):
            hz.dispatch("nhc", {"x": ["1"]}, HEADERS)

    def test_layer_table_matches_service(self):
        self.assertEqual(hz.NHC_LAYERS["AT1"], (6, 7, 8))
        self.assertEqual(hz.NHC_LAYERS["AT5"], (110, 111, 112))
        self.assertEqual(hz.NHC_LAYERS["EP1"], (136, 137, 138))
        self.assertEqual(hz.NHC_LAYERS["CP5"], (370, 371, 372))

    def test_host_allowlist(self):
        with self.assertRaisesRegex(hz.HazardFeedError, "allowlisted"):
            hz._get("https://evil.example/x", 10, "text/plain")
        with self.assertRaisesRegex(hz.HazardFeedError, "allowlisted"):
            hz._get("http://www.nhc.noaa.gov/CurrentStorms.json", 10, "text/plain")


class RouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app_path = ROOT / "services/management-api/app.py"
        sys.path.insert(0, str(app_path.parent))
        spec = importlib.util.spec_from_file_location("hazard_route_app", app_path)
        cls.app = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = cls.app
        spec.loader.exec_module(cls.app)
        cls.app.STORE = cls.app.InMemoryStore()
        cls.server = cls.app.create_server("127.0.0.1", 0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def request(self, path, headers=None):
        conn = HTTPConnection("127.0.0.1", self.port, timeout=3)
        conn.request("GET", path, headers=headers or {})
        response = conn.getresponse()
        body = response.read()
        conn.close()
        return response.status, json.loads(body)

    def test_disabled_by_default_and_not_configured_status(self):
        saved = {k: os.environ.get(k) for k in ("UCAS_PUBLIC_HAZARDS_ENABLED", "UCAS_NASA_FIRMS_MAP_KEY")}
        try:
            os.environ.pop("UCAS_PUBLIC_HAZARDS_ENABLED", None)
            os.environ.pop("UCAS_NASA_FIRMS_MAP_KEY", None)
            status, body = self.request("/api/v1/public-imagery/hazards/status")
            self.assertEqual((status, body["error"]["code"]), (404, "hazard_relay_disabled"))
            os.environ["UCAS_PUBLIC_HAZARDS_ENABLED"] = "1"
            headers = {"X-SignalWarden-Hazards": "enabled", "Host": f"127.0.0.1:{self.port}"}
            status, body = self.request("/api/v1/public-imagery/hazards/status", headers)
            self.assertEqual(status, 200)
            self.assertEqual(body["firms"]["keyStatus"], "not_configured")
            status, body = self.request("/api/v1/public-imagery/hazards/unknown", headers)
            self.assertEqual(status, 404)
            status, body = self.request("/api/v1/public-imagery/hazards/firms?bbox=-10,30,5,40", headers)
            self.assertEqual((status, body["error"]["code"]), (503, "firms_not_configured"))
        finally:
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


if __name__ == "__main__":
    unittest.main()
