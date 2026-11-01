"""Explicit local-only advisory inference. Never writes to evidence or aircraft stores.

Jobs are process-local and intentionally ephemeral; use one reference API worker.
Heavy frameworks run only in the installed per-group venv, never in the API.
"""
from __future__ import annotations

import atexit
import base64
import binascii
import copy
import fcntl
import json
import math
import os
import shutil
import stat
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import local_ai_jobs as installer
from scripts import local_ai_setup as setup

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/local_ai_infer.py"
MAX_UPLOAD = 8 * 1024 * 1024
MAX_BODY = 12 * 1024 * 1024
MAX_PROMPT = 2000
MAX_HISTORY = 20
TTL_SECONDS = 3600
MAX_ARTIFACT = 16 * 1024 * 1024
LABELS = ["a geometric shape moving", "a nature scene", "a person walking", "a static pattern"]
_LOCK = threading.RLock()
_JOBS: dict[str, dict[str, Any]] = {}
_PROCESSES: dict[str, subprocess.Popen] = {}
_ACTIVE: str | None = None
TERMINAL = {"succeeded", "failed", "cancelled"}


class InferenceError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def enabled() -> bool:
    return installer.enabled() and os.getenv("UCAS_AI_INFERENCE_ENABLED", "0") == "1"


def _view(job: dict) -> dict:
    return copy.deepcopy({k: job.get(k) for k in ("id", "group", "state", "stage", "error", "result")})


def _prune() -> None:
    now = time.monotonic()
    terminal = sorted((j for j in _JOBS.values() if j["state"] in TERMINAL and j["id"] != _ACTIVE), key=lambda j: j["created"])
    for j in terminal:
        if now - j["created"] > TTL_SECONDS or len(_JOBS) > MAX_HISTORY:
            shutil.rmtree(j["directory"], ignore_errors=True)
            _JOBS.pop(j["id"], None)


def _readiness(group: str, registry: dict | None = None) -> dict:
    """Cheap presence check only. Worker re-verifies every pinned hash before loading."""
    registry = registry or setup.load_registry()
    runtime, present, device = False, False, None
    try:
        venv = setup._venv_dir(group)
        marker = setup._target(venv, Path(".ucas-device"))
        setup._target(venv, Path("bin"))
        if marker.is_file():
            device = marker.read_text(encoding="utf-8").strip()
            runtime = device in installer.DEVICES and (venv / "bin/python").is_file()
        root = setup.model_dir(group)
        entries = registry["models"][group]["files"]
        present = bool(entries) and all((p := setup._target(root, setup._safe_relative(e["path"]))).is_file() and p.stat().st_size == e["size"] for e in entries)
    except (ValueError, OSError, KeyError):
        pass
    return {"group": group, "runtimeInstalled": runtime, "device": device, "modelPresent": present,
            "ready": runtime and present,
            "detail": "Files present; integrity, framework and resources checked on each run." if runtime and present else "Install and verify this group's runtime and pinned weights first."}


def status() -> dict:
    registry = setup.load_registry()
    with _LOCK:
        _prune()
        job = _JOBS.get(_ACTIVE) if _ACTIVE else max(_JOBS.values(), key=lambda j: j["created"], default=None)
        return {"enabled": True, "groups": [_readiness(g, registry) for g in installer.GROUPS],
                "labels": LABELS, "limits": {"uploadBytes": MAX_UPLOAD, "promptChars": MAX_PROMPT,
                "videoSeconds": 10, "imageMaxSide": 4096, "videoWidth": 1280, "videoHeight": 720},
                "job": _view(job) if job else None}


def validate_request(body: dict) -> tuple[dict, bytes | None, str | None]:
    if not isinstance(body, dict) or set(body) - {"group", "device", "prompt", "recordIds", "media"}:
        raise InferenceError(400, "invalid_inference_request", "Unsupported inference fields; no provider, path, URL or custom label fields are accepted.")
    group, device = body.get("group"), body.get("device")
    if not isinstance(group, str) or group not in installer.GROUPS or not isinstance(device, str) or device not in installer.DEVICES:
        raise InferenceError(400, "invalid_inference_request", "Select a supported group and CPU or CUDA.")
    if group == "video-generation" and device != "cuda":
        raise InferenceError(400, "device_unavailable", "Wan video generation requires CUDA.")
    prompt = body.get("prompt", "")
    if not isinstance(prompt, str) or len(prompt) > MAX_PROMPT or any(ord(c) < 32 and c not in "\n\t\r" for c in prompt):
        raise InferenceError(400, "invalid_prompt", "Prompt must be plain text of at most 2000 characters.")
    generation = group in {"llm", "image-generation", "video-generation"}
    if generation and not prompt.strip():
        raise InferenceError(400, "invalid_prompt", "A non-empty question or synthetic demo prompt is required.")
    ids = body.get("recordIds", [])
    if not isinstance(ids, list) or len(ids) > 8 or any(not isinstance(i, str) or not i or len(i) > 256 for i in ids) or len(set(ids)) != len(ids):
        raise InferenceError(400, "invalid_context", "Select at most eight distinct observation evidence record IDs.")
    if group != "llm" and ids or not generation and prompt:
        raise InferenceError(400, "invalid_inference_request", "Source records are only for Qwen; classifiers do not accept prompts.")
    media = body.get("media")
    data, suffix = None, None
    if generation:
        if media is not None:
            raise InferenceError(400, "invalid_media", "Text models and generators do not accept media uploads.")
    else:
        if not isinstance(media, dict) or set(media) != {"name", "data"} or not isinstance(media["name"], str) or not isinstance(media["data"], str):
            raise InferenceError(400, "invalid_media", "A named base64 media upload is required.")
        if len(media["name"]) > 128 or len(media["data"]) > 4 * ((MAX_UPLOAD + 2) // 3):
            raise InferenceError(413, "media_too_large", "Upload exceeds 8 MiB.")
        try:
            data = base64.b64decode(media["data"], validate=True)
        except (ValueError, binascii.Error):
            raise InferenceError(400, "invalid_media", "Upload must be valid base64.") from None
        if len(data) > MAX_UPLOAD:
            raise InferenceError(413, "media_too_large", "Upload exceeds 8 MiB.")
        if not data:
            raise InferenceError(400, "invalid_media", "Upload is empty.")
        # Never use user names as filesystem paths. Decode/geometry checks run before model loading.
        if group == "image-classification":
            suffix = ".png" if data.startswith(b"\x89PNG\r\n\x1a\n") else ".jpg" if data.startswith(b"\xff\xd8\xff") else None
        else:
            suffix = ".gif" if data.startswith((b"GIF87a", b"GIF89a")) else ".mp4" if len(data) > 12 and data[4:8] == b"ftyp" else None
        if suffix is None:
            raise InferenceError(415, "invalid_media_format", "Use PNG/JPEG for images or MP4/GIF for video; content signatures must match.")
    return {"group": group, "device": device, "prompt": prompt, "recordIds": ids}, data, suffix


def create_job(body: dict, context: list | None = None) -> dict:
    global _ACTIVE
    request, data, suffix = validate_request(body)
    ready = _readiness(request["group"])
    if not ready["runtimeInstalled"] or not ready["modelPresent"]:
        raise InferenceError(409, "model_not_installed", ready["detail"])
    if ready["device"] != request["device"]:
        raise InferenceError(409, "device_unavailable", "Selected device differs from the installed runtime.")
    with _LOCK:
        _prune()
        if _ACTIVE is not None:
            raise InferenceError(409, "inference_active", "Another inference job is active; wait or cancel it.")
        directory = Path(tempfile.mkdtemp(prefix="ucas-inference-"))
        try:
            if data is not None:
                source = directory / ("input" + suffix)
                source.write_bytes(data)
                request["input"] = str(source)
            request.pop("recordIds")
            request["context"] = context or []
            request["output_dir"] = str(directory)
            (directory / "request.json").write_text(json.dumps(request), encoding="utf-8")
            job = {"id": uuid.uuid4().hex, "group": request["group"], "state": "queued", "stage": "waiting for local resources",
                   "error": None, "result": None, "directory": directory, "device": request["device"], "created": time.monotonic()}
            _JOBS[job["id"]] = job
            _ACTIVE = job["id"]
            threading.Thread(target=_worker, args=(job,), daemon=True, name="ucas-local-inference").start()
            return _view(job)
        except Exception:
            shutil.rmtree(directory, ignore_errors=True)
            raise


def _timeout() -> float:
    try:
        value = float(os.getenv("UCAS_AI_INFERENCE_TIMEOUT_SECONDS", "300"))
    except ValueError:
        value = 300
    return min(900, max(.05, value)) if math.isfinite(value) else 300


def _worker(job: dict) -> None:
    global _ACTIVE
    process = None
    try:
        # Same cross-process lock as installer: never infer while weights/runtime mutate.
        deadline = time.monotonic() + _timeout()
        with installer._open_mutation_lock() as handle:
            while True:
                with _LOCK:
                    if job["state"] == "cancelled":
                        return
                if time.monotonic() >= deadline:
                    raise InferenceError(408, "inference_timeout", "Local inference timed out waiting for resources.")
                try:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    time.sleep(.05)
            # Check venv path again under mutation lock, not just at submission.
            venv = setup._venv_dir(job["group"])
            setup._target(venv, Path("bin"))
            python = venv / "bin/python"
            if not python.is_file():
                raise InferenceError(409, "model_not_installed", "Installed model runtime is missing.")
            directory = job["directory"]
            command = [str(python), str(SCRIPT), "--request", str(directory / "request.json"), "--result", str(directory / "result.json")]
            env = {k: os.environ[k] for k in ("HOME", "PATH", "TMPDIR", "CUDA_VISIBLE_DEVICES", "LD_LIBRARY_PATH", "UCAS_AI_HOME") if k in os.environ}
            env.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1", DO_NOT_TRACK="1", TOKENIZERS_PARALLELISM="false")
            with _LOCK:
                if job["state"] == "cancelled":
                    return
                process = subprocess.Popen(command, env=env, cwd=ROOT, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                           stderr=subprocess.DEVNULL, start_new_session=True, pass_fds=(handle.fileno(),))
                _PROCESSES[job["id"]] = process
                job.update(state="running", stage="validating media, integrity and resources; local inference")
            while process.poll() is None:
                with _LOCK:
                    if job["state"] == "cancelled":
                        installer._terminate(job["id"], process)
                        return
                if time.monotonic() >= deadline:
                    installer._terminate(job["id"], process)
                    raise InferenceError(408, "inference_timeout", "Local inference exceeded its time limit.")
                time.sleep(.05)
            result_file = directory / "result.json"
            if not result_file.is_file() or result_file.stat().st_size > 128 * 1024:
                raise InferenceError(503, "model_unavailable", "Local model exited without a valid result; check runtime and resources.")
            result = json.loads(result_file.read_text(encoding="utf-8"))
            if process.returncode != 0 or "error" in result:
                error = result.get("error", {})
                code = error.get("code", "model_unavailable")
                if not isinstance(code, str) or not code.replace("_", "").isalnum():
                    code = "model_unavailable"
                raise InferenceError(503, code, str(error.get("message", "Local model is unavailable."))[:300])
            if result.get("group") != job["group"] or result.get("advisory") is not True:
                raise InferenceError(503, "invalid_model_output", "Adapter returned an invalid inference contract.")
            if job["group"] in {"image-generation", "video-generation"}:
                if result.get("synthetic") is not True:
                    raise InferenceError(503, "invalid_model_output", "Generated artifacts must be labeled synthetic.")
                artifact_name = result.get("artifact")
                if not isinstance(artifact_name, str) or Path(artifact_name).name != artifact_name or artifact_name in {".", "..", "request.json", "result.json"}:
                    raise InferenceError(503, "invalid_model_output", "Invalid generated artifact path.")
                artifact_path = directory / artifact_name
                mime = result.get("mime")
                expected = "image/png" if job["group"] == "image-generation" else "image/gif"
                if mime != expected or artifact_path.is_symlink() or not artifact_path.is_file() or not 0 < artifact_path.stat().st_size <= MAX_ARTIFACT:
                    raise InferenceError(503, "invalid_model_output", "Invalid generated artifact format or size.")
            with _LOCK:
                if job["state"] != "cancelled":
                    job.update(state="succeeded", stage="complete; advisory only", result=result)
    except InferenceError as exc:
        with _LOCK:
            if job["state"] != "cancelled":
                job.update(state="failed", stage="failed", error={"code": exc.code, "message": exc.message})
    except Exception:
        with _LOCK:
            if job["state"] != "cancelled":
                job.update(state="failed", stage="failed", error={"code": "model_unavailable", "message": "Local inference could not execute; no external fallback was attempted."})
    finally:
        if process is not None and process.poll() is None:
            installer._terminate(job["id"], process)
        # Prompts/source snapshots/uploads are not retained after completion.
        for name in ("request.json", "input.png", "input.jpg", "input.mp4", "input.gif", "result.json"):
            (job["directory"] / name).unlink(missing_ok=True)
        with _LOCK:
            _PROCESSES.pop(job["id"], None)
            if _ACTIVE == job["id"]:
                _ACTIVE = None
            if job["state"] != "succeeded":
                shutil.rmtree(job["directory"], ignore_errors=True)
            _prune()


def get_job(job_id: str) -> dict | None:
    with _LOCK:
        _prune()
        job = _JOBS.get(job_id)
        return _view(job) if job else None


def cancel_job(job_id: str) -> dict | None:
    with _LOCK:
        job = _JOBS.get(job_id)
        if job is None:
            return None
        if job["state"] not in TERMINAL:
            job.update(state="cancelled", stage="cancelled", result=None)
            process = _PROCESSES.get(job_id)
            if process:
                installer._terminate(job_id, process)
        return _view(job)


def artifact(job_id: str) -> tuple[bytes, str] | None:
    with _LOCK:
        _prune()
        job = _JOBS.get(job_id)
        if not job or job["state"] != "succeeded" or job["group"] not in {"image-generation", "video-generation"}:
            return None
        result = job["result"]
        path = job["directory"] / result["artifact"]
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, "rb") as handle:
                info = os.fstat(handle.fileno())
                if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_ARTIFACT:
                    return None
                payload = handle.read(MAX_ARTIFACT + 1)
                if len(payload) > MAX_ARTIFACT:
                    return None
        except OSError:
            return None
        return payload, result["mime"]


def _cleanup() -> None:
    with _LOCK:
        for job_id, process in list(_PROCESSES.items()):
            installer._terminate(job_id, process)
        for job in _JOBS.values():
            shutil.rmtree(job["directory"], ignore_errors=True)


atexit.register(_cleanup)
