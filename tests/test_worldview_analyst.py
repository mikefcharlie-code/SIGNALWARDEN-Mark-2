import importlib.util
import json
import sys
import threading
from http.client import HTTPConnection
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "management-api"))
from worldview_analyst import analyze, validate_request  # noqa: E402

CANDIDATES = [
    {"id": "a", "text": "Candidate A", "citationIds": ["c1"]},
    {"id": "b", "text": "Candidate B", "citationIds": ["c2"]},
]


def request(mode="local", consent=False):
    return {"mode": mode, "question": "Which first?", "candidates": CANDIDATES, "consent": consent}


def test_local_without_configuration_never_calls_network(monkeypatch):
    monkeypatch.delenv("UCAS_AI_LOCAL_MODEL", raising=False)
    monkeypatch.delenv("UCAS_LATTICE_AI_ENDPOINT", raising=False)
    monkeypatch.setattr("worldview_analyst._provider", lambda *args: pytest.fail("network call"))
    result = analyze(request(), {})
    assert result["engine"] == "deterministic"
    assert result["selectedIds"] == ["a", "b"]
    assert result["dataLeavesSystem"] is False


def test_local_ignores_external_setting(monkeypatch):
    monkeypatch.setenv("UCAS_AI_MODE", "external")
    result = analyze(request(), {})
    assert result["engine"] == "deterministic"


def test_unknown_model_id_falls_back_and_preserves_all(monkeypatch):
    monkeypatch.setattr("worldview_analyst._provider", lambda *args: ["unknown"])
    env = {"UCAS_AI_LOCAL_MODEL": "qwen", "UCAS_LATTICE_AI_ENDPOINT": "http://127.0.0.1:8080"}
    result = analyze(request(), env)
    assert result["engine"] == "deterministic"
    assert result["selectedIds"] == ["a", "b"]


def test_external_requires_explicit_double_consent(monkeypatch):
    monkeypatch.setattr("worldview_analyst._provider", lambda *args: ["b", "a"])
    env = {"UCAS_AI_EXTERNAL_CONSENT": "true", "UCAS_AI_EXTERNAL_PROVIDER": "openai", "UCAS_AI_EXTERNAL_MODEL": "x", "UCAS_AI_EXTERNAL_API_KEY": "secret"}
    result = analyze(request("external", True), env)
    assert result["engine"] == "external-model"
    assert result["selectedIds"] == ["b", "a"]
    assert result["dataLeavesSystem"] is True


def test_limits_and_exact_shape():
    with pytest.raises(ValueError):
        validate_request({**request(), "question": "x" * 2001})
    with pytest.raises(ValueError):
        validate_request({**request(), "candidates": CANDIDATES + [{"id": "x", "text": "", "citationIds": []}] * 80})
    with pytest.raises(ValueError):
        validate_request({**request(), "candidates": [{"id": "a", "text": "", "citationIds": []}, {"id": "a", "text": "", "citationIds": []}]})


def test_validation_rejects_unhashable_mode_and_oversized_identifiers():
    with pytest.raises(ValueError):
        validate_request({**request(), "mode": []})
    with pytest.raises(ValueError):
        validate_request({**request(), "candidates": [{"id": "x" * 129, "text": "", "citationIds": []}]})
    with pytest.raises(ValueError):
        validate_request({**request(), "candidates": [{"id": "x", "text": "", "citationIds": ["c" * 129]}]})


def test_provider_emits_qwen_runner_bounded_payload_and_maps_short_ids(monkeypatch):
    import worldview_analyst as analyst
    captured = {}

    class Response:
        status = 200
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def read(self, *_): return json.dumps({"choices": [{"message": {"content": '{"selectedIds":["c1"]}'}}]}).encode()

    class Opener:
        def open(self, req, timeout):
            captured["payload"] = json.loads(req.data)
            captured["timeout"] = timeout
            return Response()

    monkeypatch.setattr(analyst.urllib.request, "build_opener", lambda *args: Opener())
    selected = analyst._provider("http://127.0.0.1:8080/v1/chat/completions", "qwen", "pick", CANDIDATES, 2)
    assert selected == ["b"]
    assert captured["payload"]["max_tokens"] == 400
    assert len("\n".join(m["content"] for m in captured["payload"]["messages"])) <= 4096
    assert len(json.dumps(captured["payload"], separators=(",", ":")).encode()) <= 16 * 1024
    assert captured["payload"]["messages"][1]["content"].find('"id":"a"') == -1


def test_provider_rejects_extra_output_and_oversized_fallback(monkeypatch):
    import worldview_analyst as analyst

    class Response:
        status = 200
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def read(self, *_): return b'{"choices":[{"message":{"content":"{\\"selectedIds\\":[],\\"extra\\":1}"}}]}'

    class Opener:
        def open(self, req, timeout): return Response()

    monkeypatch.setattr(analyst.urllib.request, "build_opener", lambda *args: Opener())
    assert analyst._provider("http://127.0.0.1:8080/v1/chat/completions", "qwen", "pick", CANDIDATES, 2) is None
    monkeypatch.setattr(analyst, "_read_response", lambda response, deadline: b"x" * 64001)
    assert analyst._provider("http://127.0.0.1:8080/v1/chat/completions", "qwen", "pick", CANDIDATES, 2) is None


@pytest.fixture
def analyst_server(monkeypatch):
    app_path = ROOT / "services" / "management-api" / "app.py"
    spec = importlib.util.spec_from_file_location("worldview_route_app", app_path)
    app = importlib.util.module_from_spec(spec); sys.modules[spec.name] = app; spec.loader.exec_module(app)
    monkeypatch.setenv("UCAS_AI_INSTALL_ENABLED", "1")
    monkeypatch.setenv("UCAS_AI_INSTALL_TOKEN", "t" * 40)
    monkeypatch.delenv("UCAS_AI_INSTALL_ORIGINS", raising=False)
    server = app.create_server("127.0.0.1", 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    yield server
    server.shutdown(); server.server_close(); thread.join(2)


def test_real_analyst_route_auth_origin_and_body(analyst_server):
    def call(body, headers=None):
        conn = HTTPConnection("127.0.0.1", analyst_server.server_port, timeout=5)
        conn.request("POST", "/api/v1/local-ai/analyst", json.dumps(body), {"Content-Type": "application/json", **(headers or {})})
        response = conn.getresponse(); raw = response.read(); conn.close()
        return response.status, json.loads(raw)
    status, body = call(request(), {"Authorization": "Bearer wrong"})
    assert status == 401 and body["error"]["code"] == "local_ai_auth_required"
    auth = {"Authorization": "Bearer " + "t" * 40, "Origin": "https://evil.example"}
    status, body = call(request(), auth)
    assert status == 403 and body["error"]["code"] == "origin_not_allowed"
    status, body = call({**request(), "mode": {}}, {"Authorization": "Bearer " + "t" * 40, "Origin": "http://localhost:3000"})
    assert status == 400 and body["error"]["code"] == "invalid_analyst_request"


def test_explicit_local_runtime_disabled_does_not_contact_model(monkeypatch):
    monkeypatch.setattr('worldview_analyst._provider', lambda *args: pytest.fail('disabled runtime called'))
    env = {'UCAS_AI_LOCAL_MODEL': 'Qwen/Qwen3-0.6B', 'UCAS_LATTICE_AI_ENDPOINT': 'http://127.0.0.1:8080', 'UCAS_AI_LOCAL_RUNTIME': 'disabled'}
    result = analyze(request(), env)
    assert result['engine'] == 'deterministic'
    assert result['dataLeavesSystem'] is False


def test_remote_endpoint_and_missing_external_consent_never_call_provider(monkeypatch):
    monkeypatch.setattr('worldview_analyst._provider', lambda *args: pytest.fail('unauthorized provider call'))
    assert analyze(request(), {'UCAS_AI_LOCAL_MODEL': 'Qwen', 'UCAS_LATTICE_AI_ENDPOINT': 'https://example.com'})['engine'] == 'deterministic'
    external = {'UCAS_AI_EXTERNAL_CONSENT': 'true', 'UCAS_AI_EXTERNAL_PROVIDER': 'openai', 'UCAS_AI_EXTERNAL_MODEL': 'x', 'UCAS_AI_EXTERNAL_API_KEY': 'fixture-only'}
    assert analyze(request('external', False), external)['dataLeavesSystem'] is False
    assert analyze(request('external', True), {**external, 'UCAS_AI_EXTERNAL_CONSENT': 'false'})['dataLeavesSystem'] is False


def test_provider_timeout_falls_back_without_returning_model_text(monkeypatch):
    import worldview_analyst
    class TimeoutOpener:
        def open(self, *args, **kwargs):
            raise TimeoutError('fixture timeout')
    monkeypatch.setattr(worldview_analyst.urllib.request, 'build_opener', lambda *args: TimeoutOpener())
    env = {'UCAS_AI_LOCAL_MODEL': 'Qwen/Qwen3-0.6B', 'UCAS_LATTICE_AI_ENDPOINT': 'http://127.0.0.1:8080'}
    result = analyze(request(), env)
    assert result['engine'] == 'deterministic'
    assert result['selectedIds'] == ['a', 'b']
    assert result['dataLeavesSystem'] is False
