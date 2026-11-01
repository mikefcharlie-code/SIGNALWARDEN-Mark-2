"""CUDA-only local runtime for the supplied ground-vehicle ego-motion model.

This module is not imported by Warden-NAV or any aircraft/live-system code.
It consumes a single local feature history and emits only an unvalidated
vehicle-relative forecast for offline ground-vehicle review.
"""
from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import numpy as np

MODEL_ID = "ground-nav-egomotion-nvidia-v1"
FEATURES = ("vbx", "vby", "yaw_rate", "abx", "aby", "curvature", "pitch", "roll", "vz")
HISTORY_STEPS = 20
FORECAST_STEPS = 30
STEP_SECONDS = 0.1
MAX_MODEL_BYTES = 4 * 1024 * 1024


class GroundEgoMotionModel:
    """Load one manually provisioned ONNX artifact on NVIDIA CUDA only."""

    def __init__(self, directory: str | Path, *, expected_sha256: str,
                 expected_size_bytes: int):
        root = Path(directory)
        if root.is_symlink() or not root.is_dir():
            raise FileNotFoundError("ground model artifact directory is missing or unsafe")
        model_path = root / "ground-nav-egomotion.onnx"
        if model_path.is_symlink() or not model_path.is_file():
            raise FileNotFoundError("ground model ONNX artifact is missing or unsafe")
        size = model_path.stat().st_size
        if size <= 0 or size > MAX_MODEL_BYTES or size != expected_size_bytes:
            raise ValueError("ground model artifact size does not match the pinned manifest")
        model_blob = model_path.read_bytes()
        if hashlib.sha256(model_blob).hexdigest() != expected_sha256:
            raise ValueError("ground model ONNX artifact failed SHA-256 verification")

        import onnxruntime as ort

        if "CUDAExecutionProvider" not in ort.get_available_providers():
            raise RuntimeError("NVIDIA CUDAExecutionProvider is unavailable; CPU inference is forbidden")
        options = ort.SessionOptions()
        options.add_session_config_entry("session.disable_cpu_ep_fallback", "1")
        try:
            session = ort.InferenceSession(
                model_blob,
                sess_options=options,
                providers=["CUDAExecutionProvider"],
            )
        except Exception as error:
            raise RuntimeError(f"could not create strict CUDA-only ground model session: {error}") from error
        if hasattr(session, "disable_fallback"):
            session.disable_fallback()
        providers = session.get_providers()
        if not providers or providers[0] != "CUDAExecutionProvider":
            raise RuntimeError("ground model did not select NVIDIA CUDA; CPU fallback is forbidden")

        inputs, outputs = session.get_inputs(), session.get_outputs()
        if ([item.name for item in inputs] != ["history"]
                or [item.name for item in outputs] != ["trajectory", "sigma"]):
            raise ValueError("ground model ONNX names do not match the pinned contract")
        if (len(inputs[0].shape) != 3 or inputs[0].shape[1:] != [HISTORY_STEPS, len(FEATURES)]
                or len(outputs[0].shape) != 3 or outputs[0].shape[1:] != [FORECAST_STEPS, 3]
                or len(outputs[1].shape) != 3 or outputs[1].shape[1:] != [FORECAST_STEPS, 2]):
            raise ValueError("ground model ONNX shapes do not match the pinned contract")
        self._session = session
        self.model_sha256 = expected_sha256

    def predict(self, history: np.ndarray) -> dict[str, Any]:
        """Return an explicitly unvalidated local-frame forecast or abstain."""
        try:
            x = np.asarray(history, dtype=np.float32)
        except (TypeError, ValueError, OverflowError):
            return self._abstain("invalid_input")
        if x.shape != (HISTORY_STEPS, len(FEATURES)):
            return self._abstain("invalid_input_shape")
        if not np.isfinite(x).all():
            return self._abstain("nonfinite_input")
        try:
            trajectory, sigma = self._session.run(
                ["trajectory", "sigma"], {"history": x[None, :, :]}
            )
            trajectory = np.asarray(trajectory, dtype=np.float32)
            sigma = np.asarray(sigma, dtype=np.float32)
        except Exception as error:
            return self._abstain(f"inference_failed:{type(error).__name__}")
        if (trajectory.shape != (1, FORECAST_STEPS, 3)
                or sigma.shape != (1, FORECAST_STEPS, 2)
                or not np.isfinite(trajectory).all()
                or not np.isfinite(sigma).all()
                or (sigma <= 0).any()):
            return self._abstain("invalid_model_output")

        rows = []
        for step, (pose, uncertainty) in enumerate(zip(trajectory[0], sigma[0]), start=1):
            rows.append({
                "future_time_s": round(step * STEP_SECONDS, 1),
                "x_m": round(float(pose[0]), 4),
                "y_m": round(float(pose[1]), 4),
                "yaw_delta_rad": round(float(pose[2]), 6),
                "sigma_x_m": round(float(uncertainty[0]), 4),
                "sigma_y_m": round(float(uncertainty[1]), 4),
            })
        return {
            "model_id": MODEL_ID,
            "model_sha256": self.model_sha256,
            "vehicle_profile": "ground_vehicle_offline_review",
            "status": "prediction_unvalidated",
            "advisory_only": True,
            "execution_provider": "CUDAExecutionProvider",
            "cpu_ep_fallback_disabled": True,
            "output_frame": "vehicle frame at the end of the supplied history; x/y are relative displacements, not global coordinates or a corrected current pose",
            "uncertainty_interpretation": "model-supplied sigma; not an independently validated confidence or safety bound",
            "input_domain_status": "not_checked; supplied model has no OOD detector",
            "forecast": rows,
            "safety_boundary": {
                "uav_or_aircraft_profile": False,
                "live_navigation_or_position_correction": False,
                "live_planning_or_control": False,
                "mission_or_effector_action": False,
            },
        }

    def _abstain(self, reason: str) -> dict[str, Any]:
        return {
            "model_id": MODEL_ID,
            "model_sha256": self.model_sha256,
            "vehicle_profile": "ground_vehicle_offline_review",
            "status": "model_unsure",
            "reason": reason,
            "advisory_only": True,
            "execution_provider": "CUDAExecutionProvider",
            "cpu_ep_fallback_disabled": True,
            "forecast": None,
        }


__all__ = ["GroundEgoMotionModel", "MODEL_ID", "FEATURES"]
