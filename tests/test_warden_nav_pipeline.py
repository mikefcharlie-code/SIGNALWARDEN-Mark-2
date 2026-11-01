import ast
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from services.warden_nav.baseline import THRESHOLDS, assess_window
from services.warden_nav.demo import build_demo
from services.warden_nav.features import FEATURE_COUNT, FEATURE_NAMES, VALUE_FEATURES, model_features
from services.warden_nav.model import infer_assessment
from services.warden_nav.residuals import compute_residuals
from simulation.nav_scenarios import generate_window

ROOT = Path(__file__).resolve().parents[1]
FORBIDDEN_LOCATION_KEYS = {"latitude_deg", "longitude_deg", "absolute_position", "corrected_position", "navigation_solution", "nav_solution"}


def _assert_no_location_payload(value):
    if isinstance(value, dict):
        assert not (FORBIDDEN_LOCATION_KEYS & {str(key).lower() for key in value})
        for child in value.values():
            _assert_no_location_payload(child)
    elif isinstance(value, list):
        for child in value:
            _assert_no_location_payload(child)


def test_nav_window_is_fixed_120_seconds_at_2_hz_and_replay_is_deterministic():
    first = build_demo("spoofing_jump", seed=71)
    second = build_demo("spoofing_jump", seed=71)
    assert first == second
    assert first["window_seconds"] == 120
    assert first["sample_rate_hz"] == 2
    assert first["window_steps"] == 240
    assert len(first["residual_traces"]) == 240
    assert first["assessment"]["window"]["sample_count"] == 240
    assert any(row["finding_id"] == "position_velocity_disagreement" for row in first["assessment"]["baseline_findings"])


def test_hard_negative_is_quiet_while_injected_navigation_patterns_produce_residual_groups():
    hard_negative = build_demo("hard_negative_maneuver", seed=19)
    assert hard_negative["assessment"]["baseline_findings"] == []
    expected = {
        "jamming_like": {"gps_measurement_stale", "gps_state_satellite_inconsistency"},
        "spoofing_drag": {"position_velocity_disagreement"},
        "spoofing_jump": {"position_velocity_disagreement"},
        "replay_like": {"replay_or_sequence_reuse"},
        "compass_glitch": {"heading_yaw_disagreement"},
        "baro_drift": {"msl_relative_offset_drift"},
        "stuck_gnss": {"gps_receiver_state_stuck_fresh"},
    }
    for scenario, expected_findings in expected.items():
        result = build_demo(scenario, seed=19)
        actual = {finding["finding_id"] for finding in result["assessment"]["baseline_findings"]}
        assert expected_findings & actual, (scenario, actual)


def test_missingness_age_trust_and_airframe_gates_are_explicit_and_abstain():
    sparse = build_demo("low_presence", seed=9)
    assert sparse["assessment"]["status"] == "abstained"
    assert sparse["field_presence_ratio"] < 0.60
    assert sparse["assessment"]["residuals"] is None
    sparse_model = infer_assessment(sparse["assessment"], airframe_class=sparse["airframe_class"])
    assert sparse_model["status"] == "abstained"
    assert "feature_presence_below_60_percent" in sparse_model["abstention_reasons"]

    stale = build_demo("stale", seed=9)
    stale_model = infer_assessment(stale["assessment"], airframe_class=stale["airframe_class"])
    assert "stale_navigation_fields" in stale_model["abstention_reasons"]

    untrusted = build_demo("untrusted_ingress", seed=9)
    assert untrusted["telemetry_trust"] == "untrusted"
    assert untrusted["assessment"]["trust_interpretation"] == "untrusted_ingress"
    untrusted_model = infer_assessment(untrusted["assessment"], airframe_class=untrusted["airframe_class"])
    assert untrusted_model["status"] == "abstained"
    assert "telemetry_untrusted" in untrusted_model["abstention_reasons"]
    labels = {event["attributes"]["pattern_label"] for event in untrusted["advisory_events"]}
    assert "untrusted_ingress" in labels
    assert "spoofing_like_pattern" not in labels

    unknown_airframe = build_demo("nominal", seed=9, airframe_class=None)
    unknown_model = infer_assessment(unknown_airframe["assessment"], airframe_class=None)
    assert "airframe_class_unknown" in unknown_model["abstention_reasons"]


def test_residual_units_and_fixed_thresholds_are_transparent():
    result = assess_window(generate_window("nominal", seed=4, airframe_class="multicopter-light"),
                           airframe_class="multicopter-light")
    assert result["status"] == "baseline_only"
    assert result["model_id"] == "warden-nav-residual-baseline-v1"
    assert result["weights_available"] is False
    residuals = result["residuals"]
    assert set(residuals["position_velocity_residual_m"]) == {"5s", "15s", "30s"}
    assert "vertical_velocity_residual_m_s" in residuals
    assert "heading_yaw_residual_deg" in residuals
    assert "msl_relative_offset_drift_m" in residuals
    assert "gps_position_age_divergence_s" in residuals
    assert THRESHOLDS["position_velocity_residual_m"] == {"5s": 5.0, "15s": 12.0, "30s": 20.0}
    assert FEATURE_COUNT == len(FEATURE_NAMES) == 43
    assert not any(token in name.lower() for name in FEATURE_NAMES for token in ("latitude", "longitude", "coordinate"))
    features = model_features(residuals, result["window"], "multicopter-light")
    assert len(features) == FEATURE_COUNT and all(np.isfinite(features))
    fixed_wing_features = model_features(residuals, result["window"], "fixed-wing-lab")
    assert fixed_wing_features != features


def test_missing_feature_payload_has_explicit_zero_plus_mask_not_imputation():
    features = model_features({}, {}, None)
    assert len(features) == FEATURE_COUNT
    assert features[0] == 0.0
    mask_start = len(VALUE_FEATURES)
    assert features[mask_start] == 0.0
    assert features[mask_start + len(VALUE_FEATURES) - 1] == 0.0


def test_demo_and_events_are_coordinate_free_advisory_and_evidence_linked():
    from jsonschema import Draft202012Validator

    demo = build_demo("spoofing_jump", seed=2)
    _assert_no_location_payload(demo)
    encoded = json.dumps(demo, sort_keys=True)
    for token in FORBIDDEN_LOCATION_KEYS:
        assert token not in encoded
    assert demo["learned_inference"]["status"] == "not_requested"
    assert demo["assessment"]["read_only"] is True
    assert demo["assessment"]["advisory_only"] is True
    assert demo["assessment"]["numeric_score"] is None
    assert demo["assessment"]["integrity_classification"] is None
    assert demo["advisory_events"]
    validator = Draft202012Validator(json.loads((ROOT / "packages/contracts/v1/operational-event.schema.json").read_text()))
    for event in demo["advisory_events"]:
        assert not list(validator.iter_errors(event))
        assert event["attributes"]["advisory_only"] is True
        assert event["attributes"]["command_issued"] is False
        assert event["attributes"]["mission_uploaded"] is False
        assert event["attributes"]["flight_authorized"] is False
        assert event["attributes"]["sequence_from"] == demo["assessment"]["window"]["sequence_from"]
        assert event["attributes"]["sequence_to"] == demo["assessment"]["window"]["sequence_to"]


def test_untrusted_ingress_event_is_not_a_spoofing_source_or_pattern_claim():
    demo = build_demo("untrusted_ingress", seed=3)
    events = [event for event in demo["advisory_events"] if event["attributes"]["finding_id"] == "untrusted_ingress"]
    assert len(events) == 1
    assert events[0]["source"] == "warden-local"
    assert events[0]["attributes"]["pattern_label"] == "untrusted_ingress"
    assert "source" not in events[0]["attributes"]
    assert "location" not in events[0]["attributes"]


def test_ood_abstention_happens_before_pattern_output():
    demo = build_demo("nominal", seed=5)
    calibration = {
        "normalization": {"mean": [0.0] * FEATURE_COUNT, "scale": [1.0] * FEATURE_COUNT},
        "ood_gate": {"limit": 1.0e-9},
        "class_score_gates": {"thresholds": {"jamming_like_pattern": 0.0,
                                              "spoofing_like_pattern": 0.0,
                                              "sensor_estimator_glitch": 0.0}},
    }
    class Session:
        def get_inputs(self): return [SimpleNamespace(name="features")]
        def get_outputs(self): return [SimpleNamespace(name="logits")]
        def run(self, _names, _inputs): return [np.asarray([[0.0, 10.0, 0.0, 0.0]], dtype=np.float32)]
    calibration_file = ROOT / "tests" / "_nav_tmp_calibration.json"
    try:
        calibration_file.write_text(json.dumps(calibration), encoding="utf-8")
        result = infer_assessment(demo["assessment"], airframe_class=demo["airframe_class"], session=Session(), calibration_path=calibration_file)
    finally:
        calibration_file.unlink(missing_ok=True)
    assert result["status"] == "model_unsure"
    assert result["pattern_label"] is None
    assert result["abstention_reasons"] == ["out_of_distribution"]


def test_nav_package_has_no_command_control_imports_or_route_path():
    forbidden = ("command_gateway", "civilian_commands", "mission_upload", "mission_gateway", "mission_planner",
                 "vehicle_control", "controls", "effector", "actuator", "mavlink", "pymavlink")
    for path in (ROOT / "services" / "warden_nav").glob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names = [alias.name.lower() for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module:
                names = [node.module.lower()]
            else:
                continue
            assert not any(fragment in name for name in names for fragment in forbidden), path
    demo_source = (ROOT / "apps/management-web/src/WardenNavDemoPanel.tsx").read_text(encoding="utf-8").lower()
    assert "/api/v1/warden/navigation-integrity/demo" in demo_source
    assert "/command" not in demo_source and "/mission" not in demo_source and "/actuator" not in demo_source


def test_optional_onnx_model_parity_when_runtime_and_local_pinned_artifact_exist():
    if importlib.util.find_spec("onnxruntime") is None:
        pytest.skip("onnxruntime is not installed in the test environment")
    from services.warden_nav.model import _verified_artifacts
    try:
        directory, _manifest = _verified_artifacts()
    except (FileNotFoundError, ImportError, OSError, ValueError, KeyError):
        pytest.skip("no explicitly provisioned, hash-verified local Warden-NAV artifact")
    import onnxruntime as ort
    calibration = json.loads((directory / "calibration.json").read_text(encoding="utf-8"))
    fixtures = calibration.get("onnx_parity_fixtures", [])
    assert len(fixtures) >= 3
    session = ort.InferenceSession(str(directory / "warden-nav.onnx"), providers=["CPUExecutionProvider"])
    for fixture in fixtures:
        vector = np.asarray([fixture["features"]], dtype=np.float32)
        expected = np.asarray([fixture["expected_logits"]], dtype=np.float32)
        actual = session.run(["logits"], {"features": vector})[0]
        np.testing.assert_allclose(actual, expected, rtol=1e-5, atol=1e-5)
    synthetic = build_demo("spoofing_jump", seed=71)
    scored = infer_assessment(synthetic["assessment"], airframe_class=synthetic["airframe_class"])
    assert scored["status"] in {"scored_pattern", "scored_no_pattern", "model_unsure"}
    if scored["status"] == "model_unsure":
        assert scored["pattern_label"] is None
    assert scored["model_hash"] == _manifest_hash(directory)
    _assert_no_location_payload(scored)


def _manifest_hash(directory):
    manifest = __import__("scripts.local_ai_setup", fromlist=["load_registry"]).load_registry()
    entry = manifest["models"]["navigation-integrity"]
    return next(file["sha256"] for file in entry["files"] if file["path"] == "warden-nav.onnx")


def test_training_refuses_to_write_artifacts_inside_git_checkout(tmp_path):
    from scripts.warden_nav_train import train

    target = ROOT / ".nav-artifact-must-not-exist"
    with pytest.raises(ValueError, match="outside the Git checkout"):
        train(target, train_seeds=4, eval_seeds=4)
    assert not target.exists()


def test_autopilot_mode_transitions_are_explicit_non_alerting_diagnostics():
    samples = generate_window("nominal", seed=8)
    for row in samples[60:]:
        row["autopilot"]["armed"] = False
    for row in samples[120:]:
        row["autopilot"]["custom_mode"] = 5
    result = assess_window(samples, airframe_class="multicopter-light")
    assert result["window"]["autopilot_mode_presence_ratio"] == 1.0
    assert result["window"]["armed_state_change_count"] == 1
    assert result["window"]["custom_mode_change_count"] == 1
    assert result["baseline_findings"] == []
