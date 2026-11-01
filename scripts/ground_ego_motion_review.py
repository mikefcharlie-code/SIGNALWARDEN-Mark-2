#!/usr/bin/env python3
"""Run one explicit, offline ground-vehicle ego-motion review.

The learned ONNX model requires a manually provisioned, hash-pinned artifact and
NVIDIA CUDA. An explicit option may instead use a separate CPU kinematic baseline.
It accepts a fixed local feature-history CSV only and has no live-system adapters.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import math
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
GROUP = "ground-ego-motion-nvidia"
MAX_INPUT_BYTES = 64 * 1024
FEATURE_COLUMNS = ("vbx", "vby", "yaw_rate", "abx", "aby", "curvature", "pitch", "roll", "vz")
HISTORY_STEPS = 20
EXPECTED_DT_S = 0.1
TIMESTAMP_TOLERANCE_S = 0.005
LIMITATIONS = [
    "Offline ground-vehicle review only; no vehicle-in-the-loop, field, or closed-loop validation is claimed.",
    "The supplied artifact has no OOD detector; this tool validates format and finiteness, not whether a history is in the training domain.",
    "Model-supplied sigma values are not independently validated confidence intervals or safety bounds.",
    "The optional CPU fallback is a separate standard-library kinematic baseline with no calibrated uncertainty; the learned ONNX model is never run on CPU.",
    "The model has no road input or future control input and cannot anticipate a turn that has not begun.",
    "The NVIDIA AV dataset agreement restricts use to authorized internal AV/ADAS development using NVIDIA technology; the trained-model grant remains unresolved.",
    "Operator attestations are not independently verified and do not grant rights or replace license review.",
]


def _disable_network() -> None:
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    from scripts.local_ai_infer import _deny_network

    _deny_network()


def load_history_csv(path: Path):
    """Read exactly one bounded feature window; timestamps are validation-only."""
    if path.is_symlink() or path.suffix.lower() != ".csv":
        raise ValueError("input must be one regular local CSV file, not a symlink")
    try:
        info = path.stat()
    except OSError as error:
        raise ValueError(f"cannot access input CSV: {error}") from error
    if not path.is_file() or info.st_size <= 0 or info.st_size > MAX_INPUT_BYTES:
        raise ValueError(f"input CSV must be a regular file between 1 byte and {MAX_INPUT_BYTES} bytes")
    payload = path.read_bytes()
    if len(payload) != info.st_size or len(payload) > MAX_INPUT_BYTES:
        raise ValueError("input CSV changed while being read or exceeded the size cap")
    try:
        text = payload.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ValueError("input CSV must be UTF-8 text") from error

    rows = list(csv.reader(io.StringIO(text, newline="")))
    expected_header = ["timestamp_s", *FEATURE_COLUMNS]
    if not rows or rows[0] != expected_header:
        raise ValueError(f"CSV header must be exactly: {','.join(expected_header)}")
    if len(rows) != HISTORY_STEPS + 1 or any(len(row) != len(expected_header) for row in rows[1:]):
        raise ValueError(f"CSV must contain exactly {HISTORY_STEPS} complete history rows")
    try:
        values = [[float(cell) for cell in row] for row in rows[1:]]
    except (TypeError, ValueError, OverflowError) as error:
        raise ValueError("all timestamps and features must be numeric") from error
    if (len(values) != HISTORY_STEPS
            or any(len(row) != len(FEATURE_COLUMNS) + 1 for row in values)
            or any(not math.isfinite(value) for row in values for value in row)):
        raise ValueError("timestamps and features must be finite")
    dt = [values[index + 1][0] - values[index][0] for index in range(HISTORY_STEPS - 1)]
    if any(step <= 0 or abs(step - EXPECTED_DT_S) > TIMESTAMP_TOLERANCE_S for step in dt):
        raise ValueError("timestamps must be strictly increasing at 10 Hz (0.1 s, ±0.005 s)")
    return [row[1:] for row in values], {
        "history_rows": HISTORY_STEPS,
        "sample_rate_hz": 10,
        "sample_spacing_validated": True,
        "recency_relative_to_current_time": "not verifiable for offline input",
    }


def _load_model():
    from scripts.local_ai_setup import load_registry, model_dir, verify_group

    manifest_path = ROOT / "configs" / "ground-ego-motion-artifact.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    registry = load_registry()
    entry = registry.get("models", {}).get(GROUP)
    if (not isinstance(entry, dict) or entry.get("distribution") != "local-only"
            or entry.get("runtime") != "onnxruntime-cuda-strict"):
        raise RuntimeError("ground model is not registered as a local-only CUDA model")
    expected = {manifest["artifact_file"]: (manifest["size_bytes"], manifest["sha256"])}
    registered = {item["path"]: (item["size"], item["sha256"]) for item in entry.get("files", [])}
    if registered != expected:
        raise RuntimeError("ground model registry and artifact manifest disagree")
    if not verify_group(GROUP, registry):
        raise RuntimeError(
            f"ground model is missing or failed hash verification; manually copy the pinned file to {model_dir(GROUP)} and run local_ai_setup.py verify --group {GROUP}"
        )
    from services.ground_ego_motion.model import GroundEgoMotionModel

    model = GroundEgoMotionModel(
        model_dir(GROUP), expected_sha256=manifest["sha256"],
        expected_size_bytes=manifest["size_bytes"],
    )
    return model, manifest


def _expected_model_metadata() -> dict[str, Any]:
    try:
        manifest = json.loads((ROOT / "configs" / "ground-ego-motion-artifact.json").read_text(encoding="utf-8"))
        if not isinstance(manifest, dict):
            raise ValueError("manifest is not an object")
        return manifest
    except (OSError, ValueError, json.JSONDecodeError):
        return {"model_id": "ground-nav-egomotion-nvidia-v1", "sha256": None,
                "source": "candidate model metadata unavailable", "training_data": "unknown"}


def _fallback_reason(error: Exception) -> str:
    if isinstance(error, FileNotFoundError):
        return "manual_model_artifact_missing_or_unverified"
    if isinstance(error, ImportError):
        return "onnxruntime_or_numpy_gpu_runtime_unavailable"
    if isinstance(error, RuntimeError):
        if "missing or failed hash verification" in str(error):
            return "manual_model_artifact_missing_or_unverified"
        return "nvidia_cuda_or_model_runtime_unavailable"
    if isinstance(error, ValueError):
        return "pinned_model_artifact_or_contract_invalid"
    if isinstance(error, OSError):
        return "model_artifact_read_failed"
    return "gpu_model_inference_failed"


def review(input_csv: Path, *, vehicle_profile: str, input_attested: bool,
           license_scope_attested: bool, allow_cpu_baseline_fallback: bool = False) -> dict[str, Any]:
    if vehicle_profile != "ground_vehicle":
        raise ValueError("this tool accepts the ground_vehicle profile only")
    if not input_attested:
        raise ValueError("explicit --attest-ground-input-provenance is required")
    if not license_scope_attested:
        raise ValueError("explicit --attest-nvidia-av-adas-license is required")
    _disable_network()
    history, input_metadata = load_history_csv(input_csv)
    model_loaded = False
    model_inference_performed = False
    fallback_used = False
    manifest = _expected_model_metadata()
    try:
        model, manifest = _load_model()
        model_loaded = True
        model_inference_performed = True
        prediction = model.predict(history)
        if prediction.get("status") == "model_unsure" and allow_cpu_baseline_fallback:
            from services.ground_ego_motion.baseline import constant_turn_rate_acceleration_baseline
            prediction = constant_turn_rate_acceleration_baseline(
                history, fallback_reason="gpu_model_abstained", expected_model_sha256=manifest.get("sha256")
            )
            fallback_used = True
    except (OSError, RuntimeError, ValueError, ImportError, KeyError, json.JSONDecodeError) as error:
        if not allow_cpu_baseline_fallback:
            raise
        from services.ground_ego_motion.baseline import constant_turn_rate_acceleration_baseline
        prediction = constant_turn_rate_acceleration_baseline(
            history, fallback_reason=_fallback_reason(error), expected_model_sha256=manifest.get("sha256")
        )
        fallback_used = True
    if not model_loaded:
        model_inference_performed = False
    execution_mode = "cpu_baseline_fallback" if fallback_used else (
        "gpu_model" if prediction.get("status") == "prediction_unvalidated" else "gpu_model_abstained"
    )
    return {
        "schema_version": "1.0",
        "execution_mode": execution_mode,
        "candidate_model": {
            "model_id": manifest.get("model_id"),
            "expected_sha256": manifest.get("sha256"),
            "artifact_distribution": "local-only; manual provisioning required",
            "weights_loaded": model_loaded,
            "inference_performed": model_inference_performed,
            "model_ran_on_cpu": False,
            "source_provenance": manifest.get("source"),
            "training_data_provenance": manifest.get("training_data"),
        },
        "operator_attestations": {
            "ground_input_provenance_reviewed": input_attested,
            "authorized_internal_av_adas_use_with_nvidia_technology_and_model_rights": license_scope_attested,
            "cpu_baseline_fallback_allowed_by_operator": allow_cpu_baseline_fallback,
            "verification": "attested by operator; not independently verified and not a grant of rights",
        },
        "vehicle_profile": "ground_vehicle_offline_review",
        "offline_only": True,
        "input_metadata": input_metadata,
        "input_trust": "operator-attested; not independently verified",
        "runtime": {
            "model_provider": "CUDAExecutionProvider" if model_loaded else None,
            "model_cpu_ep_fallback_disabled": True if model_loaded else None,
            "cpu_baseline_used": fallback_used,
            "nvidia_runtime_presence_is_not_a_license_grant": True,
        },
        "prediction": prediction,
        "safety_boundary": {
            "uav_or_aircraft_profile": False,
            "raw_or_absolute_coordinates_emitted": False,
            "live_navigation_or_position_correction": False,
            "live_planning_or_control": False,
            "mission_or_effector_action": False,
        },
        "limitations": LIMITATIONS,
    }


def _write_report(report: dict[str, Any], output: Path | None) -> None:
    payload = json.dumps(report, indent=2, allow_nan=False) + "\n"
    if output is None:
        sys.stdout.write(payload)
        return
    if output.is_symlink() or output.exists():
        raise ValueError("output path already exists or is a symlink; choose a new path")
    resolved = output.resolve(strict=False)
    if resolved == ROOT or ROOT in resolved.parents:
        raise ValueError("output report must be outside this repository checkout")
    if output.parent.is_symlink():
        raise ValueError("refusing a symlink output directory")
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf-8") as handle:
        handle.write(payload)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-csv", type=Path, required=True, help="one local 20-row ground feature-history CSV")
    parser.add_argument("--vehicle-profile", choices=("ground_vehicle",), required=True,
                        help="hard-coded ground-only profile; UAV/aircraft profiles are rejected")
    parser.add_argument("--attest-ground-input-provenance", action="store_true", required=True,
                        help="attest that the local feature history is from an authorized ground-vehicle source")
    parser.add_argument("--attest-nvidia-av-adas-license", action="store_true", required=True,
                        help="attest authorized internal AV/ADAS use with NVIDIA technology and rights to this model; this does not grant rights")
    parser.add_argument("--allow-cpu-baseline-fallback", action="store_true",
                        help="explicitly permit a separately labeled CPU kinematic baseline if the CUDA model is unavailable or abstains; never runs the model on CPU")
    parser.add_argument("--output-json", type=Path, help="new report path outside this checkout; default is stdout")
    args = parser.parse_args(argv)
    try:
        report = review(args.input_csv, vehicle_profile=args.vehicle_profile,
                        input_attested=args.attest_ground_input_provenance,
                        license_scope_attested=args.attest_nvidia_av_adas_license,
                        allow_cpu_baseline_fallback=args.allow_cpu_baseline_fallback)
        _write_report(report, args.output_json)
        return 0 if report["prediction"].get("status") in {"prediction_unvalidated", "baseline_fallback"} else 2
    except (OSError, RuntimeError, ValueError, KeyError, ImportError, json.JSONDecodeError) as error:
        print(f"ground-ego-motion-review: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
