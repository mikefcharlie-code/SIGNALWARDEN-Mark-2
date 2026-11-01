"""Mock-only tests for the WorldView mobility/context relay. CI never reaches the network."""
import importlib.util
import io
import json
import os
import struct
import sys
import threading
import unittest
from http.client import HTTPConnection
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
API_DIR = ROOT / "services" / "management-api"
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import gtfs_realtime_lite as gtfs  # noqa: E402
import worldview_mobility as wm  # noqa: E402
import worldview_mobility_parsers as parse  # noqa: E402

NOW = 1793397378.0  # fixture "current" epoch seconds (2026-10-30T21:56:18Z)
SECRET = "SEKRETkey0123456789abcdef"
HEADERS = {wm.HEADER: "enabled", "Host": "127.0.0.1:8000", "Origin": "http://127.0.0.1:8000"}
ENV_KEYS = ("UCAS_WORLDVIEW_MOBILITY_ENABLED", "UCAS_WORLDVIEW_CONTACT", "UCAS_GBFS_FEEDS_JSON", "UCAS_GTFSRT_FEEDS_JSON",
            "UCAS_GTFSRT_511_API_KEY", "UCAS_GTFSRT_MTA_BUS_KEY", "UCAS_MAPILLARY_ACCESS_TOKEN", "UCAS_NOMINATIM_URL",
            "UCAS_PANORAMAX_URL", "UCAS_RADIO_BROWSER_URL", "UCAS_OVERPASS_URL", "UCAS_TEST_FEED_KEY")


def q(**kwargs):
    return {k: [str(v)] for k, v in kwargs.items()}


class FakeTransport:
    """Routes by URL substring; records every call (url, headers)."""

    def __init__(self, routes):
        self.routes, self.calls = list(routes), []

    def __call__(self, url, *, allowed_hosts, headers=None, max_bytes=wm.SMALL_BYTES):
        self.calls.append({"url": url, "headers": dict(headers or {}), "hosts": allowed_hosts, "max_bytes": max_bytes})
        for needle, reply in self.routes:
            if needle in url:
                if isinstance(reply, Exception):
                    raise reply
                if callable(reply):
                    reply = reply()
                if isinstance(reply, bytes):
                    return reply, "application/octet-stream"
                return json.dumps(reply).encode(), "application/json"
        raise AssertionError("unexpected upstream URL " + url)


# ------------------------------------------------------------------ fixtures

GBFS_HOST = "https://gbfs.example.org/sys"
GBFS2_DISCOVERY = {"last_updated": int(NOW) - 5, "ttl": 60, "data": {"fr": {"feeds": []}, "en": {"feeds": [
    {"name": "system_information", "url": f"{GBFS_HOST}/system_information.json"},
    {"name": "station_information", "url": f"{GBFS_HOST}/station_information.json"},
    {"name": "station_status", "url": f"{GBFS_HOST}/station_status.json"},
    {"name": "free_bike_status", "url": f"{GBFS_HOST}/free_bike_status.json"},
]}}}
GBFS2_SYSTEM = {"last_updated": int(NOW) - 5, "ttl": 60, "data": {"name": "Example Bikes", "operator": "Example Op",
                                                                    "license_url": "https://example.org/license", "timezone": "America/New_York"}}
GBFS2_STATION_INFO = {"last_updated": int(NOW) - 5, "ttl": 60, "data": {"stations": [
    {"station_id": "s1", "name": "Main & 1st", "lat": 40.71, "lon": -74.0, "capacity": 20},
    {"station_id": "s2", "name": "Far away", "lat": 41.5, "lon": -74.0, "capacity": 10},
    {"station_id": "s3", "name": "Null island", "lat": 0, "lon": 0},
    {"station_id": "s4", "name": "Never reported", "lat": 40.72, "lon": -74.01},
]}}
GBFS2_STATION_STATUS = {"last_updated": int(NOW) - 5, "ttl": 30, "data": {"stations": [
    {"station_id": "s1", "num_bikes_available": 7, "num_ebikes_available": 2, "num_docks_available": 13,
     "is_renting": 1, "is_returning": True, "last_reported": int(NOW) - 30},
    {"station_id": "s4", "num_bikes_available": 0, "num_docks_available": 0, "is_renting": 0, "last_reported": 86400},
]}}
GBFS2_FREE_BIKES = {"last_updated": int(NOW) - 5, "ttl": 30, "data": {"bikes": [
    {"bike_id": "ROTATING-PRIVACY-ID-1", "lat": 40.715, "lon": -74.005, "is_reserved": 0, "is_disabled": 0, "vehicle_type_id": "ebike",
     "current_range_meters": 12000, "last_reported": int(NOW) - 40},
    {"bike_id": "ROTATING-PRIVACY-ID-2", "lat": 40.716, "lon": -74.006, "is_reserved": 0, "is_disabled": 1},
    {"bike_id": "docked-no-position"},
]}}
GBFS3_DISCOVERY = {"last_updated": "2026-10-31T20:36:13Z", "ttl": 0, "version": "3.0", "data": {"feeds": [
    {"name": "system_information", "url": "https://gbfs3.example.org/system_information.json"},
    {"name": "vehicle_status", "url": "https://gbfs3.example.org/vehicle_status.json"},
]}}
GBFS3_SYSTEM = {"last_updated": "2026-10-31T20:36:13Z", "ttl": 0, "data": {
    "name": [{"text": "Scoot Three", "language": "en"}], "attribution_organization_name": "Scoot Co"}}
GBFS3_VEHICLES = {"last_updated": "2026-10-31T20:36:13Z", "ttl": 0, "data": {"vehicles": [
    {"vehicle_id": "rot-1", "lat": 40.71, "lon": -74.0, "is_reserved": False, "is_disabled": False,
     "vehicle_type_id": "scooter", "last_reported": "2026-10-31T20:35:00Z"},
]}}
BBOX = dict(west=-74.05, south=40.68, east=-73.95, north=40.78)


def gbfs_feed_env():
    return json.dumps([
        {"id": "example-bikes", "name": "Example Bikes", "url": f"{GBFS_HOST}/gbfs.json", "attribution": "Example Bikes LLC",
         "termsUrl": "https://example.org/terms"},
        {"id": "scoot3", "name": "Scoot 3", "url": "https://gbfs3.example.org/gbfs.json", "attribution": "Scoot"},
    ])


def vehicle(entity_id, lat, lon, *, route="1", vid=None, label=None, plate=None, ts=None, deleted=False, extra=b""):
    trip = gtfs.encode_field(1, f"trip-{entity_id}", "bytes") + gtfs.encode_field(5, route, "bytes") + gtfs.encode_field(6, 1, "varint")
    pos = gtfs.encode_field(1, lat, "float") + gtfs.encode_field(2, lon, "float") + gtfs.encode_field(3, 90.0, "float")
    pos += bytes([0x21]) + struct.pack("<d", 12345.5)  # field 4 odometer, wire type 1 (fixed64), skipped
    pos += gtfs.encode_field(5, 7.5, "float")
    desc = b""
    if vid:
        desc += gtfs.encode_field(1, vid, "bytes")
    if label:
        desc += gtfs.encode_field(2, label, "bytes")
    if plate:
        desc += gtfs.encode_field(3, plate, "bytes")
    vp = gtfs.encode_field(1, trip, "bytes") + gtfs.encode_field(2, pos, "bytes") + gtfs.encode_field(4, 2, "varint")
    vp += gtfs.encode_field(7, "stop-9", "bytes") + gtfs.encode_field(8, desc, "bytes")
    if ts is not None:
        vp += gtfs.encode_field(5, ts, "varint")
    vp += extra
    entity = gtfs.encode_field(1, entity_id, "bytes")
    if deleted:
        entity += gtfs.encode_field(2, 1, "varint")
    entity += gtfs.encode_field(4, vp, "bytes")
    return gtfs.encode_field(2, entity, "bytes")


def feed_message(header_ts=int(NOW) - 5, entities=()):
    header = gtfs.encode_field(1, "2.0", "bytes") + gtfs.encode_field(2, 0, "varint") + gtfs.encode_field(3, header_ts, "varint")
    return gtfs.encode_field(1, header, "bytes") + b"".join(entities)


GTFS_PAYLOAD = feed_message(entities=[
    vehicle("e1", 40.70, -74.00, route="M15", vid="bus-100", label="100", plate="ABC1234", ts=int(NOW) - 10,
            extra=gtfs.encode_field(99, 5, "varint")),  # unknown field skipped
    vehicle("e2", 40.71, -74.01, route="M20", vid="bus-200", ts=int(NOW) - 600),  # stale vehicle
    vehicle("e3", 41.90, -74.00, route="X", vid="bus-300", ts=int(NOW) - 5),  # outside bbox
    vehicle("e4", 40.72, -74.02, route="Y", vid="bus-400", ts=int(NOW) - 5, deleted=True),
    vehicle("e5", 40.73, -74.03, route="", ts=None),  # header timestamp basis, no vehicle id
])


def gtfs_feed_env(**extra):
    row = {"id": "test-agency", "name": "Test Agency", "url": "https://rt.example.org/vehicles.pb", "attribution": "Test Agency",
           "timezone": "America/New_York"}
    row.update(extra)
    return json.dumps([row])


MAPILLARY = {"data": [
    {"id": "1234567890", "captured_at": 1700000000000, "compass_angle": 45.5, "geometry": {"type": "Point", "coordinates": [-74.0, 40.71]},
     "thumb_256_url": "https://scontent.xx.fbcdn.net/m1/thumb.jpg", "creator": {"username": "mapper1", "id": "42"}},
    {"id": "not-numeric", "geometry": {"type": "Point", "coordinates": [-74.0, 40.71]}},
    {"id": "222", "geometry": {"type": "Point", "coordinates": [-74.0, 40.71]}, "thumb_256_url": "https://evil.example.com/x.jpg"},
]}
PANORAMAX = {"type": "FeatureCollection", "features": [{
    "id": "9cc38bf6-6a40-4adf-b2be-4447eb361202", "geometry": {"type": "Point", "coordinates": [2.351779, 48.856489]},
    "properties": {"datetime": "2023-05-20T17:55:39+00:00", "license": "CC-BY-SA-4.0", "view:azimuth": 120},
    "assets": {"thumb": {"href": "https://panoramax.example.org/derivatives/thumb.jpg"}},
    "links": [{"rel": "self", "href": "https://api.panoramax.xyz/api/collections/c/items/9cc38bf6-6a40-4adf-b2be-4447eb361202"},
              {"rel": "license", "href": "https://spdx.org/licenses/CC-BY-SA-4.0.html"},
              {"rel": "via", "href": "https://panoramax.example.org/api", "instance_name": "Example instance"}],
    "providers": [{"name": "mapcomplete", "roles": ["producer"]}, {"name": "host", "roles": ["host"]}],
}]}
KARTAVIEW = {"status": {"apiCode": "600"}, "result": {"data": [
    {"id": "3892463", "lat": "48.85578", "lng": "2.35166", "heading": "54.74", "shotDate": "2016-07-09 10:54:20",
     "sequenceId": "9214", "sequenceIndex": "68", "imageThUrl": "https://cdn.kartaview.org/pr:sharp/abc", "user": {"username": "kv"}},
    {"id": "x1", "lat": "48.8", "lng": "2.3"},
]}}
NOMINATIM = [{"place_id": 361897680, "osm_type": "relation", "osm_id": 17995454, "lat": "42.3550400", "lon": "-71.0660710",
              "category": "leisure", "type": "park", "display_name": "Boston Common, Boston, MA, United States",
              "boundingbox": ["42.3524782", "42.3576063", "-71.0691858", "-71.0621238"],
              "licence": "Data © OpenStreetMap contributors, ODbL 1.0. http://osm.org/copyright"},
             {"place_id": 1, "lat": "999", "lon": "0"}]
RADIO = [{"stationuuid": "d1a54d2e-623e-4970-ab11-35f7b56c5ec3", "name": "Classic Vinyl HD", "geo_lat": 40.75, "geo_long": -73.97,
          "url": "https://stream.example.com/live.mp3", "url_resolved": "https://stream.example.com/live.mp3",
          "favicon": "https://example.com/fav.png", "homepage": "http://walmradio.com/classic", "country": "USA", "state": "NY",
          "language": "english", "tags": "jazz", "lastcheckok": 1, "lastchangetime_iso8601": "2026-01-15T08:25:00Z"},
         {"stationuuid": "nogeo", "name": "No geo", "geo_lat": None, "geo_long": None}]
GDELT = {"articles": [
    {"url": "https://news.example.com/a", "title": "Subway delays continue", "seendate": "20261031T183000Z", "domain": "news.example.com",
     "language": "English", "sourcecountry": "United States", "socialimage": "https://news.example.com/i.jpg"},
    {"url": "javascript:alert(1)", "title": "bad"},
]}
OVERPASS = {"osm3s": {"timestamp_osm_base": "2026-10-31T20:00:00Z"}, "elements": [
    {"type": "node", "id": 1, "lat": 40.71, "lon": -74.0, "tags": {"telecom": "data_center", "name": "DC One", "operator": "Op"}},
    {"type": "way", "id": 2, "center": {"lat": 40.72, "lon": -74.01}, "tags": {"waterway": "dam"}},
    {"type": "way", "id": 3, "tags": {"waterway": "dam"}},  # no centre
    {"type": "node", "id": 4, "lat": 40.7, "lon": -74.0, "tags": {"amenity": "cafe"}},
]}


class Base(unittest.TestCase):
    def setUp(self):
        self.saved_env = {k: os.environ.get(k) for k in ENV_KEYS}
        for k in ENV_KEYS:
            os.environ.pop(k, None)
        os.environ["UCAS_WORLDVIEW_MOBILITY_ENABLED"] = "1"
        self.clock = [NOW]
        self.saved = (wm.transport, wm._now, wm.time.sleep)
        wm._now = lambda: self.clock[0]
        wm.time.sleep = lambda s: self.clock.__setitem__(0, self.clock[0] + s)
        wm.reset_state()

    def tearDown(self):
        wm.transport, wm._now, wm.time.sleep = self.saved
        wm.reset_state()
        for k, v in self.saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def fake(self, routes):
        fake = FakeTransport(routes)
        wm.transport = fake
        return fake

    def call(self, route, query, headers=HEADERS):
        status, body = wm.handle("GET", wm.ROUTE_PREFIX + [route], query, headers)
        self.assertEqual(status, 200)
        json.dumps(body)  # must be JSON-serialisable
        return body


# ------------------------------------------------------------------ guards

class GuardTests(Base):
    def test_disabled_by_default(self):
        os.environ.pop("UCAS_WORLDVIEW_MOBILITY_ENABLED")
        fake = self.fake([])
        with self.assertRaises(wm.MobilityError) as ctx:
            wm.handle("GET", wm.ROUTE_PREFIX + ["status"], {}, HEADERS)
        self.assertEqual((ctx.exception.status, ctx.exception.code), (404, "worldview_mobility_disabled"))
        os.environ["UCAS_WORLDVIEW_MOBILITY_ENABLED"] = "0"
        with self.assertRaises(wm.MobilityError):
            wm.handle("GET", wm.ROUTE_PREFIX + ["gbfs"], q(feed="citibike-nyc", **BBOX), HEADERS)
        self.assertEqual(fake.calls, [])

    def test_header_and_same_origin_required(self):
        fake = self.fake([])
        cases = [({k: v for k, v in HEADERS.items() if k != wm.HEADER}, "mobility_header_required"),
                 ({**HEADERS, wm.HEADER: "yes"}, "mobility_header_required"),
                 ({**HEADERS, "Origin": "https://evil.example"}, "origin_not_allowed"),
                 ({**HEADERS, "Sec-Fetch-Site": "cross-site"}, "origin_not_allowed")]
        for headers, code in cases:
            with self.subTest(code=code, headers=headers):
                with self.assertRaises(wm.MobilityError) as ctx:
                    wm.handle("GET", wm.ROUTE_PREFIX + ["radio"], q(lat=40, lon=-74), headers)
                self.assertEqual(ctx.exception.status, 403)
                self.assertEqual(ctx.exception.code, code)
        self.assertEqual(fake.calls, [])

    def test_unknown_routes_methods_and_params(self):
        self.fake([])
        for command, path in [("POST", ["status"]), ("GET", ["nope"]), ("GET", ["status", "x"]), ("GET", [])]:
            with self.assertRaises(wm.MobilityError) as ctx:
                wm.handle(command, wm.ROUTE_PREFIX + path, {}, HEADERS)
            self.assertEqual(ctx.exception.status, 404)
        with self.assertRaises(wm.MobilityError) as ctx:
            wm.handle("GET", wm.ROUTE_PREFIX + ["radio"], {**q(lat=40, lon=-74), "url": ["https://x"]}, HEADERS)
        self.assertEqual(ctx.exception.code, "invalid_query")
        with self.assertRaises(wm.MobilityError):
            wm.handle("GET", wm.ROUTE_PREFIX + ["radio"], {"lat": ["1", "2"], "lon": ["3"]}, HEADERS)

    def test_status_reports_configuration_without_secrets(self):
        os.environ["UCAS_GTFSRT_511_API_KEY"] = SECRET
        os.environ["UCAS_MAPILLARY_ACCESS_TOKEN"] = SECRET
        body = self.call("status", {})
        text = json.dumps(body)
        self.assertNotIn(SECRET, text)
        self.assertTrue(body["readOnly"])
        feeds = {f["id"]: f for f in body["gtfsRealtime"]["feeds"]}
        self.assertTrue(feeds["sf-bay-511-muni"]["keyConfigured"])
        self.assertEqual(feeds["sf-bay-511-muni"]["status"], "configured")
        self.assertEqual(body["streetImagery"]["mapillary"]["status"], "configured")
        self.assertEqual(body["geocoder"]["status"], "not_configured")  # public OSMF without contact
        os.environ.pop("UCAS_GTFSRT_511_API_KEY")
        os.environ.pop("UCAS_MAPILLARY_ACCESS_TOKEN")
        body = self.call("status", {})
        feeds = {f["id"]: f for f in body["gtfsRealtime"]["feeds"]}
        self.assertEqual(feeds["sf-bay-511-muni"]["status"], "not_configured")
        self.assertEqual(body["streetImagery"]["mapillary"]["status"], "not_configured")

    def test_bbox_and_radius_limits(self):
        fake = self.fake([])
        bad = [
            ("gbfs", q(feed="citibike-nyc", west=-74, south=40, east=-72.5, north=40.5), "bbox_too_large"),
            ("gbfs", q(feed="citibike-nyc", west=-73, south=40, east=-74, north=40.5), "invalid_bbox"),
            ("gtfs-rt", q(feed="mbta", west=-74, south=40, east=-71.5, north=40.5), "bbox_too_large"),
            ("infrastructure", q(west=-74, south=40, east=-72.9, north=40.5), "bbox_too_large"),
            ("infrastructure", q(west=-200, south=40, east=-73, north=40.5), "invalid_query"),
            ("infrastructure", q(west="nan", south=40, east=-73, north=40.5), "invalid_query"),
            ("street-imagery", q(provider="panoramax", lat=40, lon=-74, radius=501), "invalid_query"),
            ("street-imagery", q(provider="panoramax", lat=40, lon=-74, radius=5), "invalid_query"),
            ("street-imagery", q(provider="google", lat=40, lon=-74), "invalid_query"),
            ("radio", q(lat=40, lon=-74, radius_km=101), "invalid_query"),
            ("radio", q(lat=91, lon=-74), "invalid_query"),
            ("geocode", q(q="x"), "invalid_query"),
            ("geocode", q(q="a\nb c"), "invalid_query"),
            ("news", q(q="<script>"), "invalid_query"),
        ]
        for route, query, code in bad:
            with self.subTest(route=route, query=query):
                with self.assertRaises(wm.MobilityError) as ctx:
                    wm.handle("GET", wm.ROUTE_PREFIX + [route], query, HEADERS)
                self.assertEqual(ctx.exception.code, code)
                self.assertEqual(ctx.exception.status, 400)
        self.assertEqual(fake.calls, [])

    def test_unknown_feed_and_invalid_feed_config(self):
        self.fake([])
        with self.assertRaises(wm.MobilityError) as ctx:
            wm.handle("GET", wm.ROUTE_PREFIX + ["gbfs"], q(feed="nope", **BBOX), HEADERS)
        self.assertEqual(ctx.exception.code, "unknown_feed")
        for raw in ["not json", json.dumps([{"id": "x", "url": "http://insecure.example/gbfs.json"}]),
                    json.dumps([{"id": "Bad Id", "url": "https://a.example/g.json"}]),
                    json.dumps([{"id": "a", "url": "https://a.example/g.json"}, {"id": "a", "url": "https://b.example/g.json"}]),
                    json.dumps([{"id": "a", "url": "https://user:pw@a.example/g.json"}])]:
            os.environ["UCAS_GBFS_FEEDS_JSON"] = raw
            with self.subTest(raw=raw), self.assertRaises(wm.MobilityError) as ctx:
                wm.gbfs_feeds()
            self.assertEqual(ctx.exception.code, "gbfs_config_invalid")
        os.environ["UCAS_GTFSRT_FEEDS_JSON"] = gtfs_feed_env(keyEnv="PATH", keyParam="key")
        with self.assertRaises(wm.MobilityError):
            wm.gtfs_feeds()  # keyEnv must be a UCAS_*_KEY/TOKEN name, so arbitrary env vars can't be exfiltrated


# ------------------------------------------------------------------ transport

class TransportTests(Base):
    class Resp(io.BytesIO):
        def __init__(self, data, length=True, ctype="application/json"):
            super().__init__(data)
            from email.message import Message
            self.headers = Message()
            self.headers["Content-Type"] = ctype
            if length:
                self.headers["Content-Length"] = str(len(data))

    def opener(self, reply):
        test = self

        class Opener:
            requests = []

            def open(self, request, timeout=None):
                Opener.requests.append(request)
                if isinstance(reply, Exception):
                    raise reply
                return reply
        test.saved_build = wm.build_opener
        handlers = []

        def build(*hs):
            handlers.extend(hs)
            return Opener()
        wm.build_opener = build
        self.addCleanup(setattr, wm, "build_opener", self.saved_build)
        return Opener, handlers

    def test_redirects_are_rejected_and_handler_never_follows(self):
        for code in (301, 302, 303, 307, 308):
            err = HTTPError("https://cdn.mbta.com/x", code, "moved", {"Location": "https://evil.example/"}, io.BytesIO())
            _, handlers = self.opener(err)
            with self.assertRaises(wm.MobilityError) as ctx:
                wm.http_get("https://cdn.mbta.com/x", allowed_hosts=frozenset({"cdn.mbta.com"}))
            self.assertEqual(ctx.exception.code, "upstream_redirect_rejected")
            self.assertTrue(any(isinstance(h, wm._NoRedirect) for h in handlers))
        self.assertIsNone(wm._NoRedirect().redirect_request(None, None, 302, "", {}, "https://evil.example/"))

    def test_allowlist_scheme_port_and_credentials(self):
        self.opener(self.Resp(b"{}"))
        for url, code in [("http://cdn.mbta.com/x", "upstream_url_rejected"), ("https://cdn.mbta.com:8443/x", "upstream_url_rejected"),
                          ("https://u:p@cdn.mbta.com/x", "upstream_url_rejected"), ("https://evil.example/x", "upstream_host_not_allowed")]:
            with self.subTest(url=url), self.assertRaises(wm.MobilityError) as ctx:
                wm.http_get(url, allowed_hosts=frozenset({"cdn.mbta.com"}))
            self.assertEqual(ctx.exception.code, code)
        # _fetch enforces the allowlist even with a replaced transport.
        fake = self.fake([("", {})])
        with self.assertRaises(wm.MobilityError):
            wm._fetch("https://evil.example/x", allowed_hosts=frozenset({"cdn.mbta.com"}))
        self.assertEqual(fake.calls, [])

    def test_size_limit_status_mapping_and_user_agent(self):
        opener, _ = self.opener(self.Resp(b"x" * 100))
        with self.assertRaises(wm.MobilityError) as ctx:
            wm.http_get("https://cdn.mbta.com/x", allowed_hosts=frozenset({"cdn.mbta.com"}), max_bytes=10)
        self.assertEqual(ctx.exception.code, "upstream_too_large")
        self.opener(self.Resp(b"x" * 100, length=False))
        with self.assertRaises(wm.MobilityError) as ctx:
            wm.http_get("https://cdn.mbta.com/x", allowed_hosts=frozenset({"cdn.mbta.com"}), max_bytes=10)
        self.assertEqual(ctx.exception.code, "upstream_too_large")
        for code, expected in [(429, "upstream_rate_limited"), (401, "upstream_auth_failed"), (500, "upstream_http_error")]:
            self.opener(HTTPError(f"https://cdn.mbta.com/x?api_key={SECRET}", code, "err", {}, io.BytesIO()))
            with self.assertRaises(wm.MobilityError) as ctx:
                wm.http_get(f"https://cdn.mbta.com/x?api_key={SECRET}", allowed_hosts=frozenset({"cdn.mbta.com"}))
            self.assertEqual(ctx.exception.code, expected)
            self.assertNotIn(SECRET, ctx.exception.message)
        self.opener(URLError(f"cannot reach https://cdn.mbta.com/x?api_key={SECRET}"))
        with self.assertRaises(wm.MobilityError) as ctx:
            wm.http_get(f"https://cdn.mbta.com/x?api_key={SECRET}", allowed_hosts=frozenset({"cdn.mbta.com"}))
        self.assertNotIn(SECRET, ctx.exception.message)
        os.environ["UCAS_WORLDVIEW_CONTACT"] = "ops@example.org"
        opener, _ = self.opener(self.Resp(b"{}"))
        body, ctype = wm.http_get("https://cdn.mbta.com/x", allowed_hosts=frozenset({"cdn.mbta.com"}))
        self.assertEqual((body, ctype), (b"{}", "application/json"))
        self.assertIn("ops@example.org", opener.requests[0].get_header("User-agent"))
        os.environ["UCAS_WORLDVIEW_CONTACT"] = "bad\r\nheader"
        self.assertIsNone(wm.contact())

    def test_redact(self):
        text = f"https://x.example/a?api_key={SECRET}&token={SECRET}&access_token={SECRET}&key={SECRET}&ok=1"
        out = wm.redact(text)
        self.assertNotIn(SECRET, out)
        self.assertIn("ok=1", out)


# ------------------------------------------------------------------ GBFS

class GbfsTests(Base):
    def setUp(self):
        super().setUp()
        os.environ["UCAS_GBFS_FEEDS_JSON"] = gbfs_feed_env()

    def test_gbfs2_stations_and_free_bikes(self):
        fake = self.fake([("gbfs.example.org/sys/gbfs.json", GBFS2_DISCOVERY), ("sys/system_information", GBFS2_SYSTEM),
                          ("station_information", GBFS2_STATION_INFO), ("station_status", GBFS2_STATION_STATUS),
                          ("free_bike_status", GBFS2_FREE_BIKES)])
        body = self.call("gbfs", q(feed="example-bikes", **BBOX))
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["freshness"], "fresh")
        self.assertEqual(body["providerId"], "gbfs:example-bikes")
        self.assertEqual(body["ttlSeconds"], 30)
        stations = [i for i in body["items"] if i["kind"] == "station"]
        vehicles = [i for i in body["items"] if i["kind"] == "vehicle"]
        self.assertEqual([s["id"] for s in stations], ["s1", "s4"])  # far-away and null-island stations dropped
        s1 = stations[0]
        self.assertEqual(s1["properties"]["bikesAvailable"], 7)
        self.assertEqual(s1["properties"]["docksAvailable"], 13)
        self.assertIs(s1["properties"]["isRenting"], True)
        self.assertEqual(s1["providerTimestamp"], parse.iso(NOW - 30))
        self.assertIsNone(stations[1]["providerTimestamp"])  # 86400 "never reported" sentinel is not a 1970 time
        self.assertEqual(len(vehicles), 2)
        self.assertNotIn("ROTATING-PRIVACY-ID", json.dumps(body))  # rotating ids dropped
        self.assertEqual(vehicles[0]["properties"]["vehicleType"], "ebike")
        self.assertIn("disabled", vehicles[1]["label"])
        self.assertEqual(body["system"]["name"], "Example Bikes")
        self.assertEqual(body["licenseUrl"], "https://example.org/license")
        self.assertEqual(body["sourceUrl"], f"{GBFS_HOST}/gbfs.json")
        self.assertTrue(all(c["hosts"] == frozenset({"gbfs.example.org"}) for c in fake.calls))
        # Panning within doc ttl re-filters cached documents: no new upstream calls, no throttle refusal.
        calls = len(fake.calls)
        moved = self.call("gbfs", q(feed="example-bikes", west=-74.02, south=40.70, east=-73.99, north=40.715))
        self.assertEqual(moved["status"], "ok")
        self.assertEqual(len(fake.calls), calls)
        self.assertEqual([i["id"] for i in moved["items"] if i["kind"] == "station"], ["s1"])
        # After the status ttl expires only expired documents are re-fetched.
        self.clock[0] += 31
        self.call("gbfs", q(feed="example-bikes", **BBOX))
        refetched = [c["url"] for c in fake.calls[calls:]]
        self.assertTrue(any("station_status" in u for u in refetched))
        self.assertFalse(any("station_information" in u for u in refetched))

    def test_gbfs3_vehicle_status_and_rfc3339(self):
        self.fake([("gbfs3.example.org/gbfs.json", GBFS3_DISCOVERY), ("system_information", GBFS3_SYSTEM),
                   ("vehicle_status", GBFS3_VEHICLES)])
        self.clock[0] = 1793478973.0 + 60  # 2026-10-31T20:36:13Z + 1 min
        body = self.call("gbfs", q(feed="scoot3", **BBOX))
        self.assertEqual(body["status"], "ok")
        self.assertEqual(len(body["items"]), 1)
        self.assertEqual(body["items"][0]["providerTimestamp"], "2026-10-31T20:35:00Z")
        self.assertEqual(body["system"]["name"], "Scoot Three")
        self.assertTrue(body["attribution"].startswith("Scoot Co (operator-declared)"))
        self.assertNotIn("rot-1", json.dumps(body))

    def test_gbfs_stale_feed_and_off_allowlist_subfeed(self):
        old = json.loads(json.dumps(GBFS2_STATION_STATUS))
        old["last_updated"] = int(NOW) - 3600
        self.fake([("gbfs.example.org/sys/gbfs.json", GBFS2_DISCOVERY), ("sys/system_information", GBFS2_SYSTEM),
                   ("station_information", GBFS2_STATION_INFO), ("station_status", old), ("free_bike_status", GBFS2_FREE_BIKES)])
        body = self.call("gbfs", q(feed="example-bikes", **BBOX))
        self.assertEqual(body["status"], "stale")
        self.assertFalse(body["live"])
        self.assertTrue(all(i["freshness"] == "stale" for i in body["items"]))
        self.assertTrue(all(i["live"] is False for i in body["items"]))
        self.assertTrue(all(i.get("properties", {}).get("live") is False for i in body["items"]))
        self.assertIn("last_updated", body["notice"])
        wm.reset_state()
        evil = json.loads(json.dumps(GBFS2_DISCOVERY))
        evil["data"]["en"]["feeds"][2]["url"] = "https://evil.example/station_status.json"
        fake = self.fake([("gbfs.example.org/sys/gbfs.json", evil), ("", GBFS2_STATION_INFO)])
        body = self.call("gbfs", q(feed="example-bikes", **BBOX))
        self.assertEqual(body["status"], "failed")
        self.assertEqual(body["errorCode"], "upstream_host_not_allowed")
        self.assertEqual(body["items"], [])
        self.assertFalse(any("evil.example" in c["url"] for c in fake.calls))

    def test_gbfs_schema_error_and_failure_fallback(self):
        self.fake([("gbfs.example.org/sys/gbfs.json", {"data": "nope"})])
        body = self.call("gbfs", q(feed="example-bikes", **BBOX))
        self.assertEqual(body["status"], "failed")
        self.assertEqual(body["live"], False)


# ------------------------------------------------------------------ GTFS-realtime

class GtfsDecoderTests(unittest.TestCase):
    def test_decodes_vehicle_positions_without_plate(self):
        decoded = gtfs.decode_vehicle_positions(GTFS_PAYLOAD)
        self.assertEqual(decoded["version"], "2.0")
        self.assertEqual(decoded["header_timestamp"], int(NOW) - 5)
        ids = [v["entity_id"] for v in decoded["vehicles"]]
        self.assertEqual(ids, ["e1", "e2", "e3", "e5"])  # deleted e4 skipped
        v = decoded["vehicles"][0]
        self.assertEqual((v["trip_id"], v["route_id"], v["direction_id"]), ("trip-e1", "M15", 1))
        self.assertEqual((v["vehicle_id"], v["vehicle_label"]), ("bus-100", "100"))
        self.assertAlmostEqual(v["lat"], 40.70, places=4)
        self.assertAlmostEqual(v["lon"], -74.00, places=4)
        self.assertEqual(v["bearing"], 90.0)
        self.assertEqual(v["speed_mps"], 7.5)
        self.assertEqual(v["current_status"], "IN_TRANSIT_TO")
        self.assertEqual(v["stop_id"], "stop-9")
        self.assertEqual(v["timestamp"], int(NOW) - 10)
        self.assertNotIn("ABC1234", json.dumps(decoded))

    def test_rejects_malformed_payloads(self):
        for payload in [b"", b"\x0a\x05ab", b"\x12\x00", b"\x0b", b"\x00\x01", b"\x0a" + b"\xff" * 11]:
            with self.subTest(payload=payload), self.assertRaises(gtfs.GtfsRtDecodeError):
                gtfs.decode_vehicle_positions(payload)
        old = gtfs.MAX_ENTITIES
        gtfs.MAX_ENTITIES = 2
        try:
            with self.assertRaises(gtfs.GtfsRtDecodeError):
                gtfs.decode_vehicle_positions(GTFS_PAYLOAD)
        finally:
            gtfs.MAX_ENTITIES = old


class GtfsRelayTests(Base):
    def test_normalized_vehicles_bbox_and_staleness(self):
        os.environ["UCAS_GTFSRT_FEEDS_JSON"] = gtfs_feed_env()
        fake = self.fake([("rt.example.org", GTFS_PAYLOAD)])
        body = self.call("gtfs-rt", q(feed="test-agency", **BBOX))
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["agencyTimezone"], "America/New_York")
        self.assertEqual(body["gtfsRealtimeVersion"], "2.0")
        items = {i["id"]: i for i in body["items"]}
        self.assertEqual(set(items), {"bus-100", "bus-200", "e5"})
        self.assertEqual(items["bus-100"]["label"], "Route M15")
        self.assertEqual(items["bus-100"]["freshness"], "fresh")
        self.assertEqual(items["bus-100"]["ageSeconds"], 10)
        self.assertEqual(items["bus-200"]["freshness"], "stale")
        self.assertEqual(items["e5"]["properties"]["timestampBasis"], "feed header")
        self.assertIn("route not reported", items["e5"]["label"])
        self.assertNotIn("ABC1234", json.dumps(body))
        self.assertEqual(fake.calls[0]["max_bytes"], wm.LARGE_BYTES)
        # A second view within 15 s reuses the decoded feed (one upstream fetch per interval).
        other = self.call("gtfs-rt", q(feed="test-agency", west=-74.015, south=40.705, east=-74.005, north=40.715))
        self.assertEqual([i["id"] for i in other["items"]], ["bus-200"])
        self.assertEqual(len(fake.calls), 1)
        self.clock[0] += 16
        self.call("gtfs-rt", q(feed="test-agency", **BBOX))
        self.assertEqual(len(fake.calls), 2)

    def test_old_header_marks_feed_stale(self):
        os.environ["UCAS_GTFSRT_FEEDS_JSON"] = gtfs_feed_env()
        self.fake([("rt.example.org", feed_message(header_ts=int(NOW) - 900, entities=[vehicle("e1", 40.7, -74.0, vid="b1")]))])
        body = self.call("gtfs-rt", q(feed="test-agency", **BBOX))
        self.assertEqual(body["status"], "stale")
        self.assertFalse(body["live"])
        self.assertEqual(body["items"][0]["freshness"], "stale")

    def test_missing_required_key_is_not_configured(self):
        fake = self.fake([])
        body = self.call("gtfs-rt", q(feed="sf-bay-511-muni", west=-122.5, south=37.7, east=-122.3, north=37.8))
        self.assertEqual(body["status"], "not_configured")
        self.assertEqual(body["items"], [])
        self.assertIn("UCAS_GTFSRT_511_API_KEY", body["error"])
        self.assertFalse(body["live"])
        self.assertEqual(fake.calls, [])

    def test_query_key_is_sent_upstream_but_never_returned(self):
        os.environ["UCAS_GTFSRT_511_API_KEY"] = SECRET
        fake = self.fake([("api.511.org", GTFS_PAYLOAD)])
        body = self.call("gtfs-rt", q(feed="sf-bay-511-muni", **BBOX))
        self.assertEqual(body["status"], "ok")
        sent = parse_qs(urlsplit(fake.calls[0]["url"]).query)
        self.assertEqual(sent["api_key"], [SECRET])
        self.assertEqual(sent["agency"], ["SF"])
        self.assertNotIn(SECRET, json.dumps(body))
        # Failure path (later, after the interval) also never leaks the key, and falls back to the last snapshot.
        self.clock[0] += 16
        self.fake([("api.511.org", wm.MobilityError(502, "upstream_http_error", "provider returned HTTP 500"))])
        stale = self.call("gtfs-rt", q(feed="sf-bay-511-muni", **BBOX))
        self.assertEqual(stale["status"], "stale")
        self.assertFalse(stale["live"])
        self.assertTrue(stale["items"])
        self.assertTrue(all(i["freshness"] == "stale" for i in stale["items"]))
        self.assertTrue(all(i["live"] is False for i in stale["items"]))
        self.assertTrue(all(i.get("properties", {}).get("live") is False for i in stale["items"]))
        self.assertNotIn(SECRET, json.dumps(stale))

    def test_header_key_feed(self):
        os.environ["UCAS_GTFSRT_FEEDS_JSON"] = gtfs_feed_env(keyEnv="UCAS_TEST_FEED_KEY", keyHeader="x-api-key")
        os.environ["UCAS_TEST_FEED_KEY"] = SECRET
        fake = self.fake([("rt.example.org", GTFS_PAYLOAD)])
        body = self.call("gtfs-rt", q(feed="test-agency", **BBOX))
        self.assertEqual(fake.calls[0]["headers"]["x-api-key"], SECRET)
        self.assertNotIn(SECRET, fake.calls[0]["url"])
        self.assertNotIn(SECRET, json.dumps(body))

    def test_undecodable_feed_fails_cleanly(self):
        os.environ["UCAS_GTFSRT_FEEDS_JSON"] = gtfs_feed_env()
        self.fake([("rt.example.org", b"<html>not protobuf</html>")])
        body = self.call("gtfs-rt", q(feed="test-agency", **BBOX))
        self.assertEqual(body["status"], "failed")
        self.assertEqual(body["errorCode"], "gtfs_rt_decode")

    def test_throttle_after_failure(self):
        os.environ["UCAS_GTFSRT_FEEDS_JSON"] = gtfs_feed_env()
        fake = self.fake([("rt.example.org", wm.MobilityError(502, "upstream_unreachable", "provider could not be reached"))])
        self.assertEqual(self.call("gtfs-rt", q(feed="test-agency", **BBOX))["status"], "failed")
        body = self.call("gtfs-rt", q(feed="test-agency", **BBOX))
        self.assertEqual(body["status"], "throttled")
        self.assertFalse(body["live"])
        self.assertEqual(len(fake.calls), 1)


# ------------------------------------------------------------------ street imagery

class StreetImageryTests(Base):
    def test_mapillary_not_configured_then_token_in_header_only(self):
        fake = self.fake([])
        body = self.call("street-imagery", q(provider="mapillary", lat=40.71, lon=-74.0))
        self.assertEqual(body["status"], "not_configured")
        self.assertIn("UCAS_MAPILLARY_ACCESS_TOKEN", body["error"])
        self.assertEqual(fake.calls, [])
        os.environ["UCAS_MAPILLARY_ACCESS_TOKEN"] = SECRET
        fake = self.fake([("graph.mapillary.com", MAPILLARY)])
        body = self.call("street-imagery", q(provider="mapillary", lat=40.71, lon=-74.0, radius=400))
        self.assertEqual(body["status"], "ok")
        call = fake.calls[0]
        self.assertEqual(call["headers"]["Authorization"], f"OAuth {SECRET}")
        self.assertNotIn(SECRET, call["url"])
        self.assertNotIn(SECRET, json.dumps(body))
        west, south, east, north = map(float, parse_qs(urlsplit(call["url"]).query)["bbox"][0].split(","))
        self.assertLess(north - south, 0.0046)  # Mapillary bbox capped at 250 m radius
        self.assertEqual(len(body["items"]), 2)
        first, second = body["items"]
        self.assertEqual(first["id"], "1234567890")
        self.assertEqual(first["providerTimestamp"], "2023-11-14T22:13:20Z")
        self.assertEqual(first["properties"]["author"], "mapper1")
        self.assertEqual(first["properties"]["pageUrl"], "https://www.mapillary.com/app/?pKey=1234567890")
        self.assertEqual(first["properties"]["thumbnailUrl"], "https://scontent.xx.fbcdn.net/m1/thumb.jpg")
        self.assertIsNone(second["properties"]["thumbnailUrl"])  # off-host thumbnail dropped
        self.assertIn("no face or plate analysis", body["notice"])

    def test_panoramax(self):
        fake = self.fake([("api.panoramax.xyz", PANORAMAX)])
        body = self.call("street-imagery", q(provider="panoramax", lat=48.8566, lon=2.3522, radius=150))
        sent = parse_qs(urlsplit(fake.calls[0]["url"]).query)
        self.assertEqual(sent["place_position"], ["2.352200,48.856600"])
        self.assertEqual(sent["place_distance"], ["0-150"])
        item = body["items"][0]
        self.assertEqual(item["providerTimestamp"], "2023-05-20T17:55:39+00:00")
        self.assertEqual(item["properties"]["author"], "mapcomplete")
        self.assertEqual(item["properties"]["license"], "CC-BY-SA-4.0")
        self.assertEqual(item["properties"]["instance"], "Example instance")
        self.assertEqual(item["properties"]["compassDeg"], 120)

    def test_kartaview(self):
        self.fake([("api.kartaview.org", KARTAVIEW)])
        body = self.call("street-imagery", q(provider="kartaview", lat=48.8566, lon=2.3522))
        self.assertEqual(len(body["items"]), 1)
        item = body["items"][0]
        self.assertEqual(item["providerTimestamp"], "2016-07-09T10:54:20Z")
        self.assertEqual(item["properties"]["pageUrl"], "https://kartaview.org/details/9214/68")
        self.assertEqual(item["properties"]["author"], "kv")

    def test_throttle_and_cache(self):
        fake = self.fake([("api.kartaview.org", KARTAVIEW)])
        self.call("street-imagery", q(provider="kartaview", lat=48.8566, lon=2.3522))
        same = self.call("street-imagery", q(provider="kartaview", lat=48.8566, lon=2.3522))
        self.assertEqual(same["status"], "throttled")
        self.assertTrue(same["cached"])
        self.assertEqual(len(same["items"]), 1)
        other = self.call("street-imagery", q(provider="kartaview", lat=48.0, lon=2.0))
        self.assertEqual(other["status"], "throttled")
        self.assertEqual(other["items"], [])
        self.assertEqual(len(fake.calls), 1)
        self.clock[0] += 2.5
        self.assertEqual(self.call("street-imagery", q(provider="kartaview", lat=48.0, lon=2.0))["status"], "ok")
        self.assertEqual(len(fake.calls), 2)

    def test_schema_error_is_failed_not_fabricated(self):
        self.fake([("api.kartaview.org", {"unexpected": True})])
        body = self.call("street-imagery", q(provider="kartaview", lat=48.8566, lon=2.3522))
        self.assertEqual(body["status"], "failed")
        self.assertEqual(body["items"], [])


# ------------------------------------------------------------------ geocoder / radio / news / overpass

class ContextTests(Base):
    def test_nominatim_requires_contact_on_public_endpoint(self):
        fake = self.fake([])
        body = self.call("geocode", q(q="Boston Common"))
        self.assertEqual(body["status"], "not_configured")
        self.assertIn("UCAS_WORLDVIEW_CONTACT", body["error"])
        self.assertEqual(fake.calls, [])

    def test_nominatim_results_cache_and_one_per_second(self):
        os.environ["UCAS_WORLDVIEW_CONTACT"] = "ops@example.org"
        fake = self.fake([("nominatim.openstreetmap.org", NOMINATIM)])
        body = self.call("geocode", q(q="Boston Common"))
        self.assertEqual(body["status"], "ok")
        self.assertEqual(len(body["items"]), 1)
        place = body["items"][0]
        self.assertEqual((place["lat"], place["lon"]), (42.35504, -71.066071))
        self.assertEqual(place["properties"]["osmUrl"], "https://www.openstreetmap.org/relation/17995454")
        self.assertEqual(body["license"], "ODbL 1.0")
        again = self.call("geocode", q(q="boston common"))
        self.assertTrue(again["cached"])
        self.assertEqual(len(fake.calls), 1)
        t0 = self.clock[0]
        self.call("geocode", q(q="Fenway Park"))  # waits out the 1 s gate instead of refusing
        self.assertEqual(len(fake.calls), 2)
        self.assertGreaterEqual(self.clock[0] - t0, 1.0 - 1e-9)

    def test_self_hosted_nominatim_needs_no_contact(self):
        os.environ["UCAS_NOMINATIM_URL"] = "https://geo.internal.example/"
        fake = self.fake([("geo.internal.example/search", NOMINATIM)])
        self.assertEqual(self.call("geocode", q(q="Boston"))["status"], "ok")
        self.assertEqual(fake.calls[0]["hosts"], frozenset({"geo.internal.example"}))
        os.environ["UCAS_NOMINATIM_URL"] = "http://geo.internal.example/"
        with self.assertRaises(wm.MobilityError) as ctx:
            wm.handle("GET", wm.ROUTE_PREFIX + ["geocode"], q(q="Boston"), HEADERS)
        self.assertEqual(ctx.exception.code, "endpoint_config_invalid")

    def test_radio_metadata_only(self):
        fake = self.fake([("api.radio-browser.info", RADIO)])
        body = self.call("radio", q(lat=40.71, lon=-74.0, radius_km=25))
        sent = parse_qs(urlsplit(fake.calls[0]["url"]).query)
        self.assertEqual(sent["geo_distance"], ["25000"])
        self.assertEqual(len(body["items"]), 1)
        text = json.dumps(body)
        self.assertNotIn("stream.example.com", text)
        self.assertNotIn("fav.png", text)
        station = body["items"][0]
        self.assertEqual(station["properties"]["homepage"], "http://walmradio.com/classic")
        self.assertIs(station["properties"]["lastCheckOk"], True)

    def test_gdelt_links_only_and_plaintext_rejection(self):
        fake = self.fake([("api.gdeltproject.org", GDELT)])
        body = self.call("news", q(q="subway delays", lat=40.71, lon=-74.0))
        self.assertEqual(len(body["items"]), 1)
        item = body["items"][0]
        self.assertEqual(item["providerTimestamp"], "2026-10-31T18:30:00Z")
        self.assertEqual(item["properties"]["articleUrl"], "https://news.example.com/a")
        self.assertEqual((item["lat"], item["lon"]), (40.71, -74.0))
        self.assertNotIn("i.jpg", json.dumps(body))
        self.assertEqual(body["providerTimestamp"], "2026-10-31T18:30:00Z")
        cached = self.call("news", q(q="subway delays", lat=40.71, lon=-74.0))
        self.assertTrue(cached["cached"])
        self.assertEqual(len(fake.calls), 1)
        self.clock[0] += 7
        self.fake([("api.gdeltproject.org", b"Please limit requests to one every 5 seconds.")])
        body = self.call("news", q(q="ferry service"))
        self.assertEqual(body["status"], "failed")
        self.assertEqual(body["errorCode"], "gdelt_rejected")
        self.clock[0] += 7
        self.fake([("api.gdeltproject.org", {})])
        empty = self.call("news", q(q="nothing matches"))
        self.assertEqual((empty["status"], empty["items"]), ("ok", []))

    def test_overpass_infrastructure(self):
        fake = self.fake([("overpass-api.de", OVERPASS)])
        body = self.call("infrastructure", q(west=-74.05, south=40.68, east=-73.95, north=40.78))
        ql = parse_qs(urlsplit(fake.calls[0]["url"]).query)["data"][0]
        self.assertIn('"telecom"="data_center"', ql)
        self.assertIn("(40.68000,-74.05000,40.78000,-73.95000)", ql)
        kinds = {i["id"]: i["kind"] for i in body["items"]}
        self.assertEqual(kinds, {"node-1": "datacenter", "way-2": "dam"})
        self.assertEqual(body["providerTimestamp"], "2026-10-31T20:00:00Z")
        self.assertIn("ODbL", body["notice"])
        self.assertTrue(self.call("infrastructure", q(west=-74.05, south=40.68, east=-73.95, north=40.78))["cached"])
        self.assertEqual(len(fake.calls), 1)
        self.clock[0] += 11
        self.fake([("overpass-api.de", {"elements": [], "remark": "runtime error: Query timed out"})])
        body = self.call("infrastructure", q(west=-74.0, south=40.68, east=-73.95, north=40.78))
        self.assertEqual(body["status"], "failed")


class ParserTests(unittest.TestCase):
    def test_iso_rejects_sentinels(self):
        for value in (0, 86400, -1, float("nan"), True, None, "x"):
            self.assertIsNone(parse.iso(value))
        self.assertEqual(parse.iso(1793397378), "2026-10-30T21:56:18Z")

    def test_safe_link(self):
        self.assertIsNone(parse.safe_link("javascript:alert(1)"))
        self.assertIsNone(parse.safe_link("https://u:p@x.example/"))
        self.assertIsNone(parse.safe_link("http://x.example/"))
        self.assertEqual(parse.safe_link("http://x.example/", allow_http=True), "http://x.example/")
        self.assertIsNone(parse.safe_link("https://x.example:8080/"))
        self.assertIsNone(parse.safe_link("https://notfbcdn.net/x", hosts=("fbcdn.net",)))
        self.assertEqual(parse.safe_link("https://a.fbcdn.net/x", hosts=("fbcdn.net",)), "https://a.fbcdn.net/x")

    def test_truncation_limits(self):
        info = {"data": {"stations": [{"station_id": str(i), "lat": 40.7, "lon": -74.0} for i in range(5)]}}
        status = {"data": {"stations": []}}
        items, cut = parse.gbfs_stations(info, status, (-75, 40, -73, 41), 3)
        self.assertEqual((len(items), cut), (3, True))
        self.assertFalse(items[0]["properties"]["statusReported"])


# ------------------------------------------------------------------ app wiring

class AppRouteTests(Base):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("ucas_management_api_mobility", API_DIR / "app.py")
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
        body = json.loads(response.read())
        conn.close()
        return response.status, body

    def test_route_wired_with_error_mapping(self):
        self.assertIs(self.app.worldview_mobility, wm)
        os.environ.pop("UCAS_WORLDVIEW_MOBILITY_ENABLED")
        status, body = self.request("/api/v1/worldview-mobility/status", {wm.HEADER: "enabled"})
        self.assertEqual((status, body["error"]["code"]), (404, "worldview_mobility_disabled"))
        os.environ["UCAS_WORLDVIEW_MOBILITY_ENABLED"] = "1"
        status, body = self.request("/api/v1/worldview-mobility/status")
        self.assertEqual((status, body["error"]["code"]), (403, "mobility_header_required"))
        status, body = self.request("/api/v1/worldview-mobility/status", {wm.HEADER: "enabled", "Origin": "https://evil.example"})
        self.assertEqual((status, body["error"]["code"]), (403, "origin_not_allowed"))
        status, body = self.request("/api/v1/worldview-mobility/status", {wm.HEADER: "enabled"})
        self.assertEqual(status, 200)
        self.assertTrue(body["enabled"])
        status, body = self.request("/api/v1/worldview-mobility/radio?lat=95&lon=0", {wm.HEADER: "enabled"})
        self.assertEqual((status, body["error"]["code"]), (400, "invalid_query"))
        fake = self.fake([("api.radio-browser.info", RADIO)])
        status, body = self.request("/api/v1/worldview-mobility/radio?lat=40.71&lon=-74.0", {wm.HEADER: "enabled"})
        self.assertEqual(status, 200)
        self.assertEqual(body["providerId"], "radio-browser")
        self.assertEqual(len(fake.calls), 1)


if __name__ == "__main__":
    unittest.main()
