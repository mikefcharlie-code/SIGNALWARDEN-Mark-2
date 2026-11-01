from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
from scripts import local_ai_setup as ai


def registry_for(data=b"model"):
    return {"schemaVersion": 1, "models": {"llm": {
        "repo_id": "org/model", "revision": "a" * 40, "license": "apache-2.0",
        "source_url": "https://huggingface.co/org/model",
        "files": [{"path": "model.safetensors", "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}],
        "resources": {"download_bytes": len(data), "free_disk_gb": 0},
    }}}


@pytest.fixture(autouse=True)
def isolated_cache(monkeypatch, tmp_path):
    monkeypatch.setenv("UCAS_AI_HOME", str(tmp_path / "cache"))


def test_checked_in_registry_has_all_supported_groups_and_pinned_safe_weights():
    registry = ai.load_registry()
    assert set(registry["models"]) == set(ai.GROUPS)
    for group, entry in registry["models"].items():
        if entry.get("distribution") == "local-only":
            assert group == "telemetry-health"
            assert entry["source_url"] == "local://warden-th-synthetic"
            assert ai.plan(group, registry)["automatic_download"] is False
            assert {item["path"] for item in entry["files"]} == {"warden-th.onnx", "calibration.json"}
            assert all(len(item["sha256"]) == 64 for item in entry["files"])
            continue
        assert entry["license"] in {"mit", "apache-2.0"}
        assert entry["resources"]["download_bytes"] == sum(f["size"] for f in entry["files"])
        assert any(f["path"].endswith(".safetensors") for f in entry["files"])
        assert not any(f["path"].endswith((".bin", ".pt", ".py", ".ckpt")) for f in entry["files"])


def test_warden_local_only_weights_refuse_download_and_verify_after_manual_copy():
    registry = ai.load_registry()
    model = registry["models"]["telemetry-health"]
    assert not ai.verify_group("telemetry-health", registry)
    with pytest.raises(ValueError, match="local-only"):
        ai.download("telemetry-health", accept_license=True, yes=True, registry=registry)
    root = ai.model_dir("telemetry-health")
    root.mkdir(parents=True)
    for entry in model["files"]:
        payload = (entry["path"] + " fixture").encode()
        entry["size"] = len(payload)
        entry["sha256"] = hashlib.sha256(payload).hexdigest()
        (root / entry["path"]).write_bytes(payload)
    model["files"] = list(model["files"])
    assert ai.verify_group("telemetry-health", registry)
    from scripts.local_ai_run import _verified
    assert _verified("telemetry-health", registry)[0] == root


def test_warden_artifact_manifest_pins_external_files_without_bundling_weights():
    root = Path(__file__).resolve().parents[1]
    manifest = json.loads((root / "configs" / "warden-th-artifact.json").read_text())
    registry = ai.load_registry()["models"]["telemetry-health"]
    pinned = {entry["path"]: (entry["size"], entry["sha256"]) for entry in registry["files"]}
    assert pinned[manifest["artifact_file"]] == (manifest["size_bytes"], manifest["sha256"])
    assert pinned[manifest["calibration_file"]] == (manifest["calibration_size_bytes"], manifest["calibration_sha256"])
    assert manifest["weights_in_git"] is False and manifest["automatic_download"] is False
    assert manifest["field_validated"] is False and manifest["synthetic_evaluation"]["targets_met"] is True
    assert not (root / manifest["artifact_file"]).exists()


@pytest.mark.parametrize("mutation", [
    lambda m: m.update(revision="main"),
    lambda m: m.update(source_url="https://evil.example/org/model"),
    lambda m: m.update(repo_id="org/../model"),
    lambda m: m["files"][0].update(path="../escape.safetensors"),
    lambda m: m["files"][0].update(path="model.bin"),
    lambda m: m["files"][0].update(sha256="not-a-hash"),
    lambda m: m["files"][0].update(size=True),
    lambda m: m["files"].append(dict(m["files"][0])),
])
def test_registry_rejects_unsafe_entries(tmp_path, mutation):
    reg = registry_for(); mutation(reg["models"]["llm"])
    path = tmp_path / "registry.json"; path.write_text(json.dumps(reg))
    with pytest.raises(ValueError): ai.load_registry(path)


def test_cache_target_preserves_group_isolation():
    root = ai.model_dir("llm")
    target = ai._target(root, Path("model.safetensors"))
    assert target == root / "model.safetensors"
    assert target != ai.cache_root() / "model.safetensors"


def test_verify_rejects_bad_hash_and_traversal():
    reg = registry_for(); root = ai.model_dir("llm"); root.mkdir(parents=True)
    (root / "model.safetensors").write_bytes(b"wrong")
    assert not ai.verify_group("llm", reg)
    reg["models"]["llm"]["files"][0]["path"] = "../escape.safetensors"
    assert not ai.verify_group("llm", reg)


@pytest.mark.parametrize("kind", ["file", "group", "models"])
def test_verify_rejects_symlinks(tmp_path, kind):
    reg = registry_for(); root = ai.model_dir("llm"); outside = tmp_path / "outside"; outside.mkdir()
    if kind == "file":
        root.mkdir(parents=True); (outside / "weights").write_bytes(b"model")
        (root / "model.safetensors").symlink_to(outside / "weights")
    elif kind == "group":
        root.parent.mkdir(parents=True); root.symlink_to(outside, target_is_directory=True)
        (outside / "model.safetensors").write_bytes(b"model")
    else:
        ai.cache_root().mkdir(); (ai.cache_root() / "models").symlink_to(outside, target_is_directory=True)
        (outside / "llm").mkdir(); (outside / "llm" / "model.safetensors").write_bytes(b"model")
    assert not ai.verify_group("llm", reg)


def fake_download(monkeypatch, payload):
    class Response:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def read(self, size):
            if getattr(self, "done", False): return b""
            self.done = True; return payload
    class Opener:
        def open(self, request, timeout):
            assert request.full_url.startswith("https://huggingface.co/org/model/resolve/" + "a" * 40)
            return Response()
    monkeypatch.setattr(ai.urllib.request, "build_opener", lambda *args: Opener())


def test_download_atomically_verifies_into_group_not_cache_root(monkeypatch):
    fake_download(monkeypatch, b"model")
    assert ai.download("llm", accept_license=True, yes=True, registry=registry_for())
    assert (ai.model_dir("llm") / "model.safetensors").read_bytes() == b"model"
    assert not (ai.cache_root() / "model.safetensors").exists()


@pytest.mark.parametrize("payload", [b"mod", b"wrong", b"oversized"])
def test_corrupt_download_never_becomes_a_model(monkeypatch, payload):
    fake_download(monkeypatch, payload)
    with pytest.raises(ValueError): ai.download("llm", True, True, registry_for())
    assert not (ai.model_dir("llm") / "model.safetensors").exists()
    assert not list(ai.model_dir("llm").glob(".model.safetensors.*"))


def test_existing_valid_snapshot_needs_no_network(monkeypatch):
    root = ai.model_dir("llm"); root.mkdir(parents=True); (root / "model.safetensors").write_bytes(b"model")
    class Opener:
        def open(self, *args, **kwargs): raise AssertionError("valid files must not download")
    monkeypatch.setattr(ai.urllib.request, "build_opener", lambda *args: Opener())
    assert ai.download("llm", True, True, registry_for())


@pytest.mark.parametrize("url", ["http://huggingface.co/file", "https://huggingface.co.evil.test/file", "https://user:pass@huggingface.co/file", "https://huggingface.co:444/file"])
def test_redirect_source_checks(url):
    assert not ai._official(url)


def test_official_cdn_redirect_is_allowed():
    assert ai._official("https://cas-bridge.xethub.hf.co/blob?signature=x")
    assert ai._official("https://cdn-lfs.hf.co/blob")


def test_changes_require_explicit_yes_and_license_before_side_effects():
    with pytest.raises(ValueError, match="--yes"): ai.setup("llm", "cpu", False, registry_for())
    with pytest.raises(ValueError, match="--accept-license"): ai.download("llm", False, True, registry_for())
    assert not ai.cache_root().exists()


@pytest.mark.parametrize("device,index", [("cpu", "cpu"), ("cuda", "cu126")])
def test_setup_uses_explicit_torch_index_then_pypi_without_weights(monkeypatch, device, index):
    calls = []
    monkeypatch.setattr(ai, "_check_platform", lambda: None)
    monkeypatch.setattr(ai, "_available_bytes", lambda p: 100 * 1024**3)
    monkeypatch.setattr(ai.venv.EnvBuilder, "create", lambda self, path: Path(path).mkdir(parents=True, exist_ok=True))
    monkeypatch.setattr(ai.subprocess, "run", lambda command, **kw: calls.append(command))
    monkeypatch.setattr(ai, "download", lambda *a, **kw: (_ for _ in ()).throw(AssertionError("setup must not download weights")))
    target = ai.setup("llm", device, True, registry_for())
    assert len(calls) == 2
    assert "--isolated" in calls[0]
    assert "https://download.pytorch.org/whl/" + index in calls[0]
    assert "--extra-index-url" not in calls[0]
    assert "https://pypi.org/simple" in calls[1]
    assert (target / ".ucas-device").read_text().strip() == device
    other = "cuda" if device == "cpu" else "cpu"
    with pytest.raises(ValueError, match="another device"): ai.setup("llm", other, True, registry_for())


def test_git_blob_integrity_for_metadata(tmp_path):
    data = b"{}"; path = tmp_path / "config.json"; path.write_bytes(data)
    entry = {"size": 2, "git_blob_sha1": hashlib.sha1(b"blob 2\0" + data).hexdigest()}
    assert ai._hash_matches(path, entry)
    path.write_bytes(b"[]")
    assert not ai._hash_matches(path, entry)
