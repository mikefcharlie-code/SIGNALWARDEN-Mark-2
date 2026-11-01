"""Contract tests for the read-only reports API."""
import importlib.util
import json
import sys
import threading
from http.client import HTTPConnection
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "management-api"))
spec = importlib.util.spec_from_file_location("reports_test_api", ROOT / "services" / "management-api" / "app.py")
app = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = app
spec.loader.exec_module(app)


@pytest.fixture
def api(monkeypatch):
    monkeypatch.setenv("UCAS_LATTICE_MODE", "mock")
    app.STORE = app.InMemoryStore()
    server = app.create_server("127.0.0.1", 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def request(method, path, body=None, headers=None):
        connection = HTTPConnection("127.0.0.1", server.server_port, timeout=3)
        payload = json.dumps(body) if body is not None else None
        request_headers = {"Content-Type": "application/json"}
        request_headers.update(headers or {})
        connection.request(method, path, payload, request_headers)
        response = connection.getresponse()
        result = json.loads(response.read())
        connection.close()
        return response.status, result

    yield request
    server.shutdown()
    server.server_close()
    thread.join(timeout=2)


def test_options_are_canonical_and_include_ids(api):
    status, body = api("GET", "/api/v1/reports/options")
    assert status == 200
    assert {item["id"] for item in body["types"]} == {
        "platform-status", "sensor-isr", "incident-timeline", "data-quality", "operator-handoff"
    }
    assert any(item["id"] == "sim-ucas-001" for item in body["platforms"])
    assert "sensors" in body


def test_generate_is_deterministic_and_does_not_write(api, monkeypatch):
    from datetime import datetime, timezone
    fixed = datetime(2025, 1, 1, tzinfo=timezone.utc)
    monkeypatch.setattr(app, "utc_now", lambda: fixed)
    options = {"type": "platform-status", "engine": "template"}
    first_status, first = api("POST", "/api/v1/reports/generate", options)
    second_status, second = api("POST", "/api/v1/reports/generate", options)
    assert first_status == second_status == 200
    assert first == second
    assert first["advisory"] is True
    assert first["humanReviewRequired"] is True
    assert api("GET", "/api/v1/aircraft")[1]["count"] == 1


def test_generate_validates_options_and_is_get_only_under_lattice(api):
    status, body = api("POST", "/api/v1/reports/generate", {"type": "not-a-report"})
    assert status == 400
    assert body["error"]["code"] == "invalid_report_options"
    status, body = api("GET", "/api/v1/reports/options?unexpected=1")
    assert status == 400
    status, body = api("POST", "/api/v1/lattice/overview", {})
    assert status == 405


@pytest.mark.parametrize('report_type', ['platform-status', 'sensor-isr', 'incident-timeline', 'data-quality', 'operator-handoff'])
def test_all_report_types_have_resolvable_source_citations(api, report_type):
    status, report = api('POST', '/api/v1/reports/generate', {'type': report_type})
    assert status == 200
    evidence = {row['id']: row for row in report['evidence']}
    for section in report['sections']:
        for claim in section['claims']:
            assert claim['evidenceIds'] and all(ref in evidence for ref in claim['evidenceIds'])
    assert report['engine'] == 'template'
    assert not any('weapon' in row['entityId'] or 'effector' in row['entityId'] for row in evidence.values())


def test_adapter_includes_actual_repository_data_without_raw_control_or_notes(api):
    store = app.STORE
    sample = {
        'aircraft_id': 'sim-ucas-001', 'source_id': 'local-simulator', 'source': 'simulated',
        'timestamp': '2025-01-01T00:00:00Z', 'received_at': '2025-01-01T00:00:01Z',
        'event_key': 'canonical-sample-1', 'sequence': 1, 'ingestion_status': 'accepted',
        'health': {'battery_percent': 37, 'link_quality_percent': 18},
        'position': {'latitude_deg': 99, 'longitude_deg': 99}, 'control': 'DO_NOT_EXPORT',
    }
    store.telemetry.append(sample)
    store._maintenance['m1'] = {'aircraft_id': 'sim-ucas-001', 'record_id': 'm1', 'status': 'open', 'created_at': '2025-01-01T00:00:02Z', 'notes': 'PRIVATE_DO_NOT_EXPORT'}
    store._evidence.append({'aircraft_id': 'sim-ucas-001', 'event_id': 'event-1', 'event_type': 'telemetry_accepted', 'occurred_at': sample['timestamp'], 'received_at': sample['received_at'], 'source_id': 'local-simulator', 'integrity_reference': sample['event_key']})
    before = json.dumps([store.telemetry, store._maintenance, store._evidence], sort_keys=True)
    status, report = api('POST', '/api/v1/reports/generate', {'platformIds': ['sim-ucas-001']})
    assert status == 200
    evidence = report['evidence']
    assert any(row['field'] == 'telemetry.battery_percent' and row['value'] == 37 for row in evidence)
    assert any(row['field'] == 'maintenance.status' and row['value'] == 'open' for row in evidence)
    assert any(row['field'] == 'event' and row['sourceId'] == 'local-simulator' for row in evidence)
    assert all(row['trust'] != 'trusted' for row in evidence)
    serialized = json.dumps(report)
    assert 'DO_NOT_EXPORT' not in serialized and 'latitude_deg' not in serialized
    assert json.dumps([store.telemetry, store._maintenance, store._evidence], sort_keys=True) == before


def test_sensor_filter_matches_only_available_sensor_subject(api):
    _, catalog = api('GET', '/api/v1/reports/options')
    assert not any('weapon' in item['id'] or 'effector' in item['id'] for item in catalog['platforms'])
    sensor = catalog['sensors'][0]['id']
    status, report = api('POST', '/api/v1/reports/generate', {'type': 'sensor-isr', 'sensorIds': [sensor]})
    assert status == 200 and report['evidence']
    assert all(row['subjectId'] == sensor or row.get('sensorId') == sensor for row in report['evidence'])


def test_missing_scope_and_local_unavailable_never_create_evidence(api, monkeypatch):
    monkeypatch.setenv('UCAS_AI_MODE', 'external')
    monkeypatch.delenv('UCAS_AI_LOCAL_RUNTIME', raising=False)
    monkeypatch.delenv('UCAS_AI_LOCAL_MODEL', raising=False)
    status, report = api('POST', '/api/v1/reports/generate', {'engine': 'local', 'platformIds': ['not-present']})
    assert status == 200
    assert report['evidence'] == [] and report['coverageGaps']
    assert report['engine'] == 'local-fallback' and report['modelStatus'] != 'available'


@pytest.mark.parametrize('body', [
    {'type': []}, {'engine': 'external'}, {'platformIds': 'all'}, {'sensorIds': [None]},
    {'start': '2025-01-01'}, {'start': '2025-01-01T00:00:00+00:99'},
    {'start': '2026-01-02T00:00:00Z', 'end': '2026-01-01T00:00:00Z'}, {'rawSource': 'invented'},
])
def test_invalid_report_input_fails_closed(api, body):
    assert api('POST', '/api/v1/reports/generate', body)[0] == 400


def test_generation_requires_json_and_never_exposes_write_routes(api):
    assert api('POST', '/api/v1/reports/generate', {}, {'Content-Type': 'text/plain'})[0] == 415
    assert api('GET', '/api/v1/reports/generate')[0] == 404
    assert api('POST', '/api/v1/reports/publish', {})[0] == 404
