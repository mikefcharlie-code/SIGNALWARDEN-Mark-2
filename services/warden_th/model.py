"""Verified local ONNX adapter; no downloads, network fallback, or control imports."""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
from typing import Any, Mapping, Sequence

ROOT = Path(__file__).resolve().parents[2]
GROUP = "telemetry-health"
MODEL_NAME = "warden-th.onnx"
CALIBRATION_NAME = "calibration.json"
KNOWN_AIRFRAME_CLASSES = {"multicopter-light", "multicopter-heavy", "fixed-wing-lab"}
SUBSYSTEMS = ("power", "link", "navigation", "attitude", "autopilot")


def model_dir() -> Path:
    cache = Path(os.environ.get("UCAS_AI_HOME", "~/.cache/ucas-ai")).expanduser()
    return cache / "models" / GROUP


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _entries() -> dict[str, dict[str, Any]]:
    registry = json.loads((ROOT / "configs" / "local-ai-models.json").read_text(encoding="utf-8"))
    model = registry.get("models", {}).get(GROUP, {})
    return {item["path"]: item for item in model.get("files", []) if isinstance(item, dict) and isinstance(item.get("path"), str)}


def readiness() -> dict[str, Any]:
    """Presence/integrity status only; never downloads or loads weights."""
    root = model_dir()
    entries = _entries()
    ready = bool(entries) and set(entries) >= {MODEL_NAME, CALIBRATION_NAME}
    checked = []
    if ready:
        for name, item in entries.items():
            path = root / name
            valid = path.is_file() and path.stat().st_size == item.get("size") and _sha256(path) == item.get("sha256")
            checked.append({"file": name, "verified": bool(valid)})
            ready = ready and valid
    return {"available": bool(ready), "group": GROUP, "files": checked,
            "automatic_download": False, "runtime": "onnxruntime-cpu",
            "detail": "Verified local files are available." if ready else "Copy the explicitly supplied ONNX artifact and calibration file into the local model cache, then run the verify command."}


def _load_calibration(directory: Path, expected: Mapping[str, Any] | None = None) -> dict[str, Any]:
    calibration_path = directory / CALIBRATION_NAME
    if expected is not None:
        item = expected.get(CALIBRATION_NAME)
        if not isinstance(item, Mapping) or not calibration_path.is_file() or calibration_path.stat().st_size != item.get("size") or _sha256(calibration_path) != item.get("sha256"):
            raise ValueError("Warden-TH calibration file is missing or its pinned hash does not match")
    data = json.loads(calibration_path.read_text(encoding="utf-8"))
    if data.get("schema_version") != 1 or data.get("model_id") != "warden-th":
        raise ValueError("unsupported Warden-TH calibration manifest")
    return data


def infer(model_input: Sequence[float], *, field_presence_ratio: float, airframe_class: str | None,
          telemetry_trust: str, evidence_sequence_from: int | None = None,
          evidence_sequence_to: int | None = None, evidence_channels: str = "",
          synthetic: bool = True, directory: Path | None = None,
          expected_files: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Run CPU ONNX inference only when the explicitly installed artifact verifies."""
    abstentions: list[str] = []
    if synthetic is not True:
        abstentions.append("first_pass_is_synthetic_only")
    if not isinstance(field_presence_ratio, (int, float)) or field_presence_ratio < 0.60:
        abstentions.append("feature_presence_below_60_percent")
    if not isinstance(airframe_class, str) or airframe_class not in KNOWN_AIRFRAME_CLASSES:
        abstentions.append("airframe_class_unknown")
    if not isinstance(telemetry_trust, str) or telemetry_trust not in {"trusted", "untrusted", "unknown"}:
        abstentions.append("telemetry_trust_unknown")
    if abstentions:
        return {"model_id": "warden-th", "status": "abstained", "available": False,
                "advisory_only": True, "synthetic": True, "abstention_reasons": abstentions,
                "subsystem_findings": [], "endurance_band": None, "score_semantics": "no confidence score is emitted"}
    if not isinstance(model_input, Sequence) or isinstance(model_input, (str, bytes)) or len(model_input) != 198:
        raise ValueError("Warden-TH model input must contain exactly 198 finite features")
    vector = []
    for item in model_input:
        if isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(float(item)):
            raise ValueError("Warden-TH model input must contain finite numbers only")
        vector.append(float(item))
    directory = directory or model_dir()
    entries = expected_files or _entries()
    model_path = directory / MODEL_NAME
    model_info = entries.get(MODEL_NAME, {})
    if not model_path.is_file() or model_path.stat().st_size != model_info.get("size") or _sha256(model_path) != model_info.get("sha256"):
        raise ValueError("Warden-TH ONNX model is missing or its pinned hash does not match")
    calibration = _load_calibration(directory, entries)
    runtime_mean, runtime_scale = calibration.get("input_mean"), calibration.get("input_scale")
    if not isinstance(runtime_mean, list) or not isinstance(runtime_scale, list) or len(runtime_mean) != 198 or len(runtime_scale) != 198:
        raise ValueError("Warden-TH input calibration dimensions are invalid")
    normalized = [(value - float(mean)) / max(float(scale), 1e-8) for value, mean, scale in zip(vector, runtime_mean, runtime_scale)]
    ood_distance = sum(value * value for value in normalized) / len(normalized)
    if ood_distance > float(calibration.get("ood_mean_square_ceiling", float("inf"))):
        return {"model_id": "warden-th", "status": "model_unsure", "available": True,
                "model_hash": _sha256(model_path), "advisory_only": True, "synthetic": True,
                "abstention_reasons": ["out_of_distribution_feature_window"], "subsystem_findings": [],
                "endurance_band": None, "score_semantics": "raw model scores are not confidence"}
    try:
        import onnxruntime as ort
    except ImportError as error:
        raise RuntimeError("onnxruntime is not installed in the explicit telemetry-health runtime") from error
    session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    inputs = session.get_inputs()
    outputs = session.run(None, {inputs[0].name: __import__("numpy").asarray([vector], dtype="float32")})
    raw = outputs[0][0].tolist()
    if len(raw) != 8 or any(not math.isfinite(float(value)) for value in raw):
        raise ValueError("Warden-TH ONNX output has an invalid shape or non-finite values")
    scores = [1.0 / (1.0 + math.exp(-max(-40.0, min(40.0, float(value))))) for value in raw[:5]]
    thresholds = calibration.get("alert_thresholds", {})
    nominal = calibration.get("nominal_reference_scores", {})
    findings = []
    for subsystem, score in zip(SUBSYSTEMS, scores):
        reference = nominal.get(subsystem, []) if isinstance(nominal, Mapping) else []
        percentile = 100.0 * sum(1 for value in reference if score >= float(value)) / len(reference) if reference else None
        threshold = float(thresholds.get(subsystem, 1.0))
        findings.append({"subsystem": subsystem, "detected": score > threshold,
                         "nominal_percentile": round(percentile, 2) if percentile is not None else None,
                         "evidence_channels": evidence_channels[:500],
                         "sequence_from": evidence_sequence_from, "sequence_to": evidence_sequence_to})
    endurance_log = [float(value) for value in raw[5:8]]
    target_mean = float(calibration.get("endurance_log_mean", 0.0))
    target_scale = float(calibration.get("endurance_log_scale", 1.0))
    endurance_log[0] += float(calibration.get("endurance_lower_log_offset", 0.0))
    endurance_log[2] += float(calibration.get("endurance_upper_log_offset", 0.0))
    quantiles = sorted(max(0.0, math.expm1(min(20.0, value * target_scale + target_mean))) for value in endurance_log)
    return {"model_id": "warden-th", "status": "synthetic_model_output", "available": True,
            "model_hash": _sha256(model_path), "advisory_only": True, "synthetic": True,
            "telemetry_trust": telemetry_trust, "airframe_class": airframe_class,
            "subsystem_findings": findings,
            "endurance_band": {"p10_minutes": round(quantiles[0], 2), "p50_minutes": round(quantiles[1], 2),
                               "p90_minutes": round(quantiles[2], 2), "method": "trained_synthetic_quantile_heads",
                               "calibration": "synthetic_heldout_calibration_not_operationally_validated"},
            "ood_mean_square": round(ood_distance, 6),
            "score_semantics": "Raw sigmoid values are not exposed as confidence; alert decisions use synthetic nominal calibration only.",
            "limitations": ["Trained only on seeded synthetic data.", "No SITL or field validation.",
                            "Synthetic calibration thresholds do not bound real-flight false alarms."]}
