"""Reference-data consistency only; these tests do not validate autopilot firmware."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from services.aircraft_gateway.runner import build_parser


@pytest.fixture
def reference():
    return json.loads((ROOT / "hardware/reference-multicopter.json").read_text(encoding="utf-8"))


def test_reference_is_not_owner_inventory_or_readiness_evidence(reference):
    assert reference["schema_version"] == "1.0"
    assert reference["status"] == "reference_only_not_validated"
    for key in ("owner_hardware_confirmed", "flight_ready", "runtime_consumed"):
        assert reference[key] is False
    assert reference["validation"] == {
        "sitl": "not_run", "bench": "not_run", "hil": "not_run", "flight": "not_run"
    }
    assert reference["safety"] == {
        "gateway_mavlink_transmit": False,
        "automatic_parameter_application": False,
        "firmware_installation_performed": False,
        "signatures_verified_by_gateway": False,
        "system_and_component_ids_are_placeholders": True,
        "simulator_or_router_start_required_separately": True,
    }


def test_reference_keeps_unverified_physical_details_unset(reference):
    assert reference["vehicle"]["category"] == "multicopter"
    assert reference["vehicle"]["type"] == "quadrotor"
    assert reference["vehicle"]["frame_geometry"] is None
    assert reference["vehicle"]["propulsion_and_power"] is None
    board = reference["flight_controller"]
    assert (board["manufacturer"], board["model"], board["serial_port"], board["uart"]) == (
        "Holybro", "Pixhawk 6C", "TELEM2", "UART5"
    )
    assert board["rts_cts_pins_available"] is True
    assert board["wiring_verified"] is False
    for key in ("hardware_revision", "companion_device_path", "baud", "flow_control_policy"):
        assert board[key] is None


def test_reference_keeps_separate_pinned_firmware_alternatives(reference):
    alternatives = {item["family"]: item for item in reference["autopilot_alternatives"]}
    assert len(reference["autopilot_alternatives"]) == 2
    assert set(alternatives) == {"px4", "ardupilot"}
    px4, ap = alternatives["px4"], alternatives["ardupilot"]
    assert (px4["reference_version"], px4["board_target"]) == ("1.17.0", "px4_fmu-v6c_default")
    assert px4["upstream_status"] == "official published non-draft non-prerelease release"
    assert px4["flight_controller_serial_device"] == "/dev/ttyS3"
    assert (ap["product"], ap["reference_version"], ap["board_target"]) == (
        "ArduCopter", "4.7.2", "Pixhawk6C"
    )
    assert ap["serial_parameter_prefix"] == "SERIAL2"
    assert "px4_artifact" in px4["source_ids"]
    assert "ardupilot_firmware_version" in ap["source_ids"]


@pytest.mark.parametrize("family,port", [("px4", 14540), ("ardupilot", 14551)])
def test_reference_observer_arguments_parse_without_network_or_serial(reference, family, port):
    alternative = next(item for item in reference["autopilot_alternatives"] if item["family"] == family)
    args = build_parser().parse_args(alternative["gateway_observation_example"])
    assert args.autopilot == family
    assert args.source == "simulated"
    assert args.stdout is True
    assert args.max_samples == 10
    assert args.connection == f"udpin:127.0.0.1:{port}"
    assert args.system_id == args.component_id == 1
    assert args.publisher_id is None
    assert args.publisher_token_file is None


def test_reference_facts_have_official_source_links_in_the_guide(reference):
    guide = (ROOT / "docs/reference-multicopter-configuration.md").read_text(encoding="utf-8")
    sources = reference["sources"]
    for alternative in reference["autopilot_alternatives"]:
        assert alternative["source_ids"]
        for source_id in alternative["source_ids"]:
            assert sources[source_id].startswith("https://")
            assert sources[source_id] in guide
    assert "../hardware/reference-multicopter.json" in guide
