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
MOD = ROOT / "services" / "management-api" / "sar_imagery.py"
spec = importlib.util.spec_from_file_location("sar_imagery_test_module", MOD)
sar = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = sar
spec.loader.exec_module(sar)

PRODUCT = "S1D_IW_GRDH_1SDV_20261021T230634_20261021T230659_005120_009B33_6409"

class Headers(dict):
    def get_content_type(self):
        return self.get("Content-Type", "").split(";", 1)[0].strip()

class Response(io.BytesIO):
    def __init__(self, data=b"jpeg"):
        super().__init__(data)
        self.headers = Headers({"Content-Type": "image/jpeg", "Content-Length": str(len(data))})
    def close(self):
        super().close()

class Opener:
    def __init__(self, responses): self.responses = iter(responses)
    def open(self, request, timeout=None):
        item = next(self.responses)
        if isinstance(item, HTTPError): raise item
        return item

def redirect(url, location, code=307):
    return HTTPError(url, code, "redirect", {"Location": location}, io.BytesIO())

class SarTests(unittest.TestCase):
    def setUp(self):
        self.env = os.environ.get("UCAS_PUBLIC_SAR_ENABLED")
        os.environ["UCAS_PUBLIC_SAR_ENABLED"] = "1"
        self.headers = {"X-SignalWarden-SAR": "enabled", "Host": "127.0.0.1:8000", "Origin": "http://127.0.0.1:8000"}
    def tearDown(self):
        if self.env is None: os.environ.pop("UCAS_PUBLIC_SAR_ENABLED", None)
        else: os.environ["UCAS_PUBLIC_SAR_ENABLED"] = self.env
    def test_guards_and_validation_happen_before_transport(self):
        with self.assertRaisesRegex(sar.SarImageryError, "disabled"):
            os.environ["UCAS_PUBLIC_SAR_ENABLED"] = "0"; sar.fetch_browse(PRODUCT, self.headers)
        os.environ["UCAS_PUBLIC_SAR_ENABLED"] = "1"
        with self.assertRaisesRegex(sar.SarImageryError, "product"):
            sar.fetch_browse(PRODUCT + "-GRD_HD", self.headers)
        with self.assertRaisesRegex(sar.SarImageryError, "cross-site"):
            h = {**self.headers, "Sec-Fetch-Site": "cross-site"}; sar.fetch_browse(PRODUCT, h)
    def test_allowlisted_chain_and_jpeg(self):
        self.assertEqual(sar._url_for(PRODUCT), "https://datapool.asf.alaska.edu/BROWSE/SD/" + PRODUCT + ".jpg")
        first = "https://sentinel1.asf.alaska.edu/BROWSE/SD/" + PRODUCT + ".jpg"
        cdn = "https://dy4owt9f80bz7.cloudfront.net" + sar._CDN_PREFIX + PRODUCT + ".jpg?A-userid=None&Expires=1&Signature=x&Key-Pair-Id=k"
        opener = Opener([redirect(sar._url_for(PRODUCT), first), redirect(first, cdn, 303), Response(b"abc")])
        old = sar.build_opener; sar.build_opener = lambda *args: opener
        try: self.assertEqual(sar.fetch_browse(PRODUCT, self.headers).payload, b"abc")
        finally: sar.build_opener = old

    def test_product_modes_and_browse_redirect_constraints(self):
        for mode in ("IW", "EW", "S1", "S2", "S3", "S4", "S5", "S6"):
            sar.validate_product(PRODUCT.replace("_IW_", "_" + mode + "_"))
        for suffix in ("SV", "SH", "DV", "DH"):
            sar.validate_product(PRODUCT.replace("1SDV", "1S" + suffix))
        base = "https://sentinel1.asf.alaska.edu/BROWSE/SD/" + PRODUCT + ".jpg"
        self.assertTrue(sar._allowed_redirect(base, PRODUCT, sar._url_for(PRODUCT)))
        for bad in (base.replace(".jpg", ".jpg?x=1"),
                    base.replace("https://sentinel1.asf.alaska.edu/", "https://sentinel1.asf.alaska.edu:444/"),
                    base.replace("/BROWSE/SD/", "/BROWSE/S1D/"),
                    "https://evil.example/BROWSE/SD/" + PRODUCT + ".jpg"):
            self.assertFalse(sar._allowed_redirect(bad, PRODUCT, sar._url_for(PRODUCT)))

    def test_redirect_cap_and_byte_cap(self):
        old = sar.build_opener
        try:
            first = "https://sentinel1.asf.alaska.edu/BROWSE/SD/" + PRODUCT + ".jpg"
            sar.build_opener = lambda *args: Opener([redirect(sar._url_for(PRODUCT), first)] * (sar.MAX_REDIRECTS + 1))
            with self.assertRaisesRegex(sar.SarImageryError, "redirected too many"):
                sar.fetch_browse(PRODUCT, self.headers)
            oversized = Response(b"x" * (sar.MAX_BYTES + 1))
            sar.build_opener = lambda *args: Opener([oversized])
            with self.assertRaisesRegex(sar.SarImageryError, "size limit"):
                sar.fetch_browse(PRODUCT, self.headers)
        finally: sar.build_opener = old

    def test_concurrency_limit(self):
        class Busy:
            def acquire(self, blocking=False): return False
            def release(self): raise AssertionError("busy slot must not be released")
        old = sar._transport_slots; sar._transport_slots = Busy()
        try:
            with self.assertRaisesRegex(sar.SarImageryError, "concurrency limit"):
                sar.fetch_browse(PRODUCT, self.headers)
        finally: sar._transport_slots = old

    def test_redirect_and_mime_rejected(self):
        old = sar.build_opener
        try:
            sar.build_opener = lambda *args: Opener([redirect(sar._url_for(PRODUCT), "https://evil.example/x")])
            with self.assertRaisesRegex(sar.SarImageryError, "redirect"): sar.fetch_browse(PRODUCT, self.headers)
            bad = Response(b"x"); bad.headers["Content-Type"] = "text/html"
            sar.build_opener = lambda *args: Opener([bad])
            with self.assertRaisesRegex(sar.SarImageryError, "JPEG"): sar.fetch_browse(PRODUCT, self.headers)
        finally: sar.build_opener = old

class RouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app_path = ROOT / "services/management-api/app.py"
        sys.path.insert(0, str(app_path.parent))
        spec = importlib.util.spec_from_file_location("sar_route_app", app_path)
        cls.app = importlib.util.module_from_spec(spec); sys.modules[spec.name] = cls.app; spec.loader.exec_module(cls.app)
        cls.app.STORE = cls.app.InMemoryStore(); cls.server = cls.app.create_server("127.0.0.1", 0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True); cls.thread.start(); cls.port = cls.server.server_address[1]
    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join(timeout=2)
    def request(self, path, headers=None):
        conn = HTTPConnection("127.0.0.1", self.port, timeout=3); conn.request("GET", path, headers=headers or {})
        response = conn.getresponse(); body = response.read(); conn.close(); return response.status, body
    def test_disabled_and_header_errors_are_json(self):
        old = os.environ.get("UCAS_PUBLIC_SAR_ENABLED"); os.environ.pop("UCAS_PUBLIC_SAR_ENABLED", None)
        try:
            status, body = self.request("/api/v1/public-imagery/sar/browse?product=" + PRODUCT)
            self.assertEqual(status, 404); self.assertEqual(json.loads(body)["error"]["code"], "sar_imagery_disabled")
        finally:
            if old is not None: os.environ["UCAS_PUBLIC_SAR_ENABLED"] = old
    def test_foreign_origin_rejected(self):
        os.environ["UCAS_PUBLIC_SAR_ENABLED"] = "1"
        status, body = self.request("/api/v1/public-imagery/sar/browse?product=" + PRODUCT, {"X-SignalWarden-SAR":"enabled", "Host":f"127.0.0.1:{self.port}", "Origin":"https://foreign.example"})
        self.assertEqual(status, 403); self.assertEqual(json.loads(body)["error"]["code"], "origin_not_allowed")

if __name__ == "__main__": unittest.main()
