"""Local HTTP contract tests; no external platform or Lattice service is used."""
import importlib.util
import json
import sys
import threading
from http.client import HTTPConnection
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "management-api"))
SPEC = importlib.util.spec_from_file_location("lattice_test_api", ROOT / "services" / "management-api" / "app.py")
app = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = app
SPEC.loader.exec_module(app)


@pytest.fixture
def api(monkeypatch):
    monkeypatch.setenv("UCAS_LATTICE_MODE", "mock")
    app.STORE = app.InMemoryStore()
    server = app.create_server("127.0.0.1", 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def request(method, path, body=None):
        connection = HTTPConnection("127.0.0.1", server.server_port, timeout=3)
        payload = json.dumps(body) if body is not None else None
        connection.request(method, path, payload, {"Content-Type": "application/json"})
        response = connection.getresponse()
        raw = response.read()
        connection.close()
        return response.status, json.loads(raw)

    yield request
    server.shutdown()
    server.server_close()
    thread.join(timeout=2)


def test_mock_status_and_paginated_catalog(api):
    code, status = api("GET", "/api/v1/lattice/status")
    assert code == 200
    assert status["mode"] == "mock"
    assert status["connected"] is False
    assert status["read_only"] is True
    code, first = api("GET", "/api/v1/lattice/catalog?limit=1")
    assert code == 200
    assert first["count"] == 1
    assert first["next_cursor"]
    code, second = api("GET", "/api/v1/lattice/catalog?limit=1&cursor=" + first["next_cursor"])
    assert code == 200
    assert first["items"] != second["items"]


def test_mock_observations_do_not_join_aircraft_inventory(api):
    code, platforms = api("GET", "/api/v1/lattice/platforms")
    assert code == 200
    assert platforms["count"] >= 3
    first = platforms["items"][0]
    detail_code, detail = api("GET", "/api/v1/lattice/platforms/" + first["entityId"])
    assert detail_code == 200
    assert detail == first
    _, inventory = api("GET", "/api/v1/aircraft")
    assert [item["aircraft_id"] for item in inventory["items"]] == ["sim-ucas-001"]
    assert app.STORE.telemetry == []
    assert api("GET", "/api/v1/lattice/platforms/nonexistent")[0] == 404


def test_offline_has_catalog_but_no_observations(api, monkeypatch):
    monkeypatch.setenv("UCAS_LATTICE_MODE", "offline")
    code, platforms = api("GET", "/api/v1/lattice/platforms")
    assert code == 200
    assert platforms == {"items": [], "count": 0, "next_cursor": None}
    assert api("GET", "/api/v1/lattice/catalog")[1]["count"] > 0
    assert api("GET", "/api/v1/lattice/status")[1]["connected"] is False


@pytest.mark.parametrize("mode", ["live", "sandbox", "https://example.test", "", "MOCK"])
def test_invalid_modes_fail_closed(api, monkeypatch, mode):
    monkeypatch.setenv("UCAS_LATTICE_MODE", mode)
    code, result = api("GET", "/api/v1/lattice/status")
    assert code == 503
    assert result["error"]["code"] == "lattice_mode_unavailable"


@pytest.mark.parametrize("method", ["POST", "PATCH"])
@pytest.mark.parametrize("route", ["status", "catalog", "platforms", "platforms/mock-uav/arm", "tasks", "publish"])
def test_all_handled_write_methods_are_denied(api, method, route):
    code, result = api(method, "/api/v1/lattice/" + route, {"action": "never-execute"})
    assert code == 405
    assert result["error"]["code"] == "read_only_integration"
    assert app.STORE.telemetry == []


@pytest.mark.parametrize("query", ["limit=0", "limit=101", "limit=invalid", "cursor=invalid"])
def test_invalid_pagination(api, query):
    assert api("GET", "/api/v1/lattice/platforms?" + query)[0] == 400


def test_no_task_or_raw_entity_routes(api):
    for route in ("tasks", "publish", "entities", "platforms/mock-uav/fire"):
        assert api("GET", "/api/v1/lattice/" + route)[0] == 404


def test_startup_rejects_live_mode_before_server_creation(monkeypatch):
    monkeypatch.setenv("UCAS_LATTICE_MODE", "live")
    monkeypatch.setattr(app, "create_server", lambda *_: pytest.fail("must not open a listener"))
    with pytest.raises(ValueError):
        app.main()


def test_overview_http_contract_and_capability_pagination(api):
    code, overview = api("GET", "/api/v1/lattice/overview")
    assert code == 200
    assert overview["mode"] == "mock"
    assert overview["readOnly"] is True
    assert overview["connected"] is False
    assert overview["summary"]["platformCount"] == len(overview["platforms"]) == 7
    assert overview["summary"]["sensorCount"] == 2
    assert sum(overview["summary"]["freshness"].values()) == 7
    assert overview["diagnostics"]["transport"] == "none"
    code, first = api("GET", "/api/v1/lattice/capabilities?limit=1")
    assert code == 200
    assert first["count"] == 1
    assert first["next_cursor"]
    code, second = api("GET", "/api/v1/lattice/capabilities?limit=1&cursor=" + first["next_cursor"])
    assert code == 200
    assert first["items"] != second["items"]
    _, all_items = api("GET", "/api/v1/lattice/capabilities?limit=100")
    assert all_items["count"] == 8
    assert {item["implementation"] for item in all_items["items"]} == {"local-demo", "excluded"}
    assert app.STORE.telemetry == []


def test_offline_overview_has_no_alerts_and_keeps_capabilities(api, monkeypatch):
    monkeypatch.setenv("UCAS_LATTICE_MODE", "offline")
    code, overview = api("GET", "/api/v1/lattice/overview")
    assert code == 200
    assert overview["platforms"] == overview["attention"] == []
    assert overview["summary"]["platformCount"] == 0
    assert overview["diagnostics"]["source"] == "none"
    assert overview["diagnostics"]["lastSourceUpdateTime"] is None
    assert api("GET", "/api/v1/lattice/capabilities")[1]["count"] == 8


@pytest.mark.parametrize("route", ["overview", "capabilities"])
@pytest.mark.parametrize("method", ["POST", "PATCH"])
def test_extension_writes_are_rejected(api, route, method):
    code, result = api(method, "/api/v1/lattice/" + route, {"action": "never-execute"})
    assert code == 405
    assert result["error"]["code"] == "read_only_integration"
    assert app.STORE.telemetry == []


@pytest.mark.parametrize("route", ["overview", "capabilities"])
def test_extension_modes_fail_closed(api, monkeypatch, route):
    monkeypatch.setenv("UCAS_LATTICE_MODE", "live")
    code, result = api("GET", "/api/v1/lattice/" + route)
    assert code == 503
    assert result["error"]["code"] == "lattice_mode_unavailable"


@pytest.mark.parametrize("query", ["limit=0", "limit=101", "limit=no", "cursor=invalid"])
def test_capability_invalid_pagination(api, query):
    assert api("GET", "/api/v1/lattice/capabilities?" + query)[0] == 400


def test_copilot_http_evidence_is_exact_citable_and_local_by_default(api, monkeypatch):
    """The real HTTP projection exposes evidence, not a pretend model response."""
    monkeypatch.setenv("UCAS_AI_MODE", "local")
    monkeypatch.setenv("UCAS_AI_LOCAL_RUNTIME", "rules")
    monkeypatch.setattr("urllib.request.build_opener", lambda *a: pytest.fail("rules must not call any provider"))
    code, overview = api("GET", "/api/v1/lattice/overview")
    assert code == 200
    assessment = overview["assessment"]
    assert assessment["generatedAt"] == overview["generatedAt"]
    assert assessment["evidence"] and assessment["findings"]
    evidence = {row["id"]: row for row in assessment["evidence"]}
    assert len(evidence) == len(assessment["evidence"])
    for finding in assessment["findings"]:
        assert finding["evidenceIds"]
        for citation in finding["evidenceIds"]:
            assert citation in evidence
    for row in evidence.values():
        assert row["entityId"] not in {"synthetic-weapon-001", "synthetic-effector-001"}
        assert row["field"] and row["sourceId"]
        assert "observedAt" in row and "trust" in row and "freshness" in row
        assert row["synthetic"] is True
        assert row["freshness"] != "current"  # static fixtures must never become current on refresh
    code, assistance = api("GET", "/api/v1/lattice/assistance")
    assert code == 200
    assert assistance["engine"] == "rules"
    assert assistance["modelStatus"] == "unconfigured"
    assert assistance["dataLeavesSystem"] is False
    assert assistance["readOnly"] is True
    assert assistance["assessment"]["snapshotId"] == assessment["snapshotId"]
    assert app.STORE.telemetry == []


@pytest.mark.parametrize("route", ["overview", "assistance"])
@pytest.mark.parametrize("method", ["POST", "PATCH"])
def test_copilot_remains_advisory_get_only(api, route, method):
    code, result = api(method, "/api/v1/lattice/" + route, {"prompt": "ignored", "action": "never-execute"})
    assert code == 405
    assert result["error"]["code"] == "read_only_integration"
    assert app.STORE.telemetry == []


def test_unavailable_local_model_http_path_never_tries_external(api, monkeypatch):
    import urllib.error

    monkeypatch.setenv("UCAS_AI_MODE", "local")
    monkeypatch.setenv("UCAS_AI_LOCAL_RUNTIME", "openai-compatible")
    monkeypatch.setenv("UCAS_AI_LOCAL_MODEL", "unavailable-test-model")
    monkeypatch.setenv("UCAS_LATTICE_AI_ENDPOINT", "http://127.0.0.1:9")
    # Even fully populated external settings cannot enable fallback in local mode.
    monkeypatch.setenv("UCAS_AI_EXTERNAL_PROVIDER", "openai")
    monkeypatch.setenv("UCAS_AI_EXTERNAL_CONSENT", "true")
    monkeypatch.setenv("UCAS_AI_EXTERNAL_MODEL", "must-not-run")
    monkeypatch.setenv("UCAS_AI_EXTERNAL_API_KEY", "test-not-a-key")
    attempted = []

    class Unavailable:
        def open(self, request, timeout):
            attempted.append(request.full_url)
            raise urllib.error.URLError("local model unavailable in test")

    monkeypatch.setattr("urllib.request.build_opener", lambda *a: Unavailable())
    code, response = api("GET", "/api/v1/lattice/assistance")
    assert code == 200
    assert attempted == ["http://127.0.0.1:9/v1/chat/completions"]
    assert response["engine"] == "rules"
    assert response["modelStatus"] == "unavailable"
    assert response["dataLeavesSystem"] is False
    assert "unavailable" in response["disclosure"].lower()
    assert response["assessment"]["evidence"]
    assert response["assessment"]["findings"]
    assert app.STORE.telemetry == []
