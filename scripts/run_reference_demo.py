#!/usr/bin/env python3
"""Run the bounded, synthetic UCAS reference demonstration.

This demo uses only the in-memory Management API repository and the existing
Tracegate demonstrator. It does not start a listener, open a network socket,
read aircraft data, or issue aircraft/simulator commands.
"""
from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
MANAGEMENT_SERVICE = ROOT / "services" / "management-api"
TRACEGATE_PATH = ROOT / "services" / "tracegate" / "tracegate_engine.py"
sys.path.insert(0, str(MANAGEMENT_SERVICE))

import app as management_app  # noqa: E402


def load_tracegate():
    spec = importlib.util.spec_from_file_location("phase3_tracegate_engine", TRACEGATE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load Tracegate engine")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def telemetry_sample(sequence: int, timestamp: str) -> dict[str, Any]:
    return {
        "schema_version": "1.0",
        "aircraft_id": "sim-ucas-001",
        "timestamp": timestamp,
        "received_at": timestamp,
        "sequence": sequence,
        "source": "simulated",
        "health": {
            "battery_voltage_v": 12.2,
            "battery_percent": 88,
            "link_quality_percent": 96,
            "temperature_c": 25,
            "status": "nominal",
        },
    }


def operational_event() -> dict[str, Any]:
    return {
        "schema_version": "1.0",
        "event_id": "PHASE3-TRACEGATE-001",
        "event_type": "tracegate_review",
        "severity": "info",
        "status": "open",
        "occurred_at": "2026-10-20T12:00:00Z",
        "received_at": "2026-10-20T12:00:01Z",
        "source": "tracegate",
        "entity": {"kind": "configuration", "id": "cfg-demo-camera-r2"},
        "correlation_id": "PHASE3-DEMO-001",
        "summary": "Synthetic Tracegate review completed for a camera configuration change.",
        "attributes": {"profile": "simulation", "human_review_required": True},
    }


def validate_operational_event(event: dict[str, Any]) -> None:
    from jsonschema import Draft202012Validator, FormatChecker

    schema = json.loads((ROOT / "packages/contracts/v1/operational-event.schema.json").read_text(encoding="utf-8"))
    errors = sorted(Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(event), key=lambda error: list(error.path))
    if errors:
        raise ValueError(f"operational event failed schema validation: {errors[0].message}")


def _stable_ingestion(result: dict[str, Any]) -> dict[str, Any]:
    """Keep outcome identity while omitting wall-clock receipt time."""
    return {key: value for key, value in result.items() if key != "received_at"}


def run_demo(output_dir: Path) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=False)
    store = management_app.InMemoryStore()
    source_id = "phase3-simulator"
    valid = [
        telemetry_sample(1, "2026-10-20T12:00:00Z"),
        telemetry_sample(3, "2026-10-20T12:00:20Z"),
        telemetry_sample(2, "2026-10-20T12:00:10Z"),
    ]
    outcomes = [store.ingest(valid[0], source_id)]
    outcomes.append(store.ingest(valid[1], source_id))
    outcomes.append(store.ingest(copy.deepcopy(valid[1]), source_id))
    outcomes.append(store.ingest(valid[2], source_id))

    malformed = copy.deepcopy(valid[0])
    malformed.pop("sequence")
    try:
        management_app.validate_contract("telemetry", malformed)
    except management_app.ApiError as error:
        malformed_result = {"accepted": False, "error_code": error.code}
    else:  # pragma: no cover - protects the demo's stated negative case
        raise AssertionError("malformed telemetry unexpectedly passed validation")

    maintenance = {
        "schema_version": "1.0",
        "record_id": "phase3-maint-001",
        "aircraft_id": "sim-ucas-001",
        "summary": "Synthetic camera inspection watch item",
        "status": "open",
        "created_at": "2026-10-20T12:01:00Z",
        "notes": "Simulation-only maintenance record.",
    }
    stored_maintenance = store.add_maintenance(maintenance)

    event = operational_event()
    validate_operational_event(event)

    tracegate = load_tracegate()
    tracegate_result = tracegate.make_demo_engine().evaluate(tracegate.demo_scenarios()[0])

    telemetry_fixture = {
        "schema_version": "1.0",
        "profile": "simulation",
        "aircraft_id": "sim-ucas-001",
        "source_id": source_id,
        "samples": valid,
        "malformed_case": malformed,
    }
    summary = {
        "demo_id": "phase3-reference-demo-v1",
        "profile": "simulation",
        "external_systems_used": False,
        "aircraft_control_path": False,
        "aircraft_or_simulator_commands_issued": False,
        "telemetry_outcomes": {"accepted": 2, "late": 1, "duplicate": 1},
        "malformed_ingestion": malformed_result,
        "history_count": len(store.history("sim-ucas-001")),
        "maintenance_records": len(store.maintenance("sim-ucas-001")),
        "operational_event_valid": True,
        "tracegate_readiness_status": tracegate_result["readiness_status"],
        "tracegate_event_id": tracegate_result["event_id"],
        "safety_notice": "Synthetic reference evidence only; not flight authorization, production approval, or aircraft control.",
    }

    (output_dir / "summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (output_dir / "telemetry.json").write_text(json.dumps(telemetry_fixture, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (output_dir / "ingestion-outcomes.json").write_text(json.dumps([_stable_ingestion(item) for item in outcomes], indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (output_dir / "maintenance.json").write_text(json.dumps(stored_maintenance, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (output_dir / "operational-events.json").write_text(json.dumps([event], indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (output_dir / "tracegate-result.json").write_text(json.dumps(tracegate_result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="empty output directory; defaults to a temporary directory")
    args = parser.parse_args()
    output_dir = args.output or Path(tempfile.mkdtemp(prefix="ucas-phase3-demo-"))
    summary = run_demo(output_dir)
    print(json.dumps({"output_dir": str(output_dir), "summary": summary}, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
