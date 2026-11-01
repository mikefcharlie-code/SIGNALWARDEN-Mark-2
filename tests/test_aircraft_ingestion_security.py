import importlib.util
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP_PATH = ROOT / "services" / "management-api" / "app.py"
sys.path.insert(0, str(APP_PATH.parent))
spec = importlib.util.spec_from_file_location("ucas_management_api_security", APP_PATH)
app = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = app
spec.loader.exec_module(app)
from publisher_auth import PublisherAuthError, PublisherConfigError, authenticate, load_publishers


class AircraftIngestionSecurityTests(unittest.TestCase):
    TOKEN = "t" * 32

    def sample(self, timestamp=None, source="simulated"):
        stamp = timestamp or datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        return {
            "schema_version": "1.0", "aircraft_id": "sim-ucas-001", "timestamp": stamp,
            "received_at": stamp, "sequence": 1, "source": source,
            "health": {"battery_voltage_v": 12.2, "battery_percent": 88,
                       "link_quality_percent": 96, "temperature_c": 25, "status": "nominal"},
        }

    def test_synthetic_default_and_real_fail_closed(self):
        authenticate(source_id="local-simulator", aircraft_id="sim-ucas-001", source="simulated", authorization=None, publishers=None)
        with self.assertRaises(PublisherAuthError) as raised:
            authenticate(source_id="local-simulator", aircraft_id="sim-ucas-001", source="aircraft", authorization=None, publishers=None)
        self.assertEqual(raised.exception.status, 401)

    def test_registered_binding_and_token_errors(self):
        publishers = {"pub-1": {"token": self.TOKEN, "aircraft_ids": {"sim-ucas-001"}, "sources": {"aircraft"}}}
        authenticate(source_id="pub-1", aircraft_id="sim-ucas-001", source="aircraft", authorization="Bearer " + self.TOKEN, publishers=publishers)
        for kwargs, status in [
            ({"source_id": "unknown", "aircraft_id": "sim-ucas-001", "source": "aircraft", "authorization": "Bearer " + self.TOKEN}, 401),
            ({"source_id": "pub-1", "aircraft_id": "sim-ucas-001", "source": "aircraft", "authorization": "Bearer " + "x" * 32}, 401),
            ({"source_id": "pub-1", "aircraft_id": "other", "source": "aircraft", "authorization": "Bearer " + self.TOKEN}, 403),
            ({"source_id": "pub-1", "aircraft_id": "sim-ucas-001", "source": "simulated", "authorization": "Bearer " + self.TOKEN}, 403),
        ]:
            with self.assertRaises(PublisherAuthError) as raised:
                authenticate(publishers=publishers, **kwargs)
            self.assertEqual(raised.exception.status, status)

    def test_invalid_config_is_not_silently_unauthenticated(self):
        with tempfile.NamedTemporaryFile(mode="w", delete=False) as handle:
            handle.write("[]")
            path = handle.name
        try:
            with self.assertRaises(PublisherConfigError):
                load_publishers(path)
        finally:
            os.unlink(path)

    def test_future_day_rejected_and_current_sample_recovers(self):
        store = app.InMemoryStore()
        future = self.sample((datetime.now(timezone.utc) + timedelta(days=1)).isoformat().replace("+00:00", "Z"))
        with self.assertRaises(app.ApiError) as raised:
            store.ingest(future)
        self.assertEqual(raised.exception.code, "timestamp_in_future")
        current = self.sample()
        current["sequence"] = 2
        result = store.ingest(current)
        self.assertEqual(result["status"], "accepted")


if __name__ == "__main__":
    unittest.main()


# HTTP checks supplement the pure authentication-policy tests above.
import threading
from http.client import HTTPConnection
import pytest


@pytest.fixture
def security_api(monkeypatch):
    monkeypatch.delenv("UCAS_TELEMETRY_PUBLISHERS_FILE", raising=False)
    app.STORE = app.InMemoryStore()
    app.STREAM_HUB = app.TelemetryHub()
    server = app.create_server("127.0.0.1", 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    def request(body, headers=None, query=""):
        conn = HTTPConnection("127.0.0.1", server.server_address[1], timeout=2)
        try:
            conn.request("POST", "/api/v1/telemetry/ingest" + query,
                         json.dumps(body), {"Content-Type": "application/json", **(headers or {})})
            response = conn.getresponse()
            return response.status, json.loads(response.read())
        finally:
            conn.close()
    try:
        yield request
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def config_file(tmp_path, monkeypatch):
    path = tmp_path / "publishers.json"
    path.write_text(json.dumps({"pub-1": {"token": "t" * 32,
        "aircraft_ids": ["sim-ucas-001"], "sources": ["aircraft"]}}))
    monkeypatch.setenv("UCAS_TELEMETRY_PUBLISHERS_FILE", str(path))
    return path


def test_http_real_source_fails_closed_and_invalid_config_is_503(security_api, tmp_path, monkeypatch):
    sample = AircraftIngestionSecurityTests().sample(source="aircraft")
    assert security_api(sample)[0] == 401
    path = config_file(tmp_path, monkeypatch)
    path.write_text('{"bad": {"token": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "aircraft_ids": [], "sources": [{}]}}')
    assert security_api(sample)[0] == 503
    assert app.STORE.telemetry == []


def test_http_publisher_binding_revocation_and_no_writes_on_reject(security_api, tmp_path, monkeypatch):
    path = config_file(tmp_path, monkeypatch)
    sample = AircraftIngestionSecurityTests().sample(source="aircraft")
    headers = {"X-Source-ID": "pub-1", "Authorization": "Bearer " + "t" * 32}
    assert security_api(sample, {**headers, "X-Source-ID": "unknown"})[0] == 401
    assert security_api(sample, {**headers, "Authorization": "Bearer " + "x" * 32})[0] == 401
    assert security_api({**sample, "aircraft_id": "other-aircraft"}, headers)[0] == 403
    assert security_api({**sample, "source": "simulated"}, headers)[0] == 403
    assert app.STORE.telemetry == []
    assert security_api(sample, headers)[0] == 202
    path.write_text("{}")
    assert security_api(sample, headers)[0] == 401
    assert len(app.STORE.telemetry) == 1


def test_http_future_rejected_before_latest_is_poisoned(security_api):
    future = AircraftIngestionSecurityTests().sample(
        (datetime.now(timezone.utc) + timedelta(days=1)).isoformat().replace("+00:00", "Z"))
    assert security_api(future)[0] == 400
    current = AircraftIngestionSecurityTests().sample()
    assert security_api(current)[0] == 202
    assert app.STORE.current_view("sim-ucas-001")["sample"]["timestamp"] == current["timestamp"]


def test_http_stream_and_history_share_server_receipt_time(security_api):
    sample = AircraftIngestionSecurityTests().sample()
    sample["received_at"] = "2000-01-01T00:00:00Z"
    with app.STREAM_HUB.subscribe() as subscription:
        status, result = security_api(sample)
        assert status == 202
        event = subscription.events.get(timeout=1)
    persisted = app.STORE.history("sim-ucas-001")[0]
    assert event["received_at"] == result["received_at"] == persisted["received_at"]
    assert event["sample"] == persisted
    assert event["sample"]["received_at"] != sample["received_at"]


def test_query_token_is_rejected_without_access_log_leak(security_api, capsys):
    marker = "query-secret-that-must-not-be-logged"
    sample = AircraftIngestionSecurityTests().sample()
    assert security_api(sample, query="?access_token=" + marker)[0] == 401
    captured = capsys.readouterr()
    assert marker not in captured.out + captured.err
