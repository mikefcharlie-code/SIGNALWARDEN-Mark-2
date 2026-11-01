"""Opt-in, local-only model setup/download job manager."""
from __future__ import annotations

import atexit
import contextlib
import fcntl
import hmac
import math
import os
import platform
import queue
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "local_ai_setup.py"
GROUPS = ("llm", "image-generation", "video-generation", "image-classification", "video-classification")
DEVICES = ("cpu", "cuda")
ACTIONS = ("install", "download", "install-download", "verify")
MAX_BODY = 64 * 1024
MAX_LOGS = 200
MAX_LOG_LENGTH = 2_000
MAX_HISTORY = 50
DEFAULT_ORIGINS = ("http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:8000", "http://127.0.0.1:8000")

_LOCK = threading.RLock()
_JOBS: dict[str, dict[str, Any]] = {}
_ACTIVE: str | None = None
_PROCESSES: dict[str, subprocess.Popen[str]] = {}
_MUTATION_LOCK_PATH = Path(os.getenv("UCAS_AI_INSTALL_LOCK", str(Path(tempfile.gettempdir()) / f"ucas-local-ai-{os.getuid()}" / "install.lock")))


def enabled() -> bool:
    return os.getenv("UCAS_AI_INSTALL_ENABLED", "0") == "1" and len(os.getenv("UCAS_AI_INSTALL_TOKEN", "")) >= 32


def token_valid(authorization: str | None) -> bool:
    token = os.getenv("UCAS_AI_INSTALL_TOKEN", "")
    if len(token) < 32 or not authorization or not authorization.startswith("Bearer "):
        return False
    supplied = authorization[7:]
    # compare_digest(str, str) raises TypeError for non-ASCII. Reject it cleanly.
    try:
        supplied_bytes = supplied.encode("ascii")
        token_bytes = token.encode("ascii")
    except UnicodeEncodeError:
        return False
    return bool(supplied_bytes) and hmac.compare_digest(supplied_bytes, token_bytes)


def allowed_origins() -> set[str]:
    configured = os.getenv("UCAS_AI_INSTALL_ORIGINS")
    values = configured.split(",") if configured is not None else list(DEFAULT_ORIGINS)
    return {value.strip() for value in values if value.strip() and value.strip() != "*"}


def mutation_origin_allowed(origin: str | None) -> bool:
    return origin is not None and origin.lower() != "null" and origin in allowed_origins()


def _job_view(job: dict[str, Any]) -> dict[str, Any]:
    with _LOCK:
        return {"id": job["id"], "group": job["group"], "device": job["device"], "action": job["action"],
                "state": job["state"], "stage": job["stage"], "logs": list(job["logs"]), "error": job["error"]}


def _add_log(job: dict[str, Any], line: str) -> None:
    token = os.getenv("UCAS_AI_INSTALL_TOKEN", "")
    if token:
        line = line.replace(token, "[redacted]")
    line = line.replace("Authorization", "[redacted-header]").strip()[:MAX_LOG_LENGTH]
    if not line:
        return
    with _LOCK:
        job["logs"].append(line)
        del job["logs"][:-MAX_LOGS]


def _command(group: str, device: str, action: str) -> list[str]:
    base = [sys.executable, str(SCRIPT)]
    if action == "install":
        return base + ["setup", "--group", group, "--device", device, "--yes"]
    if action == "download":
        return base + ["download", "--group", group, "--yes", "--accept-license"]
    if action == "verify":
        return base + ["verify", "--group", group]
    raise ValueError("unsupported action")


def _terminate(job_id: str, process: subprocess.Popen[str]) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=2)
        # A child (pip) may outlive a leader that exited promptly on SIGTERM.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    except (ProcessLookupError, OSError, subprocess.TimeoutExpired):
        try:
            process.kill()
        except OSError:
            pass


def _run_command(job: dict[str, Any], action: str, lock_handle: Any | None = None) -> None:
    command = _command(job["group"], job["device"], action)
    with _LOCK:
        if job["state"] == "cancelled":
            return
        job["stage"] = action
    _add_log(job, "starting " + action)
    process: subprocess.Popen[str] | None = None
    reader: threading.Thread | None = None
    try:
        env = os.environ.copy()
        env.pop("UCAS_AI_INSTALL_TOKEN", None)
        kwargs: dict[str, Any] = dict(stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                      bufsize=1, start_new_session=True, env=env)
        # Check immediately before launch, then register under the same lock as cancellation.
        with _LOCK:
            if job["state"] == "cancelled":
                return
            if lock_handle is not None:
                kwargs["pass_fds"] = (lock_handle.fileno(),)
            process = subprocess.Popen(command, **kwargs)
            _PROCESSES[job["id"]] = process
            cancelled_after_registration = job["state"] == "cancelled"
        if cancelled_after_registration:
            _terminate(job["id"], process)
            return

        assert process.stdout is not None
        lines: queue.Queue[object] = queue.Queue(maxsize=200)
        sentinel = object()
        def read_output() -> None:
            try:
                while line := process.stdout.readline(MAX_LOG_LENGTH + 1):
                    while True:
                        try:
                            lines.put(line, timeout=0.25)
                            break
                        except queue.Full:
                            if process.poll() is not None:
                                return
            finally:
                try:
                    lines.put(sentinel, timeout=0.25)
                except queue.Full:
                    pass
        reader = threading.Thread(target=read_output, daemon=True, name="ucas-local-ai-output")
        reader.start()
        try:
            timeout = max(0.01, float(os.getenv("UCAS_AI_INSTALL_TIMEOUT_SECONDS", "3600")))
        except ValueError:
            timeout = 3600.0
        if not math.isfinite(timeout):
            timeout = 3600.0
        timeout = min(timeout, 24 * 3600)
        deadline = time.monotonic() + timeout
        eof = False
        while not eof:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                _terminate(job["id"], process)
                raise TimeoutError("local AI job timed out")
            try:
                item = lines.get(timeout=min(remaining, 0.25))
            except queue.Empty:
                continue
            if item is sentinel:
                eof = True
            else:
                _add_log(job, str(item))
        result = process.wait(timeout=2)
        if result != 0:
            raise RuntimeError(f"setup command failed with exit code {result}")
    except Exception as exc:
        if process is not None:
            _terminate(job["id"], process)
        with _LOCK:
            if job["state"] != "cancelled":
                job["state"] = "failed"
                job["error"] = str(exc)[:300]
        return
    finally:
        if reader is not None:
            reader.join(timeout=1)
        with _LOCK:
            if process is not None and _PROCESSES.get(job["id"]) is process:
                _PROCESSES.pop(job["id"], None)
    with _LOCK:
        cancelled = job["state"] == "cancelled"
    if not cancelled:
        _add_log(job, "completed " + action)


def _open_mutation_lock():
    """Open a service-owned, private lock without following a final symlink."""
    parent = _MUTATION_LOCK_PATH.parent
    parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = parent.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise PermissionError("AI lock directory must be service-owned and mode 0700")
    fd = os.open(_MUTATION_LOCK_PATH, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
            raise PermissionError("AI lock must be a private service-owned regular file")
        return os.fdopen(fd, "a+")
    except Exception:
        os.close(fd)
        raise


@contextlib.contextmanager
def _mutation_lock(job: dict[str, Any]):
    """Serialize installer workers across API processes and restarts."""
    with _open_mutation_lock() as handle:
        while True:
            with _LOCK:
                if job["state"] == "cancelled":
                    yield None
                    return
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                time.sleep(0.05)
        try:
            yield handle
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _worker(job: dict[str, Any]) -> None:
    global _ACTIVE
    with _LOCK:
        if job["state"] == "cancelled":
            if _ACTIVE == job["id"]:
                _ACTIVE = None
            return
    try:
        with _mutation_lock(job) as lock_handle:
            with _LOCK:
                if job["state"] == "cancelled":
                    return
                job["state"] = "running"
            if job["action"] in ("install", "install-download"):
                _run_command(job, "install", lock_handle)
            if job["state"] == "running" and job["action"] in ("download", "install-download"):
                _run_command(job, "download", lock_handle)
            if job["state"] == "running" and job["action"] == "verify":
                _run_command(job, "verify", lock_handle)
    except Exception:
        with _LOCK:
            if job["state"] != "cancelled":
                job["state"] = "failed"
                job["error"] = "Installer worker could not acquire resources or execute the job."
    finally:
        with _LOCK:
            _PROCESSES.pop(job["id"], None)
            if job["state"] == "running":
                job["state"] = "succeeded"
                job["stage"] = "complete"
            if _ACTIVE == job["id"]:
                _ACTIVE = None
            terminals = [j for j in _JOBS.values() if j["state"] in ("succeeded", "failed", "cancelled")]
            for old in sorted(terminals, key=lambda j: j["created"])[:-MAX_HISTORY]:
                _JOBS.pop(old["id"], None)


def _cleanup() -> None:
    with _LOCK:
        processes = list(_PROCESSES.items())
    for job_id, process in processes:
        _terminate(job_id, process)


atexit.register(_cleanup)


def create_job(group: str, device: str, action: str, accept_license: bool) -> dict[str, Any]:
    global _ACTIVE
    if group not in GROUPS or device not in DEVICES or action not in ACTIONS:
        raise ValueError("unsupported group, device, or action")
    if action in ("download", "install-download") and accept_license is not True:
        raise ValueError("acceptLicense must be true for download actions")
    with _LOCK:
        # A cancelled worker still owns the slot until its finalizer runs.
        if _ACTIVE is not None:
            raise RuntimeError("another local AI job is already active")
        job = {"id": uuid.uuid4().hex, "group": group, "device": device, "action": action,
               "state": "queued", "stage": "queued", "logs": [], "error": None, "created": time.monotonic()}
        _JOBS[job["id"]] = job
        _ACTIVE = job["id"]
        threading.Thread(target=_worker, args=(job,), daemon=True, name="ucas-local-ai-job").start()
        return _job_view(job)


def get_job(job_id: str) -> dict[str, Any] | None:
    with _LOCK:
        job = _JOBS.get(job_id)
        return _job_view(job) if job else None


def cancel_job(job_id: str) -> dict[str, Any] | None:
    with _LOCK:
        job = _JOBS.get(job_id)
        if not job:
            return None
        if job["state"] in ("succeeded", "failed", "cancelled"):
            return _job_view(job)
        job["state"] = "cancelled"
        job["stage"] = "cancelled"
        job["error"] = None
        process = _PROCESSES.get(job_id)
    if process is not None:
        _terminate(job_id, process)
    _add_log(job, "cancelled")
    return _job_view(job)


def _resource_status(group: str, model: dict[str, Any], setup: Any) -> dict[str, Any]:
    resources = model.get("resources", {})
    cache = setup.cache_root()
    try:
        free = setup._available_bytes(cache.parent if cache.parent.exists() else Path.home())
    except (OSError, ValueError):
        free = 0
    required = int(float(resources.get("free_disk_gb", 0)) * 1024 ** 3)
    device = None
    runtime = False
    try:
        # Validate cache parents through setup's traversal guard. The final Python
        # symlink is normal for venv.EnvBuilder and is therefore allowed.
        venv = setup._target(cache / "venvs", Path(group))
        marker = setup._target(venv, Path(".ucas-device"))
        python = venv / "bin" / "python"
        safe_venv = not venv.is_symlink() and marker.is_file() and not marker.is_symlink()
        if safe_venv:
            device = marker.read_text(encoding="utf-8").strip()
            runtime = device in DEVICES and python.is_file()
    except (OSError, ValueError):
        pass
    warnings = [
        "Runtime installed means only the isolated Python environment and device marker exist; it does not prove inference readiness.",
        "Framework setup needs about 3 GiB free disk for CPU or 8 GiB for CUDA per isolated group; package caches can add more.",
        str(model.get("notes", "Memory figures are planning estimates, not guarantees.")),
    ]
    if group == "video-generation":
        warnings.append("Video generation requires CUDA in this runner.")
    return {"group": group, "repo_id": model["repo_id"], "revision": model["revision"], "license": model.get("license"),
            "download_bytes": resources.get("download_bytes", sum(int(x["size"]) for x in model["files"])),
            "free_bytes": free, "free_enough": free >= required, "ram_gb": resources.get("ram_gb", "unknown"),
            "vram_gb": resources.get("vram_gb", "unknown"), "warnings": warnings, "runtimeInstalled": runtime, "device": device}


def status() -> dict[str, Any]:
    import importlib
    setup = importlib.import_module("scripts.local_ai_setup")
    registry = setup.load_registry()
    groups = [_resource_status(group, registry["models"][group], setup) for group in GROUPS if group in registry["models"]]
    with _LOCK:
        current = _JOBS.get(_ACTIVE) if _ACTIVE else None
        if current is None:
            retained = list(_JOBS.values())
            current = max(retained, key=lambda item: item["created"], default=None)
        job = _job_view(current) if current else None
    return {"enabled": True, "host": platform.node(), "cacheRoot": str(setup.cache_root()), "groups": groups, "job": job}
