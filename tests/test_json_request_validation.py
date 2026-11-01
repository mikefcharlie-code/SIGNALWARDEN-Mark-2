"""HTTP boundary regressions for malformed JSON (issues #4 and #5)."""
import json
import threading
from http.client import HTTPConnection

import pytest

from test_management_api import app


@pytest.fixture
def api_server():
    app.STORE = app.InMemoryStore()
    server = app.create_server("127.0.0.1", 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_address[1]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


@pytest.mark.parametrize("constant", ["NaN", "Infinity", "-Infinity", "1e400", "-1e400"])
def test_nonfinite_json_constants_are_rejected_without_ingestion(api_server, constant):
    payload = (
        '{"schema_version":"1.0","aircraft_id":"sim-ucas-001",'
        '"timestamp":"2026-01-01T00:00:00Z","received_at":"2026-01-01T00:00:00Z",'
        '"sequence":1,"source":"simulated","health":{'
        '"battery_voltage_v":' + constant + ',"battery_percent":88,'
        '"link_quality_percent":96,"temperature_c":25,"status":"nominal"}}'
    ).encode()
    status, body = send_raw(api_server, payload)
    assert status == 400
    assert body["error"]["code"] == "invalid_json"
    assert app.STORE.history("sim-ucas-001") == []
    assert app.STORE.ingestion_status("sim-ucas-001")["counts"] == {}


def test_excessive_json_nesting_is_a_client_error(api_server):
    payload = b'{"nested":' + b'[' * 20000 + b'0' + b']' * 20000 + b'}'
    status, body = send_raw(api_server, payload)
    assert status == 400
    assert body["error"]["code"] == "invalid_json"
    assert app.STORE.history("sim-ucas-001") == []


def send_raw(port, payload):
    connection = HTTPConnection("127.0.0.1", port, timeout=3)
    try:
        connection.request("POST", "/api/v1/telemetry/ingest", body=payload,
                           headers={"Content-Type": "application/json"})
        response = connection.getresponse()
        return response.status, json.loads(response.read())
    finally:
        connection.close()
