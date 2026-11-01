import copy
import importlib.util
import json
import sys
import threading
import unittest
from datetime import datetime, timedelta, timezone
from http.client import HTTPConnection
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP_PATH = ROOT / "services" / "management-api" / "app.py"
sys.path.insert(0, str(APP_PATH.parent))
SPEC = importlib.util.spec_from_file_location("ucas_management_api", APP_PATH)
app = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = app
SPEC.loader.exec_module(app)


class ManagementApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app.STORE = app.InMemoryStore()
        cls.server = app.create_server("127.0.0.1", 0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def setUp(self):
        app.STORE = app.InMemoryStore()

    def request(self, method, path, body=None, headers=None):
        conn = HTTPConnection("127.0.0.1", self.port, timeout=3)
        headers = {"Content-Type": "application/json", **(headers or {})}
        payload = json.dumps(body).encode() if body is not None else None
        conn.request(method, path, body=payload, headers=headers)
        response = conn.getresponse()
        raw = response.read()
        conn.close()
        return response.status, json.loads(raw)

    def telemetry(self, sequence=1, timestamp=None, source="simulated"):
        stamp = timestamp or datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        return {
            "schema_version": "1.0",
            "aircraft_id": "sim-ucas-001",
            "timestamp": stamp,
            "received_at": stamp,
            "sequence": sequence,
            "source": source,
            "health": {
                "battery_voltage_v": 12.2,
                "battery_percent": 88,
                "link_quality_percent": 96,
                "temperature_c": 25,
                "status": "nominal",
            },
        }

    def test_health_and_inventory(self):
        status, body = self.request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertFalse(body["aircraft_control"])
        status, body = self.request("GET", "/api/v1/aircraft?limit=1")
        self.assertEqual(status, 200)
        self.assertEqual(body["count"], 1)
        self.assertEqual(body["items"][0]["aircraft_id"], "sim-ucas-001")

    def test_ingest_latest_history_and_status(self):
        sample = self.telemetry()
        status, result = self.request("POST", "/api/v1/telemetry/ingest", sample, {"X-Source-ID": "sim-source-1"})
        self.assertEqual(status, 202)
        self.assertEqual(result["status"], "accepted")
        self.assertTrue(result["received_at"].endswith("Z"))

        status, latest = self.request("GET", "/api/v1/aircraft/sim-ucas-001/telemetry/latest")
        self.assertEqual(status, 200)
        self.assertEqual(latest["freshness"], "fresh")
        self.assertEqual(latest["sample"]["source_id"], "sim-source-1")
        self.assertEqual(latest["last_accepted_sequence"], 1)

        status, history = self.request("GET", "/api/v1/aircraft/sim-ucas-001/telemetry?limit=10")
        self.assertEqual(status, 200)
        self.assertEqual(history["count"], 1)
        self.assertEqual(history["items"][0]["ingestion_status"], "accepted")

        status, ingestion = self.request("GET", "/api/v1/aircraft/sim-ucas-001/telemetry/ingestion-status")
        self.assertEqual(status, 200)
        self.assertEqual(ingestion["counts"]["accepted"], 1)

    def test_duplicate_is_idempotent_and_evidence_is_readable(self):
        sample = self.telemetry(sequence=2)
        first_status, first = self.request("POST", "/api/v1/telemetry/ingest", sample)
        second_status, second = self.request("POST", "/api/v1/telemetry/ingest", sample)
        self.assertEqual(first_status, 202)
        self.assertEqual(second_status, 200)
        self.assertEqual(first["event_key"], second["event_key"])
        self.assertEqual(second["status"], "duplicate")

        status, evidence = self.request("GET", "/api/v1/aircraft/sim-ucas-001/evidence")
        self.assertEqual(status, 200)
        self.assertTrue(any(item["event_type"] == "telemetry_accepted" for item in evidence["items"]))

    def test_late_sample_does_not_replace_latest(self):
        now = datetime.now(timezone.utc).replace(microsecond=0)
        newer = self.telemetry(sequence=20, timestamp=now.isoformat().replace("+00:00", "Z"))
        older = self.telemetry(sequence=19, timestamp=(now - timedelta(seconds=2)).isoformat().replace("+00:00", "Z"))
        self.request("POST", "/api/v1/telemetry/ingest", newer)
        status, result = self.request("POST", "/api/v1/telemetry/ingest", older)
        self.assertEqual(status, 202)
        self.assertEqual(result["status"], "late")
        _, latest = self.request("GET", "/api/v1/aircraft/sim-ucas-001/telemetry/latest")
        self.assertEqual(latest["last_accepted_sequence"], 20)

    def test_maintenance_create_update_and_list(self):
        record = {
            "schema_version": "1.0",
            "record_id": "maint-api-001",
            "aircraft_id": "sim-ucas-001",
            "summary": "Synthetic inspection",
            "status": "open",
            "created_at": "2026-01-01T00:00:00Z",
        }
        status, created = self.request("POST", "/api/v1/aircraft/sim-ucas-001/maintenance", record)
        self.assertEqual(status, 201)
        self.assertEqual(created["record_id"], record["record_id"])
        status, updated = self.request("PATCH", "/api/v1/maintenance/maint-api-001", {"status": "completed"})
        self.assertEqual(status, 200)
        self.assertEqual(updated["status"], "completed")
        status, listing = self.request("GET", "/api/v1/aircraft/sim-ucas-001/maintenance")
        self.assertEqual(status, 200)
        self.assertTrue(any(item["record_id"] == "maint-api-001" for item in listing["items"]))

    def test_validation_and_not_found_errors(self):
        invalid = copy.deepcopy(self.telemetry(sequence=99))
        invalid["health"]["battery_percent"] = 101
        status, body = self.request("POST", "/api/v1/telemetry/ingest", invalid)
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "contract_validation_failed")
        status, body = self.request("GET", "/api/v1/aircraft/unknown-aircraft")
        self.assertEqual(status, 404)
        self.assertEqual(body["error"]["code"], "aircraft_not_found")

    def test_history_cursor_pagination(self):
        for sequence in (101, 102, 103):
            self.request("POST", "/api/v1/telemetry/ingest", self.telemetry(sequence=sequence))
        status, first = self.request("GET", "/api/v1/aircraft/sim-ucas-001/telemetry?limit=1")
        self.assertEqual(status, 200)
        self.assertEqual(first["count"], 1)
        self.assertIsNotNone(first["next_cursor"])
        status, second = self.request("GET", "/api/v1/aircraft/sim-ucas-001/telemetry?limit=1&cursor=" + first["next_cursor"])
        self.assertEqual(status, 200)
        self.assertEqual(second["count"], 1)
        self.assertNotEqual(first["items"][0]["event_key"], second["items"][0]["event_key"])


if __name__ == "__main__":
    unittest.main()
