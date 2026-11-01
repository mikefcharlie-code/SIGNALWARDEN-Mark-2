"""Offline tests for the opt-in public traffic-camera / TomTom relay.

All upstream traffic is served by a fake opener with small hand-written
fixtures; these tests never touch the network.
"""
import base64
import gzip
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
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
MOD = ROOT / "services" / "management-api" / "public_traffic.py"
spec = importlib.util.spec_from_file_location("public_traffic_test_module", MOD)
pt = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = pt
spec.loader.exec_module(pt)

JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 32 + b"\xff\xd9"
NOW = 1_793_400_000.0  # 2026-10-30T... fixed test clock
KEY_ENVS = ("UCAS_WSDOT_ACCESS_CODE", "UCAS_ONTARIO511_API_KEY", "UCAS_511NY_API_KEY", "UCAS_FL511_API_KEY", "UCAS_TOMTOM_API_KEY", pt.TOMTOM_ENABLE_ENV)


class Headers(dict):
    def get(self, key, default=None):
        for k, v in self.items():
            if k.lower() == key.lower():
                return v
        return default


class FakeResponse(io.BytesIO):
    def __init__(self, data, content_type="application/json", extra=None):
        super().__init__(data)
        self.headers = Headers({"Content-Type": content_type, "Content-Length": str(len(data)), **(extra or {})})


class FakeOpener:
    """Routes by URL prefix; records every requested URL and headers."""

    def __init__(self, routes):
        self.routes, self.seen = routes, []

    def open(self, request, timeout=None):
        url = request.full_url
        self.seen.append((url, dict(request.header_items())))
        for prefix, item in self.routes.items():
            if url.startswith(prefix):
                item = item() if callable(item) else item
                if isinstance(item, Exception):
                    raise item
                return item
        raise AssertionError(f"unexpected upstream request {url}")


def js(doc, **kw):
    return lambda: FakeResponse(json.dumps(doc).encode(), **kw)


def img(data=JPEG, last_modified="Fri, 30 Oct 2026 21:47:54 GMT", content_type="image/jpeg"):
    extra = {"Last-Modified": last_modified} if last_modified else {}
    return lambda: FakeResponse(data, content_type, extra)


CALTRANS_D4 = {"data": [
    {"cctv": {"index": "1", "recordTimestamp": {"recordEpoch": "1769206788"}, "inService": "true",
              "location": {"locationName": "TV102 -- I-580 : West of SR-24", "longitude": "-122.27291", "latitude": "37.82539",
                           "direction": "West", "route": "I-580"},
              "imageData": {"static": {"currentImageURL": "https://cwwp2.dot.ca.gov/data/d4/cctv/image/tv102/tv102.jpg"}}}},
    {"cctv": {"index": "2", "inService": "false",
              "location": {"locationName": "Out of service", "longitude": "-122.3", "latitude": "37.8"},
              "imageData": {"static": {"currentImageURL": "https://cwwp2.dot.ca.gov/data/d4/cctv/image/off/off.jpg"}}}},
    {"cctv": {"index": "3", "inService": "true",
              "location": {"locationName": "Foreign host", "longitude": "-122.31", "latitude": "37.81"},
              "imageData": {"static": {"currentImageURL": "https://evil.example/data/d4/x.jpg"}}}},
    {"cctv": {"index": "4", "inService": "true",
              "location": {"locationName": "Far away", "longitude": "-121.6", "latitude": "38.4"},
              "imageData": {"static": {"currentImageURL": "https://cwwp2.dot.ca.gov/data/d4/cctv/image/far/far.jpg"}}}},
]}
TFL = [{"id": "JamCams_00001.1", "commonName": "A406 Billet Upass E", "lat": 51.6, "lon": -0.016, "additionalProperties": [
    {"key": "available", "value": "true"},
    {"key": "imageUrl", "value": "https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00001.1.jpg", "modified": "2026-10-10T07:31:00Z"},
    {"key": "view", "value": "West"}]},
    {"id": "JamCams_00001.2", "commonName": "Other bucket", "lat": 51.5, "lon": -0.1, "additionalProperties": [
        {"key": "available", "value": "true"},
        {"key": "imageUrl", "value": "https://s3-eu-west-1.amazonaws.com/some-other-bucket/x.jpg"}]},
    {"id": "JamCams_00001.3", "commonName": "Unavailable", "lat": 51.5, "lon": -0.1, "additionalProperties": [
        {"key": "available", "value": "false"}]}]
TXDOT = {"roadwayCctvStatuses": {"IH-35": [
    {"icd_Id": "IH-35 @ E Riverside (1000)", "name": "IH-35 @ E Riverside", "latitude": 30.247, "longitude": -97.734,
     "dirDescription": "North", "statusDescription": "Device Online", "hasSnapshot": True},
    {"icd_Id": "IH-35 @ offline", "name": "offline", "latitude": 30.25, "longitude": -97.73,
     "statusDescription": "Device Offline", "hasSnapshot": True}]}}
DIGITRAFFIC = {"type": "FeatureCollection", "dataUpdatedTime": "2026-10-30T18:43:56Z", "features": [
    {"type": "Feature", "id": "C01503", "geometry": {"type": "Point", "coordinates": [24.9, 60.2, 0]},
     "properties": {"id": "C01503", "name": "kt51_Inkoo", "collectionStatus": "GATHERING", "dataUpdatedTime": "2026-10-30T15:25:00Z",
                    "presets": [{"id": "C0150301", "inCollection": True}, {"id": "C0150302", "inCollection": False}]}},
    {"type": "Feature", "id": "C09999", "geometry": {"type": "Point", "coordinates": [24.95, 60.21, 0]},
     "properties": {"id": "C09999", "name": "removed", "collectionStatus": "REMOVED_TEMPORARILY", "presets": [{"id": "C0999901", "inCollection": True}]}}]}
NSW = {"type": "FeatureCollection", "features": [{"type": "Feature", "id": "023651ee", "geometry": {"type": "Point", "coordinates": [151.105, -34.03]},
       "properties": {"title": "5 Ways (Miranda)", "view": "looking west", "direction": "W",
                      "href": "https://webcams.transport.nsw.gov.au/livetraffic-webcams/cameras/5_ways_miranda.jpeg"}}]}
IBI = [{"Id": 455, "Roadway": "Highway 407", "Direction": "Eastbound", "Latitude": 43.85, "Longitude": -79.4, "Location": "Highway 407 East of Bethesda",
        "Views": [{"Id": 815, "Url": "https://511on.ca/map/Cctv/815", "Status": "Enabled"}, {"Id": 816, "Url": "https://511on.ca/map/Cctv/816", "Status": "Disabled"}]}]
WSDOT = [{"CameraID": 1001, "Title": "I-5 at NE 45th", "IsActive": True, "DisplayLatitude": 47.66, "DisplayLongitude": -122.32,
          "ImageURL": "https://images.wsdot.wa.gov/nw/005vc16970.jpg", "CameraLocation": {"RoadName": "I-5", "Direction": "N"}},
         {"CameraID": 1002, "Title": "Partner camera", "IsActive": True, "DisplayLatitude": 47.65, "DisplayLongitude": -122.3,
          "ImageURL": "https://www.tripcheck.com/x.jpg", "CameraLocation": {}}]
TOMTOM_INCIDENTS = {"incidents": [
    {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[-73.95, 40.75], [-73.94, 40.76]]},
     "properties": {"id": "inc-1", "iconCategory": 6, "magnitudeOfDelay": 2, "events": [{"description": "Stationary traffic", "code": 101}],
                    "startTime": "2026-10-30T20:00:00Z", "from": "A", "to": "B", "length": 1200.5, "delay": 240, "roadNumbers": ["I-495"],
                    "lastReportTime": "2026-10-30T21:40:00Z"}},
    {"type": "Feature", "geometry": {"type": "Point", "coordinates": ["bad", 1]}, "properties": {"id": "bad"}}]}
TOMTOM_FLOW = {"flowSegmentData": {"frc": "FRC2", "currentSpeed": 31, "freeFlowSpeed": 56, "currentTravelTime": 120, "freeFlowTravelTime": 66,
                                   "confidence": 0.95, "roadClosure": False, "coordinates": {"coordinate": [{"latitude": 40.751, "longitude": -73.949}]}}}


def q(**kw):
    return {k: [str(v)] for k, v in kw.items()}


class RelayTestCase(unittest.TestCase):
    def setUp(self):
        self.saved = {k: os.environ.get(k) for k in (pt.ENABLE_ENV, pt.PROVIDER_FILTER_ENV, pt.TXDOT_DISTRICTS_ENV, *KEY_ENVS)}
        for k in self.saved:
            os.environ.pop(k, None)
        os.environ[pt.ENABLE_ENV] = "1"
        os.environ[pt.PROVIDER_FILTER_ENV] = ",".join(pt.PROVIDERS)
        os.environ[pt.TOMTOM_ENABLE_ENV] = "1"
        self.headers = {pt.HEADER: "enabled", "Host": "127.0.0.1:8000", "Origin": "http://127.0.0.1:8000"}
        pt.reset_state()
        self.now = NOW
        self.old_clock, self.old_factory = pt.clock, pt.opener_factory
        pt.clock = lambda: self.now

    def tearDown(self):
        pt.clock, pt.opener_factory = self.old_clock, self.old_factory
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        pt.reset_state()

    def use(self, routes):
        opener = FakeOpener(routes)
        pt.opener_factory = lambda: opener
        return opener

    def call(self, suffix, query=None, method="GET"):
        return pt.dispatch(method, suffix, query or {}, self.headers)


class GuardTests(RelayTestCase):
    def test_disabled_header_origin_and_method_guards_precede_transport(self):
        opener = self.use({})
        os.environ[pt.ENABLE_ENV] = "0"
        with self.assertRaises(pt.PublicTrafficError) as ctx:
            self.call(["providers"])
        self.assertEqual((ctx.exception.status, ctx.exception.code), (404, "public_traffic_disabled"))
        os.environ[pt.ENABLE_ENV] = "1"
        for headers, code in (({**self.headers, pt.HEADER: "no"}, "traffic_header_required"),
                              ({**self.headers, "Origin": "https://foreign.example"}, "origin_not_allowed"),
                              ({**self.headers, "Sec-Fetch-Site": "cross-site"}, "origin_not_allowed")):
            with self.assertRaises(pt.PublicTrafficError) as ctx:
                pt.dispatch("GET", ["providers"], {}, headers)
            self.assertEqual(ctx.exception.code, code)
        with self.assertRaises(pt.PublicTrafficError) as ctx:
            self.call(["providers"], method="POST")
        self.assertEqual(ctx.exception.status, 405)
        self.assertEqual(opener.seen, [])

    def test_provider_status_and_no_secret_leak(self):
        os.environ.pop(pt.PROVIDER_FILTER_ENV, None)
        os.environ.pop(pt.TOMTOM_ENABLE_ENV, None)
        listing = self.call(["providers"])
        status = {p["id"]: p["status"] for p in listing["cameraProviders"]}
        self.assertTrue(all(value == "disabled" for value in status.values()))
        self.assertEqual(listing["traffic"]["status"], "disabled")
        self.assertIn("No plate reading", listing["privacy"])
        os.environ["UCAS_WSDOT_ACCESS_CODE"] = "SECRET-WSDOT-123"
        os.environ["UCAS_TOMTOM_API_KEY"] = "SECRET-TOMTOM-456"
        os.environ[pt.PROVIDER_FILTER_ENV] = "caltrans,wsdot"
        os.environ[pt.TOMTOM_ENABLE_ENV] = "1"
        listing = self.call(["providers"])
        status = {p["id"]: p["status"] for p in listing["cameraProviders"]}
        self.assertEqual(status["wsdot"], "available")
        self.assertEqual(status["tfl"], "disabled")
        self.assertEqual(listing["traffic"]["status"], "available")
        text = json.dumps(listing)
        self.assertNotIn("SECRET-WSDOT", text)
        self.assertNotIn("SECRET-TOMTOM", text)

    def test_query_validation(self):
        self.use({})
        bad = [q(provider="nope", west=-1, south=-1, east=1, north=1),
               q(provider="caltrans", west=1, south=-1, east=-1, north=1),
               q(provider="caltrans", west=-10, south=30, east=0, north=40),
               q(provider="caltrans", west="nan", south=-1, east=1, north=1),
               {**q(provider="caltrans", west=-1, south=-1, east=1, north=1), "url": ["https://evil.example"]}]
        for query in bad:
            with self.assertRaises(pt.PublicTrafficError) as ctx:
                self.call(["cameras", "catalog"], query)
            self.assertEqual(ctx.exception.status, 400)
        with self.assertRaises(pt.PublicTrafficError) as ctx:
            self.call(["cameras", "catalog"], q(provider="wsdot", west=-122.5, south=47.5, east=-122.2, north=47.8))
        self.assertEqual((ctx.exception.status, ctx.exception.code), (503, "not_configured"))

    def test_out_of_coverage_makes_no_request(self):
        opener = self.use({})
        result = self.call(["cameras", "catalog"], q(provider="tfl", west=10, south=10, east=11, north=11))
        self.assertEqual(result["status"], "out_of_coverage")
        self.assertEqual(opener.seen, [])


class CatalogTests(RelayTestCase):
    def test_caltrans_reads_only_overlapping_district_and_normalises(self):
        opener = self.use({"https://cwwp2.dot.ca.gov/data/d4/cctv/cctvStatusD04.json": js(CALTRANS_D4),
                           "https://cwwp2.dot.ca.gov/data/d3/cctv/cctvStatusD03.json": js({"data": []})})
        result = self.call(["cameras", "catalog"], q(provider="caltrans", west=-122.4, south=37.7, east=-122.2, north=37.9))
        self.assertEqual(sorted(u for u, _ in opener.seen), ["https://cwwp2.dot.ca.gov/data/d3/cctv/cctvStatusD03.json",
                                                             "https://cwwp2.dot.ca.gov/data/d4/cctv/cctvStatusD04.json"])
        ids = [c["id"] for c in result["cameras"]]
        self.assertEqual(ids, ["D04:x", "D04:tv102"])  # in service, inside bbox, nearest first
        cam = result["cameras"][1]
        self.assertEqual((cam["road"], cam["direction"], cam["lat"], cam["lon"]), ("I-580", "West", 37.82539, -122.27291))
        self.assertEqual(cam["providerUpdatedAt"], "2026-01-23T22:19:48Z")
        self.assertIsNone(result["cameras"][0]["snapshotUrl"])  # foreign host dropped
        self.assertEqual(result["attribution"], "Caltrans — cwwp2.dot.ca.gov (courtesy)")
        self.assertEqual(result["status"], "ok")
        self.assertIn("retrievedAt", result)

    def test_catalog_cache_and_throttle(self):
        opener = self.use({"https://api.tfl.gov.uk/Place/Type/JamCam": js(TFL)})
        query = q(provider="tfl", west=-0.3, south=51.4, east=0.1, north=51.7)
        first = self.call(["cameras", "catalog"], query)
        self.call(["cameras", "catalog"], query)
        self.assertEqual(len(opener.seen), 1)
        self.assertEqual([c["id"] for c in first["cameras"]], ["JamCams_00001.2", "JamCams_00001.1"])
        tfl = {c["id"]: c for c in first["cameras"]}
        self.assertIsNone(tfl["JamCams_00001.2"]["snapshotUrl"])  # outside the jamcams bucket path
        self.assertEqual(tfl["JamCams_00001.1"]["providerUpdatedAt"], "2026-10-10T07:31:00Z")
        self.assertEqual(tfl["JamCams_00001.1"]["direction"], "West")
        self.now += pt.CATALOG_TTL + 1
        self.call(["cameras", "catalog"], query)
        self.assertEqual(len(opener.seen), 2)

    def test_austin_txdot_nsw_digitraffic(self):
        austin_row = {"camera_id": "674", "location_name": " CESAR CHAVEZ ST / 35 SVRD", "primary_st": " CESAR CHAVEZ ST",
                      "modified_date": "2026-09-24T21:58:00.000", "screenshot_address": "https://cctv.austinmobility.io/image/674.jpg",
                      "location": {"type": "Point", "coordinates": [-97.735786, 30.260996]}}
        gz = gzip.compress(json.dumps(DIGITRAFFIC).encode())
        opener = self.use({
            "https://data.austintexas.gov/resource/b4k4-adkb.json": js([austin_row], extra={"Last-Modified": "Sun, 25 Oct 2026 06:55:38 GMT"}),
            "https://its.txdot.gov/its/DistrictIts/GetCctvStatusListByDistrict": js(TXDOT),
            "https://data.livetraffic.com/cameras/traffic-cam.json": js(NSW),
            "https://tie.digitraffic.fi/api/weathercam/v1/stations": lambda: FakeResponse(gz, extra={"Content-Encoding": "gzip"}),
        })
        austin = self.call(["cameras", "catalog"], q(provider="austin", west=-97.8, south=30.2, east=-97.7, north=30.3))
        self.assertEqual(austin["cameras"][0]["name"], "CESAR CHAVEZ ST / 35 SVRD")
        self.assertEqual(austin["cameras"][0]["providerUpdatedAt"], "2026-09-25T02:58:00Z")
        self.assertEqual(austin["providerUpdatedAt"], "2026-10-25T06:55:38Z")
        austin_url = parse_qs(urlsplit(opener.seen[0][0]).query)
        self.assertEqual(austin_url["camera_status"], ["TURNED_ON"])
        os.environ[pt.TXDOT_DISTRICTS_ENV] = "aus,BOGUS"
        txdot = self.call(["cameras", "catalog"], q(provider="txdot", west=-98, south=30, east=-97.5, north=30.5))
        self.assertEqual([c["id"] for c in txdot["cameras"]], ["AUS:IH-35 @ E Riverside _1000_"])
        self.assertIn("icdId=IH-35+%40+E+Riverside+%281000%29", txdot["cameras"][0]["snapshotUrl"])
        self.assertEqual(sum("GetCctvStatusListByDistrict" in u for u, _ in opener.seen), 1)
        nsw = self.call(["cameras", "catalog"], q(provider="nsw", west=151, south=-34.1, east=151.2, north=-33.9))
        self.assertEqual(nsw["snapshotMode"], "hotlink")
        self.assertTrue(nsw["cameras"][0]["snapshotUrl"].startswith("https://webcams.transport.nsw.gov.au/livetraffic-webcams/cameras/"))
        digi = self.call(["cameras", "catalog"], q(provider="digitraffic", west=24.5, south=60, east=25.5, north=60.5))
        self.assertEqual([c["id"] for c in digi["cameras"]], ["C0150301"])
        self.assertEqual(digi["providerUpdatedAt"], "2026-10-30T18:43:56Z")
        sent = dict(opener.seen[-1][1])
        self.assertEqual(sent.get("Accept-encoding"), "gzip")
        self.assertIn("Digitraffic-user", sent)

    def test_keyed_providers_put_key_only_in_upstream_request(self):
        os.environ["UCAS_ONTARIO511_API_KEY"] = "SECRET-ON-KEY"
        os.environ["UCAS_WSDOT_ACCESS_CODE"] = "SECRET-WSDOT"
        opener = self.use({"https://511on.ca/api/v2/get/cameras": js(IBI),
                           "https://wsdot.wa.gov/Traffic/api/HighwayCameras/HighwayCamerasREST.svc/GetCamerasAsJson": js(WSDOT)})
        on = self.call(["cameras", "catalog"], q(provider="ontario511", west=-79.6, south=43.7, east=-79.2, north=44))
        self.assertIn("key=SECRET-ON-KEY", opener.seen[0][0])
        self.assertEqual([c["id"] for c in on["cameras"]], ["455-815"])
        self.assertEqual(on["cameras"][0]["snapshotUrl"], "https://511on.ca/map/Cctv/815")
        ws = self.call(["cameras", "catalog"], q(provider="wsdot", west=-122.5, south=47.5, east=-122.2, north=47.8))
        self.assertEqual({c["id"]: c["snapshotUrl"] for c in ws["cameras"]},
                         {"1001": "https://images.wsdot.wa.gov/nw/005vc16970.jpg", "1002": None})
        for result in (on, ws):
            self.assertNotIn("SECRET", json.dumps(result))

    def test_upstream_errors_never_echo_url_or_key(self):
        os.environ["UCAS_FL511_API_KEY"] = "SECRET-FL"
        self.use({"https://fl511.com/api/v2/get/cameras": HTTPError("https://fl511.com/api/v2/get/cameras?key=SECRET-FL", 401, "no", {}, io.BytesIO())})
        with self.assertRaises(pt.PublicTrafficError) as ctx:
            self.call(["cameras", "catalog"], q(provider="fl511", west=-80.5, south=25.5, east=-80, north=26))
        self.assertEqual(ctx.exception.code, "upstream_unauthorized")
        self.assertNotIn("SECRET", ctx.exception.message)
        self.assertNotIn("fl511.com", ctx.exception.message)
        pt.reset_state()
        os.environ["UCAS_511NY_API_KEY"] = "SECRET-NY"
        self.use({"https://511ny.org/api/v2/get/cameras": lambda: FakeResponse(b"<!doctype html>", "text/html")})
        with self.assertRaises(pt.PublicTrafficError) as ctx:
            self.call(["cameras", "catalog"], q(provider="ny511", west=-74.1, south=40.6, east=-73.8, north=40.9))
        self.assertEqual(ctx.exception.code, "upstream_invalid_json")

    def test_catalog_size_limit(self):
        big = FakeResponse(b"[]")
        big.headers["Content-Length"] = str(pt.MAX_CATALOG_BYTES + 1)
        self.use({"https://api.tfl.gov.uk/": lambda: big})
        with self.assertRaises(pt.PublicTrafficError) as ctx:
            self.call(["cameras", "catalog"], q(provider="tfl", west=-0.3, south=51.4, east=0.1, north=51.7))
        self.assertEqual(ctx.exception.status, 413)


class SnapshotTests(RelayTestCase):
    def test_relay_returns_display_bytes_with_image_time(self):
        opener = self.use({"https://cwwp2.dot.ca.gov/data/d4/cctv/cctvStatusD04.json": js(CALTRANS_D4),
                           "https://cwwp2.dot.ca.gov/data/d4/cctv/image/tv102/tv102.jpg": img()})
        result = self.call(["cameras", "snapshot"], q(provider="caltrans", id="D04:tv102"))
        self.assertEqual(base64.b64decode(result["dataBase64"]), JPEG)
        self.assertEqual((result["mime"], result["imageTime"], result["imageTimeSource"]), ("image/jpeg", "2026-10-30T21:47:54Z", "http-last-modified"))
        self.assertIn("display only", result["disclosure"])
        with self.assertRaises(pt.PublicTrafficError) as ctx:
            self.call(["cameras", "snapshot"], q(provider="caltrans", id="D04:tv102"))
        self.assertEqual(ctx.exception.code, "snapshot_throttled")
        self.now += pt.SNAPSHOT_MIN_INTERVAL + 1
        self.call(["cameras", "snapshot"], q(provider="caltrans", id="D04:tv102"))
        self.assertEqual(sum(u.endswith("tv102.jpg") for u, _ in opener.seen), 2)

    def test_unknown_foreign_and_non_image_snapshots_rejected(self):
        self.use({"https://cwwp2.dot.ca.gov/data/d4/cctv/cctvStatusD04.json": js(CALTRANS_D4),
                  "https://cwwp2.dot.ca.gov/data/d4/cctv/image/tv102/tv102.jpg": img(b"<html>placeholder</html>", content_type="text/html")})
        for camera_id, code in (("D04:missing", "camera_not_found"), ("D04:x", "snapshot_unavailable"), ("D99:x", "camera_not_found")):
            with self.assertRaises(pt.PublicTrafficError) as ctx:
                self.call(["cameras", "snapshot"], q(provider="caltrans", id=camera_id))
            self.assertEqual(ctx.exception.code, code)
        with self.assertRaises(pt.PublicTrafficError) as ctx:
            self.call(["cameras", "snapshot"], q(provider="caltrans", id="D04:tv102"))
        self.assertEqual(ctx.exception.code, "snapshot_not_image")
        with self.assertRaises(pt.PublicTrafficError) as ctx:
            self.call(["cameras", "snapshot"], {**q(provider="caltrans", id="D04:tv102"), "url": ["https://evil.example/x.jpg"]})
        self.assertEqual(ctx.exception.code, "invalid_query")

    def test_hotlink_provider_is_never_relayed(self):
        opener = self.use({})
        with self.assertRaises(pt.PublicTrafficError) as ctx:
            self.call(["cameras", "snapshot"], q(provider="nsw", id="023651ee"))
        self.assertEqual(ctx.exception.code, "snapshot_hotlink_only")
        self.assertEqual(opener.seen, [])

    def test_txdot_base64_json_snapshot_and_local_timestamp(self):
        self.use({"https://its.txdot.gov/its/DistrictIts/GetCctvStatusListByDistrict": js(TXDOT),
                  "https://its.txdot.gov/its/DistrictIts/GetCctvSnapshotByIcdId": js({"icd_Id": "x", "snippet": base64.b64encode(JPEG).decode(),
                                                                                      "timestampFormatted": "10/30/2026 4:52 PM"})})
        os.environ[pt.TXDOT_DISTRICTS_ENV] = "AUS"
        result = self.call(["cameras", "snapshot"], q(provider="txdot", id="AUS:IH-35 @ E Riverside _1000_"))
        self.assertEqual(base64.b64decode(result["dataBase64"]), JPEG)
        self.assertEqual((result["imageTime"], result["imageTimeSource"]), ("2026-10-30T21:52:00Z", "provider-json"))

    def test_rate_window(self):
        self.use({"https://cwwp2.dot.ca.gov/data/d4/cctv/cctvStatusD04.json": js(CALTRANS_D4)})
        pt._snapshot_window[:] = [self.now] * pt.SNAPSHOT_PER_MINUTE
        with self.assertRaises(pt.PublicTrafficError) as ctx:
            self.call(["cameras", "snapshot"], q(provider="caltrans", id="D04:tv102"))
        self.assertEqual(ctx.exception.code, "snapshot_rate_limited")


class TomTomTests(RelayTestCase):
    query = q(west=-74.0, south=40.7, east=-73.9, north=40.8)

    def test_disabled_without_explicit_flag_even_with_key(self):
        os.environ["UCAS_TOMTOM_API_KEY"] = "SECRET-TT"
        os.environ.pop(pt.TOMTOM_ENABLE_ENV, None)
        opener = self.use({})
        with self.assertRaises(pt.PublicTrafficError) as ctx:
            self.call(["tomtom"], self.query)
        self.assertEqual((ctx.exception.status, ctx.exception.code), (404, "provider_disabled"))
        self.assertEqual(opener.seen, [])

    def test_not_configured_without_key(self):
        opener = self.use({})
        with self.assertRaises(pt.PublicTrafficError) as ctx:
            self.call(["tomtom"], self.query)
        self.assertEqual((ctx.exception.status, ctx.exception.code), (503, "not_configured"))
        self.assertEqual(opener.seen, [])

    def test_incidents_and_flow_normalised_without_key_in_output(self):
        os.environ["UCAS_TOMTOM_API_KEY"] = "SECRET-TT"
        opener = self.use({"https://api.tomtom.com/traffic/services/5/incidentDetails": js(TOMTOM_INCIDENTS),
                           "https://api.tomtom.com/traffic/services/4/flowSegmentData": js(TOMTOM_FLOW)})
        result = self.call(["tomtom"], self.query)
        self.assertNotIn("SECRET", json.dumps(result))
        self.assertTrue(all("key=SECRET-TT" in u for u, _ in opener.seen))
        bbox = parse_qs(urlsplit(opener.seen[0][0]).query)["bbox"][0]
        self.assertEqual(bbox, "-74.00000,40.70000,-73.90000,40.80000")
        self.assertEqual(len(result["incidents"]), 1)
        inc = result["incidents"][0]
        self.assertEqual((inc["category"], inc["delaySeconds"], inc["lat"], inc["lon"], inc["roadNumbers"]), ("Jam", 240.0, 40.75, -73.95, "I-495"))
        self.assertEqual(inc["lastReportTime"], "2026-10-30T21:40:00Z")
        self.assertEqual((result["flow"]["currentSpeedKmh"], result["flow"]["freeFlowSpeedKmh"]), (31.0, 56.0))
        self.assertEqual(result["attribution"], "Traffic data © TomTom")
        again = self.call(["tomtom"], self.query)
        self.assertTrue(again["cached"])
        self.assertEqual(len(opener.seen), 2)

    def test_area_limit_and_flow_failure_is_soft(self):
        os.environ["UCAS_TOMTOM_API_KEY"] = "k"
        self.use({"https://api.tomtom.com/traffic/services/5/incidentDetails": js({"incidents": []}),
                  "https://api.tomtom.com/traffic/services/4/flowSegmentData": HTTPError("u", 400, "no road", {}, io.BytesIO())})
        with self.assertRaises(pt.PublicTrafficError) as ctx:
            self.call(["tomtom"], q(west=-75, south=40, east=-73.5, north=41.5))
        self.assertEqual(ctx.exception.code, "bbox_too_large")
        result = self.call(["tomtom"], self.query)
        self.assertIsNone(result["flow"])
        self.assertEqual(result["flowError"], "upstream_error")


class RouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app_path = ROOT / "services/management-api/app.py"
        sys.path.insert(0, str(app_path.parent))
        spec = importlib.util.spec_from_file_location("public_traffic_route_app", app_path)
        cls.app = importlib.util.module_from_spec(spec); sys.modules[spec.name] = cls.app; spec.loader.exec_module(cls.app)
        cls.app.STORE = cls.app.InMemoryStore(); cls.server = cls.app.create_server("127.0.0.1", 0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True); cls.thread.start(); cls.port = cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join(timeout=2)

    def request(self, path, headers=None):
        conn = HTTPConnection("127.0.0.1", self.port, timeout=3); conn.request("GET", path, headers=headers or {})
        response = conn.getresponse(); body = response.read(); conn.close(); return response.status, json.loads(body)

    def test_route_is_disabled_by_default_and_lists_providers_when_enabled(self):
        old = os.environ.pop("UCAS_PUBLIC_TRAFFIC_ENABLED", None)
        old_allow = os.environ.get(pt.PROVIDER_FILTER_ENV)
        try:
            status, body = self.request("/api/v1/public-traffic/providers")
            self.assertEqual((status, body["error"]["code"]), (404, "public_traffic_disabled"))
            os.environ["UCAS_PUBLIC_TRAFFIC_ENABLED"] = "1"
            os.environ[pt.PROVIDER_FILTER_ENV] = "caltrans"
            status, body = self.request("/api/v1/public-traffic/providers", {"X-SignalWarden-Traffic": "enabled", "Host": f"127.0.0.1:{self.port}"})
            self.assertEqual(status, 200)
            self.assertIn("caltrans", [p["id"] for p in body["cameraProviders"]])
            status, body = self.request("/api/v1/public-traffic/cameras/catalog?provider=caltrans&west=1&south=1&east=0&north=2",
                                        {"X-SignalWarden-Traffic": "enabled", "Host": f"127.0.0.1:{self.port}"})
            self.assertEqual((status, body["error"]["code"]), (400, "invalid_bbox"))
        finally:
            os.environ.pop("UCAS_PUBLIC_TRAFFIC_ENABLED", None)
            if old_allow is None:
                os.environ.pop(pt.PROVIDER_FILTER_ENV, None)
            else:
                os.environ[pt.PROVIDER_FILTER_ENV] = old_allow
            if old is not None:
                os.environ["UCAS_PUBLIC_TRAFFIC_ENABLED"] = old


if __name__ == "__main__":
    unittest.main()
