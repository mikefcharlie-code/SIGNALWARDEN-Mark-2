import json

from services.lattice_readonly import OfflineLattice
from services.lattice_readonly.assistance import build_assistance


def test_default_is_local_rules_without_network(monkeypatch):
    def fail(*args, **kwargs):
        raise AssertionError("default local rules must not call a provider")
    monkeypatch.setattr("urllib.request.build_opener", fail)
    result = build_assistance(OfflineLattice("offline").overview(now=None), environ={})
    assert result["mode"] == "local"
    assert result["engine"] == "rules"
    assert result["modelStatus"] == "unconfigured"
    assert result["dataLeavesSystem"] is False
    assert result["readOnly"] is True


def test_external_requires_all_explicit_flags_and_never_falls_back():
    result = build_assistance({}, environ={"UCAS_AI_MODE": "external", "UCAS_AI_EXTERNAL_PROVIDER": "openai"})
    assert result["modelStatus"] == "unavailable"
    assert result["dataLeavesSystem"] is False
    assert result["engine"] == "rules"


def test_bad_loopback_config_and_missing_model_fail_closed(monkeypatch):
    monkeypatch.setattr("urllib.request.build_opener", lambda *args: (_ for _ in ()).throw(AssertionError("must not call")))
    result = build_assistance({}, environ={"UCAS_AI_LOCAL_RUNTIME": "openai-compatible", "UCAS_LATTICE_AI_ENDPOINT": "http://example.test:80", "UCAS_AI_LOCAL_MODEL": "m"})
    assert result["modelStatus"] == "unavailable"
    assert result["provider"] == "openai-compatible-local"
    result = build_assistance({}, environ={"UCAS_AI_LOCAL_RUNTIME": "openai-compatible", "UCAS_LATTICE_AI_ENDPOINT": "http://127.0.0.1:80"})
    assert result["modelStatus"] == "unavailable"


def test_local_root_gets_chat_completions_path_and_model(monkeypatch):
    class Response:
        status = 200
        def read(self, size):
            return json.dumps({"choices": [{"message": {"content": '{"insights": [{"id": "summary.empty", "evidence": ["summary.empty"]}]}'}}]}).encode()
        def __enter__(self): return self
        def __exit__(self, *args): pass
    captured = {}
    def opener(*args):
        class O:
            def open(self, req, timeout):
                captured["url"] = req.full_url
                captured["body"] = json.loads(req.data)
                return Response()
        return O()
    monkeypatch.setattr("urllib.request.build_opener", opener)
    result = build_assistance({}, environ={"UCAS_AI_LOCAL_RUNTIME": "openai-compatible", "UCAS_AI_LOCAL_MODEL": "local-test", "UCAS_LATTICE_AI_ENDPOINT": "http://127.0.0.1:1"})
    assert result["engine"] == "local-model"
    assert result["modelStatus"] == "available"
    assert captured["url"] == "http://127.0.0.1:1/v1/chat/completions"
    assert captured["body"]["model"] == "local-test"


def test_external_success_requires_consent_and_discloses(monkeypatch):
    class Response:
        status = 200
        def read(self, size):
            return b'{"choices":[{"message":{"content":"{\\"insights\\":[]}"}}]}'
        def __enter__(self): return self
        def __exit__(self, *args): pass
    captured = {}
    def opener(*args):
        class O:
            def open(self, req, timeout):
                captured.update(url=req.full_url, auth=req.headers.get("Authorization"), body=json.loads(req.data))
                return Response()
        return O()
    monkeypatch.setattr("urllib.request.build_opener", opener)
    result = build_assistance({}, environ={"UCAS_AI_MODE": "external", "UCAS_AI_EXTERNAL_PROVIDER": "openai", "UCAS_AI_EXTERNAL_CONSENT": "true", "UCAS_AI_EXTERNAL_MODEL": "gpt-test", "UCAS_AI_EXTERNAL_API_KEY": "secret"})
    assert result["modelStatus"] == "available"
    assert result["dataLeavesSystem"] is True
    assert captured["url"] == "https://api.openai.com/v1/chat/completions"
    assert captured["auth"] == "Bearer secret"
    assert captured["body"]["model"] == "gpt-test"


def test_malformed_nested_response_injection_and_duplicates_fail_safe(monkeypatch):
    class Response:
        status = 200
        def __init__(self, payload): self.payload = payload
        def read(self, size): return self.payload
        def __enter__(self): return self
        def __exit__(self, *args): pass
    payloads = [b'{}', b'{"choices":[null]}', b'{"choices":[{"message":{}}]}', b'{"choices":[{"message":{"content":"{\\"insights\\":[{\\"id\\":\\"summary.empty\\",\\"evidence\\":[\\"summary.empty\\" ]},{\\"id\\":\\"summary.empty\\",\\"evidence\\":[\\"summary.empty\\"]}]}"}}]}']
    for payload in payloads:
        monkeypatch.setattr("urllib.request.build_opener", lambda *args, p=payload: type("O", (), {"open": lambda self, req, timeout: Response(p)})())
        result = build_assistance({}, environ={"UCAS_AI_LOCAL_RUNTIME": "openai-compatible", "UCAS_AI_LOCAL_MODEL": "m", "UCAS_LATTICE_AI_ENDPOINT": "http://127.0.0.1:1"})
        assert result["modelStatus"] == "unavailable"
        assert result["engine"] == "rules"


def test_evidence_excludes_inventory_and_exposes_counts():
    overview = {"platforms": [
        {"catalogId": "informational-weapon-like", "freshness": "stale", "sensors": {"sensors": [{"sensorId": "secret", "operationalState": "x"}]}},
        {"catalogId": "autonomous-air-like", "freshness": "stale", "sensors": {"sensors": [{"sensorId": "safe", "operationalState": "x"}]}},
        ],
        "attention": [{"code": "observation_stale", "entityId": "sensitive-id"}], "synthetic": True}
    result = build_assistance(overview, environ={})
    assert result["evidenceCounts"] == {"freshness.stale": 1}
    assert result["insights"][0]["detail"].find("1") >= 0
    serialized = json.dumps(result)
    assert "secret" not in serialized and "sensitive-id" not in serialized


def test_local_cpu_budget_is_separate_from_external_budget():
    from services.lattice_readonly.assistance import _timeout
    assert _timeout({}, local=True) == 45
    assert _timeout({}, local=False) == 2
    assert _timeout({"UCAS_LATTICE_AI_TIMEOUT": "999"}, local=True) == 60
    assert _timeout({"UCAS_LATTICE_AI_TIMEOUT": "999"}) == 2
    for value in ("nan", "inf", "-inf", "not-a-number"):
        assert _timeout({"UCAS_LATTICE_AI_TIMEOUT": value}, local=True) == 45
        assert _timeout({"UCAS_LATTICE_AI_TIMEOUT": value}) == 2


def test_malformed_loopback_urls_fail_closed_without_network(monkeypatch):
    monkeypatch.setattr("urllib.request.build_opener", lambda *a: (_ for _ in ()).throw(AssertionError("must not call")))
    for endpoint in ("http://[bad:8080", "http://127.0.0.1:bad", "http://127.0.0.1:8080/other", "http://user:pass@127.0.0.1:8080"):
        result = build_assistance({}, environ={"UCAS_AI_LOCAL_RUNTIME": "openai-compatible", "UCAS_AI_LOCAL_MODEL": "m", "UCAS_LATTICE_AI_ENDPOINT": endpoint})
        assert result["modelStatus"] == "unavailable"
        assert result["engine"] == "rules"
        assert result["dataLeavesSystem"] is False


def test_oversize_provider_response_cannot_be_accepted(monkeypatch):
    from services.lattice_readonly.assistance import MAX_RESPONSE_BYTES
    class Response:
        status = 200
        def read(self, size): return b"x" * (MAX_RESPONSE_BYTES + 1)
        def __enter__(self): return self
        def __exit__(self, *args): pass
    monkeypatch.setattr("urllib.request.build_opener", lambda *a: type("O", (), {"open": lambda self, req, timeout: Response()})())
    result = build_assistance({}, environ={"UCAS_AI_LOCAL_RUNTIME": "openai-compatible", "UCAS_AI_LOCAL_MODEL": "m", "UCAS_LATTICE_AI_ENDPOINT": "http://127.0.0.1:8080"})
    assert result["engine"] == "rules"
    assert result["modelStatus"] == "unavailable"


def test_inventory_attention_and_unlinked_events_are_not_provider_evidence():
    from services.lattice_readonly.assistance import _evidence
    overview = {"platforms": [
        {"entityId": "benign", "catalogId": "fixed-camera-sensor-like", "freshness": "current"},
        {"entityId": "inventory", "catalogId": "informational-weapon-like", "freshness": "stale"},
    ], "attention": [
        {"entityId": "benign", "code": "reported_offline"},
        {"entityId": "inventory", "code": "health_unknown"},
        {"entityId": "missing", "code": "health_unknown"},
        {"entityId": [], "code": {}},
    ]}
    evidence, _, counts = _evidence(overview)
    assert evidence["platformCount"] == 1
    assert evidence["attention"]["health_unknown"] == 0
    assert counts == {"attention.reported_offline": 1}
    assert "inventory" not in json.dumps(evidence)
