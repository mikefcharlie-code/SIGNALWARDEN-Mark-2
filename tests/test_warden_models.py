import ast
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path

from services.warden_nav import assess as assess_nav
from services.warden_nav.residuals import compute_residuals
from services.warden_th import assess as assess_th
from services.warden_trust import annotate_evidence

ROOT = Path(__file__).resolve().parents[1]
BASE_TIME = datetime(2026, 10, 29, 15, 0, tzinfo=timezone.utc)


def full_sample(sequence, *, north_m_s=0.2, east_m_s=0.3):
    seconds = sequence * 5
    stamp = (BASE_TIME + timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z")
    latitude = 38.0 + (north_m_s * seconds) / 111_320
    longitude = -77.0 + (east_m_s * seconds) / (111_320 * 0.788)
    return {
        "schema_version": "1.1",
        "aircraft_id": "aircraft-test-1",
        "timestamp": stamp,
        "received_at": stamp,
        "sequence": sequence,
        "source": "aircraft",
        "health": {
            "battery_voltage_v": 15.8 - sequence * 0.01,
            "battery_percent": 82.0 - sequence * 0.1,
            "link_quality_percent": 96.0,
            "temperature_c": 27.0 + sequence * 0.05,
            "status": "nominal",
        },
        "autopilot": {
            "family": "px4", "system_id": 1, "component_id": 1, "vehicle_type": 2,
            "armed": False, "base_mode": 0, "custom_mode": 0, "system_status": 4,
            "heartbeat_age_seconds": 0.1,
        },
        "position": {
            "latitude_deg": latitude, "longitude_deg": longitude, "altitude_msl_m": 100.0,
            "relative_altitude_m": 50.0, "vx_m_s": north_m_s, "vy_m_s": east_m_s,
            "vz_m_s": 0.0, "heading_deg": 0.0, "age_seconds": 0.1,
        },
        "attitude": {"roll_rad": 0.0, "pitch_rad": 0.0, "yaw_rad": 0.0, "age_seconds": 0.1},
        "gps": {"fix_type": 3, "satellites_visible": 10, "age_seconds": 0.1},
        "session_id": "0" * 32,
        "observation": {
            "heartbeat_timeout_seconds": 2.0, "field_timeout_seconds": 2.0,
            "battery_age_seconds": 0.1, "system_status_age_seconds": 0.1,
        },
        "ingress_security": {
            "policy": "required-signed", "telemetry_trust": "signature-verified",
            "flight_ready": False, "counters": {},
        },
    }


def test_th_baseline_preserves_presence_and_does_not_invent_scores_or_coordinates():
    samples = [full_sample(i) for i in range(6)]
    result = assess_th(samples)
    assert result["mode"] == "deterministic_baseline"
    assert result["weights_available"] is False and result["learned_inference"] == "unavailable"
    assert result["status"] == "baseline_only"
    assert result["numeric_score"] is None
    summary = result["feature_summary"]
    assert summary["feature_presence_ratio"] >= 0.60
    assert summary["imputation"] == "none" and summary["resampling"] == "not_performed"
    assert summary["presence_mask"]["position.age_seconds"] is True
    assert "latitude_deg" not in json.dumps(result) and "longitude_deg" not in json.dumps(result)


def test_th_abstains_below_the_presence_gate_and_keeps_missing_values_explicit():
    legacy = {"timestamp": "2026-10-29T15:00:00Z", "sequence": 1,
              "health": {"battery_voltage_v": 12.2, "battery_percent": 80, "link_quality_percent": 90}}
    result = assess_th([legacy])
    assert result["status"] == "abstained"
    assert "feature_presence_below_60_percent" in result["abstention_reasons"]
    assert result["feature_summary"]["presence_mask"]["gps.age_seconds"] is False
    assert result["feature_summary"]["latest_observed_features"]["gps.age_seconds"] is None


def test_nav_residuals_are_descriptive_coordinate_free_and_do_not_classify_spoofing():
    from simulation.nav_scenarios import generate_window

    samples = generate_window("nominal", seed=7, trust="signature-verified", airframe_class="multicopter-light")
    result = assess_nav(samples, telemetry_trust="untrusted", airframe_class="multicopter-light")
    assert result["status"] == "baseline_only"
    assert result["weights_available"] is False and result["numeric_score"] is None
    assert result["telemetry_trust"] == "untrusted"
    assert result["integrity_classification"] is None
    assert "telemetry_trust_not_verified" in result["abstention_reasons"]
    residuals = result["residuals"]
    assert residuals["position_velocity_residual_m"]["30s"] is not None
    assert residuals["position_velocity_residual_m"]["30s"] < 1.0
    serialized = json.dumps(result)
    assert "latitude_deg" not in serialized and "longitude_deg" not in serialized
    assert "not evidence of spoofing" in " ".join(result["limitations"])


def test_nav_abstains_when_position_gps_and_attitude_presence_is_low():
    result = assess_nav([{"timestamp": "2026-10-29T15:00:00Z", "health": {"battery_percent": 80}}])
    assert result["status"] == "abstained"
    assert result["residuals"] is None
    assert result["feature_presence_ratio"] < 0.60


def test_residual_function_returns_only_scalar_measurements():
    result = compute_residuals([full_sample(0), full_sample(1)])
    assert set(result) >= {"position_velocity_residual_m", "heading_yaw_residual_deg", "gps_position_age_divergence_s"}
    assert "latitude_deg" not in json.dumps(result) and "longitude_deg" not in json.dumps(result)


def test_trust_labels_are_additive_fail_closed_and_never_assign_scores():
    rows = [
        {"id": "e-synthetic", "sourceId": "fixture", "trust": "unknown", "freshness": "stale", "synthetic": True},
        {"id": "e-untrusted", "sourceId": "sensor-a", "trust": "untrusted", "freshness": "current", "synthetic": False},
        {"id": "e-unknown", "sourceId": "unknown", "trust": "trusted", "freshness": "current", "synthetic": False},
    ]
    labeled = annotate_evidence(rows)
    assert len(labeled) == len(rows)
    assert [row["id"] for row in labeled] == [row["id"] for row in rows]
    assert labeled[0]["reliability"]["band"] == "low"
    assert labeled[1]["reliability"]["band"] == "low"
    assert labeled[2]["reliability"]["band"] == "unscored"
    assert all(row["reliability"]["score"] is None for row in labeled)
    assert all(row["reliability"]["factorsUp"] == [] for row in labeled)


def test_warden_packages_do_not_import_command_or_control_modules():
    forbidden_roots = {"services.civilian_commands", "services.command_gateway", "services.mission_upload",
                       "services.mission_gateway", "services.effectors", "services.actuators", "mavlink", "pymavlink"}
    forbidden_fragments = ("command_gateway", "mission_upload", "mission_gateway", "effector", "actuator", "mavlink")
    for package in ("warden_th", "warden_nav", "warden_trust"):
        for path in (ROOT / "services" / package).glob("*.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"))
            imported = set()
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    imported.update(alias.name for alias in node.names)
                elif isinstance(node, ast.ImportFrom) and node.module:
                    imported.add(node.module)
            assert not any(name in forbidden_roots or name.startswith("services.civilian_commands.")
                           or any(fragment in name.lower() for fragment in forbidden_fragments) for name in imported), path


def test_assessment_and_report_pipeline_preserve_source_rows_with_scoreless_reliability():
    from services.lattice_readonly.evidence import build_assessment
    from services.lattice_readonly.reports import build_report

    overview = {
        "generatedAt": "2026-10-29T15:00:30Z",
        "platforms": [{
            "entityId": "demo-aircraft", "catalogId": "autonomous-air-like", "synthetic": True,
            "provenance": {"sourceId": "demo-source", "sourceUpdateTime": "2026-10-29T15:00:00Z", "trust": "trusted"},
        }],
        "observationEvidence": [{
            "entityId": "demo-aircraft", "subjectId": "demo-aircraft", "sourceId": "demo-source",
            "field": "health.status", "value": "ok", "observedAt": "2026-10-29T15:00:00Z",
            "trust": "trusted", "synthetic": False,
        }],
    }
    assessment = build_assessment(overview)
    assessed = next(row for row in assessment["evidence"] if row["field"] == "health.status")
    assert assessed["synthetic"] is True and assessed["trust"] == "unknown"
    assert assessed["reliability"]["score"] is None and assessed["reliability"]["band"] == "low"

    report = build_report(overview, {"type": "data-quality"})
    reported = next(row for row in report["evidence"] if row["field"] == "health.status")
    assert reported["id"] == assessed["id"]
    assert reported["value"] == "ok" and reported["synthetic"] is True
    assert reported["reliability"]["score"] is None
    assert "numeric score: not produced" in report["markdown"]



def test_warden_th_seeded_windows_and_fault_baseline_are_reproducible():
    from simulation.fault_injection import SCENARIOS, generate_window
    from services.warden_th.baseline import assess_window
    from services.warden_th.window import build_window, model_features, MODEL_FEATURE_COUNT

    nominal_a = generate_window("nominal", seed=603)
    nominal_b = generate_window("nominal", seed=603)
    assert nominal_a == nominal_b and len(nominal_a) == 240
    assert len(SCENARIOS) == 9 and len(model_features(build_window(nominal_a))) == MODEL_FEATURE_COUNT == 198
    assert build_window(nominal_a)["window_seconds"] == 120
    assert assess_window(build_window(nominal_a), airframe_class="multicopter-light", samples=nominal_a)["findings"] == []
    expected = {"battery_sag": "power", "thermal_ramp": "power", "link_degradation": "link",
                "gps_jump": "navigation", "attitude_oscillation": "attitude", "stuck_sensor": "power",
                "unexpected_mode_change": "autopilot"}
    for scenario, subsystem in expected.items():
        samples = generate_window(scenario, seed=603)
        result = assess_window(build_window(samples), airframe_class="multicopter-light", samples=samples)
        assert subsystem in {finding["subsystem"] for finding in result["findings"]}, scenario


def test_warden_th_advisory_events_validate_and_low_presence_abstains():
    from jsonschema import Draft202012Validator
    from services.warden_th.demo import build_demo

    demo = build_demo("low_presence", seed=7, trust="untrusted")
    assert demo["window_steps"] == 240 and demo["sample_rate_hz"] == 2
    assert demo["field_presence_ratio"] < 0.60 and demo["telemetry_trust"] == "untrusted"
    assert demo["learned_inference"]["status"] == "not_requested"
    validator = Draft202012Validator(json.loads((ROOT / "packages/contracts/v1/operational-event.schema.json").read_text()))
    sag = build_demo("battery_sag", seed=7)
    for event in sag["advisory_events"]:
        assert not list(validator.iter_errors(event))
        assert event["attributes"]["advisory_only"] is True
        assert event["attributes"]["command_issued"] is False
        assert event["attributes"]["mission_uploaded"] is False
