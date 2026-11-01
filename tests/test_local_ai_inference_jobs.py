import json
import importlib.util
import os
import shutil
import sys
import time
from pathlib import Path

import fcntl
import pytest

from scripts import local_ai_setup as setup

ROOT = Path(__file__).resolve().parents[1]
APP_PATH = ROOT / "services" / "management-api" / "app.py"
sys.path.insert(0, str(APP_PATH.parent))
spec = importlib.util.spec_from_file_location("ucas_management_api_local_ai_jobs_lifecycle", APP_PATH)
app = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = app
spec.loader.exec_module(app)
jobs = app.local_ai_inference


@pytest.fixture(autouse=True)
def clean_jobs():
    with jobs._LOCK:
        jobs._JOBS.clear()
        jobs._PROCESSES.clear()
        jobs._ACTIVE = None
    yield
    jobs._cleanup()
    with jobs._LOCK:
        jobs._JOBS.clear()
        jobs._PROCESSES.clear()
        jobs._ACTIVE = None


def configure_runtime(monkeypatch, tmp_path, script_body):
    cache = tmp_path / "cache"
    cache.mkdir(exist_ok=True)
    monkeypatch.setenv("UCAS_AI_HOME", str(cache))
    monkeypatch.setattr(setup, "cache_root", lambda: cache)
    venv = cache / "venvs" / "llm"
    shutil.rmtree(venv, ignore_errors=True)
    shutil.rmtree(cache / "models" / "llm", ignore_errors=True)
    (venv / "bin").mkdir(parents=True)
    (venv / "bin" / "python").symlink_to(sys.executable)
    (venv / ".ucas-device").write_text("cpu\n")
    model = cache / "models" / "llm"
    model.mkdir(parents=True)
    weight = model / "weights.safetensors"
    weight.write_bytes(b"fixture")
    monkeypatch.setattr(setup, "_venv_dir", lambda group: venv)
    monkeypatch.setattr(setup, "model_dir", lambda group: model)
    monkeypatch.setattr(setup, "load_registry", lambda: {"models": {"llm": {"files": [{"path": "weights.safetensors", "size": 7}]}}})
    monkeypatch.setattr(jobs, "_readiness", lambda group: {"runtimeInstalled": True, "modelPresent": True, "device": "cpu", "detail": "ready"})
    lock = tmp_path / "installer.lock"
    monkeypatch.setattr(jobs.installer, "_MUTATION_LOCK_PATH", lock)
    script = tmp_path / "worker.py"
    script.write_text(script_body)
    monkeypatch.setattr(jobs, "SCRIPT", script)
    monkeypatch.setenv("UCAS_AI_MODE", "external")
    monkeypatch.setenv("UCAS_AI_INFERENCE_TIMEOUT_SECONDS", "2")
    return venv, script


def wait_for(job_id, state, timeout=4):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        record = jobs.get_job(job_id)
        if record and record["state"] == state:
            return record
        time.sleep(.01)
    pytest.fail(f"job {job_id} did not reach {state}: {jobs.get_job(job_id)}")


def llm_request(prompt="hello"):
    return {"group": "llm", "device": "cpu", "prompt": prompt}


def test_missing_model_and_wrong_device_are_rejected_before_spawn(monkeypatch):
    monkeypatch.setattr(jobs, "_readiness", lambda group: {"runtimeInstalled": False, "modelPresent": False, "device": None, "detail": "missing fixture"})
    with pytest.raises(jobs.InferenceError) as missing:
        jobs.create_job(llm_request())
    assert missing.value.status == 409 and missing.value.code == "model_not_installed"
    monkeypatch.setattr(jobs, "_readiness", lambda group: {"runtimeInstalled": True, "modelPresent": True, "device": "cuda", "detail": "ready"})
    with pytest.raises(jobs.InferenceError) as wrong:
        jobs.create_job(llm_request())
    assert wrong.value.status == 409 and wrong.value.code == "device_unavailable"


def test_queued_cancel_before_spawn(monkeypatch, tmp_path):
    configure_runtime(monkeypatch, tmp_path, "import pathlib,sys,time\npathlib.Path(sys.argv[0] + '.ran').write_text('ran')\ntime.sleep(1)\n")
    lock = jobs.installer._MUTATION_LOCK_PATH
    lock.parent.mkdir(parents=True, exist_ok=True)
    with jobs.installer._open_mutation_lock() as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        job = jobs.create_job(llm_request())
        time.sleep(.05)
        assert jobs.get_job(job["id"])["state"] == "queued"
        assert jobs.cancel_job(job["id"])["state"] == "cancelled"
    wait_for(job["id"], "cancelled")
    assert not Path(str(jobs.SCRIPT) + ".ran").exists()


def test_silent_worker_times_out(monkeypatch, tmp_path):
    configure_runtime(monkeypatch, tmp_path, "import time\ntime.sleep(30)\n")
    monkeypatch.setenv("UCAS_AI_INFERENCE_TIMEOUT_SECONDS", "0.1")
    job = jobs.create_job(llm_request())
    result = wait_for(job["id"], "failed")
    assert result["error"]["code"] == "inference_timeout"


def test_cancel_running_child_releases_active_slot(monkeypatch, tmp_path):
    started = tmp_path / "started"
    configure_runtime(monkeypatch, tmp_path, f"import pathlib,time\npathlib.Path({str(started)!r}).write_text('yes')\ntime.sleep(30)\n")
    job = jobs.create_job(llm_request())
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline and not started.exists():
        time.sleep(.01)
    assert started.exists()
    assert jobs.cancel_job(job["id"])["state"] == "cancelled"
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline and jobs._ACTIVE is not None:
        time.sleep(.01)
    assert jobs._ACTIVE is None and jobs._PROCESSES == {}


def test_subprocess_environment_is_offline_and_strips_credentials(monkeypatch, tmp_path):
    capture = tmp_path / "env.json"
    configure_runtime(monkeypatch, tmp_path, f"import json,os,pathlib,sys\npathlib.Path({str(capture)!r}).write_text(json.dumps(dict(os.environ)))\npathlib.Path(sys.argv[4]).write_text(json.dumps({{'group':'llm','advisory':True,'synthetic':False,'answer':'ok'}}))\n")
    monkeypatch.setenv("UCAS_AI_INSTALL_TOKEN", "secret")
    monkeypatch.setenv("HF_TOKEN", "secret-hf")
    job = jobs.create_job(llm_request())
    wait_for(job["id"], "succeeded")
    env = json.loads(capture.read_text())
    assert "UCAS_AI_INSTALL_TOKEN" not in env and "HF_TOKEN" not in env
    assert env["HF_HUB_OFFLINE"] == "1" and env["TRANSFORMERS_OFFLINE"] == "1"


def test_successful_generation_requires_synthetic_artifact(monkeypatch, tmp_path):
    configure_runtime(monkeypatch, tmp_path, "import json,sys,pathlib\nrequest=json.loads(pathlib.Path(sys.argv[2]).read_text())\nout=pathlib.Path(request['output_dir'])/'demo.png'; out.write_bytes(b'PNG')\npathlib.Path(sys.argv[4]).write_text(json.dumps({'group':'image-generation','advisory':True,'synthetic':True,'artifact':'demo.png','mime':'image/png'}))\n")
    # The fake script receives --request request.json --result result.json.
    body = {"group": "image-generation", "device": "cpu", "prompt": "demo"}
    monkeypatch.setattr(jobs, "_readiness", lambda group: {"runtimeInstalled": True, "modelPresent": True, "device": "cpu", "detail": "ready"})
    job = jobs.create_job(body)
    result = wait_for(job["id"], "succeeded")
    assert result["result"]["synthetic"] is True
    assert jobs.artifact(job["id"])[1] == "image/png"


def test_failed_invalid_output_and_artifact_traversal_are_rejected(monkeypatch, tmp_path):
    configure_runtime(monkeypatch, tmp_path, "import json,sys,pathlib\npathlib.Path(sys.argv[4]).write_text(json.dumps({'error':{'code':'adapter_failed','message':'fixture'}}))\n")
    failed = jobs.create_job(llm_request())
    assert wait_for(failed["id"], "failed")["error"]["code"] == "adapter_failed"
    configure_runtime(monkeypatch, tmp_path, "import json,sys,pathlib\npathlib.Path(sys.argv[4]).write_text(json.dumps({'group':'image-generation','advisory':True,'synthetic':True,'artifact':'../escape.png','mime':'image/png'}))\n")
    invalid = jobs.create_job({"group": "image-generation", "device": "cpu", "prompt": "demo"})
    assert wait_for(invalid["id"], "failed")["error"]["code"] == "invalid_model_output"


def test_external_mode_never_selects_http_provider(monkeypatch):
    monkeypatch.setenv("UCAS_AI_MODE", "remote")
    request, _, _ = jobs.validate_request(llm_request())
    assert request["group"] == "llm"
    assert not any(key in request for key in ("provider", "url", "endpoint"))


def test_shared_lock_is_private_and_rejects_symlinks_and_shared_parent(monkeypatch, tmp_path):
    private = tmp_path / "private"
    lock = private / "worker.lock"
    monkeypatch.setattr(jobs.installer, "_MUTATION_LOCK_PATH", lock)
    with jobs.installer._open_mutation_lock() as handle:
        assert os.fstat(handle.fileno()).st_mode & 0o077 == 0
    assert private.stat().st_mode & 0o077 == 0
    lock.unlink()
    target = tmp_path / "unrelated"
    target.write_text("do not alter")
    lock.symlink_to(target)
    with pytest.raises(OSError):
        jobs.installer._open_mutation_lock()
    assert target.read_text() == "do not alter"
    lock.unlink()
    private.chmod(0o755)
    with pytest.raises(PermissionError):
        jobs.installer._open_mutation_lock()


def test_artifact_bytes_survive_retention_and_symlink_is_refused(tmp_path):
    directory = tmp_path / "private-job"
    directory.mkdir(mode=0o700)
    image = directory / "synthetic.png"
    image.write_bytes(b"immutable synthetic bytes")
    job = {"id": "artifact-job", "group": "image-generation", "state": "succeeded", "created": time.monotonic(),
           "directory": directory, "result": {"artifact": image.name, "mime": "image/png"}}
    jobs._JOBS[job["id"]] = job
    downloaded = jobs.artifact(job["id"])
    assert downloaded == (b"immutable synthetic bytes", "image/png")
    image.unlink()
    target = tmp_path / "not-an-artifact"
    target.write_bytes(b"private")
    image.symlink_to(target)
    assert jobs.artifact(job["id"]) is None
    job["created"] -= jobs.TTL_SECONDS + 1
    assert jobs.artifact(job["id"]) is None
    assert downloaded[0] == b"immutable synthetic bytes"


def test_status_labels_match_the_fixed_adapter_allowlist():
    from scripts.local_ai_infer import BENIGN_LABELS
    assert jobs.LABELS == list(BENIGN_LABELS)
