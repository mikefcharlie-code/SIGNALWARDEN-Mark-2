"""Hash-pinned, local-only Warden-NAV multimodal scorer.

This module is used only by the explicit offline-log review CLI. It does not
produce a position/navigation solution, create an event, or access a vehicle.
"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
from typing import Any

import numpy as np

from .features import FEATURE_COUNT, FEATURE_NAMES, MODALITIES, MODALITY_SLICES

MODEL_ID = "warden-nav-multimodal-v2"
CLASSES = ("nominal", "jamming_like_pattern", "spoofing_like_pattern", "sensor_estimator_glitch")
MAX_CALIBRATION_BYTES = 512 * 1024


def _read_calibration(path: Path, *, expected_model_sha256: str,
                      expected_calibration_sha256: str,
                      expected_calibration_size_bytes: int) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_CALIBRATION_BYTES:
        raise ValueError("Warden-NAV v2 calibration file is missing, unsafe, or too large")
    payload = path.read_bytes()
    if (len(payload) != expected_calibration_size_bytes
            or hashlib.sha256(payload).hexdigest() != expected_calibration_sha256):
        raise ValueError("Warden-NAV v2 calibration failed SHA-256 verification")
    try:
        calibration = json.loads(payload.decode("utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError("Warden-NAV v2 calibration is not valid JSON") from error
    if (not isinstance(calibration, dict) or calibration.get("model_id") != MODEL_ID
            or calibration.get("model_sha256") != expected_model_sha256
            or tuple(calibration.get("classes", ())) != CLASSES
            or tuple(calibration.get("feature_names", ())) != FEATURE_NAMES
            or tuple(calibration.get("modalities", ())) != MODALITIES):
        raise ValueError("Warden-NAV v2 calibration does not match this model contract")
    norm = calibration.get("normalization")
    if not isinstance(norm, dict):
        raise ValueError("Warden-NAV v2 normalization is missing")
    mean = np.asarray(norm.get("mean"), dtype=np.float32)
    scale = np.asarray(norm.get("scale"), dtype=np.float32)
    if (mean.shape != (FEATURE_COUNT,) or scale.shape != (FEATURE_COUNT,)
            or not np.isfinite(mean).all() or not np.isfinite(scale).all()
            or (scale <= 0).any()):
        raise ValueError("Warden-NAV v2 normalization is invalid")
    gates = calibration.get("class_gates")
    if not isinstance(gates, dict):
        raise ValueError("Warden-NAV v2 class gates are missing")
    for label in CLASSES[1:]:
        gate = gates.get(label)
        if isinstance(gate, bool) or not isinstance(gate, (int, float)) or not math.isfinite(float(gate)):
            raise ValueError("Warden-NAV v2 class gate is invalid")
    support = calibration.get("expert_class_support")
    if not isinstance(support, dict) or set(support) != set(MODALITIES):
        raise ValueError("Warden-NAV v2 expert class-support metadata is missing")
    for modality in MODALITIES:
        labels = support.get(modality)
        if (not isinstance(labels, list) or "nominal" not in labels
                or any(label not in CLASSES for label in labels)):
            raise ValueError("Warden-NAV v2 expert class-support metadata is invalid")
    limit = calibration.get("ood_limit")
    if isinstance(limit, bool) or not isinstance(limit, (int, float)) or not math.isfinite(float(limit)) or float(limit) <= 0:
        raise ValueError("Warden-NAV v2 OOD limit is invalid")
    return calibration


def interpret_logits(features: np.ndarray, modality_mask: np.ndarray, logits: np.ndarray,
                     calibration: dict[str, Any], *, model_sha256: str | None = None) -> dict[str, Any]:
    """Interpret one result; OOD and input-contract gates precede all class output."""
    base: dict[str, Any] = {
        "model_id": MODEL_ID,
        "advisory_only": True,
        "model_sha256": model_sha256,
        "score_semantics": "logit margin over a fixed calibration gate; not probability, confidence, ground truth, attribution, or a navigation solution",
    }
    try:
        x = np.asarray(features, dtype=np.float32)
        mask = np.asarray(modality_mask, dtype=np.float32)
        scores = np.asarray(logits, dtype=np.float32)
    except (TypeError, ValueError, OverflowError):
        return {**base, "status": "model_unsure", "reason": "invalid_input"}
    if x.shape != (FEATURE_COUNT,) or mask.shape != (len(MODALITIES),) or scores.shape != (len(CLASSES),):
        return {**base, "status": "model_unsure", "reason": "invalid_input_shape"}
    if (np.isinf(x).any() or not np.isfinite(mask).all() or not np.isfinite(scores).all()
            or not np.isin(mask, (0.0, 1.0)).all()):
        return {**base, "status": "model_unsure", "reason": "invalid_or_nonfinite_input"}
    present = [name for name, bit in zip(MODALITIES, mask) if bit == 1.0]
    if not present:
        return {**base, "status": "model_unsure", "reason": "no_modalities", "modalities_used": []}
    for name in present:
        values = x[MODALITY_SLICES[name]]
        if np.isfinite(values).mean() < 0.5:
            return {**base, "status": "model_unsure", "reason": "incomplete_present_modality",
                    "modalities_used": present}

    norm = calibration["normalization"]
    mean = np.asarray(norm["mean"], dtype=np.float32)
    scale = np.asarray(norm["scale"], dtype=np.float32)
    imputed = np.where(np.isnan(x), mean, x)
    z = np.minimum(np.abs((imputed - mean) / scale), 1000.0)
    ood_score = max(float(z[MODALITY_SLICES[name]].max()) for name in present)
    ood_limit = float(calibration["ood_limit"])
    common = {**base, "modalities_used": present, "ood_score": round(ood_score, 3),
              "ood_limit": ood_limit}
    if not math.isfinite(ood_score) or ood_score > ood_limit:
        return {**common, "status": "model_unsure", "reason": "out_of_distribution"}

    margins = scores[1:] - scores[0]
    gates = np.asarray([calibration["class_gates"][name] for name in CLASSES[1:]], dtype=np.float32)
    selected = int(np.argmax(margins - gates))
    if float(margins[selected]) > float(gates[selected]):
        pattern = CLASSES[selected + 1]
        support = calibration.get("expert_class_support", {})
        if not any(pattern in support.get(name, []) for name in present):
            return {**common, "status": "model_unsure", "reason": "unsupported_class_for_present_experts"}
        return {**common, "status": "pattern", "pattern": pattern,
                "margin_over_gate": round(float(margins[selected] - gates[selected]), 3)}
    return {**common, "status": "no_gated_pattern"}


class MultimodalNavModel:
    """A CPU ONNX model that can be loaded only from two exact local files."""

    def __init__(self, directory: str | Path, *, expected_sha256: str,
                 expected_size_bytes: int, expected_calibration_sha256: str,
                 expected_calibration_size_bytes: int):
        directory = Path(directory)
        if directory.is_symlink() or not directory.is_dir():
            raise FileNotFoundError("Warden-NAV v2 local artifact directory is missing or unsafe")
        onnx_path = directory / "warden-nav-mm.onnx"
        calibration_path = directory / "calibration.json"
        for path in (onnx_path, calibration_path):
            if path.is_symlink() or not path.is_file():
                raise FileNotFoundError(f"Warden-NAV v2 artifact is missing or unsafe: {path.name}")
        model_blob = onnx_path.read_bytes()
        if (len(model_blob) != expected_size_bytes
                or hashlib.sha256(model_blob).hexdigest() != expected_sha256):
            raise ValueError("Warden-NAV v2 ONNX model failed SHA-256 verification")
        self.calibration = _read_calibration(
            calibration_path,
            expected_model_sha256=expected_sha256,
            expected_calibration_sha256=expected_calibration_sha256,
            expected_calibration_size_bytes=expected_calibration_size_bytes,
        )
        import onnxruntime as ort

        self._session = ort.InferenceSession(model_blob, providers=["CPUExecutionProvider"])
        inputs, outputs = self._session.get_inputs(), self._session.get_outputs()
        if ([item.name for item in inputs] != ["features", "modality_mask"]
                or [item.name for item in outputs] != ["logits"]):
            raise ValueError("Warden-NAV v2 ONNX input/output names do not match the manifest")
        if (len(inputs[0].shape) != 2 or inputs[0].shape[1] != FEATURE_COUNT
                or len(inputs[1].shape) != 2 or inputs[1].shape[1] != len(MODALITIES)
                or len(outputs[0].shape) != 2 or outputs[0].shape[1] != len(CLASSES)):
            raise ValueError("Warden-NAV v2 ONNX input/output shapes do not match the manifest")
        self.model_sha256 = expected_sha256

    def assess(self, features: np.ndarray, modality_mask: np.ndarray) -> dict[str, Any]:
        try:
            x = np.asarray(features, dtype=np.float32)
            mask = np.asarray(modality_mask, dtype=np.float32)
            if x.shape != (FEATURE_COUNT,) or mask.shape != (len(MODALITIES),):
                return interpret_logits(x, mask, np.zeros(len(CLASSES), np.float32), self.calibration,
                                       model_sha256=self.model_sha256)
            logits = self._session.run(
                ["logits"],
                {"features": x[None, :], "modality_mask": mask[None, :]},
            )[0]
            logits = np.asarray(logits, dtype=np.float32)
            if logits.shape != (1, len(CLASSES)):
                return {"model_id": MODEL_ID, "model_sha256": self.model_sha256,
                        "advisory_only": True, "status": "model_unsure", "reason": "invalid_model_output"}
            return interpret_logits(x, mask, logits[0], self.calibration, model_sha256=self.model_sha256)
        except (TypeError, ValueError, OverflowError, KeyError, IndexError):
            return {"model_id": MODEL_ID, "model_sha256": self.model_sha256,
                    "advisory_only": True, "status": "model_unsure", "reason": "inference_failed"}


__all__ = ["MultimodalNavModel", "MODEL_ID", "CLASSES", "interpret_logits"]
