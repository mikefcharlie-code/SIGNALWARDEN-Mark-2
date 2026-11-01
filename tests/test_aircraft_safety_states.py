"""Observed warning propagation, not proof of aircraft failsafe execution."""
import pytest

from test_aircraft_mapper import NOW, OBSERVED_AT, heartbeat, message, VALIDATOR
from services.aircraft_gateway.mapper import TelemetryMapper


@pytest.fixture(params=[("px4", 12), ("ardupilot", 3)])
def vehicle(request):
    family, autopilot = request.param
    mapper = TelemetryMapper("safety-sitl", family, 7, field_timeout=2)
    def beat(status=4, now=NOW, **kwargs):
        return mapper.accept(heartbeat(autopilot=autopilot, system_status=status, **kwargs), now=now)
    assert beat()
    return mapper, beat


def snapshot(mapper, now=NOW):
    sample = mapper.snapshot(now=now, timestamp=OBSERVED_AT)
    if sample is not None:
        assert list(VALIDATOR.iter_errors(sample)) == []
    return sample


@pytest.mark.parametrize("status", [5, 6, 7, 8])
def test_reported_critical_emergency_shutdown_termination_warn(vehicle, status):
    mapper, beat = vehicle
    assert beat(status)
    sample = snapshot(mapper)
    assert sample["autopilot"]["system_status"] == status
    assert sample["health"]["status"] == "warning"
    # A healthy sensor bitmap must not overwrite the heartbeat warning.
    assert mapper.accept(message("SYS_STATUS", onboard_control_sensors_present=7,
                                 onboard_control_sensors_enabled=7,
                                 onboard_control_sensors_health=7), now=NOW)
    assert snapshot(mapper)["health"]["status"] == "warning"
    assert beat(4, NOW + 1)
    assert snapshot(mapper, NOW + 1)["health"]["status"] == "unknown"


@pytest.mark.parametrize("state", [2, 3, 4, 5, 6])
def test_selected_battery_warning_without_voltage_or_percentage_thresholds(vehicle, state):
    mapper, _ = vehicle
    assert mapper.accept(message("BATTERY_STATUS", id=0, voltages=[65535] * 10,
                                 battery_remaining=-1, charge_state=state), now=NOW)
    health = snapshot(mapper)["health"]
    assert health["status"] == "warning"
    assert health["battery_voltage_v"] is None
    assert health["battery_percent"] is None


def test_battery_fault_warning_expires_and_ignores_other_battery(vehicle):
    mapper, beat = vehicle
    assert not mapper.accept(message("BATTERY_STATUS", id=1, charge_state=5,
                                     fault_bitmask=1), now=NOW)
    assert snapshot(mapper)["health"]["status"] == "unknown"
    assert mapper.accept(message("BATTERY_STATUS", id=0, fault_bitmask=1), now=NOW)
    assert snapshot(mapper)["health"]["status"] == "warning"
    assert beat(4, NOW + 3)
    assert snapshot(mapper, NOW + 3)["health"]["status"] == "unknown"
    assert beat(6, NOW + 3)
    assert snapshot(mapper, NOW + 3)["health"]["status"] == "warning"
    assert snapshot(mapper, NOW + 9) is None
    assert beat(4, NOW + 9)
    assert snapshot(mapper, NOW + 9)["health"]["status"] == "unknown"


@pytest.mark.parametrize("state", [None, 0, 1, 7, 200])
def test_nonwarning_battery_state_never_invents_nominal_health(vehicle, state):
    mapper, _ = vehicle
    assert mapper.accept(message("BATTERY_STATUS", id=0, charge_state=state,
                                 fault_bitmask=0), now=NOW)
    assert snapshot(mapper)["health"]["status"] == "unknown"


@pytest.mark.parametrize("bad", [{"base_mode": 1.5}, {"base_mode": 256},
                                  {"custom_mode": -1}, {"custom_mode": 2**32},
                                  {"vehicle_type": True}, {"vehicle_type": 256},
                                  {"system_status": float("nan")}])
def test_invalid_selected_heartbeat_invalidates_old_state_and_session(bad):
    mapper = TelemetryMapper("safety-sitl", "px4", 7)
    assert mapper.accept(heartbeat(), now=NOW)
    assert mapper.accept(message("SYS_STATUS", voltage_battery=12000), now=NOW)
    old = snapshot(mapper)
    assert not mapper.accept(heartbeat(**bad), now=NOW + 1)
    assert snapshot(mapper, NOW + 1) is None
    assert mapper.accept(heartbeat(), now=NOW + 2)
    recovered = snapshot(mapper, NOW + 2)
    assert old["session_id"] != recovered["session_id"]
    assert recovered["health"]["battery_voltage_v"] is None


@pytest.mark.parametrize("version", ["v10", "v20"])
@pytest.mark.parametrize("family,autopilot", [("px4", 12), ("ardupilot", 3)])
def test_encoded_heartbeat_and_battery_warnings_respect_wire_version(version, family, autopilot):
    import importlib
    mav = importlib.import_module(f"pymavlink.dialects.{version}.common")
    encoder = mav.MAVLink(None, srcSystem=7, srcComponent=1)
    decoder = mav.MAVLink(None)
    mapper = TelemetryMapper("wire-safety", family, 7)

    def receive(frame):
        decoded = decoder.parse_buffer(frame.pack(encoder))
        assert len(decoded) == 1
        return mapper.accept(decoded[0], now=NOW)

    assert receive(mav.MAVLink_heartbeat_message(2, autopilot, 0, 0, 6, 3))
    assert snapshot(mapper)["health"]["status"] == "warning"
    assert receive(mav.MAVLink_heartbeat_message(2, autopilot, 0, 0, 4, 3))
    assert snapshot(mapper)["health"]["status"] == "unknown"
    fields = dict(id=0, battery_function=0, type=0, temperature=32767,
                  voltages=[65535] * 10, current_battery=-1,
                  current_consumed=-1, energy_consumed=-1, battery_remaining=-1)
    if version == "v20":
        fields.update(charge_state=5, fault_bitmask=1)
    assert receive(mav.MAVLink_battery_status_message(**fields))
    expected = "warning" if version == "v20" else "unknown"
    assert snapshot(mapper)["health"]["status"] == expected


def test_primary_battery_measured_zero_is_not_confused_with_unknown_sentinel(vehicle):
    mapper, _ = vehicle
    assert mapper.accept(message("BATTERY_STATUS", id=0, voltages=[0] + [65535] * 9,
                                 voltages_ext=[0] * 4), now=NOW)
    assert snapshot(mapper)["health"]["battery_voltage_v"] == 0
    assert mapper.accept(message("BATTERY_STATUS", id=0, voltages=[65535] * 10,
                                 voltages_ext=[0] * 4), now=NOW)
    assert snapshot(mapper)["health"]["battery_voltage_v"] is None


def test_duplicate_boot_timestamp_does_not_refresh_sensor_age(vehicle):
    mapper, beat = vehicle
    assert mapper.accept(message("ATTITUDE", time_boot_ms=1000, roll=1, pitch=2, yaw=3), now=NOW)
    assert not mapper.accept(message("ATTITUDE", time_boot_ms=1000, roll=9, pitch=9, yaw=9), now=NOW + 1)
    assert snapshot(mapper, NOW + 1)["attitude"] == {
        "roll_rad": 1, "pitch_rad": 2, "yaw_rad": 3, "age_seconds": 1}
    assert beat(4, NOW + 3)
    assert not mapper.accept(message("ATTITUDE", time_boot_ms=1000, roll=1, pitch=2, yaw=3), now=NOW + 3)
    assert "attitude" not in snapshot(mapper, NOW + 3)
    assert mapper.accept(message("ATTITUDE", time_boot_ms=1010, roll=4, pitch=5, yaw=6), now=NOW + 3)
    assert snapshot(mapper, NOW + 3)["attitude"]["age_seconds"] == 0


def test_battery_observation_age_tracks_actual_selected_source(vehicle):
    mapper, beat = vehicle
    assert mapper.accept(message("SYS_STATUS", voltage_battery=12000), now=NOW)
    assert mapper.accept(message("BATTERY_STATUS", id=0, voltages=[11000]), now=NOW + 1)
    assert beat(4, NOW + 1)
    sample = snapshot(mapper, NOW + 1.5)
    assert sample["observation"] == {"heartbeat_timeout_seconds": 5,
                                      "field_timeout_seconds": 2,
                                      "battery_age_seconds": 0.5,
                                      "system_status_age_seconds": 1.5}
    assert sample["health"]["battery_voltage_v"] == 11
    assert mapper.accept(message("SYS_STATUS", voltage_battery=13000), now=NOW + 3.1)
    assert beat(4, NOW + 3.1)
    sample = snapshot(mapper, NOW + 3.1)
    assert sample["observation"]["battery_age_seconds"] == 0
    assert sample["health"]["battery_voltage_v"] == 13


@pytest.mark.parametrize("boot", [1.0, "1", True, -1, 2**32])
def test_malformed_boot_clock_cannot_refresh_valid_observation(vehicle, boot):
    mapper, _ = vehicle
    assert mapper.accept(message("ATTITUDE", time_boot_ms=1000, roll=1, pitch=2, yaw=3), now=NOW)
    assert not mapper.accept(message("ATTITUDE", time_boot_ms=boot, roll=4, pitch=5, yaw=6), now=NOW + 1)
    assert snapshot(mapper, NOW + 1)["attitude"]["age_seconds"] == 1
    assert snapshot(mapper, NOW + 1)["attitude"]["roll_rad"] == 1
