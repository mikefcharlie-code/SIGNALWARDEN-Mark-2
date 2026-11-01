import gzip
import importlib.util
import io
import json
import os
import sys
import threading
import time
import unittest
from http.client import HTTPConnection
from pathlib import Path
from urllib.error import HTTPError, URLError

ROOT = Path(__file__).resolve().parents[1]
MOD = ROOT / "services" / "management-api" / "worldview_gpsjam.py"
spec = importlib.util.spec_from_file_location("worldview_gpsjam_test_module", MOD)
gj = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = gj
spec.loader.exec_module(gj)

HEADERS = {"X-SignalWarden-GpsJam": "enabled", "Host": "127.0.0.1:8000", "Origin": "http://127.0.0.1:8000"}
NOW = 1793491200.0  # 2026-11-01T00:00:00Z

# Hand-written excerpts in the live gpsjam.org layouts (verified 2026-10-31); counts are invented.
MANIFEST = """date,suspect,num_bad_aircraft_hexes,source
2022-02-14,true,89,adsbexchange
2026-10-28,true,594,merged
2026-10-29,false,513,airplaneslive
bogus,false,1,merged
2026-10-30,false,597,merged
2026-02-30,false,1,merged
2026-10-27,false,x,unknownsource
"""
DAY = """hex,count_good_aircraft,count_bad_aircraft
841f725ffffffff,40,30
841f607ffffffff,90,5
84089b1ffffffff,200,3
843f4dbffffffff,10,2
851f725ffffffff,5,5
841f725ffffffff,1,1
zz,1,1
84488a5ffffffff,-1,2
84488a7ffffffff,0,0
842a107ffffffff,abc,2

"""


class Headers(dict):
    def get(self, key, default=None):
        for k, v in self.items():
            if k.lower() == key.lower():
                return v
        return default


class Response(io.BytesIO):
    def __init__(self, body, headers=None, gz=False):
        data = body.encode("utf-8") if isinstance(body, str) else body
        if gz:
            data = gzip.compress(data)
            headers = {"Content-Encoding": "gzip", **(headers or {})}
        super().__init__(data)
        self.headers = Headers({"Content-Length": str(len(data)), **(headers or {})})


class SlowResponse(Response):
    def read1(self, size=-1):
        time.sleep(0.02)
        return super().read1(size)


class Opener:
    def __init__(self, routes):
        self.routes, self.requests = routes, []

    def open(self, request, timeout=None):
        self.requests.append(request)
        for needle, reply in self.routes:
            if request.full_url.endswith(needle):
                if isinstance(reply, Exception):
                    raise reply
                return reply() if callable(reply) else reply
        raise AssertionError("unexpected upstream URL " + request.full_url)


class Base(unittest.TestCase):
    def setUp(self):
        self.saved = os.environ.get(gj.ENV_FLAG)
        os.environ[gj.ENV_FLAG] = "1"
        self.factory, self.clock_value = gj.opener_factory, [1000.0]
        gj.clock = lambda: self.clock_value[0]
        gj.wall = lambda: NOW
        gj.reset_state()

    def tearDown(self):
        gj.opener_factory = self.factory
        gj.clock = __import__("time").monotonic
        gj.wall = __import__("time").time
        gj.reset_state()
        if self.saved is None:
            os.environ.pop(gj.ENV_FLAG, None)
        else:
            os.environ[gj.ENV_FLAG] = self.saved

    def use(self, routes):
        opener = Opener(routes)
        gj.opener_factory = lambda: opener
        return opener

    def standard(self, gz=True):
        return self.use([
            ("/data/manifest.csv", lambda: Response(MANIFEST, gz=gz)),
            ("/data/merged/2026-10-30-h3_4.csv", lambda: Response(DAY, gz=gz)),
            ("/data/airplaneslive/2026-10-29-h3_4.csv", lambda: Response(DAY, gz=gz)),
            ("/data/2022-02-14-h3_4.csv", lambda: Response(DAY, gz=gz)),
        ])

    def day_requests(self, opener):
        return [r for r in opener.requests if r.full_url.endswith("-h3_4.csv")]


class GuardTests(Base):
    def test_disabled_header_and_origin_guards_precede_transport(self):
        opener = self.use([])
        os.environ[gj.ENV_FLAG] = "0"
        with self.assertRaises(gj.GpsJamRelayError) as ctx:
            gj.handle(["status"], {}, HEADERS)
        self.assertEqual((ctx.exception.status, ctx.exception.code), (404, "gpsjam_relay_disabled"))
        os.environ.pop(gj.ENV_FLAG)
        with self.assertRaises(gj.GpsJamRelayError):
            gj.handle(["manifest"], {}, HEADERS)
        os.environ[gj.ENV_FLAG] = "1"
        with self.assertRaisesRegex(gj.GpsJamRelayError, "required"):
            gj.handle(["status"], {}, {"Host": "a"})
        with self.assertRaisesRegex(gj.GpsJamRelayError, "cross-site"):
            gj.handle(["status"], {}, {**HEADERS, "Origin": "https://evil.example"})
        with self.assertRaisesRegex(gj.GpsJamRelayError, "cross-site"):
            gj.handle(["status"], {}, {**HEADERS, "Sec-Fetch-Site": "cross-site"})
        with self.assertRaisesRegex(gj.GpsJamRelayError, "not found"):
            gj.handle(["data", "manifest.csv"], {}, HEADERS)
        self.assertEqual(opener.requests, [])

    def test_status_is_keyless_inferred_and_not_real_time(self):
        body = gj.handle(["status"], {}, HEADERS)
        self.assertTrue(body["enabled"]); self.assertTrue(body["readOnly"]); self.assertTrue(body["inferredIndicator"])
        self.assertFalse(body["realTime"])
        self.assertEqual(body["providers"]["gpsjam"]["status"], "keyless")
        self.assertIn("no explicit data licence", body["providers"]["gpsjam"]["termsNote"])
        with self.assertRaises(gj.GpsJamRelayError):
            gj.handle(["status"], {"x": ["1"]}, HEADERS)

    def test_query_validation_precedes_transport(self):
        opener = self.use([])
        for bad in ({}, {"date": ["2026-10-30", "2026-10-29"]}, {"date": ["2026-13-01"]}, {"date": ["../../etc"]},
                    {"date": ["2026-10-30"], "x": ["1"]}, {"date": ["20261030"]}):
            with self.subTest(bad=bad), self.assertRaises(gj.GpsJamRelayError) as ctx:
                gj.handle(["day"], bad, HEADERS)
            self.assertEqual(ctx.exception.status, 400)
        with self.assertRaises(gj.GpsJamRelayError):
            gj.handle(["manifest"], {"x": ["1"]}, HEADERS)
        self.assertEqual(opener.requests, [])

    def test_fixed_url_allowlist(self):
        self.assertTrue(gj._allowed_url("https://gpsjam.org/data/manifest.csv"))
        self.assertTrue(gj._allowed_url("https://gpsjam.org/data/merged/2026-10-30-h3_4.csv"))
        self.assertTrue(gj._allowed_url("https://gpsjam.org/data/2024-01-01-h3_4.csv"))
        for bad in ("http://gpsjam.org/data/manifest.csv", "https://evil.example/data/manifest.csv",
                    "https://gpsjam.org:8443/data/manifest.csv", "https://u:p@gpsjam.org/data/manifest.csv",
                    "https://gpsjam.org/data/manifest.csv?x=1", "https://gpsjam.org/data/other/2026-10-30-h3_4.csv",
                    "https://gpsjam.org/data/2026-10-30-h3_5.csv", "https://gpsjam.org/faq/"):
            self.assertFalse(gj._allowed_url(bad), bad)
        with self.assertRaisesRegex(gj.GpsJamRelayError, "allowlisted"):
            gj._fetch_text("https://evil.example/data/manifest.csv", 100)


class ManifestAndDayTests(Base):
    def test_manifest_parses_and_labels_provenance(self):
        opener = self.standard()
        body = gj.handle(["manifest"], {}, HEADERS)
        self.assertEqual([d["date"] for d in body["dates"]], ["2022-02-14", "2026-10-28", "2026-10-29", "2026-10-30"])
        self.assertEqual(body["latest"], "2026-10-30"); self.assertEqual(body["earliest"], "2022-02-14")
        self.assertTrue(body["dates"][1]["suspect"]); self.assertEqual(body["dates"][3]["badHexes"], 597)
        self.assertEqual(body["sourceUrl"], "https://gpsjam.org/data/manifest.csv")
        self.assertEqual(body["termsUrl"], "https://gpsjam.org/faq/")
        self.assertIn("John Wiseman", body["attribution"]); self.assertIn("ADS-B Exchange", body["attribution"])
        self.assertIn("Not a jammer detection", body["disclosure"])
        request = opener.requests[0]
        self.assertEqual(request.get_method(), "GET"); self.assertIn("SignalWarden", request.get_header("User-agent"))
        self.assertEqual(request.get_header("Accept-encoding"), "gzip")

    def test_day_uses_manifest_source_directory_and_validates_cells(self):
        opener = self.standard()
        body = gj.handle(["day"], {"date": ["2026-10-30"]}, HEADERS)
        self.assertEqual(body["sourceUrl"], "https://gpsjam.org/data/merged/2026-10-30-h3_4.csv")
        self.assertEqual(body["cells"], [["841f725ffffffff", 40, 30], ["841f607ffffffff", 90, 5], ["84089b1ffffffff", 200, 3], ["843f4dbffffffff", 10, 2]])
        self.assertEqual(body["skippedRows"], 6, "wrong resolution, duplicate, malformed, negative, zero and non-numeric rows")
        self.assertEqual((body["timeZone"], body["periodHours"], body["h3Resolution"]), ("UTC", 24, 4))
        self.assertEqual(body["retrievedAt"], "2026-11-01T00:00:00Z")
        self.assertIn("no explicit data licence", body["termsNote"])
        self.assertEqual(body["cache"], "miss")
        self.assertEqual(gj.handle(["day"], {"date": ["2026-10-29"]}, HEADERS)["sourceUrl"], "https://gpsjam.org/data/airplaneslive/2026-10-29-h3_4.csv")
        old = gj.handle(["day"], {"date": ["2022-02-14"]}, HEADERS)
        self.assertEqual(old["sourceUrl"], "https://gpsjam.org/data/2022-02-14-h3_4.csv"); self.assertTrue(old["suspect"])
        self.assertEqual(len(self.day_requests(opener)), 3)

    def test_uncompressed_responses_are_accepted(self):
        self.standard(gz=False)
        self.assertEqual(gj.handle(["day"], {"date": ["2026-10-30"]}, HEADERS)["cellCount"], 4)

    def test_dates_outside_manifest_are_not_fetched(self):
        opener = self.standard()
        with self.assertRaises(gj.GpsJamRelayError) as ctx:
            gj.handle(["day"], {"date": ["2026-10-31"]}, HEADERS)
        self.assertEqual((ctx.exception.status, ctx.exception.code), (404, "date_not_in_manifest"))
        self.assertEqual(self.day_requests(opener), [])

    def test_cache_per_date_lru_and_throttle(self):
        opener = self.standard()
        gj.handle(["day"], {"date": ["2026-10-30"]}, HEADERS)
        self.assertEqual(gj.handle(["day"], {"date": ["2026-10-30"]}, HEADERS)["cache"], "hit")
        self.assertEqual(len(self.day_requests(opener)), 1)
        self.assertEqual(len([r for r in opener.requests if r.full_url.endswith("manifest.csv")]), 1, "manifest cached")
        self.clock_value[0] += gj.DAY_CACHE_SECONDS + 1
        gj.handle(["day"], {"date": ["2026-10-30"]}, HEADERS)
        self.assertEqual(len(self.day_requests(opener)), 2)
        self.assertLessEqual(len(gj._day_cache), gj.DAY_CACHE_ENTRIES)

    def test_day_cache_is_scoped_to_manifest_source(self):
        first = self.standard()
        self.assertEqual(gj.handle(["day"], {"date": ["2026-10-30"]}, HEADERS)["source"], "merged")
        self.clock_value[0] += gj.MANIFEST_CACHE_SECONDS + 1
        updated = MANIFEST.replace("2026-10-30,false,597,merged", "2026-10-30,false,597,airplaneslive")
        second = self.use([
            ("/data/manifest.csv", lambda: Response(updated)),
            ("/data/airplaneslive/2026-10-30-h3_4.csv", lambda: Response(DAY)),
        ])
        body = gj.handle(["day"], {"date": ["2026-10-30"]}, HEADERS)
        self.assertEqual(body["source"], "airplaneslive")
        self.assertEqual(body["sourceUrl"], "https://gpsjam.org/data/airplaneslive/2026-10-30-h3_4.csv")
        self.assertEqual(len(self.day_requests(first)) + len(self.day_requests(second)), 2)

    def test_hourly_day_budget(self):
        self.standard()
        gj.DAY_FETCHES_PER_HOUR, saved = 1, gj.DAY_FETCHES_PER_HOUR
        try:
            gj.handle(["day"], {"date": ["2026-10-30"]}, HEADERS)
            with self.assertRaises(gj.GpsJamRelayError) as ctx:
                gj.handle(["day"], {"date": ["2026-10-29"]}, HEADERS)
            self.assertEqual((ctx.exception.status, ctx.exception.code, ctx.exception.retry_after), (429, "relay_throttled", 60))
        finally:
            gj.DAY_FETCHES_PER_HOUR = saved

    def test_upstream_failures_are_sanitised(self):
        cases = [(URLError("https://gpsjam.org/secret-path"), "provider_unreachable"),
                 (HTTPError("u", 503, "x", Headers(), io.BytesIO(b"")), "provider_error"),
                 (HTTPError("u", 404, "x", Headers(), io.BytesIO(b"")), "provider_not_found"),
                 (lambda: Response("x" * 10, {"Content-Length": str(gj.MAX_COMPRESSED_BYTES + 1)}), "provider_too_large"),
                 (lambda: Response(b"\x1f\x8bnot-gzip", {"Content-Encoding": "gzip"}), "provider_invalid_encoding"),
                 (lambda: Response(gzip.compress(DAY.encode("utf-8"))[:-8], {"Content-Encoding": "gzip"}), "provider_invalid_encoding"),
                 (lambda: Response("x", {"Content-Encoding": "br"}), "provider_invalid_encoding"),
                 (lambda: Response("hex,count_good_aircraft,count_bad_aircraft\nzz,1,1\n"), "provider_invalid_schema"),
                 (lambda: Response("a,b,c\n"), "provider_invalid_schema")]
        for reply, code in cases:
            with self.subTest(code=code):
                gj.reset_state()
                self.use([("/data/manifest.csv", lambda: Response(MANIFEST)), ("/data/merged/2026-10-30-h3_4.csv", reply)])
                with self.assertRaises(gj.GpsJamRelayError) as ctx:
                    gj.handle(["day"], {"date": ["2026-10-30"]}, HEADERS)
                self.assertEqual(ctx.exception.code, code)
                self.assertNotIn("secret-path", ctx.exception.message)

    def test_total_response_read_deadline(self):
        saved = gj.TIMEOUT_SECONDS
        try:
            gj.TIMEOUT_SECONDS = 0.005
            self.use([
                ("/data/manifest.csv", lambda: Response(MANIFEST)),
                ("/data/merged/2026-10-30-h3_4.csv", lambda: SlowResponse(DAY)),
            ])
            with self.assertRaises(gj.GpsJamRelayError) as ctx:
                gj.handle(["day"], {"date": ["2026-10-30"]}, HEADERS)
            self.assertEqual(ctx.exception.code, "provider_timeout")
        finally:
            gj.TIMEOUT_SECONDS = saved

    def test_decompression_bomb_is_capped(self):
        bomb = "hex,count_good_aircraft,count_bad_aircraft\n" + "841f725ffffffff,1,1\n" * 400_000  # ~8 MB, compresses tiny
        self.use([("/data/manifest.csv", lambda: Response(MANIFEST)), ("/data/merged/2026-10-30-h3_4.csv", lambda: Response(bomb, gz=True))])
        with self.assertRaises(gj.GpsJamRelayError) as ctx:
            gj.handle(["day"], {"date": ["2026-10-30"]}, HEADERS)
        self.assertEqual(ctx.exception.code, "provider_too_large")

    def test_manifest_failure_serves_previous_and_throttles_without_cache(self):
        self.use([("/data/manifest.csv", URLError("down"))])
        with self.assertRaises(gj.GpsJamRelayError):
            gj.handle(["manifest"], {}, HEADERS)
        with self.assertRaises(gj.GpsJamRelayError) as ctx:
            gj.handle(["manifest"], {}, HEADERS)
        self.assertEqual((ctx.exception.status, ctx.exception.code, ctx.exception.retry_after), (429, "relay_throttled", 120))
        gj.reset_state()
        self.standard()
        gj.handle(["manifest"], {}, HEADERS)
        self.clock_value[0] += gj.MANIFEST_CACHE_SECONDS + 1
        self.use([("/data/manifest.csv", URLError("down"))])
        self.assertEqual(gj.handle(["manifest"], {}, HEADERS)["cache"], "hit", "previous manifest served when refresh fails")

    def test_manifest_header_must_match(self):
        with self.assertRaises(gj.GpsJamRelayError):
            gj.parse_manifest("when,what\n2026-10-30,x\n")


class RouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app_path = ROOT / "services/management-api/app.py"
        sys.path.insert(0, str(app_path.parent))
        spec = importlib.util.spec_from_file_location("gpsjam_route_app", app_path)
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
        old = os.environ.pop(gj.ENV_FLAG, None)
        try:
            status, body = self.request("/api/v1/worldview-gpsjam/status")
            self.assertEqual((status, body["error"]["code"]), (404, "gpsjam_relay_disabled"))
            os.environ[gj.ENV_FLAG] = "1"
            status, body = self.request("/api/v1/worldview-gpsjam/status", {"X-SignalWarden-GpsJam": "enabled", "Host": f"127.0.0.1:{self.port}"})
            self.assertEqual(status, 200); self.assertTrue(body["readOnly"]); self.assertFalse(body["realTime"])
            status, body = self.request("/api/v1/worldview-gpsjam/status", {"X-SignalWarden-GpsJam": "enabled", "Host": f"127.0.0.1:{self.port}", "Origin": "https://foreign.example"})
            self.assertEqual((status, body["error"]["code"]), (403, "origin_not_allowed"))
            status, body = self.request("/api/v1/worldview-gpsjam/day?date=nope", {"X-SignalWarden-GpsJam": "enabled", "Host": f"127.0.0.1:{self.port}"})
            self.assertEqual((status, body["error"]["code"]), (400, "invalid_date"))
            status, _ = self.request("/api/v1/worldview-gpsjam/status", {"X-SignalWarden-GpsJam": "enabled"}, method="POST")
            self.assertNotEqual(status, 200)
        finally:
            os.environ.pop(gj.ENV_FLAG, None)
            if old is not None:
                os.environ[gj.ENV_FLAG] = old


if __name__ == "__main__":
    unittest.main()
