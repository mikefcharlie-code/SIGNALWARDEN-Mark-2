#!/usr/bin/env python3
"""Train/evaluate a tiny Warden-NAV head from seeded synthetic scenarios only.

The ONNX artifact is written only to the explicitly supplied local directory;
no weights or calibration are automatically downloaded or committed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import sys
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

CLASSES = ("nominal", "jamming_like_pattern", "spoofing_like_pattern", "sensor_estimator_glitch")
TRAIN_SCENARIOS = (
    "nominal", "hard_negative_maneuver", "jamming_like", "spoofing_drag", "spoofing_jump",
    "replay_like", "estimator_reset", "compass_glitch", "baro_drift", "stuck_gnss",
)
EVAL_SCENARIOS = TRAIN_SCENARIOS
SCENARIO_TO_CLASS = {
    "nominal": "nominal", "hard_negative_maneuver": "nominal",
    "jamming_like": "jamming_like_pattern",
    "spoofing_drag": "spoofing_like_pattern", "spoofing_jump": "spoofing_like_pattern", "replay_like": "spoofing_like_pattern",
    "estimator_reset": "sensor_estimator_glitch", "compass_glitch": "sensor_estimator_glitch",
    "baro_drift": "sensor_estimator_glitch", "stuck_gnss": "sensor_estimator_glitch",
}
AIRFRAMES = ("multicopter-light", "multicopter-heavy", "fixed-wing-lab")


def _window(scenario: str, seed: int, airframe: str):
    from simulation.nav_scenarios import generate_window
    from services.warden_nav.baseline import assess_window
    samples = generate_window(scenario, seed=seed, airframe_class=airframe)
    return samples, assess_window(samples, airframe_class=airframe)


def _vector(assessment: dict[str, Any], airframe: str):
    from services.warden_nav.features import model_features
    return model_features(assessment.get("residuals"), assessment.get("window"), airframe)


def _softmax(logits):
    import numpy as np
    shifted = logits - logits.max(axis=1, keepdims=True)
    exp = np.exp(shifted)
    return exp / exp.sum(axis=1, keepdims=True)


def _train(x, y, *, seed: int, steps: int = 1800):
    import numpy as np
    n, dimensions = x.shape
    mean = x.mean(axis=0)
    scale = x.std(axis=0)
    scale[scale < 1.0e-5] = 1.0
    z = (x - mean) / scale
    rng = np.random.default_rng(seed)
    weights = rng.normal(0.0, 0.015, (dimensions, len(CLASSES))).astype(np.float32)
    bias = np.zeros(len(CLASSES), dtype=np.float32)
    first_w = np.zeros_like(weights); second_w = np.zeros_like(weights)
    first_b = np.zeros_like(bias); second_b = np.zeros_like(bias)
    onehot = np.eye(len(CLASSES), dtype=np.float32)[y]
    beta1, beta2, rate, epsilon = 0.9, 0.999, 0.018, 1.0e-8
    for step in range(1, steps + 1):
        logits = z @ weights + bias
        grad_logits = (_softmax(logits) - onehot) / n
        grad_w = z.T @ grad_logits + 0.001 * weights
        grad_b = grad_logits.sum(axis=0)
        first_w = beta1 * first_w + (1 - beta1) * grad_w
        second_w = beta2 * second_w + (1 - beta2) * (grad_w * grad_w)
        first_b = beta1 * first_b + (1 - beta1) * grad_b
        second_b = beta2 * second_b + (1 - beta2) * (grad_b * grad_b)
        correction1, correction2 = 1 - beta1 ** step, 1 - beta2 ** step
        weights -= rate * (first_w / correction1) / (np.sqrt(second_w / correction2) + epsilon)
        bias -= rate * (first_b / correction1) / (np.sqrt(second_b / correction2) + epsilon)
    return mean.astype(np.float32), scale.astype(np.float32), weights.astype(np.float32), bias.astype(np.float32)


def _export_onnx(path: Path, mean, scale, weights, bias) -> None:
    import onnx
    from onnx import TensorProto, helper, numpy_helper
    import numpy as np
    input_info = helper.make_tensor_value_info("features", TensorProto.FLOAT, [None, int(mean.shape[0])])
    output_info = helper.make_tensor_value_info("logits", TensorProto.FLOAT, [None, len(CLASSES)])
    nodes = [
        helper.make_node("Sub", ["features", "input_mean"], ["centered"]),
        helper.make_node("Div", ["centered", "input_scale"], ["normalized"]),
        helper.make_node("MatMul", ["normalized", "weights"], ["linear"]),
        helper.make_node("Add", ["linear", "bias"], ["logits"]),
    ]
    initializers = [
        numpy_helper.from_array(mean.astype(np.float32), "input_mean"),
        numpy_helper.from_array(scale.astype(np.float32), "input_scale"),
        numpy_helper.from_array(weights.astype(np.float32), "weights"),
        numpy_helper.from_array(bias.astype(np.float32), "bias"),
    ]
    graph = helper.make_graph(nodes, "warden_nav_synthetic_linear_head", [input_info], [output_info], initializers)
    model = helper.make_model(graph, producer_name="warden-nav-synthetic-training",
                              opset_imports=[helper.make_opsetid("", 13)])
    model.ir_version = min(model.ir_version, 9)
    model.metadata_props.add(key="dataset", value="seeded-synthetic-only")
    model.metadata_props.add(key="purpose", value="development-only-advisory-pattern-score")
    onnx.checker.check_model(model)
    path.write_bytes(model.SerializeToString(deterministic=True))


def _percentile_higher(values, percentile: float) -> float:
    import numpy as np
    return float(np.quantile(np.asarray(values, dtype=np.float64), percentile, method="higher"))


def _counts_metrics(actual, predicted, *, coverage: float = 1.0):
    tp = sum(a and p for a, p in zip(actual, predicted))
    fp = sum((not a) and p for a, p in zip(actual, predicted))
    fn = sum(a and (not p) for a, p in zip(actual, predicted))
    tn = sum((not a) and (not p) for a, p in zip(actual, predicted))
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"true_positive": tp, "false_positive": fp, "false_negative": fn, "true_negative": tn,
            "precision": round(precision, 6), "recall": round(recall, 6), "f1": round(f1, 6),
            "coverage": round(coverage, 6)}


def train(output_dir: Path, *, train_seeds: int = 24, eval_seeds: int = 20) -> dict[str, Any]:
    import numpy as np
    from services.warden_nav.features import FEATURE_NAMES
    output_dir = output_dir.expanduser().resolve()
    try:
        output_dir.relative_to(ROOT.resolve())
    except ValueError:
        pass
    else:
        raise ValueError("artifact output directory must be outside the Git checkout")
    output_dir.mkdir(parents=True, exist_ok=True)
    train_x, train_y = [], []
    for scenario in TRAIN_SCENARIOS:
        label = SCENARIO_TO_CLASS[scenario]
        class_index = CLASSES.index(label)
        for seed in range(train_seeds):
            for airframe in AIRFRAMES:
                _, assessment = _window(scenario, seed, airframe)
                train_x.append(_vector(assessment, airframe)); train_y.append(class_index)
    x_train = np.asarray(train_x, dtype=np.float32)
    y_train = np.asarray(train_y, dtype=np.int64)
    mean, scale, weights, bias = _train(x_train, y_train, seed=90210)
    model_path = output_dir / "warden-nav.onnx"
    _export_onnx(model_path, mean, scale, weights, bias)
    model_sha = hashlib.sha256(model_path.read_bytes()).hexdigest()

    # Held-out synthetic nominal calibration and mixed-scenario evaluation; no operational data.
    nominal_calibration = []
    known_domain_vectors = []
    for seed in range(20_000, 20_050):
        for scenario in ("nominal", "hard_negative_maneuver"):
            for airframe in AIRFRAMES:
                _, assessment = _window(scenario, seed, airframe)
                nominal_calibration.append(_vector(assessment, airframe))
    for scenario in TRAIN_SCENARIOS:
        for seed in range(10_000, 10_020):
            for airframe in AIRFRAMES:
                _, assessment = _window(scenario, seed, airframe)
                known_domain_vectors.append(_vector(assessment, airframe))
    nominal_x = np.asarray(nominal_calibration, dtype=np.float32)
    domain_x = np.asarray(known_domain_vectors, dtype=np.float32)
    z_nominal = (nominal_x - mean) / scale
    z_domain = (domain_x - mean) / scale
    nominal_logits = z_nominal @ weights + bias
    domain_ood = np.max(np.abs(z_domain), axis=1)
    nominal_ood = np.max(np.abs(z_nominal), axis=1)
    ood_limit = max(_percentile_higher(domain_ood, 0.995), _percentile_higher(nominal_ood, 0.995))
    nominal_margins = nominal_logits[:, 1:] - nominal_logits[:, [0]]
    score_thresholds = {
        CLASSES[index]: _percentile_higher(nominal_margins[:, index - 1], 0.995)
        for index in range(1, len(CLASSES))
    }
    parity_fixtures = []
    for scenario, seed in (("nominal", 30_001), ("spoofing_jump", 30_002), ("compass_glitch", 30_003)):
        _, assessment = _window(scenario, seed, "multicopter-light")
        vector = np.asarray(_vector(assessment, "multicopter-light"), dtype=np.float32)
        expected_logits = ((vector - mean) / scale) @ weights + bias
        parity_fixtures.append({"scenario": scenario, "seed": seed, "airframe_class": "multicopter-light",
                                "features": vector.astype(float).tolist(),
                                "expected_logits": expected_logits.astype(float).tolist()})
    calibration = {
        "schema_version": 1,
        "model_id": "warden-nav-synthetic-linear-v1",
        "model_file": "warden-nav.onnx",
        "model_sha256": model_sha,
        "synthetic_only": True,
        "training_data": "seeded-project-synthetic-scenarios-only",
        "training_seed_range": [0, train_seeds - 1],
        "calibration_seed_range": [20_000, 20_049],
        "evaluation_seed_range": [10_000, 10_000 + eval_seeds - 1],
        "airframe_classes": list(AIRFRAMES),
        "feature_names": list(FEATURE_NAMES),
        "feature_count": len(FEATURE_NAMES),
        "classes": list(CLASSES),
        "normalization": {"mean": mean.astype(float).tolist(), "scale": scale.astype(float).tolist()},
        "ood_gate": {"method": "maximum absolute standardized feature value",
                     "limit": float(ood_limit), "calibration_percentile": 99.5,
                     "dataset": "held-out seeded synthetic in-domain scenarios"},
        "class_score_gates": {"method": "class-logit minus nominal-logit threshold",
                              "thresholds": score_thresholds,
                              "nominal_calibration_percentile": 99.5,
                              "dataset": "held-out seeded synthetic nominal and hard-negative scenarios"},
        "metrics_label": "synthetic/SITL-development evidence only; not operational validation",
        "dependencies": {"numpy": "BSD-3-Clause", "onnx": "Apache-2.0", "onnxruntime": "MIT"},
        "onnx_parity_fixtures": parity_fixtures,
    }
    calibration_path = output_dir / "calibration.json"
    calibration_path.write_text(json.dumps(calibration, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")

    eval_rows = []
    for scenario in EVAL_SCENARIOS:
        for seed in range(10_000, 10_000 + eval_seeds):
            for airframe in AIRFRAMES:
                samples, assessment = _window(scenario, seed, airframe)
                vector = np.asarray([_vector(assessment, airframe)], dtype=np.float32)
                standardized = (vector - mean) / scale
                ood_score = float(np.max(np.abs(standardized)))
                logits = standardized @ weights + bias
                margins = logits[0, 1:] - logits[0, 0]
                selected = int(np.argmax(margins)) + 1
                score = float(margins[selected - 1])
                label = "abstain" if ood_score > ood_limit else (CLASSES[selected] if score > score_thresholds[CLASSES[selected]] else "nominal")
                eval_rows.append({
                    "truth": SCENARIO_TO_CLASS[scenario], "learned": label,
                    "baseline_alert": bool(assessment.get("baseline_findings")),
                    "is_anomaly": SCENARIO_TO_CLASS[scenario] != "nominal",
                    "ood": ood_score > ood_limit,
                })
    baseline_metrics = _counts_metrics([row["is_anomaly"] for row in eval_rows], [row["baseline_alert"] for row in eval_rows])
    learned_pred = [row["learned"] != "nominal" for row in eval_rows]
    learned_metrics = _counts_metrics([row["is_anomaly"] for row in eval_rows], learned_pred,
                                      coverage=sum(row["learned"] != "abstain" for row in eval_rows) / len(eval_rows))
    confusion = {truth: {pred: 0 for pred in (*CLASSES, "abstain")} for truth in CLASSES}
    for row in eval_rows:
        confusion[row["truth"]][row["learned"]] += 1
    anomaly_classes = tuple(label for label in CLASSES if label != "nominal")
    pattern_detected = sum(confusion[truth][pred] for truth in anomaly_classes for pred in anomaly_classes)
    pattern_correct = sum(confusion[label][label] for label in anomaly_classes)
    nominal_hours = sum(row["truth"] == "nominal" for row in eval_rows) * 120.0 / 3600.0
    evaluation = {
        "dataset": "seeded-project-synthetic-only",
        "status": "development-evidence-not-operational-validation",
        "evaluation_window_count": len(eval_rows),
        "baseline_thresholds": baseline_metrics,
        "learned_head": learned_metrics,
        "learned_confusion_matrix": confusion,
        "learned_pattern_accuracy_when_anomaly_detected": round(pattern_correct / pattern_detected, 6) if pattern_detected else 0.0,
        "baseline_false_alerts_per_nominal_flight_hour": round(baseline_metrics["false_positive"] / nominal_hours, 6) if nominal_hours else None,
        "learned_false_alerts_per_nominal_flight_hour": round(learned_metrics["false_positive"] / nominal_hours, 6) if nominal_hours else None,
        "synthetic_hard_negative_false_alerts": sum(
            row["baseline_alert"] for row in eval_rows
            if row["truth"] == "nominal"),
        "synthetic_ood_abstentions": sum(row["learned"] == "abstain" for row in eval_rows),
        "limitations": [
            "Generated only from seeded synthetic telemetry; results are not flight, SITL, or operational validation.",
            "Class labels describe telemetry-pattern resemblance, never an RF source, intent, location, or ground truth position.",
            "Synthetic scenario families and thresholds are not representative or license-reviewed field data.",
        ],
    }
    calibration["synthetic_evaluation"] = evaluation
    calibration_path.write_text(json.dumps(calibration, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
    return {
        "artifact_file": str(model_path), "size_bytes": model_path.stat().st_size,
        "sha256": model_sha,
        "calibration_file": str(calibration_path), "calibration_size_bytes": calibration_path.stat().st_size,
        "calibration_sha256": hashlib.sha256(calibration_path.read_bytes()).hexdigest(),
        "evaluation": evaluation,
        "weights_in_git": False,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True, type=Path, help="explicit local artifact output directory")
    parser.add_argument("--train-seeds", type=int, default=24)
    parser.add_argument("--eval-seeds", type=int, default=20)
    args = parser.parse_args(argv)
    if args.train_seeds < 4 or args.train_seeds > 500 or args.eval_seeds < 4 or args.eval_seeds > 500:
        parser.error("seed counts must be from 4 to 500")
    try:
        print(json.dumps(train(args.output_dir.expanduser().resolve(), train_seeds=args.train_seeds,
                               eval_seeds=args.eval_seeds), indent=2, sort_keys=True))
    except (ImportError, OSError, ValueError, RuntimeError) as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
