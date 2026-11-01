"""Offline tests for the opt-in space relay. Upstreams are always mocked."""
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
API = ROOT / "services" / "management-api"
spec = importlib.util.spec_from_file_location("space_relay_test_module", API / "space_relay.py")
relay = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = relay
spec.loader.exec_module(relay)

FAKE_KEY = "test-ll2-key-not-real-0123456789"


class Headers(dict):
    pass


class Response(io.BytesIO):
    def __init__(self, payload, length=None):
        data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        super().__init__(data)
        self.headers = Headers({"Content-Length": str(len(data) if length is None else length)})


def satnogs_row(**over):
    row = {
        "id": 101, "start": "2026-10-30T20:00:00Z", "end": "2026-10-30T20:08:00Z", "ground_station": 42,
        "station_name": "TEST-STATION", "station_lat": 12.3456, "station_lng": 65.4321, "observer": "someone",
        "norad_cat_id": 99999, "status": "good", "transmitter_description": "Synthetic beacon",
        "transmitter_mode": "FSK", "observation_frequency": 437000000,
    }
    row.update(over)
    return row


LAUNCHES = {"count": 1, "results": [{
    "id": "00000000-0000-4000-8000-000000000001", "name": "Synthetic Rocket | Test Payload",
    "status": {"abbrev": "TBD", "description": "Synthetic"}, "net": "2026-11-02T12:00:00Z",
    "window_start": "2026-11-02T11:00:00Z", "window_end": "2026-11-02T13:00:00Z",
    "last_updated": "2026-10-30T12:00:00Z", "lsp_name": "Example LSP", "mission": "Test Payload",
    "pad": "Pad 0", "location": "Example Range", "image": "https://example.invalid/i.jpg",
}]}


class RelayTests(unittest.TestCase):
    def setUp(self):
        self.saved = {k: os.environ.get(k) for k in ("UCAS_SPACE_RELAY_ENABLED", "UCAS_LAUNCH_LIBRARY_API_KEY")}
        os.environ["UCAS_SPACE_RELAY_ENABLED"] = "1"
        os.environ.pop("UCAS_LAUNCH_LIBRARY_API_KEY", None)
        relay.reset_state()
        self.requests = []
        self.responses = []
        self.old_open = relay._open

        def fake_open(request, timeout):
            self.requests.append(request)
            item = self.responses.pop(0)
            if isinstance(item, Exception):
                raise item
            return item

        relay._open = fake_open
        self.headers = {"X-SignalWarden-Space": "enabled", "Host": "127.0.0.1:8000", "Origin": "http://127.0.0.1:8000"}

    def tearDown(self):
        relay._open = self.old_open
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_guards_before_transport(self):
        os.environ["UCAS_SPACE_RELAY_ENABLED"] = "0"
        with self.assertRaises(relay.SpaceRelayError) as ctx:
            relay.dispatch("GET", ["status"], {}, self.headers)
        self.assertEqual((ctx.exception.status, ctx.exception.code), (404, "space_relay_disabled"))
        os.environ["UCAS_SPACE_RELAY_ENABLED"] = "1"
        with self.assertRaisesRegex(relay.SpaceRelayError, "X-SignalWarden-Space"):
            relay.dispatch("GET", ["status"], {}, {"Host": "x"})
        with self.assertRaisesRegex(relay.SpaceRelayError, "cross-site"):
            relay.dispatch("GET", ["status"], {}, {**self.headers, "Origin": "https://evil.example"})
        with self.assertRaisesRegex(relay.SpaceRelayError, "cross-site"):
            relay.dispatch("GET", ["status"], {}, {**self.headers, "Sec-Fetch-Site": "cross-site"})
        with self.assertRaisesRegex(relay.SpaceRelayError, "read-only"):
            relay.dispatch("POST", ["status"], {}, self.headers)
        for bad in (["0"], ["abc"], ["1", "2"], ["1234567890"], ["-5"]):
            with self.assertRaisesRegex(relay.SpaceRelayError, "norad"):
                relay.dispatch("GET", ["satnogs", "observations"], {"norad": bad}, self.headers)
        with self.assertRaisesRegex(relay.SpaceRelayError, "norad"):
            relay.dispatch("GET", ["satnogs", "observations"], {"norad": ["1"], "url": ["https://x"]}, self.headers)
        with self.assertRaisesRegex(relay.SpaceRelayError, "not found"):
            relay.dispatch("GET", ["anything"], {}, self.headers)
        self.assertEqual(self.requests, [])

    def test_satnogs_reduces_fields_and_excludes_future_and_other_objects(self):
        self.responses = [Response([
            satnogs_row(),
            satnogs_row(id=102, status="future"),
            satnogs_row(id=103, norad_cat_id=12345),
            satnogs_row(id=104, status="failed"),
        ])]
        body = relay.dispatch("GET", ["satnogs", "observations"], {"norad": ["99999"]}, self.headers)
        url = self.requests[0].full_url
        self.assertTrue(url.startswith("https://network.satnogs.org/api/observations/?norad_cat_id=99999&end="))
        self.assertEqual([o["id"] for o in body["observations"]], [101, 104])
        text = json.dumps(body)
        for leaked in ("someone", "12.3456", "65.4321", "observer", "station_lat"):
            self.assertNotIn(leaked, text)
        self.assertEqual(body["observations"][0]["stationName"], "TEST-STATION")
        self.assertIn("not optical", body["note"])
        self.assertFalse(body["cached"])
        self.assertIn("retrievedAt", body)
        again = relay.dispatch("GET", ["satnogs", "observations"], {"norad": ["99999"]}, self.headers)
        self.assertTrue(again["cached"])
        self.assertEqual(len(self.requests), 1)

    def test_launches_keyless_and_keyed_without_leaking_key(self):
        self.responses = [Response(LAUNCHES)]
        body = relay.dispatch("GET", ["launches", "upcoming"], {}, self.headers)
        self.assertFalse(body["keyConfigured"])
        self.assertIsNone(self.requests[0].get_header("Authorization"))
        self.assertEqual(body["results"][0]["name"], "Synthetic Rocket | Test Payload")
        self.assertNotIn("image", body["results"][0])
        relay.reset_state()
        os.environ["UCAS_LAUNCH_LIBRARY_API_KEY"] = FAKE_KEY
        self.responses = [Response(LAUNCHES)]
        body = relay.dispatch("GET", ["launches", "upcoming"], {}, self.headers)
        self.assertEqual(self.requests[1].get_header("Authorization"), f"Token {FAKE_KEY}")
        self.assertTrue(body["keyConfigured"])
        self.assertNotIn(FAKE_KEY, json.dumps(body))
        status = relay.dispatch("GET", ["status"], {}, self.headers)
        self.assertEqual(status["launchLibrary"]["apiKey"], "configured")
        self.assertNotIn(FAKE_KEY, json.dumps(status))

    def test_invalid_key_is_treated_as_not_configured(self):
        os.environ["UCAS_LAUNCH_LIBRARY_API_KEY"] = "bad key\r\nX-Injected: 1"
        self.assertEqual(relay.status()["launchLibrary"]["apiKey"], "not_configured")

    def test_upstream_errors_are_generic_and_throttled(self):
        os.environ["UCAS_LAUNCH_LIBRARY_API_KEY"] = FAKE_KEY
        self.responses = [HTTPError("https://ll.thespacedevs.com/x", 429, "slow down", {}, io.BytesIO())]
        with self.assertRaises(relay.SpaceRelayError) as ctx:
            relay.dispatch("GET", ["launches", "upcoming"], {}, self.headers)
        self.assertEqual(ctx.exception.code, "space_upstream_rate_limited")
        self.assertNotIn(FAKE_KEY, ctx.exception.message)
        with self.assertRaises(relay.SpaceRelayError) as ctx:
            relay.dispatch("GET", ["launches", "upcoming"], {}, self.headers)
        self.assertEqual(ctx.exception.code, "space_relay_throttled")
        self.assertEqual(len(self.requests), 1)
        relay.reset_state()
        self.responses = [URLError("boom " + FAKE_KEY)]
        with self.assertRaises(relay.SpaceRelayError) as ctx:
            relay.dispatch("GET", ["satnogs", "observations"], {"norad": ["5"]}, self.headers)
        self.assertNotIn(FAKE_KEY, ctx.exception.message)

    def test_size_limit_and_invalid_json(self):
        self.responses = [Response(b"[]", length=relay.MAX_BYTES + 1)]
        with self.assertRaisesRegex(relay.SpaceRelayError, "size limit"):
            relay.dispatch("GET", ["satnogs", "observations"], {"norad": ["7"]}, self.headers)
        relay.reset_state()
        self.responses = [Response(b"x" * (relay.MAX_BYTES + 10), length=0)]
        with self.assertRaisesRegex(relay.SpaceRelayError, "size limit"):
            relay.dispatch("GET", ["satnogs", "observations"], {"norad": ["7"]}, self.headers)
        relay.reset_state()
        self.responses = [Response(b"<html>")]
        with self.assertRaisesRegex(relay.SpaceRelayError, "invalid JSON"):
            relay.dispatch("GET", ["satnogs", "observations"], {"norad": ["7"]}, self.headers)

    def test_host_allowlist(self):
        with self.assertRaisesRegex(relay.SpaceRelayError, "allowlisted"):
            relay._get_json("https://evil.example/api", {})
        with self.assertRaisesRegex(relay.SpaceRelayError, "allowlisted"):
            relay._get_json("http://network.satnogs.org/api", {})
        self.assertEqual(self.requests, [])


class RouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(API))
        app_spec = importlib.util.spec_from_file_location("space_route_app", API / "app.py")
        cls.app = importlib.util.module_from_spec(app_spec)
        sys.modules[app_spec.name] = cls.app
        app_spec.loader.exec_module(cls.app)
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

    def test_disabled_by_default_and_status_route(self):
        old = os.environ.pop("UCAS_SPACE_RELAY_ENABLED", None)
        try:
            status, body = self.request("/api/v1/worldview/space/status")
            self.assertEqual((status, body["error"]["code"]), (404, "space_relay_disabled"))
            os.environ["UCAS_SPACE_RELAY_ENABLED"] = "1"
            status, body = self.request("/api/v1/worldview/space/status", {"X-SignalWarden-Space": "enabled"})
            self.assertEqual(status, 200)
            self.assertTrue(body["enabled"])
            status, body = self.request(
                "/api/v1/worldview/space/status",
                {"X-SignalWarden-Space": "enabled", "Host": f"127.0.0.1:{self.port}", "Origin": "https://foreign.example"},
            )
            self.assertEqual((status, body["error"]["code"]), (403, "origin_not_allowed"))
        finally:
            if old is None:
                os.environ.pop("UCAS_SPACE_RELAY_ENABLED", None)
            else:
                os.environ["UCAS_SPACE_RELAY_ENABLED"] = old


if __name__ == "__main__":
    unittest.main()
