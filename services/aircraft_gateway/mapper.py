"""Receive-only MAVLink common-message mapping. No flight-control authority.

All timestamps are gateway observation times, not synchronized aircraft time.
Unknown/stale measurements are never replaced with plausible numeric defaults.
"""
from __future__ import annotations

import math
import re
import time
import uuid
from datetime import datetime, timezone

AUTOPILOTS = {"px4": 12, "ardupilot": 3}
IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


def number(value, minimum=None, maximum=None):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value):
        return None
    if minimum is not None and value < minimum:
        return None
    if maximum is not None and value > maximum:
        return None
    return value


class TelemetryMapper:
    """One explicitly identified aircraft/component per mapper; never auto-select."""

    def __init__(self, aircraft_id, autopilot, system_id, component_id=1,
                 source="simulated", heartbeat_timeout=5.0, field_timeout=5.0,
                 battery_id=0):
        if not isinstance(aircraft_id, str) or not IDENTIFIER.fullmatch(aircraft_id):
            raise ValueError("invalid aircraft_id")
        if autopilot not in AUTOPILOTS or source not in {"simulated", "aircraft"}:
            raise ValueError("explicit supported autopilot and source are required")
        for value in (system_id, component_id):
            if type(value) is not int or not 1 <= value <= 255:
                raise ValueError("system/component IDs must be integers from 1 to 255")
        for value in (heartbeat_timeout, field_timeout):
            if number(value, 0) is None or value == 0:
                raise ValueError("timeouts must be finite positive numbers")
        if type(battery_id) is not int or not 0 <= battery_id <= 255:
            raise ValueError("battery_id must be an integer from 0 to 255")
        self.aircraft_id, self.autopilot, self.source = aircraft_id, autopilot, source
        self.system_id, self.component_id = system_id, component_id
        self.heartbeat_timeout, self.field_timeout = heartbeat_timeout, field_timeout
        self.battery_id = battery_id
        self._heartbeat = None
        self._messages = {}
        self._sequence = 0
        self.session_id = uuid.uuid4().hex

    def accept(self, message, now=None):
        now = time.monotonic() if now is None else now
        if (message.get_srcSystem(), message.get_srcComponent()) != (self.system_id, self.component_id):
            return False
        kind = message.get_type()
        if kind == "HEARTBEAT":
            if getattr(message, "autopilot", None) != AUTOPILOTS[self.autopilot]:
                self._heartbeat = None
                self._messages.clear()
                return False
            bounds = {"type": 255, "base_mode": 255,
                      "custom_mode": 4294967295, "system_status": 255}
            if any(type(getattr(message, key, None)) is not int
                   or not 0 <= getattr(message, key) <= maximum
                   for key, maximum in bounds.items()):
                self._heartbeat = None
                self._messages.clear()
                return False
            if self._heartbeat is None or now - self._heartbeat[1] > self.heartbeat_timeout:
                self._messages.clear()
                self.session_id = uuid.uuid4().hex
            self._heartbeat = (message, now)
            return True
        if self._heartbeat is None or now - self._heartbeat[1] > self.heartbeat_timeout:
            return False
        if kind not in {"SYS_STATUS", "BATTERY_STATUS", "GLOBAL_POSITION_INT", "ATTITUDE", "GPS_RAW_INT"}:
            return False
        if kind == "BATTERY_STATUS" and getattr(message, "id", None) != self.battery_id:
            return False
        # A backwards boot clock is conservatively treated as a reboot/out-of-order
        # boundary: discard cached sensors, never splice two vehicle sessions.
        previous = self._messages.get(kind)
        boot = getattr(message, "time_boot_ms", None)
        old_boot = getattr(previous[0], "time_boot_ms", None) if previous else None
        if boot is not None and (type(boot) is not int or not 0 <= boot <= 4294967295):
            return False
        if type(boot) is int and type(old_boot) is int and boot == old_boot:
            # Duplicate/replayed measurement: retain the original observation
            # age, rather than making unchanged aircraft time fresh again.
            return False
        if isinstance(boot, int) and isinstance(old_boot, int) and boot < old_boot:
            self._messages.clear()
            self._heartbeat = None
            return False
        self._messages[kind] = (message, now)
        return True

    def _fresh(self, kind, now):
        entry = self._messages.get(kind)
        if entry is None or not 0 <= now - entry[1] <= self.field_timeout:
            return None
        return entry[0], round(now - entry[1], 3)

    def snapshot(self, now=None, timestamp=None):
        now = time.monotonic() if now is None else now
        if self._heartbeat is None or not 0 <= now - self._heartbeat[1] <= self.heartbeat_timeout:
            return None
        heartbeat, heartbeat_at = self._heartbeat
        stamp = timestamp or datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")
        health = {"battery_voltage_v": None, "battery_percent": None,
                  "link_quality_percent": None, "status": "unknown"}
        # MAV_STATE CRITICAL, EMERGENCY, POWEROFF and FLIGHT_TERMINATION.
        # Normal/active heartbeat is not evidence of overall aircraft health.
        if heartbeat.system_status in {5, 6, 7, 8}:
            health["status"] = "warning"
        sample = {"schema_version": "1.1", "session_id": self.session_id, "aircraft_id": self.aircraft_id,
                  "timestamp": stamp, "received_at": stamp, "sequence": self._sequence,
                  "source": self.source, "health": health,
                  "observation": {"heartbeat_timeout_seconds": self.heartbeat_timeout,
                                  "field_timeout_seconds": self.field_timeout,
                                  "battery_age_seconds": None,
                                  "system_status_age_seconds": None},
                  "autopilot": {"family": self.autopilot, "system_id": self.system_id,
                                "component_id": self.component_id,
                                "vehicle_type": heartbeat.type,
                                "armed": bool(heartbeat.base_mode & 128),
                                "base_mode": heartbeat.base_mode,
                                "custom_mode": heartbeat.custom_mode,
                                "system_status": heartbeat.system_status,
                                "heartbeat_age_seconds": round(now - heartbeat_at, 3)}}
        self._sequence += 1
        status = self._fresh("SYS_STATUS", now)
        if status:
            msg, age = status
            sample["observation"]["system_status_age_seconds"] = age
            # SYS_STATUS has no battery identity.  It is only a fallback for
            # the explicitly selected primary battery; never use it to
            # silently populate a selected non-primary battery.
            if self.battery_id == 0:
                sample["observation"]["battery_age_seconds"] = age
                voltage = number(getattr(msg, "voltage_battery", None), 0, 65534)
                health["battery_voltage_v"] = voltage / 1000 if voltage is not None else None
                health["battery_percent"] = number(getattr(msg, "battery_remaining", None), 0, 100)
            enabled = getattr(msg, "onboard_control_sensors_enabled", 0)
            healthy = getattr(msg, "onboard_control_sensors_health", 0)
            present = getattr(msg, "onboard_control_sensors_present", 0)
            if all(type(v) is int for v in (enabled, healthy, present)) and (enabled & present & ~healthy):
                health["status"] = "warning"
        battery = self._fresh("BATTERY_STATUS", now)
        if battery:
            msg, age = battery
            sample["observation"]["battery_age_seconds"] = age
            cells = getattr(msg, "voltages", [])
            ext = getattr(msg, "voltages_ext", [])
            valid = [v for v in cells if number(v, 0, 65534) is not None]
            valid.extend(v for v in ext if number(v, 1, 65534) is not None)
            health["battery_voltage_v"] = sum(valid) / 1000 if valid else None
            health["battery_percent"] = number(getattr(msg, "battery_remaining", None), 0, 100)
            temp = number(getattr(msg, "temperature", None), -32768, 32766)
            if temp is not None:
                health["temperature_c"] = temp / 100
            # Low/critical/emergency/failed/unhealthy are explicit reports,
            # not thresholds guessed from voltage or remaining percentage.
            charge_state = getattr(msg, "charge_state", None)
            faults = getattr(msg, "fault_bitmask", None)
            if (type(charge_state) is int and charge_state in {2, 3, 4, 5, 6}
                    or type(faults) is int and 0 < faults <= 4294967295):
                health["status"] = "warning"
        position = self._fresh("GLOBAL_POSITION_INT", now)
        if position:
            msg, age = position
            fields = {"latitude_deg": ("lat", 1e7, -900000000, 900000000),
                      "longitude_deg": ("lon", 1e7, -1800000000, 1800000000),
                      "altitude_msl_m": ("alt", 1000, None, None),
                      "relative_altitude_m": ("relative_alt", 1000, None, None),
                      "vx_m_s": ("vx", 100, None, None),
                      "vy_m_s": ("vy", 100, None, None),
                      "vz_m_s": ("vz", 100, None, None)}
            values = {key: number(getattr(msg, attr, None), low, high)
                      for key, (attr, _, low, high) in fields.items()}
            if all(v is not None for v in values.values()):
                sample["position"] = {key: value / fields[key][1] for key, value in values.items()}
                heading = number(getattr(msg, "hdg", None), 0, 35999)
                sample["position"].update(heading_deg=heading / 100 if heading is not None else None,
                                          age_seconds=age)
        attitude = self._fresh("ATTITUDE", now)
        if attitude:
            msg, age = attitude
            values = {f"{key}_rad": number(getattr(msg, key, None)) for key in ("roll", "pitch", "yaw")}
            if all(v is not None for v in values.values()):
                sample["attitude"] = dict(values, age_seconds=age)
        gps = self._fresh("GPS_RAW_INT", now)
        if gps:
            msg, age = gps
            fix = number(getattr(msg, "fix_type", None), 0, 8)
            if fix is not None:
                sample["gps"] = {"fix_type": fix,
                                 "satellites_visible": number(getattr(msg, "satellites_visible", None), 0, 254),
                                 "age_seconds": age}
        return sample
