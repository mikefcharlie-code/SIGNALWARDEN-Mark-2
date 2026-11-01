"""Optional hash-pinned local ONNX NAV pattern head; never an external fallback."""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
from typing import Any, Mapping, Sequence

from .baseline import assess_window
from .features import FEATURE_COUNT, model_features
from .window import MAX_FRESH_AGE_SECONDS, PRESENCE_THRESHOLD

MODEL_ID = "warden-nav-synthetic-linear-v1"
MODEL_GROUP = "navigation-integrity"
PATTERN_CLASSES = ("jamming_like_pattern", "spoofing_like_pattern", "sensor_estimator_glitch")
KNOWN_AIRFRAMES = {"multicopter-light", "multicopter-heavy", "fixed-wing-lab"}


def _verified_artifacts() -> tuple[Path, dict[str, Any]]:
    try:
        from scripts.local_ai_setup import load_registry, model_dir, verify_group
    except ImportError:
        from local_ai_setup import load_registry, model_dir, verify_group
    registry = load_registry()
    model = registry["models"].get(MODEL_GROUP)
    if not isinstance(model, dict) or model.get("distribution") != "local-only":
        raise FileNotFoundError("Warden-NAV local artifact is not registered")
    if not verify_group(MODEL_GROUP, registry):
        raise FileNotFoundError("Warden-NAV local artifact is absent or failed hash verification")
    directory = Path(model_dir(MODEL_GROUP))
    if directory.is_symlink() or not directory.is_dir():
        raise FileNotFoundError("Warden-NAV local artifact directory is unavailable")
    return directory, model


def _load_calibration(path: Path) -> dict[str, Any]:
    if path.is_dir():
        path = path / "calibration.json"
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 256 * 1024:
        raise ValueError("Warden-NAV calibration is invalid")
    calibration = json.loads(path.read_text(encoding="utf-8"))
    if (calibration.get("model_id") != MODEL_ID or calibration.get("feature_count") != FEATURE_COUNT
            or calibration.get("synthetic_only") is not True):
        raise ValueError("Warden-NAV calibration contract mismatch")
    return calibration


def _gate_reasons(assessment: Mapping[str, Any], *, airframe_class: str | None,
                  telemetry_trust: str) -> list[str]:
    window = assessment.get("window") if isinstance(assessment.get("window"), Mapping) else {}
    reasons = []
    if float(window.get("navigation_presence_ratio", 0.0) or 0.0) < PRESENCE_THRESHOLD:
        reasons.append("feature_presence_below_60_percent")
    if float(window.get("window_coverage_ratio", 0.0) or 0.0) < PRESENCE_THRESHOLD:
        reasons.append("window_coverage_below_60_percent")
    if float(window.get("fresh_navigation_ratio", 0.0) or 0.0) < 0.60:
        reasons.append("fresh_navigation_presence_below_60_percent")
    if window.get("stale_fields"):
        reasons.append("stale_navigation_fields")
    if window.get("unknown_age_fields") and any(name in window.get("unknown_age_fields", []) for name in ("gps", "position")):
        reasons.append("navigation_age_unknown")
    if telemetry_trust != "trusted":
        reasons.append("telemetry_trust_not_verified" if telemetry_trust == "unknown" else "telemetry_untrusted")
    if airframe_class not in KNOWN_AIRFRAMES:
        reasons.append("airframe_class_unknown")
    return reasons


def infer_assessment(assessment: Mapping[str, Any], *, airframe_class: str | None,
                     telemetry_trust: str | None = None, session: Any = None,
                     model_path: str | Path | None = None, calibration_path: str | Path | None = None,
                     artifact_hash: str | None = None) -> dict[str, Any]:
    """Score one already-built residual assessment; no coordinates enter this adapter."""
    trust = telemetry_trust or str(assessment.get("telemetry_trust", "unknown"))
    reasons = _gate_reasons(assessment, airframe_class=airframe_class, telemetry_trust=trust)
    base = {"model_id": MODEL_ID, "advisory_only": True, "synthetic_training_only": True,
            "pattern_label": None, "model_hash": artifact_hash, "score_semantics":
            "empirical synthetic-development threshold; not probability, confidence, attribution, or truth"}
    if reasons:
        return {**base, "status": "abstained", "abstention_reasons": reasons,
                "baseline_overlap": bool(assessment.get("baseline_findings"))}
    if session is None:
        try:
            directory, registry_model = _verified_artifacts()
            calibration_path = calibration_path or directory / "calibration.json"
            model_path = model_path or directory / "warden-nav.onnx"
            manifest_hash = next(entry["sha256"] for entry in registry_model["files"] if entry["path"] == "warden-nav.onnx")
            artifact_hash = manifest_hash
            base["model_hash"] = manifest_hash
            calibration = _load_calibration(Path(calibration_path))
            actual_hash = hashlib.sha256(Path(model_path).read_bytes()).hexdigest()
            if actual_hash != manifest_hash or calibration.get("model_sha256") != manifest_hash:
                raise ValueError("Warden-NAV model/calibration hash mismatch")
            import onnxruntime as ort
            session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
        except (FileNotFoundError, ImportError, OSError, ValueError, StopIteration) as error:
            return {**base, "status": "unavailable", "abstention_reasons": ["local_onnx_model_not_installed_or_runtime_unavailable"],
                    "detail": str(error)[:200], "baseline_overlap": bool(assessment.get("baseline_findings"))}
    else:
        try:
            calibration = json.loads(Path(calibration_path).read_text(encoding="utf-8")) if calibration_path else {}
        except (OSError, ValueError, TypeError):
            calibration = {}
        if not calibration:
            return {**base, "status": "unavailable", "abstention_reasons": ["calibration_unavailable"],
                    "baseline_overlap": bool(assessment.get("baseline_findings"))}
    residuals = assessment.get("residuals") if isinstance(assessment.get("residuals"), Mapping) else {}
    window = assessment.get("window") if isinstance(assessment.get("window"), Mapping) else {}
    vector = model_features(residuals, window, airframe_class)
    try:
        import numpy as np
        means = np.asarray(calibration["normalization"]["mean"], dtype=np.float32)
        scales = np.asarray(calibration["normalization"]["scale"], dtype=np.float32)
        if means.shape != (FEATURE_COUNT,) or scales.shape != (FEATURE_COUNT,) or not np.isfinite(means).all() or not np.isfinite(scales).all() or (scales <= 0).any():
            raise ValueError("invalid calibration normalization")
        normalized = (np.asarray(vector, dtype=np.float32) - means) / scales
        ood_score = float(np.max(np.abs(normalized)))
        ood_limit = float(calibration["ood_gate"]["limit"])
        if not math.isfinite(ood_limit) or ood_limit <= 0:
            raise ValueError("invalid OOD gate")
        if ood_score > ood_limit:
            return {**base, "status": "model_unsure", "abstention_reasons": ["out_of_distribution"],
                    "ood_score": round(ood_score, 6), "ood_limit": ood_limit,
                    "baseline_overlap": bool(assessment.get("baseline_findings"))}
        inputs = session.get_inputs()
        outputs = session.get_outputs()
        if len(inputs) != 1 or inputs[0].name != "features" or len(outputs) != 1 or outputs[0].name != "logits":
            raise ValueError("unexpected Warden-NAV ONNX input/output contract")
        logits = np.asarray(session.run(["logits"], {"features": np.asarray([vector], dtype=np.float32)})[0], dtype=np.float32)
        if logits.shape != (1, 4) or not np.isfinite(logits).all():
            raise ValueError("invalid Warden-NAV ONNX result")
        margins = logits[0, 1:] - logits[0, 0]
        selected = int(np.argmax(margins))
        label = PATTERN_CLASSES[selected]
        threshold = float(calibration["class_score_gates"]["thresholds"][label])
        if not math.isfinite(threshold):
            raise ValueError("invalid Warden-NAV class calibration")
        pattern = label if float(margins[selected]) > threshold else None
        return {**base, "status": "scored_pattern" if pattern else "scored_no_pattern",
                "pattern_label": pattern, "class_gate_exceeded": bool(pattern),
                "development_margin_gate": round(float(margins[selected]), 6),
                "development_gate_threshold": threshold,
                "ood_score": round(ood_score, 6), "ood_limit": ood_limit,
                "baseline_overlap": bool(assessment.get("baseline_findings")),
                "abstention_reasons": []}
    except (ImportError, KeyError, TypeError, ValueError, IndexError, OverflowError) as error:
        return {**base, "status": "unavailable", "abstention_reasons": ["local_onnx_inference_failed"],
                "detail": str(error)[:200], "baseline_overlap": bool(assessment.get("baseline_findings"))}


def infer(samples: Sequence[Mapping[str, Any]], *, airframe_class: str | None,
          telemetry_trust: str | None = None, session: Any = None,
          model_path: str | Path | None = None, calibration_path: str | Path | None = None,
          artifact_hash: str | None = None) -> dict[str, Any]:
    assessment = assess_window(samples, telemetry_trust=telemetry_trust, airframe_class=airframe_class)
    return infer_assessment(assessment, airframe_class=airframe_class, telemetry_trust=telemetry_trust,
                            session=session, model_path=model_path, calibration_path=calibration_path,
                            artifact_hash=artifact_hash)


__all__ = ["infer", "infer_assessment", "MODEL_ID", "MODEL_GROUP", "PATTERN_CLASSES"]
