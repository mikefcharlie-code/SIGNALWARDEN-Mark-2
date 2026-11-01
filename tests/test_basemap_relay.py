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
MOD = ROOT / "services" / "management-api" / "basemap_relay.py"
spec = importlib.util.spec_from_file_location("basemap_relay_test_module", MOD)
relay = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = relay
spec.loader.exec_module(relay)

ESRI_KEY = "esri-test-key-DO-NOT-LEAK"
GOOGLE_KEY = "google-test-key-DO-NOT-LEAK"
ENV = ("UCAS_PUBLIC_BASEMAP_RELAY_ENABLED", "UCAS_ESRI_API_KEY", "UCAS_GOOGLE_MAPS_API_KEY")
HEADERS = {"X-SignalWarden-Basemap": "enabled", "Host": "127.0.0.1:8000", "Origin": "http://127.0.0.1:8000"}
JPEG = b"\xff\xd8\xff\xe0fixture\xff\xd9"


class Headers(dict):
    def get_content_type(self):
        return self.get("Content-Type", "").split(";", 1)[0].strip()


class Response(io.BytesIO):
    def __init__(self, data=JPEG, content_type="image/jpeg"):
        super().__init__(data)
        self.headers = Headers({"Content-Type": content_type, "Content-Length": str(len(data))})


class Opener:
    def __init__(self, responses, seen):
        self.responses, self.seen = iter(responses), seen

    def open(self, request, timeout=None):
        self.seen.append(request)
        item = next(self.responses)
        if isinstance(item, Exception):
            raise item
        return item


class RelayTests(unittest.TestCase):
    def setUp(self):
        self.saved = {name: os.environ.get(name) for name in ENV}
        for name in ENV:
            os.environ.pop(name, None)
        relay._stamps = {"esri": [], "google": []}
        relay._google_session.clear()
        self.old_opener = relay.build_opener
        self.seen = []

    def tearDown(self):
        relay.build_opener = self.old_opener
        for name, value in self.saved.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value

    def use(self, *responses):
        opener = Opener(list(responses), self.seen)
        relay.build_opener = lambda *args: opener

    def test_status_reports_disabled_then_not_configured_then_configured_without_key_values(self):
        s = relay.handle(["status"], {}, HEADERS)
        self.assertFalse(s["relayEnabled"])
        self.assertEqual(s["providers"]["esri"]["status"], "disabled")
        self.assertEqual(s["providers"]["google3d"]["status"], "not_implemented")
        os.environ["UCAS_PUBLIC_BASEMAP_RELAY_ENABLED"] = "1"
        s = relay.handle(["status"], {}, HEADERS)
        self.assertEqual(s["providers"]["esri"]["status"], "not_configured")
        self.assertEqual(s["providers"]["google2d"]["status"], "not_configured")
        os.environ["UCAS_ESRI_API_KEY"] = ESRI_KEY
        os.environ["UCAS_GOOGLE_MAPS_API_KEY"] = GOOGLE_KEY
        s = relay.handle(["status"], {}, HEADERS)
        self.assertEqual(s["providers"]["esri"]["status"], "configured")
        self.assertEqual(s["providers"]["google2d"]["status"], "configured")
        text = json.dumps(s)
        self.assertNotIn(ESRI_KEY, text)
        self.assertNotIn(GOOGLE_KEY, text)

    def test_guards_happen_before_transport(self):
        self.use()  # any transport use raises StopIteration
        with self.assertRaises(relay.BasemapError) as ctx:
            relay.handle(["esri", "tile"], {"z": ["2"], "x": ["1"], "y": ["1"]}, {})
        self.assertEqual(ctx.exception.code, "basemap_header_required")
        with self.assertRaises(relay.BasemapError) as ctx:
            relay.handle(["esri", "tile"], {"z": ["2"], "x": ["1"], "y": ["1"]}, {**HEADERS, "Origin": "https://evil.example"})
        self.assertEqual(ctx.exception.code, "origin_not_allowed")
        with self.assertRaises(relay.BasemapError) as ctx:
            relay.handle(["esri", "tile"], {"z": ["2"], "x": ["1"], "y": ["1"]}, HEADERS)
        self.assertEqual(ctx.exception.code, "basemap_relay_disabled")
        os.environ["UCAS_PUBLIC_BASEMAP_RELAY_ENABLED"] = "1"
        with self.assertRaises(relay.BasemapError) as ctx:
            relay.handle(["google", "tile"], {"z": ["2"], "x": ["1"], "y": ["1"]}, HEADERS)
        self.assertEqual((ctx.exception.status, ctx.exception.code), (503, "not_configured"))
        self.assertEqual(self.seen, [])

    def test_tile_coordinates_are_strictly_validated(self):
        os.environ["UCAS_PUBLIC_BASEMAP_RELAY_ENABLED"] = "1"
        os.environ["UCAS_ESRI_API_KEY"] = ESRI_KEY
        self.use()
        for query in ({"z": ["9"], "x": ["0"], "y": ["0"]}, {"z": ["2"], "x": ["4"], "y": ["0"]}, {"z": ["2"], "x": ["-1"], "y": ["0"]},
                      {"z": ["2"], "x": ["1"], "y": ["1"], "url": ["https://evil.example"]}, {"z": ["2", "3"], "x": ["1"], "y": ["1"]},
                      {"z": ["²"], "x": ["0"], "y": ["0"]}, {"z": ["1.5"], "x": ["0"], "y": ["0"]}, {"z": ["2"], "x": ["1"]}):
            with self.subTest(query=query), self.assertRaises(relay.BasemapError) as ctx:
                relay.handle(["esri", "tile"], query, HEADERS)
            self.assertEqual(ctx.exception.code, "invalid_tile")
        self.assertEqual(self.seen, [])

    def test_esri_tile_uses_fixed_url_with_server_side_token(self):
        os.environ["UCAS_PUBLIC_BASEMAP_RELAY_ENABLED"] = "1"
        os.environ["UCAS_ESRI_API_KEY"] = ESRI_KEY
        self.use(Response())
        tile = relay.handle(["esri", "tile"], {"z": ["3"], "x": ["2"], "y": ["5"]}, HEADERS)
        self.assertEqual((tile.payload, tile.mime), (JPEG, "image/jpeg"))
        url = self.seen[0].full_url
        self.assertTrue(url.startswith("https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/3/5/2?token="))
        self.assertIn(ESRI_KEY, url)  # only upstream; never returned

    def test_upstream_errors_never_leak_the_key(self):
        os.environ["UCAS_PUBLIC_BASEMAP_RELAY_ENABLED"] = "1"
        os.environ["UCAS_ESRI_API_KEY"] = ESRI_KEY
        url = relay.ESRI_TILE.format(z=1, x=0, y=0) + "?token=" + ESRI_KEY
        cases = [
            (HTTPError(url, 403, "forbidden " + ESRI_KEY, {}, io.BytesIO()), "basemap_provider_auth"),
            (HTTPError(url, 302, "redirect", {"Location": "https://evil.example"}, io.BytesIO()), "basemap_redirect_rejected"),
            (HTTPError(url, 429, "slow", {}, io.BytesIO()), "basemap_provider_quota"),
            (URLError("cannot reach " + url), "basemap_provider_unreachable"),
            (Response(b"<html>", "text/html"), "basemap_invalid_content_type"),
            (Response(b"x" * (relay.MAX_BYTES + 1)), "basemap_too_large"),
        ]
        for item, code in cases:
            self.use(item)
            with self.subTest(code=code), self.assertRaises(relay.BasemapError) as ctx:
                relay.handle(["esri", "tile"], {"z": ["1"], "x": ["0"], "y": ["0"]}, HEADERS)
            self.assertEqual(ctx.exception.code, code)
            self.assertNotIn(ESRI_KEY, ctx.exception.message)
            self.assertNotIn(ESRI_KEY, str(ctx.exception))
            self.assertIsNone(ctx.exception.__cause__)

    def test_streaming_response_obeys_total_deadline(self):
        class SlowResponse:
            headers = Headers({"Content-Length": "0"})
            def read(self, _size):
                time.sleep(0.02)
                return b""
            def close(self):
                pass

        with self.assertRaises(relay.BasemapError) as ctx:
            relay._read(SlowResponse(), 1024, time.monotonic() + 0.005)
        self.assertEqual((ctx.exception.status, ctx.exception.code), (504, "basemap_provider_timeout"))

    def test_google_session_is_created_once_and_reused(self):
        os.environ["UCAS_PUBLIC_BASEMAP_RELAY_ENABLED"] = "1"
        os.environ["UCAS_GOOGLE_MAPS_API_KEY"] = GOOGLE_KEY
        session = json.dumps({"session": "sess-fixture", "expiry": "4102444800", "tileWidth": 256, "imageFormat": "jpeg"}).encode()
        viewport = json.dumps({"copyright": "Imagery ©2026 Fixture Provider", "maxZoomRects": []}).encode()
        self.use(Response(session, "application/json"), Response(), Response(), Response(viewport, "application/json"))
        relay.handle(["google", "tile"], {"z": ["2"], "x": ["1"], "y": ["2"]}, HEADERS)
        relay.handle(["google", "tile"], {"z": ["2"], "x": ["2"], "y": ["2"]}, HEADERS)
        attribution = relay.handle(["google", "attribution"], {"zoom": ["3"], "north": ["40"], "south": ["30"], "east": ["-70"], "west": ["-80"]}, HEADERS)
        self.assertEqual(attribution["copyright"], "Imagery ©2026 Fixture Provider")
        self.assertNotIn(GOOGLE_KEY, json.dumps(attribution))
        self.assertEqual(self.seen[0].get_method(), "POST")
        self.assertTrue(self.seen[0].full_url.startswith(relay.GOOGLE_SESSION))
        self.assertEqual(json.loads(self.seen[0].data)["mapType"], "satellite")
        self.assertTrue(self.seen[1].full_url.startswith("https://tile.googleapis.com/v1/2dtiles/2/1/2?session=sess-fixture&key="))
        self.assertEqual(len([r for r in self.seen if r.full_url.startswith(relay.GOOGLE_SESSION)]), 1)
        self.assertTrue(self.seen[3].full_url.startswith(relay.GOOGLE_VIEWPORT))

    def test_viewport_validation(self):
        os.environ["UCAS_PUBLIC_BASEMAP_RELAY_ENABLED"] = "1"
        os.environ["UCAS_GOOGLE_MAPS_API_KEY"] = GOOGLE_KEY
        self.use()
        for q in ({"zoom": ["3"], "north": ["91"], "south": ["30"], "east": ["1"], "west": ["0"]},
                  {"zoom": ["3"], "north": ["10"], "south": ["30"], "east": ["1"], "west": ["0"]},
                  {"zoom": ["3"], "north": ["nan"], "south": ["30"], "east": ["1"], "west": ["0"]},
                  {"zoom": ["3"]}):
            with self.subTest(q=q), self.assertRaises(relay.BasemapError):
                relay.handle(["google", "attribution"], q, HEADERS)
        self.assertEqual(self.seen, [])

    def test_rate_limit_and_concurrency(self):
        os.environ["UCAS_PUBLIC_BASEMAP_RELAY_ENABLED"] = "1"
        os.environ["UCAS_ESRI_API_KEY"] = ESRI_KEY
        relay._stamps["esri"] = [relay.time.monotonic()] * relay.RATE_PER_MINUTE
        self.use()
        with self.assertRaises(relay.BasemapError) as ctx:
            relay.handle(["esri", "tile"], {"z": ["1"], "x": ["0"], "y": ["0"]}, HEADERS)
        self.assertEqual(ctx.exception.code, "basemap_rate_limited")

        class Busy:
            def acquire(self, blocking=False): return False
            def release(self): raise AssertionError("must not release")
        old = relay._slots
        relay._slots = Busy()
        try:
            with self.assertRaises(relay.BasemapError) as ctx:
                relay.handle(["esri", "tile"], {"z": ["1"], "x": ["0"], "y": ["0"]}, HEADERS)
            self.assertEqual(ctx.exception.code, "basemap_relay_busy")
        finally:
            relay._slots = old


class RouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app_path = ROOT / "services/management-api/app.py"
        sys.path.insert(0, str(app_path.parent))
        spec = importlib.util.spec_from_file_location("basemap_route_app", app_path)
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

    def setUp(self):
        self.saved = {name: os.environ.get(name) for name in ENV}
        for name in ENV:
            os.environ.pop(name, None)

    def tearDown(self):
        for name, value in self.saved.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value

    def request(self, path, headers=None):
        conn = HTTPConnection("127.0.0.1", self.port, timeout=3)
        conn.request("GET", path, headers=headers or {})
        response = conn.getresponse()
        body = response.read()
        conn.close()
        return response.status, body

    def headers(self):
        return {"X-SignalWarden-Basemap": "enabled", "Host": f"127.0.0.1:{self.port}", "Origin": f"http://127.0.0.1:{self.port}"}

    def test_status_route_and_not_configured_tile(self):
        os.environ["UCAS_PUBLIC_BASEMAP_RELAY_ENABLED"] = "1"
        status, body = self.request("/api/v1/public-imagery/basemap/status", self.headers())
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["providers"]["esri"]["status"], "not_configured")
        status, body = self.request("/api/v1/public-imagery/basemap/esri/tile?z=1&x=0&y=0", self.headers())
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(body)["error"]["code"], "not_configured")

    def test_disabled_and_missing_header(self):
        status, body = self.request("/api/v1/public-imagery/basemap/esri/tile?z=1&x=0&y=0", self.headers())
        self.assertEqual((status, json.loads(body)["error"]["code"]), (404, "basemap_relay_disabled"))
        status, body = self.request("/api/v1/public-imagery/basemap/status")
        self.assertEqual((status, json.loads(body)["error"]["code"]), (403, "basemap_header_required"))


if __name__ == "__main__":
    unittest.main()
