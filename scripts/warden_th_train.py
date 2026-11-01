#!/usr/bin/env python3
"""Train/evaluate a tiny Warden-TH prototype on reproducible synthetic telemetry only."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import sys
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import numpy as np
from simulation.fault_injection import LABELS, SCENARIOS, generate_window
from services.warden_th.window import build_window, model_features, MODEL_FEATURE_COUNT, CHANNEL_NAMES
from services.warden_th.baseline import assess_window

SUBSYSTEMS = ("power", "link", "navigation", "attitude", "autopilot")
QUANTILES = np.asarray([0.1, 0.5, 0.9], dtype=np.float32)


def _hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _sample(seed: int, scenario: str, fault_onset_index: int = 120) -> tuple[np.ndarray, np.ndarray, float, dict[str, Any]]:
    samples = generate_window(scenario, seed=seed, fault_onset_index=fault_onset_index)
    window = build_window(samples)
    x = np.asarray(model_features(window), dtype=np.float32)
    if x.shape != (MODEL_FEATURE_COUNT,):
        raise ValueError(f"unexpected Warden-TH feature length: {x.shape}")
    y = np.asarray([1.0 if label in LABELS[scenario] else 0.0 for label in SUBSYSTEMS], dtype=np.float32)
    metadata = samples[-1]["_synthetic_metadata"]
    rate = float(metadata["battery_discharge_pct_per_second"])
    observed_percent = samples[-1]["health"]["battery_percent"]
    final_percent = (float(observed_percent) if observed_percent is not None
                     else max(0.0, 90.0 - rate * (len(samples) - 1) / 2.0))
    endurance = max(0.0, (final_percent - 20.0) / max(rate * 60.0, 1e-6))
    y_time = math.log1p(min(endurance, 240.0))
    return x, y, y_time, {"samples": samples, "window": window, "metadata": metadata}


def _sigmoid(value: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(value, -40, 40)))


def _train_network(x: np.ndarray, y: np.ndarray, time_y: np.ndarray, seed: int, epochs: int = 220) -> tuple[dict[str, np.ndarray], float, float]:
    rng = np.random.default_rng(seed)
    mean = x.mean(axis=0)
    scale = x.std(axis=0)
    scale[scale < 1e-6] = 1.0
    xn = np.clip((x - mean) / scale, -8, 8)
    time_mean = float(time_y.mean())
    time_scale = float(max(time_y.std(), 0.15))
    tn = (time_y - time_mean) / time_scale
    hidden = 16
    w1 = rng.normal(0, math.sqrt(2 / xn.shape[1]), size=(xn.shape[1], hidden)).astype(np.float32)
    b1 = np.zeros(hidden, dtype=np.float32)
    w2 = rng.normal(0, 0.03, size=(hidden, 8)).astype(np.float32)
    b2 = np.zeros(8, dtype=np.float32)
    params = [w1, b1, w2, b2]
    first = [np.zeros_like(value) for value in params]
    second = [np.zeros_like(value) for value in params]
    step = 0
    for epoch in range(epochs):
        order = rng.permutation(len(xn))
        for begin in range(0, len(order), 64):
            batch = order[begin:begin + 64]
            xb, yb, tb = xn[batch], y[batch], tn[batch]
            z1 = xb @ w1 + b1
            h = np.maximum(z1, 0)
            raw = h @ w2 + b2
            logits, time_pred = raw[:, :5], raw[:, 5:]
            pred = _sigmoid(logits)
            grad = np.zeros_like(raw)
            grad[:, :5] = (pred - yb) / max(1, len(batch))
            residual = tb[:, None] - time_pred
            quantile_grad = np.where(residual >= 0, -QUANTILES, 1.0 - QUANTILES)
            grad[:, 5:] = 0.18 * quantile_grad / max(1, len(batch))
            gw2 = h.T @ grad
            gb2 = grad.sum(axis=0)
            gh = grad @ w2.T
            gh[z1 <= 0] = 0
            gw1 = xb.T @ gh
            gb1 = gh.sum(axis=0)
            grads = [gw1, gb1, gw2, gb2]
            step += 1
            for index, (param, grad_value) in enumerate(zip(params, grads)):
                first[index] = 0.9 * first[index] + 0.1 * grad_value
                second[index] = 0.999 * second[index] + 0.001 * (grad_value * grad_value)
                m = first[index] / (1 - 0.9 ** step)
                v = second[index] / (1 - 0.999 ** step)
                param -= 0.006 * m / (np.sqrt(v) + 1e-8)
    return {"w1": w1, "b1": b1, "w2": w2, "b2": b2, "input_mean": mean.astype(np.float32),
            "input_scale": scale.astype(np.float32)}, time_mean, time_scale


def _forward(params: dict[str, np.ndarray], x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    xn = np.clip((x - params["input_mean"]) / params["input_scale"], -8, 8)
    hidden = np.maximum(xn @ params["w1"] + params["b1"], 0)
    raw = hidden @ params["w2"] + params["b2"]
    return _sigmoid(raw[:, :5]), raw[:, 5:]


def _export_onnx(params: dict[str, np.ndarray], output: Path) -> None:
    try:
        import onnx
        from onnx import TensorProto, helper, numpy_helper
    except ImportError as error:
        raise RuntimeError("ONNX export requires the optional 'onnx' training dependency") from error
    initializers = [
        numpy_helper.from_array(params["input_mean"].astype(np.float32), "input_mean"),
        numpy_helper.from_array(params["input_scale"].astype(np.float32), "input_scale"),
        numpy_helper.from_array(params["w1"].astype(np.float32), "w1"),
        numpy_helper.from_array(params["b1"].astype(np.float32), "b1"),
        numpy_helper.from_array(params["w2"].astype(np.float32), "w2"),
        numpy_helper.from_array(params["b2"].astype(np.float32), "b2"),
        numpy_helper.from_array(np.asarray([-8.0], dtype=np.float32), "clip_min"),
        numpy_helper.from_array(np.asarray([8.0], dtype=np.float32), "clip_max"),
        numpy_helper.from_array(np.asarray([0, 0, 0, 0, 0], dtype=np.int64), "starts_a"),
        numpy_helper.from_array(np.asarray([0, 0], dtype=np.int64), "starts_b"),
        numpy_helper.from_array(np.asarray([5, 8], dtype=np.int64), "ends_a"),
        numpy_helper.from_array(np.asarray([5, 8], dtype=np.int64), "ends_b"),
        numpy_helper.from_array(np.asarray([1], dtype=np.int64), "axes"),
        numpy_helper.from_array(np.asarray([5], dtype=np.int64), "steps"),
    ]
    # Slice outputs use opset-13 input parameters. Build a single raw 8-vector output;
    # the advisory adapter applies sigmoid to only the five anomaly logits.
    nodes = [
        helper.make_node("Sub", ["x", "input_mean"], ["centered"]),
        helper.make_node("Div", ["centered", "input_scale"], ["normalized"]),
        helper.make_node("Clip", ["normalized", "clip_min", "clip_max"], ["bounded"]),
        helper.make_node("Gemm", ["bounded", "w1", "b1"], ["pre_hidden"]),
        helper.make_node("Relu", ["pre_hidden"], ["hidden"]),
        helper.make_node("Gemm", ["hidden", "w2", "b2"], ["raw"]),
    ]
    input_info = helper.make_tensor_value_info("x", TensorProto.FLOAT, [1, MODEL_FEATURE_COUNT])
    output_info = helper.make_tensor_value_info("raw", TensorProto.FLOAT, [1, 8])
    graph = helper.make_graph(nodes, "warden_th_synthetic_mlp", [input_info], [output_info], initializer=initializers)
    model = helper.make_model(graph, producer_name="warden-th-synthetic-trainer", opset_imports=[helper.make_opsetid("", 13)])
    model.ir_version = min(model.ir_version, 9)
    onnx.checker.check_model(model)
    output.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model, output)


def _nominal_stream_scores(params: dict[str, np.ndarray], ood_limit: float,
                           seed_start: int, seeds: int) -> np.ndarray:
    """Collect accepted nominal scores on the same 120 s / 5 s replay used in evaluation."""
    scores: list[np.ndarray] = []
    for seed in range(seed_start, seed_start + seeds):
        samples = generate_window("nominal", seed=seed, sample_count=360, fault_onset_index=240)
        for end_index in range(239, len(samples), 10):
            window = build_window(samples[end_index - 239:end_index + 1])
            x = np.asarray(model_features(window), dtype=np.float32)[None, :]
            probs, _ = _forward(params, x)
            normalized = np.clip((x - params["input_mean"]) / params["input_scale"], -8, 8)
            if float(np.mean(normalized * normalized)) <= ood_limit:
                scores.append(probs[0])
    if not scores:
        raise ValueError("nominal calibration produced no in-distribution replay windows")
    return np.stack(scores)


def _stream_replay(params: dict[str, np.ndarray], thresholds: dict[str, float], ood_limit: float,
                   seed_start: int, seeds: int) -> dict[str, Any]:
    """Replay 180 s synthetic streams as complete 120 s windows at a 5 s stride."""
    nominal_episodes = 0
    # A 180 s sequence supplies one 120 s warm-up window and 60 s of monitored replay.
    nominal_hours = seeds * (180.0 - 120.0) / 3600.0
    subsystem_hits = {name: 0 for name in SUBSYSTEMS}
    subsystem_trials = {name: 0 for name in SUBSYSTEMS}
    delays: list[float] = []
    for seed in range(seed_start, seed_start + seeds):
        samples = generate_window("nominal", seed=seed, sample_count=360, fault_onset_index=240)
        previous_alert = False
        for end_index in range(239, len(samples), 10):
            window = build_window(samples[end_index - 239:end_index + 1])
            x = np.asarray(model_features(window), dtype=np.float32)[None, :]
            probs, _ = _forward(params, x)
            normalized = np.clip((x - params["input_mean"]) / params["input_scale"], -8, 8)
            distance = float(np.mean(normalized * normalized))
            flags = ([float(probs[0, i]) > thresholds[name] for i, name in enumerate(SUBSYSTEMS)]
                     if distance <= ood_limit else [False] * len(SUBSYSTEMS))
            alert = any(flags)
            if alert and not previous_alert:
                nominal_episodes += 1
            previous_alert = alert
    for scenario in SCENARIOS:
        expected = LABELS[scenario]
        if not expected:
            continue
        for seed in range(seed_start, seed_start + seeds):
            samples = generate_window(scenario, seed=seed, sample_count=360, fault_onset_index=240)
            first_detected: dict[str, int] = {}
            for end_index in range(239, len(samples), 10):
                window = build_window(samples[end_index - 239:end_index + 1])
                if window["field_presence_ratio"] < 0.60:
                    continue
                x = np.asarray(model_features(window), dtype=np.float32)[None, :]
                probs, _ = _forward(params, x)
                normalized = np.clip((x - params["input_mean"]) / params["input_scale"], -8, 8)
                distance = float(np.mean(normalized * normalized))
                if distance > ood_limit:
                    continue
                for i, subsystem in enumerate(SUBSYSTEMS):
                    if subsystem in expected and float(probs[0, i]) > thresholds[subsystem]:
                        first_detected.setdefault(subsystem, end_index)
            for subsystem in expected:
                subsystem_trials[subsystem] += 1
                if subsystem in first_detected:
                    subsystem_hits[subsystem] += 1
                    delays.append(max(0.0, (first_detected[subsystem] - 240) / 2.0))
    recalls = {name: (subsystem_hits[name] / subsystem_trials[name] if subsystem_trials[name] else None)
               for name in SUBSYSTEMS}
    return {"stream_fault_recall_by_subsystem": recalls,
            "stream_detection_delay_median_seconds": float(np.median(delays)) if delays else None,
            "stream_detection_delay_p90_seconds": float(np.quantile(delays, 0.9)) if delays else None,
            "stream_fault_misses": sum(subsystem_trials.values()) - sum(subsystem_hits.values()),
            "stream_nominal_false_alarm_episodes_per_flight_hour": nominal_episodes / nominal_hours if nominal_hours else None,
            "stream_nominal_sequences": seeds, "stream_nominal_hours": nominal_hours,
            "stream_window_seconds": 120, "stream_stride_seconds": 5}


def train(seed: int, train_seeds: int, validation_seeds: int, output_dir: Path) -> dict[str, Any]:
    if train_seeds < 5 or validation_seeds < 5:
        raise ValueError("use at least five independent seeds in train and validation")
    train_data = [_sample(s, scenario, onset) for s in range(seed, seed + train_seeds) for scenario in SCENARIOS
                  for onset in ((120, 210, 230) if LABELS[scenario] else (120,))]
    calibration_data = [_sample(s, scenario) for s in range(seed + 100_000, seed + 100_000 + validation_seeds) for scenario in SCENARIOS]
    evaluation_data = [_sample(s, scenario) for s in range(seed + 200_000, seed + 200_000 + validation_seeds) for scenario in SCENARIOS]
    x_train = np.stack([row[0] for row in train_data])
    y_train = np.stack([row[1] for row in train_data])
    t_train = np.asarray([row[2] for row in train_data], dtype=np.float32)
    params, time_mean, time_scale = _train_network(x_train, y_train, t_train, seed)
    x_cal = np.stack([row[0] for row in calibration_data])
    t_cal = np.asarray([row[2] for row in calibration_data], dtype=np.float32)
    _, cal_time_pred = _forward(params, x_cal)
    cal_time_pred = cal_time_pred * time_scale + time_mean
    # Declared synthetic fault families are known in-distribution cases; a nominal-only OOD gate
    # would mask the fault signals the model is meant to report.
    calibration_distance = np.mean(((x_cal - params["input_mean"]) / params["input_scale"]) ** 2, axis=1)
    ood_limit = float(np.quantile(calibration_distance, 0.99, method="higher"))
    nominal_stream_scores = _nominal_stream_scores(params, ood_limit, seed + 100_000, validation_seeds)
    thresholds = {subsystem: float(np.quantile(nominal_stream_scores[:, j], 0.999, method="higher"))
                  for j, subsystem in enumerate(SUBSYSTEMS)}
    nominal_reference = {subsystem: [round(float(value), 8) for value in nominal_stream_scores[:, j]]
                         for j, subsystem in enumerate(SUBSYSTEMS)}
    endurance_lower_offset = float(np.quantile(t_cal - cal_time_pred[:, 0], 0.12))
    endurance_upper_offset = float(np.quantile(t_cal - cal_time_pred[:, 2], 0.88))
    x_test = np.stack([row[0] for row in evaluation_data])
    y_test = np.stack([row[1] for row in evaluation_data])
    t_test = np.asarray([row[2] for row in evaluation_data], dtype=np.float32)
    test_probs, time_pred = _forward(params, x_test)
    time_pred = time_pred * time_scale + time_mean
    time_pred[:, 0] += endurance_lower_offset
    time_pred[:, 2] += endurance_upper_offset
    time_pred.sort(axis=1)
    predictions = test_probs > np.asarray([thresholds[key] for key in SUBSYSTEMS])
    window_recalls: dict[str, float | None] = {}
    for j, subsystem in enumerate(SUBSYSTEMS):
        positive = y_test[:, j] == 1
        window_recalls[subsystem] = float(predictions[positive, j].mean()) if positive.any() else None
    stream_metrics = _stream_replay(params, thresholds, ood_limit, seed + 200_000, validation_seeds)
    low_presence_rows = [_sample(s, "low_presence")[3]["window"] for s in range(seed + 200_000, seed + 200_000 + validation_seeds)]
    low_presence_abstention_percent = 100.0 * sum(row["field_presence_ratio"] < 0.60 for row in low_presence_rows) / max(1, len(low_presence_rows))
    endurance_actual = np.expm1(t_test)
    endurance_pred = np.expm1(np.clip(time_pred, 0, math.log1p(240)))
    p50_abs_error = float(np.median(np.abs(endurance_pred[:, 1] - endurance_actual)))
    coverage = float(np.mean((endurance_actual >= endurance_pred[:, 0]) & (endurance_actual <= endurance_pred[:, 2])))
    output_dir.mkdir(parents=True, exist_ok=True)
    model_path = output_dir / "warden-th.onnx"
    _export_onnx(params, model_path)
    calibration = {
        "schema_version": 1, "model_id": "warden-th", "generator_version": "warden-th-synthetic-v1",
        "training_seeds": [seed, seed + train_seeds - 1],
        "calibration_seeds": [seed + 100_000, seed + 100_000 + validation_seeds - 1],
        "evaluation_seeds": [seed + 200_000, seed + 200_000 + validation_seeds - 1],
        "training_examples": len(train_data), "calibration_examples": len(calibration_data),
        "evaluation_examples": len(evaluation_data),
        "input_feature_count": MODEL_FEATURE_COUNT, "channel_count": len(CHANNEL_NAMES),
        "input_mean": [float(value) for value in params["input_mean"]],
        "input_scale": [float(value) for value in params["input_scale"]],
        "alert_thresholds": thresholds, "nominal_reference_scores": nominal_reference,
        "ood_mean_square_ceiling": ood_limit, "ood_reference": "all declared synthetic scenarios; held-out 99th percentile",
        "endurance_log_mean": time_mean, "endurance_log_scale": time_scale,
        "endurance_lower_log_offset": endurance_lower_offset, "endurance_upper_log_offset": endurance_upper_offset,
        "endurance_residual_calibration_quantiles": {"p10_head": 0.12, "p90_head": 0.88},
        "calibration_data": "synthetic held-out 120-second nominal replay windows at 5-second strides (99.9th percentile thresholds) and endurance residuals; not an operational guarantee",
        "evaluation": {"synthetic_window_fault_recall_by_subsystem": window_recalls,
                       "synthetic_fault_recall_by_subsystem": stream_metrics["stream_fault_recall_by_subsystem"],
                       "synthetic_median_detection_delay_seconds": stream_metrics["stream_detection_delay_median_seconds"],
                       "synthetic_p90_detection_delay_seconds": stream_metrics["stream_detection_delay_p90_seconds"],
                       "synthetic_fault_misses": stream_metrics["stream_fault_misses"],
                       "synthetic_nominal_false_alarms_per_flight_hour": stream_metrics["stream_nominal_false_alarm_episodes_per_flight_hour"],
                       "synthetic_low_presence_abstention_percent": low_presence_abstention_percent,
                       "synthetic_stream_evaluation": {key: value for key, value in stream_metrics.items() if key not in {"stream_fault_recall_by_subsystem", "stream_detection_delay_median_seconds", "stream_detection_delay_p90_seconds", "stream_fault_misses", "stream_nominal_false_alarm_episodes_per_flight_hour"}},
                       "synthetic_endurance_p50_absolute_error_minutes": p50_abs_error,
                       "synthetic_endurance_p10_p90_coverage_percent": 100.0 * coverage,
                       "targets_met": bool(min(stream_metrics["stream_fault_recall_by_subsystem"].values()) >= 0.90
                                           and stream_metrics["stream_detection_delay_median_seconds"] is not None
                                           and stream_metrics["stream_detection_delay_median_seconds"] <= 10.0
                                           and stream_metrics["stream_nominal_false_alarm_episodes_per_flight_hour"] is not None
                                           and stream_metrics["stream_nominal_false_alarm_episodes_per_flight_hour"] <= 1.0
                                           and p50_abs_error <= 2.0
                                           and 0.75 <= coverage <= 0.85
                                           and low_presence_abstention_percent == 100.0),
                       "limitations": ["All fitting, calibration, and evaluation examples are seeded synthetic telemetry.", "Latency and false-alarm estimates are from offline 5-second-stride replay of 180-second synthetic streams with 120-second windows.", "Synthetic metrics are not field validation or an operational guarantee."]},
        "weights_in_git": False, "automatic_download": False, "external_inference": "disabled",
        "advisory_only": True, "field_validated": False,
    }
    calibration_path = output_dir / "calibration.json"
    calibration_path.write_text(json.dumps(calibration, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    files = []
    for path in (model_path, calibration_path):
        files.append({"path": path.name, "size": path.stat().st_size, "sha256": _hash(path)})
    manifest = {
        "schema_version": 1, "model_id": "warden-th", "artifact_status": "generated_local_not_committed",
        "generator_version": "warden-th-synthetic-v1", "trained_on": "synthetic-only",
        "license_status": "NOASSERTION: project has not selected an open-source license; no third-party dataset is used",
        "runtime": "onnxruntime-cpu", "files": files, "resources": {"free_disk_mb": 50, "ram_mb": 512, "gpu": "not used"},
        "weights_in_git": False, "automatic_download": False, "external_inference": "disabled", "advisory_only": True,
        "field_validated": False, "evaluation": calibration["evaluation"],
    }
    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return {"output_dir": str(output_dir), "manifest": manifest, "manifest_path": str(manifest_path),
            "model_sha256": _hash(model_path), "calibration_sha256": _hash(calibration_path)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, default=73021)
    parser.add_argument("--train-seeds", type=int, default=32)
    parser.add_argument("--validation-seeds", type=int, default=60, help="Independent seed count used for each calibration and evaluation split.")
    parser.add_argument("--output-dir", type=Path, required=True,
                        help="Write ONNX weights outside the Git checkout (required).")
    args = parser.parse_args()
    try:
        result = train(args.seed, args.train_seeds, args.validation_seeds, args.output_dir.expanduser())
    except (ValueError, RuntimeError, OSError, ImportError) as error:
        parser.error(str(error))
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
