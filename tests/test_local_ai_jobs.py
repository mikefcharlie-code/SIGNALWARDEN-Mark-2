import importlib.util
import json
import sys
import threading
import time
from http.client import HTTPConnection
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
APP_PATH = ROOT / "services" / "management-api" / "app.py"
sys.path.insert(0, str(APP_PATH.parent))
spec = importlib.util.spec_from_file_location("ucas_management_api_local_ai", APP_PATH)
app = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = app
spec.loader.exec_module(app)


@pytest.fixture
def server(monkeypatch):
    monkeypatch.setenv("UCAS_AI_INSTALL_ENABLED", "1")
    monkeypatch.setenv("UCAS_AI_INSTALL_TOKEN", "t" * 40)
    monkeypatch.delenv("UCAS_AI_INSTALL_ORIGINS", raising=False)
    with app.local_ai_jobs._LOCK:
        app.local_ai_jobs._JOBS.clear()
        app.local_ai_jobs._PROCESSES.clear()
        app.local_ai_jobs._ACTIVE = None
    instance = app.create_server("127.0.0.1", 0)
    thread = threading.Thread(target=instance.serve_forever, daemon=True)
    thread.start()
    yield instance
    instance.shutdown(); instance.server_close(); thread.join(2)


def request(server, method, path, body=None, headers=None):
    connection = HTTPConnection("127.0.0.1", server.server_port, timeout=3)
    headers = {"Content-Type": "application/json", "Authorization": "Bearer " + "t" * 40, **(headers or {})}
    payload = None if body is None else json.dumps(body)
    connection.request(method, path, payload, headers)
    response = connection.getresponse()
    result = json.loads(response.read())
    connection.close()
    return response.status, result


def test_auth_origin_and_exact_body(server):
    status, body = request(server, "GET", "/api/v1/local-ai/status", headers={"Authorization": "Bearer wrong"})
    assert status == 401 and body["error"]["code"] == "local_ai_auth_required"
    status, body = request(server, "POST", "/api/v1/local-ai/jobs", {"group": "llm"}, headers={"Origin": "https://evil.example"})
    assert status == 403 and body["error"]["code"] == "origin_not_allowed"
    status, body = request(server, "POST", "/api/v1/local-ai/jobs", {"group": "llm", "device": "cpu", "action": "download", "acceptLicense": False}, headers={"Origin": "http://localhost:3000"})
    assert status == 400 and body["error"]["code"] == "invalid_job_request"
    status, body = request(server, "POST", "/api/v1/local-ai/jobs", {"group": "llm", "device": "cpu", "action": "verify", "acceptLicense": False}, headers={"Origin": "http://localhost:3000", "Content-Type": "text/plain"})
    assert status == 415 and body["error"]["code"] == "json_required"


def test_status_does_not_verify_weights(server, monkeypatch):
    monkeypatch.setattr(app.local_ai_jobs, "_resource_status", lambda group, model, setup: {"group": group, "repo_id": model["repo_id"], "revision": model["revision"], "license": model.get("license"), "download_bytes": 0, "free_bytes": 1, "free_enough": True, "ram_gb": 1, "vram_gb": 1, "warnings": [], "runtimeInstalled": False, "device": None})
    status, body = request(server, "GET", "/api/v1/local-ai/status")
    assert status == 200 and body["enabled"] is True and body["job"] is None


def test_one_active_and_cancel(monkeypatch):
    gate = threading.Event()
    def blocked(job):
        with app.local_ai_jobs._LOCK:
            job["state"] = "running"
        gate.wait(2)
    monkeypatch.setattr(app.local_ai_jobs, "_worker", blocked)
    with app.local_ai_jobs._LOCK:
        app.local_ai_jobs._JOBS.clear(); app.local_ai_jobs._ACTIVE = None
    first = app.local_ai_jobs.create_job("llm", "cpu", "verify", False)
    for _ in range(50):
        if app.local_ai_jobs.get_job(first["id"])["state"] == "running": break
        time.sleep(.01)
    with pytest.raises(RuntimeError, match="already active"):
        app.local_ai_jobs.create_job("llm", "cpu", "verify", False)
    cancelled = app.local_ai_jobs.cancel_job(first["id"])
    assert cancelled["state"] == "cancelled"
    gate.set()


def job_record(action="verify"):
    return {"id": "test-job", "group": "llm", "device": "cpu", "action": action,
            "state": "running", "stage": "queued", "logs": [], "error": None, "created": time.monotonic()}


def test_silent_subprocess_times_out_and_token_not_inherited(monkeypatch, tmp_path):
    script = tmp_path / "silent.py"
    script.write_text("import os,time\nassert 'UCAS_AI_INSTALL_TOKEN' not in os.environ\ntime.sleep(30)\n")
    monkeypatch.setattr(app.local_ai_jobs, "SCRIPT", script)
    monkeypatch.setenv("UCAS_AI_INSTALL_TOKEN", "secret-test-token")
    monkeypatch.setenv("UCAS_AI_INSTALL_TIMEOUT_SECONDS", "0.1")
    job = job_record()
    started = time.monotonic()
    app.local_ai_jobs._run_command(job, "verify")
    assert time.monotonic() - started < 5
    assert job["state"] == "failed" and "timed out" in job["error"]
    assert job["id"] not in app.local_ai_jobs._PROCESSES


def test_fixed_commands_and_real_success_failure(monkeypatch, tmp_path):
    jobs = app.local_ai_jobs
    assert jobs._command("llm", "cpu", "install")[-6:] == ["setup", "--group", "llm", "--device", "cpu", "--yes"]
    assert "--accept-license" in jobs._command("llm", "cpu", "download")
    with pytest.raises(ValueError): jobs._command("llm", "cpu", "shell")
    script = tmp_path / "fixture.py"
    script.write_text("print('fixture verified', flush=True)\n")
    monkeypatch.setattr(jobs, "SCRIPT", script)
    job = job_record()
    jobs._run_command(job, "verify")
    assert job["error"] is None and "fixture verified" in job["logs"]
    script.write_text("raise SystemExit(7)\n")
    job = job_record()
    jobs._run_command(job, "verify")
    assert job["state"] == "failed" and "exit code 7" in job["error"]


def test_cancel_before_launch_never_spawns(monkeypatch):
    job = job_record(); job["state"] = "cancelled"
    monkeypatch.setattr(app.local_ai_jobs.subprocess, "Popen", lambda *a, **k: pytest.fail("cancelled job launched"))
    app.local_ai_jobs._run_command(job, "verify")
    assert job["state"] == "cancelled"


def test_cancelled_worker_keeps_active_slot_until_finalized(monkeypatch):
    jobs = app.local_ai_jobs
    job = job_record(); job["state"] = "cancelled"
    with jobs._LOCK:
        jobs._JOBS.clear(); jobs._JOBS[job["id"]] = job; jobs._ACTIVE = job["id"]
    try:
        with pytest.raises(RuntimeError, match="already active"):
            jobs.create_job("llm", "cpu", "verify", False)
    finally:
        with jobs._LOCK: jobs._ACTIVE = None; jobs._JOBS.clear()


def test_status_recognizes_normal_venv_python_symlink_and_latest_job(monkeypatch, tmp_path):
    import scripts.local_ai_setup as setup
    monkeypatch.setenv("UCAS_AI_HOME", str(tmp_path))
    env = tmp_path / "venvs" / "llm"
    (env / "bin").mkdir(parents=True)
    (env / "bin" / "python").symlink_to(sys.executable)
    (env / ".ucas-device").write_text("cpu\n")
    model = setup.load_registry()["models"]["llm"]
    status = app.local_ai_jobs._resource_status("llm", model, setup)
    assert status["runtimeInstalled"] is True and status["device"] == "cpu"
    monkeypatch.setattr(setup, "verify_group", lambda *a: pytest.fail("status hashes weights"))
    job = job_record(); job["state"] = "succeeded"
    with app.local_ai_jobs._LOCK:
        app.local_ai_jobs._JOBS.clear(); app.local_ai_jobs._JOBS[job["id"]] = job; app.local_ai_jobs._ACTIVE = None
    assert app.local_ai_jobs.status()["job"]["state"] == "succeeded"
    with app.local_ai_jobs._LOCK: app.local_ai_jobs._JOBS.clear()


def test_worker_resource_error_is_terminal(monkeypatch, tmp_path):
    jobs = app.local_ai_jobs
    blocked = tmp_path / "file"; blocked.write_text("not a directory")
    monkeypatch.setattr(jobs, "_MUTATION_LOCK_PATH", blocked / "lock")
    job = job_record(); job["state"] = "queued"
    with jobs._LOCK: jobs._ACTIVE = job["id"]
    jobs._worker(job)
    assert job["state"] == "failed" and jobs._ACTIVE is None


def test_nonascii_token_rejected_without_server_error(monkeypatch):
    monkeypatch.setenv("UCAS_AI_INSTALL_TOKEN", "t" * 40)
    assert app.local_ai_jobs.token_valid("Bearer café") is False


def test_disabled_and_body_shape_rejected(server, monkeypatch):
    monkeypatch.setenv("UCAS_AI_INSTALL_ENABLED", "0")
    assert request(server, "GET", "/api/v1/local-ai/status")[0] == 404
    monkeypatch.setenv("UCAS_AI_INSTALL_ENABLED", "1")
    payload = {"group": "llm", "device": "cpu", "action": "verify", "acceptLicense": False, "command": "bad"}
    assert request(server, "POST", "/api/v1/local-ai/jobs", payload, {"Origin": "http://localhost:3000"})[0] == 400
    assert request(server, "POST", "/api/v1/local-ai/jobs", {}, {"Origin": "null"})[0] == 403
    assert request(server, "POST", "/api/v1/local-ai/jobs", {})[0] == 403


def test_cancel_running_subprocess_finishes_before_releasing_active_slot(monkeypatch, tmp_path):
    jobs = app.local_ai_jobs
    script = tmp_path / "sleep.py"; script.write_text("import time\nprint('running fixture', flush=True)\ntime.sleep(30)\n")
    monkeypatch.setattr(jobs, "SCRIPT", script)
    monkeypatch.setattr(jobs, "_MUTATION_LOCK_PATH", tmp_path / "installer.lock")
    with jobs._LOCK: jobs._JOBS.clear(); jobs._ACTIVE = None
    job = jobs.create_job("llm", "cpu", "verify", False)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and job["id"] not in jobs._PROCESSES: time.sleep(.01)
    assert job["id"] in jobs._PROCESSES
    assert jobs.cancel_job(job["id"])["state"] == "cancelled"
    while time.monotonic() < deadline and jobs._ACTIVE is not None: time.sleep(.01)
    assert jobs._ACTIVE is None and job["id"] not in jobs._PROCESSES
    assert jobs.get_job(job["id"])["state"] == "cancelled"
    with jobs._LOCK: jobs._JOBS.clear()


def test_bad_http_framing_and_oversized_body_rejected(server):
    for extra, expected in [({"Content-Length": "-1"}, 400), ({"Content-Length": "65537"}, 413), ({"Transfer-Encoding": "chunked"}, 400)]:
        conn = HTTPConnection("127.0.0.1", server.server_port, timeout=3)
        headers = {"Authorization": "Bearer " + "t" * 40, "Origin": "http://localhost:3000", "Content-Type": "application/json", **extra}
        conn.request("POST", "/api/v1/local-ai/jobs", "{}", headers)
        response = conn.getresponse()
        assert response.status == expected
        response.read(); conn.close()
