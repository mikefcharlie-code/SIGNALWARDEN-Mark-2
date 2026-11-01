import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "run_reference_demo.py"
SPEC = importlib.util.spec_from_file_location("phase3_demo", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_reference_demo_writes_stable_evidence_bundle(tmp_path):
    first_dir = tmp_path / "first"
    second_dir = tmp_path / "second"
    first = MODULE.run_demo(first_dir)
    second = MODULE.run_demo(second_dir)

    assert first == second
    assert first["telemetry_outcomes"] == {"accepted": 2, "duplicate": 1, "late": 1}
    assert first["malformed_ingestion"] == {"accepted": False, "error_code": "contract_validation_failed"}
    assert first["tracegate_readiness_status"] == "READY"
    assert first["external_systems_used"] is False
    assert first["aircraft_control_path"] is False
    assert first["aircraft_or_simulator_commands_issued"] is False

    expected = {
        "summary.json",
        "telemetry.json",
        "ingestion-outcomes.json",
        "maintenance.json",
        "operational-events.json",
        "tracegate-result.json",
    }
    assert {path.name for path in first_dir.iterdir()} == expected
    assert json.loads((first_dir / "operational-events.json").read_text())[0]["event_type"] == "tracegate_review"
    assert json.loads((first_dir / "tracegate-result.json").read_text())["event_id"] == "DEMO-01-CAMERA-SWAP"

    for name in expected:
        assert (first_dir / name).read_bytes() == (second_dir / name).read_bytes(), name
