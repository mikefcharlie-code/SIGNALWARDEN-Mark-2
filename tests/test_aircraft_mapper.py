from __future__ import annotations

import copy
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from services.aircraft_gateway.mapper import TelemetryMapper


SCHEMA = json.loads(
    (ROOT / "packages/contracts/v1/telemetry.schema.json").read_text()
)
VALIDATOR = Draft202012Validator(SCHEMA)


NOW = 100.0
OBSERVED_AT = "2026-10-22T10:00:00Z"


def message(kind: str, *, system_id: int = 7, component_id: int = 1, **attrs):
    """Small pymavlink-like fake used by all mapper tests."""
    return SimpleNamespace(
        get_type=lambda: kind,
        get_srcSystem=lambda: system_id,
        get_srcComponent=lambda: component_id,
        **attrs,
    )


def heartbeat(
    *,
    autopilot: int = 12,
    vehicle_type: int = 2,
    base_mode: int = 128,
    custom_mode: int = 42,
    system_status: int = 4,
    **ids,
):
    return message(
        "HEARTBEAT",
        type=vehicle_type,
        autopilot=autopilot,
        base_mode=base_mode,
        custom_mode=custom_mode,
        system_status=system_status,
        **ids,
    )


def mapper(**kwargs):
    return TelemetryMapper("drone-7", "px4", 7, component_id=1, **kwargs)


def ready_mapper(**kwargs):
    result = mapper(**kwargs)
    assert result.accept(heartbeat(), now=NOW)
    return result


def test_mapper_rejects_invalid_configuration():
    with pytest.raises(ValueError):
        TelemetryMapper("drone-7", "invalid", 7)
    with pytest.raises(ValueError):
        TelemetryMapper("drone-7", "px4", 0)
    with pytest.raises(ValueError):
        TelemetryMapper("drone-7", "px4", 7, component_id=0)
    with pytest.raises(ValueError):
        TelemetryMapper("drone-7", "px4", 7, source="invalid")
    with pytest.raises(ValueError):
        TelemetryMapper("drone-7", "px4", 7, heartbeat_timeout=0)
    with pytest.raises(ValueError):
        TelemetryMapper("drone-7", "px4", 7, field_timeout=0)


@pytest.mark.parametrize(
    ("family", "autopilot", "vehicle_type"),
    [("px4", 12, 2), ("ardupilot", 3, 1), ("px4", 12, 19)],
)
def test_heartbeat_accepts_supported_autopilot_and_all_vehicle_types(
    family, autopilot, vehicle_type
):
    m = TelemetryMapper("drone-7", family, 7)
    assert m.accept(
        heartbeat(autopilot=autopilot, vehicle_type=vehicle_type), now=NOW
    )
    snapshot = m.snapshot(now=NOW, timestamp=OBSERVED_AT)
    assert snapshot["autopilot"] == {
        "family": family,
        "system_id": 7,
        "component_id": 1,
        "vehicle_type": vehicle_type,
        "armed": True,
        "base_mode": 128,
        "custom_mode": 42,
        "system_status": 4,
        "heartbeat_age_seconds": 0,
    }


def test_mapper_rejects_wrong_source_ids_and_wrong_autopilot_heartbeat():
    m = mapper()
    assert not m.accept(heartbeat(system_id=8), now=NOW)
    assert not m.accept(heartbeat(component_id=2), now=NOW)
    assert not m.accept(heartbeat(autopilot=3), now=NOW)
    assert m.snapshot(now=NOW, timestamp=OBSERVED_AT) is None


def test_no_telemetry_is_emitted_before_a_valid_heartbeat():
    m = mapper()
    assert not m.accept(message("SYS_STATUS", voltage_battery=12000, battery_remaining=50), now=NOW)
    assert m.snapshot(now=NOW, timestamp=OBSERVED_AT) is None


def test_heartbeat_expiry_returns_none_and_sequence_only_advances_on_snapshots():
    m = ready_mapper(heartbeat_timeout=5)
    first = m.snapshot(now=NOW, timestamp=OBSERVED_AT)
    assert first["sequence"] == 0
    assert m.snapshot(now=NOW + 5.001, timestamp=OBSERVED_AT) is None
    assert m.snapshot(now=NOW + 5.001, timestamp=OBSERVED_AT) is None
    assert m.accept(heartbeat(custom_mode=99), now=NOW + 6)
    assert m.snapshot(now=NOW + 6, timestamp=OBSERVED_AT)["sequence"] == 1


def test_snapshot_has_contract_metadata_source_timestamps_and_nullable_health():
    m = ready_mapper(source="aircraft")
    snapshot = m.snapshot(now=NOW, timestamp=OBSERVED_AT)
    assert snapshot["schema_version"] == "1.1"
    assert snapshot["aircraft_id"] == "drone-7"
    assert snapshot["source"] == "aircraft"
    assert snapshot["timestamp"] == OBSERVED_AT
    assert snapshot["received_at"] == OBSERVED_AT
    assert snapshot["health"] == {
        "battery_voltage_v": None,
        "battery_percent": None,
        "link_quality_percent": None,
        "status": "unknown",
    }


def test_mapper_snapshot_validates_as_extended_telemetry_1_1():
    snapshot = ready_mapper().snapshot(now=NOW, timestamp=OBSERVED_AT)
    errors = sorted(VALIDATOR.iter_errors(snapshot), key=lambda error: list(error.path))
    assert errors == []


def test_legacy_telemetry_1_0_rejects_null_health_and_autopilot_extension():
    snapshot = ready_mapper().snapshot(now=NOW, timestamp=OBSERVED_AT)
    legacy = copy.deepcopy(snapshot)
    legacy["schema_version"] = "1.0"
    legacy["health"]["battery_voltage_v"] = 12.0
    legacy["health"]["battery_percent"] = 80
    legacy["health"]["link_quality_percent"] = 50
    legacy.pop("autopilot")
    legacy.pop("session_id")
    legacy.pop("observation")
    assert list(VALIDATOR.iter_errors(legacy)) == []

    nullable_legacy = copy.deepcopy(legacy)
    nullable_legacy["health"]["battery_voltage_v"] = None
    assert list(VALIDATOR.iter_errors(nullable_legacy))

    extended_legacy = copy.deepcopy(legacy)
    extended_legacy["autopilot"] = snapshot["autopilot"]
    assert list(VALIDATOR.iter_errors(extended_legacy))


def test_sys_status_converts_voltage_and_battery_sentinels_and_radio_does_not_invent_link_quality():
    m = ready_mapper()
    assert m.accept(
        message("SYS_STATUS", voltage_battery=12345, battery_remaining=76), now=NOW
    )
    assert not m.accept(message("RADIO_STATUS", rssi=255, remrssi=10), now=NOW)
    health = m.snapshot(now=NOW, timestamp=OBSERVED_AT)["health"]
    assert health["battery_voltage_v"] == pytest.approx(12.345)
    assert health["battery_percent"] == 76
    assert health["link_quality_percent"] is None

    m = ready_mapper()
    assert m.accept(
        message("SYS_STATUS", voltage_battery=65535, battery_remaining=-1), now=NOW
    )
    health = m.snapshot(now=NOW, timestamp=OBSERVED_AT)["health"]
    assert health["battery_voltage_v"] is None
    assert health["battery_percent"] is None


def test_selected_battery_status_sums_cells_and_takes_precedence_over_sys_status():
    m = ready_mapper()
    assert m.accept(
        message("SYS_STATUS", voltage_battery=12000, battery_remaining=20), now=NOW
    )
    assert m.accept(
        message(
            "BATTERY_STATUS",
            id=0,
            voltages=[4000, 4100, 4200, 65535, 0, 0, 0, 0, 0, 0],
            voltages_ext=[100, 200, 0, 65535],
            temperature=2534,
            battery_remaining=80,
        ),
        now=NOW,
    )
    health = m.snapshot(now=NOW, timestamp=OBSERVED_AT)["health"]
    assert health["battery_voltage_v"] == pytest.approx(12.6)
    assert health["battery_percent"] == 80
    assert health["temperature_c"] == pytest.approx(25.34)


def test_nonprimary_battery_does_not_fallback_to_sys_status_battery_fields():
    m = ready_mapper(battery_id=2)
    assert m.accept(
        message(
            "SYS_STATUS",
            voltage_battery=12000,
            battery_remaining=20,
            onboard_control_sensors_enabled=3,
            onboard_control_sensors_present=3,
            onboard_control_sensors_health=1,
        ),
        now=NOW,
    )
    health = m.snapshot(now=NOW, timestamp=OBSERVED_AT)["health"]
    assert health["battery_voltage_v"] is None
    assert health["battery_percent"] is None
    assert health["status"] == "warning"


def test_nonprimary_selected_battery_status_is_used_without_sys_status_battery():
    m = ready_mapper(battery_id=2)
    assert m.accept(
        message("SYS_STATUS", voltage_battery=12000, battery_remaining=20), now=NOW
    )
    assert m.accept(
        message(
            "BATTERY_STATUS",
            id=2,
            voltages=[4000, 4100],
            voltages_ext=[],
            battery_remaining=80,
        ),
        now=NOW,
    )
    health = m.snapshot(now=NOW, timestamp=OBSERVED_AT)["health"]
    assert health["battery_voltage_v"] == pytest.approx(8.1)
    assert health["battery_percent"] == 80


def test_stale_nonprimary_battery_does_not_revert_to_fresh_sys_status_battery():
    m = ready_mapper(battery_id=2, field_timeout=5)
    assert m.accept(
        message("BATTERY_STATUS", id=2, voltages=[4000], battery_remaining=80),
        now=NOW,
    )
    assert m.accept(heartbeat(), now=NOW + 4)
    assert m.accept(
        message("SYS_STATUS", voltage_battery=12000, battery_remaining=20),
        now=NOW + 4,
    )
    health = m.snapshot(now=NOW + 5.001, timestamp=OBSERVED_AT)["health"]
    assert health["battery_voltage_v"] is None
    assert health["battery_percent"] is None


def test_battery_status_ignores_other_battery_id_and_unknown_temperature():
    m = ready_mapper()
    assert not m.accept(
        message(
            "BATTERY_STATUS",
            id=1,
            voltages=[4000] * 10,
            voltages_ext=[100] * 4,
            temperature=2000,
            battery_remaining=10,
        ),
        now=NOW,
    )
    health = m.snapshot(now=NOW, timestamp=OBSERVED_AT)["health"]
    assert health["battery_voltage_v"] is None
    assert health["battery_percent"] is None
    assert "temperature_c" not in health


def test_position_attitude_and_gps_fields_are_converted_and_heading_65535_is_null():
    m = ready_mapper()
    assert m.accept(
        message(
            "GLOBAL_POSITION_INT",
            lat=123456789,
            lon=-987654321,
            alt=12345,
            relative_alt=2345,
            vx=120,
            vy=-50,
            vz=7,
            hdg=65535,
        ),
        now=NOW,
    )
    assert m.accept(
        message("ATTITUDE", roll=0.1, pitch=-0.2, yaw=1.5), now=NOW
    )
    assert m.accept(
        message("GPS_RAW_INT", fix_type=3, satellites_visible=255), now=NOW
    )
    snapshot = m.snapshot(now=NOW, timestamp=OBSERVED_AT)
    assert snapshot["position"] == {
        "latitude_deg": pytest.approx(12.3456789),
        "longitude_deg": pytest.approx(-98.7654321),
        "altitude_msl_m": pytest.approx(12.345),
        "relative_altitude_m": pytest.approx(2.345),
        "vx_m_s": pytest.approx(1.2),
        "vy_m_s": pytest.approx(-0.5),
        "vz_m_s": pytest.approx(0.07),
        "heading_deg": None,
        "age_seconds": 0,
    }
    assert snapshot["attitude"] == {
        "roll_rad": pytest.approx(0.1),
        "pitch_rad": pytest.approx(-0.2),
        "yaw_rad": pytest.approx(1.5),
        "age_seconds": 0,
    }
    assert snapshot["gps"] == {
        "fix_type": 3,
        "satellites_visible": None,
        "age_seconds": 0,
    }


def test_stale_sensor_sections_are_omitted_and_stale_health_is_nullable():
    m = ready_mapper(field_timeout=5)
    assert m.accept(message("SYS_STATUS", voltage_battery=12000, battery_remaining=90), now=NOW)
    assert m.accept(message("GLOBAL_POSITION_INT", lat=1, lon=2, alt=3, relative_alt=4, vx=5, vy=6, vz=7, hdg=8), now=NOW)
    assert m.accept(message("ATTITUDE", roll=1, pitch=2, yaw=3), now=NOW)
    assert m.accept(message("GPS_RAW_INT", fix_type=3, satellites_visible=10), now=NOW)
    # A fresh heartbeat keeps the stream alive, but does not refresh sensor fields.
    assert m.accept(heartbeat(), now=NOW + 4)
    stale = m.snapshot(now=NOW + 5.001, timestamp=OBSERVED_AT)
    assert stale["health"]["battery_voltage_v"] is None
    assert stale["health"]["battery_percent"] is None
    assert "position" not in stale
    assert "attitude" not in stale
    assert "gps" not in stale


def test_recovered_heartbeat_clears_cached_sensor_fields_from_expired_session():
    m = ready_mapper(heartbeat_timeout=5)
    assert m.accept(
        message("SYS_STATUS", voltage_battery=12000, battery_remaining=90), now=NOW
    )
    assert m.snapshot(now=NOW, timestamp=OBSERVED_AT)["health"]["battery_voltage_v"] == 12
    assert m.accept(heartbeat(), now=NOW + 6)
    recovered = m.snapshot(now=NOW + 6, timestamp=OBSERVED_AT)
    assert recovered["health"]["battery_voltage_v"] is None
    assert recovered["health"]["battery_percent"] is None


def test_bad_data_and_nonfinite_sensor_values_are_ignored_defensively():
    m = ready_mapper()
    assert not m.accept(message("BAD_DATA", data=b"garbage"), now=NOW)
    assert m.accept(message("GLOBAL_POSITION_INT", lat=float("nan"), lon=float("inf"), alt=1, relative_alt=2, vx=3, vy=4, vz=5, hdg=6), now=NOW)
    snapshot = m.snapshot(now=NOW, timestamp=OBSERVED_AT)
    assert "position" not in snapshot


def test_heartbeat_recovery_changes_session_and_drops_cached_sensors():
    m = ready_mapper()
    assert m.accept(message("SYS_STATUS", voltage_battery=12000, battery_remaining=80), now=NOW)
    first = m.snapshot(now=NOW, timestamp=OBSERVED_AT)
    assert m.snapshot(now=NOW + 6, timestamp=OBSERVED_AT) is None
    assert m.accept(heartbeat(), now=NOW + 6)
    recovered = m.snapshot(now=NOW + 6, timestamp=OBSERVED_AT)
    assert recovered["session_id"] != first["session_id"]
    assert recovered["health"]["battery_voltage_v"] is None


def test_observed_boot_clock_regression_requires_new_heartbeat_session():
    m = ready_mapper()
    assert m.accept(message("ATTITUDE", time_boot_ms=1000, roll=0, pitch=0, yaw=0), now=NOW)
    before = m.snapshot(now=NOW, timestamp=OBSERVED_AT)
    assert not m.accept(message("ATTITUDE", time_boot_ms=10, roll=1, pitch=1, yaw=1), now=NOW + 1)
    assert m.snapshot(now=NOW + 1, timestamp=OBSERVED_AT) is None
    assert m.accept(heartbeat(), now=NOW + 1)
    after = m.snapshot(now=NOW + 1, timestamp=OBSERVED_AT)
    assert after["session_id"] != before["session_id"]
    assert "attitude" not in after
