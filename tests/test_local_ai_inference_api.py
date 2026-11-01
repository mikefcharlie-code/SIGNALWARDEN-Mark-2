import base64
import importlib.util
import json
import sys
import threading
from http.client import HTTPConnection
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
APP_PATH = ROOT / "services" / "management-api" / "app.py"
sys.path.insert(0, str(APP_PATH.parent))
spec = importlib.util.spec_from_file_location("ucas_management_api_local_ai_inference", APP_PATH)
app = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = app
spec.loader.exec_module(app)


@pytest.fixture
def server(monkeypatch):
    monkeypatch.setenv("UCAS_AI_INSTALL_ENABLED", "1")
    monkeypatch.setenv("UCAS_AI_INFERENCE_ENABLED", "1")
    monkeypatch.setenv("UCAS_AI_INSTALL_TOKEN", "t" * 40)
    monkeypatch.delenv("UCAS_AI_INSTALL_ORIGINS", raising=False)
    monkeypatch.setenv("UCAS_AI_MODE", "remote")
    with app.local_ai_inference._LOCK:
        app.local_ai_inference._JOBS.clear()
    instance = app.create_server("127.0.0.1", 0)
    thread = threading.Thread(target=instance.serve_forever, daemon=True)
    thread.start()
    yield instance
    instance.shutdown(); instance.server_close(); thread.join(2)


def request(server, method, path, body=None, headers=None):
    connection = HTTPConnection("127.0.0.1", server.server_port, timeout=5)
    merged = {"Authorization": "Bearer " + "t" * 40, "Content-Type": "application/json", **(headers or {})}
    payload = None if body is None else json.dumps(body)
    connection.request(method, path, payload, merged)
    response = connection.getresponse()
    raw = response.read()
    connection.close()
    content_type = response.getheader("Content-Type", "")
    if "json" in content_type:
        return response.status, json.loads(raw), response
    return response.status, raw, response


def test_inference_requires_feature_gate_and_bearer_auth(server, monkeypatch):
    status, body, _ = request(server, "GET", "/api/v1/local-ai/inference/status", headers={"Authorization": "Bearer wrong"})
    assert status == 401 and body["error"]["code"] == "local_ai_auth_required"
    monkeypatch.setenv("UCAS_AI_INFERENCE_ENABLED", "0")
    status, body, _ = request(server, "GET", "/api/v1/local-ai/inference/status")
    assert status == 404 and body["error"]["code"] == "not_found"


def test_status_is_readiness_only_and_does_not_hash_or_load(server, monkeypatch):
    calls = []
    monkeypatch.setattr(app.local_ai_inference, "status", lambda: calls.append("status") or {"enabled": True, "groups": [{"group": "llm", "ready": False, "modelPresent": False}]})
    monkeypatch.setattr(app.local_ai_inference, "preflight", lambda: pytest.fail("status must not preflight"), raising=False)
    status, body, _ = request(server, "GET", "/api/v1/local-ai/inference/status")
    assert status == 200 and body["groups"][0]["ready"] is False
    assert calls == ["status"]


def test_create_resolves_only_offline_evidence_and_never_mutates_store(server, monkeypatch):
    captured = {}
    evidence = [
        {"id": "keep", "observedAt": "2025-01-01T00:00:00Z", "value": "grounded observation", "entityId": "aircraft-1"},
        {"id": "drop", "observedAt": "2025-01-01T00:01:00Z", "value": "other observation", "entityId": "aircraft-1"},
    ]

    class FakeLattice:
        def __init__(self, *args, **kwargs):
            pass

        def overview(self, **kwargs):
            return {"assessment": {"evidence": evidence}}

    def fake_create(body, context=None):
        captured["body"] = body
        captured["context"] = context
        return {"id": "job-1", "state": "queued", "group": body["group"], "device": body["device"]}

    monkeypatch.setattr(app, "OfflineLattice", FakeLattice)
    monkeypatch.setattr(app.local_ai_inference, "create_job", fake_create)
    before = json.dumps(evidence, sort_keys=True)
    status, body, _ = request(server, "POST", "/api/v1/local-ai/inference", {"group": "llm", "device": "cpu", "prompt": "quote", "recordIds": ["keep"]}, {"Origin": "http://localhost:3000"})
    assert status == 202 and body["id"] == "job-1"
    assert captured["body"] == {"group": "llm", "device": "cpu", "prompt": "quote", "recordIds": ["keep"]}
    assert captured["context"] == [{
        "record_id": "keep",
        "timestamp": "2025-01-01T00:00:00Z",
        "text": '{"entityId": "aircraft-1", "field": null, "freshness": null, "sourceId": null, "subjectId": null, "synthetic": null, "trust": null, "value": "grounded observation"}',
        "synthetic": False,
    }]
    assert json.dumps(evidence, sort_keys=True) == before


def test_client_context_and_unknown_record_are_rejected_without_inference(server, monkeypatch):
    monkeypatch.setattr(app.local_ai_inference, "create_job", lambda *args: pytest.fail("invalid request reached inference"))
    for payload in (
        {"group": "llm", "device": "cpu", "context": []},
        {"group": "llm", "device": "cpu", "recordIds": ["missing"]},
        {"group": "llm", "device": "cpu", "recordIds": "keep"},
        {"group": "llm", "device": "cpu", "unexpected": 1},
    ):
        status, body, _ = request(server, "POST", "/api/v1/local-ai/inference", payload, {"Origin": "http://localhost:3000"})
        assert status == 400 and body["error"]["code"] in {"invalid_inference_request", "invalid_context", "unknown_context_record", "invalid_prompt"}


def test_prompt_and_media_validation_limits(server, monkeypatch):
    monkeypatch.setattr(app.local_ai_inference, "create_job", lambda *args: pytest.fail("oversize request reached inference"))
    for payload in (
        {"group": "llm", "device": "cpu", "prompt": "x" * 2001},
        {"group": "llm", "device": "cpu", "media": {"name": "x.txt", "data": base64.b64encode(b"not media").decode()}},
    ):
        status, body, _ = request(server, "POST", "/api/v1/local-ai/inference", payload, {"Origin": "http://localhost:3000"})
        assert status == 400 and body["error"]["code"] in {"invalid_prompt", "invalid_media"}


def test_raw_upload_and_wire_limits_are_enforced(server, monkeypatch):
    monkeypatch.setattr(app.local_ai_inference, "create_job", lambda *args: pytest.fail("oversize request reached inference"))
    # A valid-looking PNG signature plus >8 MiB decoded content must be rejected.
    raw = b"\x89PNG\r\n\x1a\n" + b"0" * (8 * 1024 * 1024)
    payload = {"group": "image-classification", "device": "cpu", "media": {"name": "x.png", "data": base64.b64encode(raw).decode()}}
    status, body, _ = request(server, "POST", "/api/v1/local-ai/inference", payload, {"Origin": "http://localhost:3000"})
    assert status == 413 and body["error"]["code"] in {"request_too_large", "media_too_large"}


def test_job_read_cancel_and_binary_artifact(server, monkeypatch, tmp_path):
    artifact = tmp_path / "out.png"
    artifact.write_bytes(b"PNG-fixture")
    monkeypatch.setattr(app.local_ai_inference, "get_job", lambda job_id: {"id": job_id, "state": "succeeded"})
    monkeypatch.setattr(app.local_ai_inference, "cancel_job", lambda job_id: {"id": job_id, "state": "cancelled"})
    monkeypatch.setattr(app.local_ai_inference, "artifact", lambda job_id: (artifact.read_bytes(), "image/png"))
    status, body, _ = request(server, "GET", "/api/v1/local-ai/inference/jobs/job-1")
    assert status == 200 and body["state"] == "succeeded"
    status, body, _ = request(server, "POST", "/api/v1/local-ai/inference/jobs/job-1/cancel", {}, {"Origin": "http://localhost:3000"})
    assert status == 200 and body["state"] == "cancelled"
    status, raw, response = request(server, "GET", "/api/v1/local-ai/inference/jobs/job-1/artifact")
    assert status == 200 and raw == b"PNG-fixture" and response.getheader("Content-Type") == "image/png"


def test_mutations_require_allowed_origin_and_cancel_body_is_exact(server, monkeypatch):
    monkeypatch.setattr(app.local_ai_inference, "create_job", lambda *args: pytest.fail("origin check happened too late"))
    status, body, _ = request(server, "POST", "/api/v1/local-ai/inference", {"group": "llm", "device": "cpu"}, {"Origin": "https://evil.example"})
    assert status == 403 and body["error"]["code"] == "origin_not_allowed"
    monkeypatch.setattr(app.local_ai_inference, "cancel_job", lambda *args: pytest.fail("invalid cancel body reached module"))
    status, body, _ = request(server, "POST", "/api/v1/local-ai/inference/jobs/job-1/cancel", {"extra": 1}, {"Origin": "http://localhost:3000"})
    assert status == 400 and body["error"]["code"] in {"invalid_cancel_request", "invalid_json"}
