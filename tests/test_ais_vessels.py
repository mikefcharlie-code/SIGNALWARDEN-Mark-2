"""AIS vessel relay tests: fixtures and fakes only, never the network."""
import asyncio
import importlib.util
import io
import json
import os
import socket
import sys
import threading
import unittest
from http.client import HTTPConnection
from pathlib import Path
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "management-api"))
sys.path.insert(0, str(ROOT / "tests"))
import ais_vessels as av  # noqa: E402

from test_ais_nmea import T1, T5, T18, T24A, tagged  # noqa: E402

KEY = "test-aisstream-key-should-never-leak-123"
BW_ID, BW_SECRET = "bw-client-id-xyz", "bw-client-secret-should-never-leak"
ENV = ("UCAS_PUBLIC_AIS_ENABLED", "UCAS_AISSTREAM_API_KEY", "UCAS_KYSTVERKET_AIS_ENABLED",
       "UCAS_BARENTSWATCH_CLIENT_ID", "UCAS_BARENTSWATCH_CLIENT_SECRET")
BERGEN = av.BBox(south=59.5, west=4.0, north=61.0, east=6.5)

# Recorded-shape AISStream frames (documented envelope; values are fixtures).
AISSTREAM_POSITION = {
    "MessageType": "PositionReport",
    "MetaData": {"MMSI": 259000420, "MMSI_String": 259000420, "ShipName": "AUGUSTSON           ",
                 "latitude": 60.39, "longitude": 5.32, "time_utc": "2026-10-30 21:00:00.318353 +0000 UTC"},
    "Message": {"PositionReport": {"Cog": 308, "CommunicationState": 81982, "Latitude": 60.39, "Longitude": 5.32,
                                   "MessageID": 1, "NavigationalStatus": 0, "PositionAccuracy": True, "Raim": False,
                                   "RateOfTurn": 0, "RepeatIndicator": 0, "Sog": 10.2, "Spare": 0,
                                   "SpecialManoeuvreIndicator": 0, "Timestamp": 31, "TrueHeading": 305,
                                   "UserID": 259000420, "Valid": True}},
}
AISSTREAM_STATIC = {
    "MessageType": "ShipStaticData",
    "MetaData": {"MMSI": 259000420, "ShipName": "AUGUSTSON", "time_utc": "2026-10-30 21:00:01 +0000 UTC"},
    "Message": {"ShipStaticData": {"UserID": 259000420, "Name": "AUGUSTSON           ", "Type": 52, "CallSign": "LAXY",
                                   "Destination": "BERGEN", "ImoNumber": 1234567, "Valid": True}},
}
AISSTREAM_CLASS_B = {
    "MessageType": "StandardClassBPositionReport",
    "MetaData": {"MMSI": 257999000, "time_utc": "2026-10-30 21:00:02 +0000 UTC"},
    "Message": {"StandardClassBPositionReport": {"UserID": 257999000, "Latitude": 60.0, "Longitude": 5.0, "Sog": 102.3,
                                                 "Cog": 360, "TrueHeading": 511, "Valid": True}},
}
AISSTREAM_OUTSIDE = json.loads(json.dumps(AISSTREAM_POSITION))
AISSTREAM_OUTSIDE["Message"]["PositionReport"].update({"UserID": 111111111, "Latitude": 10.0, "Longitude": 10.0})
WALL = 1793394030.0  # 2026-10-30T21:00:30Z


class EnvCase(unittest.TestCase):
    def setUp(self):
        self.saved = {k: os.environ.get(k) for k in ENV}
        for k in ENV:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


class Clock:
    def __init__(self, t=1000.0): self.t = t
    def __call__(self): return self.t


class BBoxAndStoreTests(unittest.TestCase):
    def test_bbox_validation_and_cap(self):
        q = lambda **kw: {k: [str(v)] for k, v in kw.items()}
        box = av.parse_bbox(q(south=59.5, west=4, north=61, east=6.5))
        self.assertTrue(box.contains(60, 5))
        for bad in (q(south=61, west=4, north=59, east=6), q(south=50, west=4, north=60, east=6),
                    q(south=59, west=170, north=60, east=-170), q(south="nan", west=4, north=60, east=6),
                    q(south=59, west=4, north=60), {"south": ["1", "2"], "west": ["4"], "north": ["5"], "east": ["6"]}):
            with self.assertRaises(av.AisRelayError):
                av.parse_bbox(bad)

    def test_latest_position_static_merge_ttl_and_stale(self):
        wall = Clock(WALL)
        store = av.VesselStore(wall)
        store.update(mmsi=259000420, name="NORDIC TEST", ship_type=70)  # static before position
        store.update(mmsi=259000420, ais_class="A", lat=60.0, lon=5.0, sog=1.0, cog=2.0, heading=3, nav_status=0, provider_time=WALL - 5)
        store.update(mmsi=259000420, ais_class="A", lat=60.1, lon=5.1, sog=4.0, cog=5.0, heading=6, nav_status=5, provider_time=WALL - 1)
        vessels, total = store.snapshot(BERGEN)
        self.assertEqual(total, 1)
        v = vessels[0]
        self.assertEqual((v["lat"], v["name"], v["shipTypeText"], v["navStatusText"], v["stale"]), (60.1, "NORDIC TEST", "Cargo", "Moored", False))
        self.assertEqual(v["providerTimestamp"], "2026-10-30T21:00:29Z")
        wall.t += av.STALE_AFTER_SECONDS + 5
        self.assertTrue(store.snapshot(BERGEN)[0][0]["stale"])
        wall.t += av.POSITION_TTL_SECONDS
        self.assertEqual(store.snapshot(BERGEN), ([], 0))

    def test_future_provider_time_clamped_and_capacity_bounded(self):
        store = av.VesselStore(Clock(WALL))
        store.update(mmsi=1, lat=60, lon=5, provider_time=WALL + 3600)
        self.assertEqual(store.snapshot(BERGEN)[0][0]["ageSeconds"], 0)
        for i in range(av.MAX_VESSELS + 50):
            store.update(mmsi=100000 + i, lat=60, lon=5)
        self.assertLessEqual(len(store.vessels), av.MAX_VESSELS)
        vessels, total = store.snapshot(BERGEN)
        self.assertEqual(len(vessels), av.MAX_RETURNED)
        self.assertGreater(total, av.MAX_RETURNED)
        store.update(mmsi=0, lat=60, lon=5)
        store.update(mmsi="x", lat=60, lon=5)
        self.assertNotIn(0, store.vessels)


class AisStreamParseTests(unittest.TestCase):
    def test_position_static_and_class_b(self):
        p = av.parse_aisstream_message(json.dumps(AISSTREAM_POSITION).encode())
        self.assertEqual((p["mmsi"], p["lat"], p["lon"], p["sog"], p["cog"], p["heading"], p["nav_status"], p["name"], p["ais_class"]),
                         (259000420, 60.39, 5.32, 10.2, 308.0, 305, 0, "AUGUSTSON", "A"))
        self.assertAlmostEqual(p["provider_time"], 1793394000.318353, places=3)
        s = av.parse_aisstream_message(json.dumps(AISSTREAM_STATIC))
        self.assertEqual(s, {"mmsi": 259000420, "name": "AUGUSTSON", "ship_type": 52})  # no callsign/IMO/destination
        b = av.parse_aisstream_message(json.dumps(AISSTREAM_CLASS_B))
        self.assertEqual((b["ais_class"], b["sog"], b["cog"], b["heading"]), ("B", None, None, None))
        self.assertIsNone(av.parse_aisstream_message(json.dumps({"MessageType": "SubscriptionConfirmation", "Message": {}})))
        invalid = json.loads(json.dumps(AISSTREAM_POSITION)); invalid["Message"]["PositionReport"]["Valid"] = False
        self.assertIsNone(av.parse_aisstream_message(json.dumps(invalid)))

    def test_subscription_shape(self):
        sub = json.loads(av.aisstream_subscription("k", BERGEN))
        self.assertEqual(sub["BoundingBoxes"], [[[59.5, 4.0], [61.0, 6.5]]])
        self.assertIn("PositionReport", sub["FilterMessageTypes"])
        self.assertIn("ShipStaticData", sub["FilterMessageTypes"])


class FakeWs:
    def __init__(self, frames, worker):
        self.frames, self.worker, self.sent = list(frames), worker, []
    async def __aenter__(self): return self
    async def __aexit__(self, *exc): return False
    async def send(self, text): self.sent.append(text)
    async def recv(self):
        if self.frames:
            return self.frames.pop(0)
        self.worker.stop_event.set()
        await asyncio.sleep(0)
        raise asyncio.TimeoutError()


class AisStreamWorkerTests(EnvCase):
    def make(self, frames):
        holder = {}
        def connect(url):
            holder["url"] = url
            holder["ws"] = FakeWs(frames, worker)
            return holder["ws"]
        worker = av.AisStreamWorker(connect=connect, clock=Clock(), wall=Clock(WALL))
        worker.bbox, worker.last_poll = BERGEN, worker.clock()
        return worker, holder

    def test_session_subscribes_and_stores_in_box_only(self):
        os.environ["UCAS_AISSTREAM_API_KEY"] = KEY
        frames = [json.dumps({"MessageType": "SubscriptionConfirmation", "Message": {"CompressionEnabled": True}}).encode(),
                  json.dumps(AISSTREAM_STATIC).encode(), json.dumps(AISSTREAM_POSITION).encode(),
                  json.dumps(AISSTREAM_OUTSIDE).encode(), b"not json"]
        worker, holder = self.make(frames)
        worker.session()
        self.assertEqual(holder["url"], "wss://stream.aisstream.io/v0/stream")
        sub = json.loads(holder["ws"].sent[0])
        self.assertEqual(sub["APIKey"], KEY)
        vessels, total = worker.store.snapshot(BERGEN)
        self.assertEqual(total, 1)
        self.assertEqual((vessels[0]["mmsi"], vessels[0]["shipTypeText"]), (259000420, "Tug"))
        self.assertEqual(worker.health()["state"], "live")
        self.assertNotIn(KEY, json.dumps(worker.health()))
    def test_acknowledgement_and_malformed_frames_do_not_mark_live(self):
        os.environ["UCAS_AISSTREAM_API_KEY"] = KEY
        invalid = json.loads(json.dumps(AISSTREAM_POSITION))
        invalid["Message"]["PositionReport"]["Latitude"] = 91
        frames = [json.dumps({"MessageType": "SubscriptionConfirmation", "Message": {}}).encode(),
                  b"not json", json.dumps(invalid).encode()]
        worker, _ = self.make(frames)
        worker.session()
        self.assertNotEqual(worker.health()["state"], "live")
        self.assertEqual(worker.messages, 0)


    def test_error_frame_redacts_key(self):
        os.environ["UCAS_AISSTREAM_API_KEY"] = KEY
        worker, _ = self.make([json.dumps({"error": f"Api Key Is Not Valid: {KEY}"})])
        with self.assertRaises(av.ProviderError) as ctx:
            worker.session()
        self.assertNotIn(KEY, str(ctx.exception))
        self.assertIn("rejected", str(ctx.exception))

    def test_connection_errors_are_sanitized(self):
        os.environ["UCAS_AISSTREAM_API_KEY"] = KEY
        def connect(url):
            raise OSError(f"boom {KEY}")
        worker = av.AisStreamWorker(connect=connect, clock=Clock(), wall=Clock(WALL))
        worker.bbox, worker.last_poll = BERGEN, worker.clock()
        with self.assertRaises(av.ProviderError) as ctx:
            worker.session()
        self.assertNotIn(KEY, str(ctx.exception))

    def test_missing_key_never_connects(self):
        called = []
        worker = av.AisStreamWorker(connect=lambda url: called.append(url), clock=Clock(), wall=Clock(WALL))
        worker.bbox = BERGEN
        with self.assertRaisesRegex(av.ProviderError, "not configured"):
            worker.session()
        self.assertEqual(called, [])


class FakeSocket:
    def __init__(self, chunks, worker):
        self.chunks, self.worker, self.closed = list(chunks), worker, False
    def settimeout(self, value): self.timeout = value
    def recv(self, size):
        if self.chunks:
            return self.chunks.pop(0)
        self.worker.stop_event.set()
        raise socket.timeout()
    def close(self): self.closed = True


class KystverketWorkerTests(unittest.TestCase):
    def test_malformed_lines_do_not_refresh_live_status(self):
        worker = av.KystverketWorker(clock=Clock(), wall=Clock(WALL))
        worker.bbox, worker.last_poll = BERGEN, worker.clock()
        worker.feed_line(b"not an AIS sentence")
        self.assertNotEqual(worker.health()["state"], "live")
        self.assertEqual(worker.messages, 0)

    def test_tcp_stream_decodes_and_filters(self):
        holder = {}
        outside = "!AIVDM,1,1,,B,15M67FC000G?ufbE`FepT@3n00Sa,0*5C"  # San Francisco: outside the box
        lines = [tagged(T5[0], 1793394000), T5[1], tagged(T1, 1793394020), outside, T24A, T18, "garbage", "!" + "x" * 9000]
        stream = ("\r\n".join(lines) + "\r\n").encode()
        chunks = [stream[i:i + 37] for i in range(0, len(stream), 37)]  # split mid-sentence
        def connect(address):
            holder["address"] = address
            holder["sock"] = FakeSocket(chunks, worker)
            return holder["sock"]
        worker = av.KystverketWorker(connect=connect, clock=Clock(), wall=Clock(WALL))
        worker.bbox, worker.last_poll = BERGEN, worker.clock()
        worker.session()
        self.assertEqual(holder["address"], ("153.44.253.27", 5631))
        self.assertTrue(holder["sock"].closed)
        vessels = {v["mmsi"]: v for v in worker.store.snapshot(BERGEN)[0]}
        self.assertEqual(set(vessels), {259000420, 257999000})
        a = vessels[259000420]
        self.assertEqual((a["name"], a["shipType"], a["sogKn"], a["providerTimestamp"], a["aisClass"]), ("NORDIC TEST", 70, 12.3, "2026-10-30T21:00:20Z", "A"))
        b = vessels[257999000]
        self.assertEqual((b["name"], b["aisClass"]), ("SEA BREEZE", "B"))

    def test_unreachable_feed_is_reported(self):
        def connect(address): raise OSError("timed out")
        worker = av.KystverketWorker(connect=connect, clock=Clock(), wall=Clock(WALL))
        worker.bbox, worker.last_poll = BERGEN, worker.clock()
        with self.assertRaisesRegex(av.ProviderError, "could not be reached"):
            worker.session()

    def test_closed_connection_is_error(self):
        worker = av.KystverketWorker(clock=Clock(), wall=Clock(WALL))
        worker.connect = lambda address: FakeSocket([b""], worker)
        worker.bbox, worker.last_poll = BERGEN, worker.clock()
        with self.assertRaisesRegex(av.ProviderError, "closed"):
            worker.session()


class Resp(io.BytesIO):
    pass


class FakeOpener:
    def __init__(self, responses): self.responses, self.requests = list(responses), []
    def open(self, request, timeout=None):
        self.requests.append(request)
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return Resp(item)


BW_ROWS = [
    {"courseOverGround": 187.5, "latitude": 60.3913, "longitude": 5.3221, "name": "NORDIC TEST", "rateOfTurn": 0,
     "shipType": 70, "speedOverGround": 12.3, "trueHeading": 185, "navigationalStatus": 0, "mmsi": 259000420,
     "msgtime": "2026-10-30T21:00:20+00:00", "stream": "terrestrial"},
    {"courseOverGround": None, "latitude": 70.0, "longitude": 20.0, "name": "FAR AWAY", "mmsi": 258000000,
     "msgtime": "2026-10-30T21:00:00+00:00", "navigationalStatus": 5},
    {"mmsi": 1, "latitude": None, "longitude": 5},
]


class BarentsWatchTests(EnvCase):
    def test_token_then_bounded_snapshot_and_throttle(self):
        os.environ.update({"UCAS_BARENTSWATCH_CLIENT_ID": BW_ID, "UCAS_BARENTSWATCH_CLIENT_SECRET": BW_SECRET})
        opener = FakeOpener([json.dumps({"access_token": "tok", "expires_in": 3600}).encode(), json.dumps(BW_ROWS).encode()])
        clock = Clock()
        poller = av.BarentsWatchPoller(opener=opener, clock=clock, wall=Clock(WALL))
        poller.refresh(BERGEN)
        token_req, data_req = opener.requests
        self.assertEqual(token_req.full_url, "https://id.barentswatch.no/connect/token")
        self.assertIn(b"scope=ais", token_req.data)
        self.assertEqual(data_req.full_url, "https://live.ais.barentswatch.no/v1/latest/combined")
        self.assertEqual(data_req.get_header("Authorization"), "Bearer tok")
        body = json.loads(data_req.data)
        self.assertEqual(body["geometry"]["coordinates"][0][0], [4.0, 59.5])
        self.assertEqual(body["modelType"], "Simple")
        vessels = poller.store.snapshot(BERGEN)[0]
        self.assertEqual([v["mmsi"] for v in vessels], [259000420])
        self.assertEqual(vessels[0]["navStatusText"], "Under way using engine")
        self.assertEqual(poller.health()["state"], "live")
        poller.refresh(BERGEN)  # throttled: no new request
        self.assertEqual(len(opener.requests), 2)

    def test_all_malformed_rows_do_not_mark_live_or_clear_valid_snapshot(self):
        os.environ.update({"UCAS_BARENTSWATCH_CLIENT_ID": BW_ID, "UCAS_BARENTSWATCH_CLIENT_SECRET": BW_SECRET})
        bad_rows = [{"mmsi": "bad", "latitude": "not-a-number", "longitude": 5}]
        opener = FakeOpener([json.dumps({"access_token": "tok", "expires_in": 3600}).encode(),
                             json.dumps(BW_ROWS).encode(), json.dumps(bad_rows).encode()])
        clock = Clock()
        poller = av.BarentsWatchPoller(opener=opener, clock=clock, wall=Clock(WALL))
        poller.refresh(BERGEN)
        self.assertEqual(poller.health()["state"], "live")
        clock.t += av.BARENTSWATCH_MIN_INTERVAL + 1
        poller.refresh(BERGEN)
        self.assertEqual(poller.health()["state"], "error")
        self.assertIn("no valid AIS positions", poller.health()["error"])
        self.assertEqual([v["mmsi"] for v in poller.store.snapshot(BERGEN)[0]], [259000420])

    def test_http_errors_never_echo_credentials(self):
        os.environ.update({"UCAS_BARENTSWATCH_CLIENT_ID": BW_ID, "UCAS_BARENTSWATCH_CLIENT_SECRET": BW_SECRET})
        err = HTTPError("https://id.barentswatch.no/connect/token", 400, BW_SECRET, {}, io.BytesIO(BW_SECRET.encode()))
        poller = av.BarentsWatchPoller(opener=FakeOpener([err]), clock=Clock(), wall=Clock(WALL))
        poller.refresh(BERGEN)
        health = json.dumps(poller.health())
        self.assertEqual(poller.health()["state"], "error")
        self.assertNotIn(BW_SECRET, health)
        self.assertNotIn(BW_ID, health)
        self.assertIn("HTTP 400", health)

    def test_oversize_response_rejected(self):
        os.environ.update({"UCAS_BARENTSWATCH_CLIENT_ID": BW_ID, "UCAS_BARENTSWATCH_CLIENT_SECRET": BW_SECRET})
        big = b"[" + b" " * (av.BARENTSWATCH_MAX_BYTES + 10) + b"]"
        poller = av.BarentsWatchPoller(opener=FakeOpener([json.dumps({"access_token": "t"}).encode(), big]), clock=Clock(), wall=Clock(WALL))
        poller.refresh(BERGEN)
        self.assertIn("size limit", poller.health()["error"])


HEADERS = {"X-SignalWarden-AIS": "enabled", "Host": "127.0.0.1:8000", "Origin": "http://127.0.0.1:8000"}
VQ = {"provider": ["aisstream"], "south": ["59.5"], "west": ["4"], "north": ["61"], "east": ["6.5"]}


class HandleTests(EnvCase):
    def relay(self):
        return av.AisRelay(workers={"aisstream": av.AisStreamWorker(connect=lambda url: None),
                                    "kystverket": av.KystverketWorker(connect=lambda a: None),
                                    "barentswatch": av.BarentsWatchPoller(opener=FakeOpener([]))})

    def test_disabled_by_default_and_guards(self):
        with self.assertRaises(av.AisRelayError) as ctx:
            av.handle("GET", ["status"], {}, HEADERS, self.relay())
        self.assertEqual((ctx.exception.status, ctx.exception.code), (404, "public_ais_disabled"))
        os.environ["UCAS_PUBLIC_AIS_ENABLED"] = "1"
        for headers, code in (({**HEADERS, "X-SignalWarden-AIS": "no"}, "ais_header_required"),
                              ({**HEADERS, "Origin": "https://evil.example"}, "origin_not_allowed"),
                              ({**HEADERS, "Sec-Fetch-Site": "cross-site"}, "origin_not_allowed")):
            with self.assertRaises(av.AisRelayError) as ctx:
                av.handle("GET", ["status"], {}, headers, self.relay())
            self.assertEqual(ctx.exception.code, code)
        with self.assertRaises(av.AisRelayError) as ctx:
            av.handle("POST", ["status"], {}, HEADERS, self.relay())
        self.assertEqual(ctx.exception.status, 405)
        for query in ({**VQ, "provider": ["marinetraffic"]}, {**VQ, "apikey": ["x"]}):
            with self.assertRaises(av.AisRelayError):
                av.handle("GET", ["vessels"], query, HEADERS, self.relay())

    def test_not_configured_is_explicit_and_fabricates_nothing(self):
        os.environ["UCAS_PUBLIC_AIS_ENABLED"] = "1"
        relay = self.relay()
        status = av.handle("GET", ["status"], {}, HEADERS, relay)
        states = {p["provider"]: p["status"] for p in status["providers"]}
        self.assertEqual(states, {"aisstream": "not_configured", "kystverket": "not_configured", "barentswatch": "not_configured"})
        self.assertFalse(status["transmit"])
        body = av.handle("GET", ["vessels"], VQ, HEADERS, relay)
        self.assertEqual((body["status"], body["vessels"]), ("not_configured", []))
        self.assertIn("UCAS_AISSTREAM_API_KEY", body["message"])
        self.assertIn("self-reported", body["disclosure"])
        self.assertIsNone(relay.workers["aisstream"].thread)  # no connection attempted

    def test_configured_status_never_contains_secrets(self):
        os.environ.update({"UCAS_PUBLIC_AIS_ENABLED": "1", "UCAS_AISSTREAM_API_KEY": KEY,
                           "UCAS_BARENTSWATCH_CLIENT_ID": BW_ID, "UCAS_BARENTSWATCH_CLIENT_SECRET": BW_SECRET,
                           "UCAS_KYSTVERKET_AIS_ENABLED": "1"})
        text = json.dumps(av.handle("GET", ["status"], {}, HEADERS, self.relay()))
        for secret in (KEY, BW_ID, BW_SECRET):
            self.assertNotIn(secret, text)
        self.assertIn("NLOD", text)

    def test_vessels_from_configured_stream_worker(self):
        os.environ.update({"UCAS_PUBLIC_AIS_ENABLED": "1", "UCAS_AISSTREAM_API_KEY": KEY})
        relay = self.relay()
        worker = relay.workers["aisstream"]
        worker.touch = lambda bbox: setattr(worker, "bbox", bbox)  # no thread in unit test
        worker.store.update(mmsi=259000420, lat=60.0, lon=5.0, sog=3.0, provider_time=None)
        worker.state, worker.last_message_at = "live", worker.wall()
        body = av.handle("GET", ["vessels"], VQ, HEADERS, relay)
        self.assertEqual(body["status"], "live")
        self.assertEqual(body["vessels"][0]["mmsi"], 259000420)
        self.assertEqual(body["attribution"], "Vessel data: AISStream.io")
        self.assertNotIn(KEY, json.dumps(body))


class WorkerLifecycleTests(EnvCase):
    def test_thread_starts_on_poll_and_stops_when_idle(self):
        os.environ["UCAS_AISSTREAM_API_KEY"] = KEY
        clock = Clock()
        started = threading.Event()
        class Ws(FakeWs):
            async def recv(self):
                started.set()
                clock.t += av.IDLE_DISCONNECT_SECONDS + 1  # no poll arrives: idle disconnect
                raise asyncio.TimeoutError()
        worker = av.AisStreamWorker(connect=lambda url: Ws([], worker), clock=clock, wall=Clock(WALL))
        worker.touch(BERGEN)
        worker.thread.join(5)
        self.assertTrue(started.is_set())
        self.assertFalse(worker.thread.is_alive())
        self.assertEqual(worker.state, "idle")

    def test_failure_sets_error_and_backoff(self):
        clock = Clock()
        worker = av.KystverketWorker(connect=lambda a: (_ for _ in ()).throw(OSError("x")), clock=clock, wall=Clock(WALL))
        def stop_after_first(message):
            av.StreamWorker._fail(worker, message)
            worker.stop_event.set()
        worker._fail = stop_after_first
        worker.touch(BERGEN)
        worker.thread.join(5)
        self.assertEqual(worker.state, "error")
        self.assertIn("could not be reached", worker.error)
        self.assertGreater(worker.retry_after, clock.t)


class RouteTests(EnvCase):
    @classmethod
    def setUpClass(cls):
        app_path = ROOT / "services/management-api/app.py"
        spec = importlib.util.spec_from_file_location("ais_route_app", app_path)
        cls.app = importlib.util.module_from_spec(spec); sys.modules[spec.name] = cls.app; spec.loader.exec_module(cls.app)
        cls.app.STORE = cls.app.InMemoryStore(); cls.server = cls.app.create_server("127.0.0.1", 0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True); cls.thread.start(); cls.port = cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join(timeout=2)

    def request(self, path, headers=None):
        conn = HTTPConnection("127.0.0.1", self.port, timeout=3); conn.request("GET", path, headers=headers or {})
        response = conn.getresponse(); body = response.read(); conn.close(); return response.status, json.loads(body)

    def test_route_disabled_then_not_configured(self):
        status, body = self.request("/api/v1/public-ais/status")
        self.assertEqual((status, body["error"]["code"]), (404, "public_ais_disabled"))
        os.environ["UCAS_PUBLIC_AIS_ENABLED"] = "1"
        headers = {"X-SignalWarden-AIS": "enabled", "Host": f"127.0.0.1:{self.port}", "Origin": f"http://127.0.0.1:{self.port}"}
        status, body = self.request("/api/v1/public-ais/vessels?provider=kystverket&south=59&west=4&north=61&east=6", headers)
        self.assertEqual((status, body["status"], body["vessels"]), (200, "not_configured", []))
        status, body = self.request("/api/v1/public-ais/vessels?provider=aisstream&south=0&west=0&north=40&east=40", headers)
        self.assertEqual((status, body["error"]["code"]), (400, "ais_bbox_too_large"))


if __name__ == "__main__":
    unittest.main()
