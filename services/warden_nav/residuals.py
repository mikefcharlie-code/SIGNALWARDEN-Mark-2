"""Deterministic Warden-NAV residuals with coordinate-minimizing output.

Latitude/longitude are projected into a temporary window-relative ENU frame and
are never returned, logged, or included in evidence. These residuals describe
internal telemetry agreement only; they do not correct or replace navigation.
"""
from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
import math
from typing import Any

_A = 6_378_137.0
_E2 = 6.69437999014e-3
_FRESH_AGE_SECONDS = 2.0


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        result = float(value)
    except (OverflowError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _stamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.endswith("Z"):
        return None
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
        return parsed.astimezone(timezone.utc) if parsed.tzinfo else None
    except (ValueError, OverflowError):
        return None


def _get(item: Mapping[str, Any], dotted: str) -> Any:
    value: Any = item
    for part in dotted.split("."):
        value = value.get(part) if isinstance(value, Mapping) else None
    return value


def _ecef(lat_deg: float, lon_deg: float, altitude_m: float) -> tuple[float, float, float]:
    lat, lon = math.radians(lat_deg), math.radians(lon_deg)
    sin_lat, cos_lat = math.sin(lat), math.cos(lat)
    radius = _A / math.sqrt(1.0 - _E2 * sin_lat * sin_lat)
    return ((radius + altitude_m) * cos_lat * math.cos(lon),
            (radius + altitude_m) * cos_lat * math.sin(lon),
            (radius * (1.0 - _E2) + altitude_m) * sin_lat)


def _enu(lat_deg: float, lon_deg: float, altitude_m: float,
         origin: tuple[float, float, float, float, float]) -> tuple[float, float, float]:
    lat0, lon0, x0, y0, z0 = origin
    x, y, z = _ecef(lat_deg, lon_deg, altitude_m)
    dx, dy, dz = x - x0, y - y0, z - z0
    lat, lon = math.radians(lat0), math.radians(lon0)
    east = -math.sin(lon) * dx + math.cos(lon) * dy
    north = -math.sin(lat) * math.cos(lon) * dx - math.sin(lat) * math.sin(lon) * dy + math.cos(lat) * dz
    up = math.cos(lat) * math.cos(lon) * dx + math.cos(lat) * math.sin(lon) * dy + math.sin(lat) * dz
    return east, north, up


def _wrap_degrees(value: float) -> float:
    return (value + 180.0) % 360.0 - 180.0


def _valid_rows(samples: Sequence[Mapping[str, Any]] | None) -> tuple[list[dict[str, Any]], int, int]:
    raw: list[tuple[Mapping[str, Any], datetime]] = []
    for item in samples or []:
        if not isinstance(item, Mapping):
            continue
        stamp = _stamp(item.get("timestamp"))
        if stamp is not None:
            raw.append((item, stamp))
    raw.sort(key=lambda row: (row[1], _number(row[0].get("sequence")) or -1))
    duplicate_timestamps = sum(count - 1 for count in Counter(stamp for _, stamp in raw).values() if count > 1)
    sequence_replays = 0
    prior_sequence: float | None = None
    for item, _ in raw:
        sequence = _number(item.get("sequence"))
        if sequence is not None and prior_sequence is not None and sequence <= prior_sequence:
            sequence_replays += 1
        if sequence is not None:
            prior_sequence = sequence
    by_stamp: dict[datetime, Mapping[str, Any]] = {}
    for item, stamp in raw:
        by_stamp[stamp] = item
    unique = [(stamp, item) for stamp, item in sorted(by_stamp.items())]
    if unique:
        end = unique[-1][0]
        start = end - timedelta(seconds=120)
        unique = [(stamp, item) for stamp, item in unique if start <= stamp <= end]
    rows = [{"item": item, "stamp": stamp,
             "position": item.get("position") if isinstance(item.get("position"), Mapping) else {},
             "gps": item.get("gps") if isinstance(item.get("gps"), Mapping) else {},
             "attitude": item.get("attitude") if isinstance(item.get("attitude"), Mapping) else {}}
            for stamp, item in unique]
    return rows, duplicate_timestamps, sequence_replays


def _position_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    valid = []
    for row in rows:
        pos = row["position"]
        lat, lon, msl = (_number(pos.get(key)) for key in ("latitude_deg", "longitude_deg", "altitude_msl_m"))
        if None not in (lat, lon, msl) and -90 <= lat <= 90 and -180 <= lon <= 180:
            valid.append({**row, "lat": lat, "lon": lon, "msl": msl})
    if not valid:
        return []
    first = valid[0]
    x0, y0, z0 = _ecef(first["lat"], first["lon"], first["msl"])
    origin = (first["lat"], first["lon"], x0, y0, z0)
    for row in valid:
        row["enu"] = _enu(row["lat"], row["lon"], row["msl"], origin)
    return valid


def _velocity_residual(position_rows: list[dict[str, Any]], end_index: int, period: float) -> float | None:
    end = position_rows[end_index]
    target = end["stamp"] - timedelta(seconds=period)
    candidates = [index for index, row in enumerate(position_rows[:end_index]) if row["stamp"] <= target]
    if not candidates:
        return None
    start_index = candidates[-1]
    start, finish = position_rows[start_index], end
    elapsed = (finish["stamp"] - start["stamp"]).total_seconds()
    if elapsed <= 0 or elapsed < period * 0.5 or elapsed > period * 1.5:
        return None
    segment = position_rows[start_index:end_index + 1]
    east_integral = north_integral = 0.0
    for left, right in zip(segment, segment[1:]):
        dt = (right["stamp"] - left["stamp"]).total_seconds()
        if dt <= 0 or dt > 1.5:
            return None
        lvx, rvx = _number(left["position"].get("vx_m_s")), _number(right["position"].get("vx_m_s"))
        lvy, rvy = _number(left["position"].get("vy_m_s")), _number(right["position"].get("vy_m_s"))
        if None in (lvx, rvx, lvy, rvy):
            return None
        north_integral += (lvx + rvx) * 0.5 * dt
        east_integral += (lvy + rvy) * 0.5 * dt
    actual_east = finish["enu"][0] - start["enu"][0]
    actual_north = finish["enu"][1] - start["enu"][1]
    return math.hypot(actual_east - east_integral, actual_north - north_integral)


def _age(value: Any) -> float | None:
    age = _number(value)
    return age if age is not None and age >= 0 else None


def _gps_stuck(rows: list[dict[str, Any]], positions: list[dict[str, Any]]) -> tuple[bool, float]:
    if len(rows) < 2 or not positions:
        return False, 0.0
    run_start = len(rows) - 1
    latest = rows[-1]
    key = (_number(latest["gps"].get("fix_type")), _number(latest["gps"].get("satellites_visible")))
    latest_age = _age(latest["gps"].get("age_seconds"))
    if None in key or latest_age is None or latest_age > _FRESH_AGE_SECONDS:
        return False, 0.0
    while run_start > 0:
        prior = rows[run_start - 1]
        prior_key = (_number(prior["gps"].get("fix_type")), _number(prior["gps"].get("satellites_visible")))
        prior_age = _age(prior["gps"].get("age_seconds"))
        if prior_key != key or prior_age is None or prior_age > _FRESH_AGE_SECONDS:
            break
        run_start -= 1
    duration = (rows[-1]["stamp"] - rows[run_start]["stamp"]).total_seconds()
    start_stamp = rows[run_start]["stamp"]
    moved = [position for position in positions if position["stamp"] >= start_stamp]
    distance = math.hypot(moved[-1]["enu"][0] - moved[0]["enu"][0], moved[-1]["enu"][1] - moved[0]["enu"][1]) if len(moved) > 1 else 0.0
    return duration >= 30.0 and distance >= 5.0, duration


def compute_residuals(samples: Sequence[Mapping[str, Any]] | None, *, airframe_class: str | None = None) -> dict[str, Any]:
    """Return deterministic navigation residuals and scalar traces, never coordinates."""
    rows, duplicate_timestamps, sequence_replays = _valid_rows(samples)
    positions = _position_rows(rows)
    if not rows or not positions:
        return {
            "sample_count": len(rows), "position_sample_count": len(positions),
            "position_velocity_residual_m": {"5s": None, "15s": None, "30s": None},
            "vertical_velocity_residual_m_s": None, "msl_relative_offset_drift_m": None,
            "heading_yaw_residual_deg": None, "course_heading_residual_deg": None,
            "gps_position_age_divergence_s": None, "gps_fix_transition_count": 0,
            "gps_fix_satellite_mismatch_count": 0, "satellite_count_max_step": None,
            "gps_receiver_stuck_fresh": False, "gps_frozen_fresh_seconds": 0.0,
            "duplicate_timestamp_count": duplicate_timestamps, "sequence_replay_count": sequence_replays,
            "latest_ages_seconds": {"gps": None, "position": None, "attitude": None}, "traces": [],
        }
    latest = rows[-1]
    latest_position = positions[-1]
    latest_stamp = latest["stamp"]
    position_residual = {f"{period}s": _velocity_residual(positions, len(positions) - 1, float(period))
                         for period in (5, 15, 30)}
    vertical_residual = None
    target = latest_stamp - timedelta(seconds=5)
    vertical_starts = [row for row in rows if row["stamp"] <= target and _number(row["position"].get("relative_altitude_m")) is not None]
    vertical_ends = [row for row in rows if _number(row["position"].get("relative_altitude_m")) is not None]
    if vertical_starts and vertical_ends:
        start_row, end_row = vertical_starts[-1], vertical_ends[-1]
        dt = (end_row["stamp"] - start_row["stamp"]).total_seconds()
        velocities = [_number(row["position"].get("vz_m_s")) for row in rows if start_row["stamp"] <= row["stamp"] <= end_row["stamp"]]
        velocities = [value for value in velocities if value is not None]
        if dt > 0 and velocities:
            rate = (_number(end_row["position"].get("relative_altitude_m")) - _number(start_row["position"].get("relative_altitude_m"))) / dt
            vertical_residual = rate + sum(velocities) / len(velocities)  # NED convention: vz positive down.
    first_position = positions[0]
    start_offset = first_position["msl"] - (_number(first_position["position"].get("relative_altitude_m")) or 0.0)
    end_offset = latest_position["msl"] - (_number(latest_position["position"].get("relative_altitude_m")) or 0.0)
    offset_drift = end_offset - start_offset
    heading = _number(latest_position["position"].get("heading_deg"))
    yaw = _number(latest["attitude"].get("yaw_rad"))
    heading_yaw = _wrap_degrees(heading - math.degrees(yaw)) if heading is not None and yaw is not None else None
    vx, vy = (_number(latest_position["position"].get(key)) for key in ("vx_m_s", "vy_m_s"))
    speed = math.hypot(vx, vy) if vx is not None and vy is not None else None
    known_airframe = airframe_class in {"multicopter-light", "multicopter-heavy", "fixed-wing-lab"}
    course_heading = _wrap_degrees(math.degrees(math.atan2(vy, vx)) - heading) if heading is not None and vx is not None and vy is not None and speed is not None and speed > 3.0 and known_airframe else None
    gps_age = _age(latest["gps"].get("age_seconds"))
    position_age = _age(latest_position["position"].get("age_seconds"))
    attitude_age = _age(latest["attitude"].get("age_seconds"))
    fix_values = [_number(row["gps"].get("fix_type")) for row in rows]
    sat_values = [_number(row["gps"].get("satellites_visible")) for row in rows]
    fix_transitions = sum(1 for left, right in zip(fix_values, fix_values[1:]) if left is not None and right is not None and left != right)
    sat_steps = [abs(right - left) for left, right in zip(sat_values, sat_values[1:]) if left is not None and right is not None]
    mismatch_count = sum(1 for fix, sats in zip(fix_values, sat_values) if fix is not None and sats is not None and ((sats >= 6 and fix < 3) or (fix >= 3 and sats < 4)))
    gps_stuck, frozen_seconds = _gps_stuck(rows, positions)
    traces = []
    for row in rows:
        position_index = next((i for i in range(len(positions) - 1, -1, -1) if positions[i]["stamp"] == row["stamp"]), None)
        trace_residuals = ({period: _velocity_residual(positions, position_index, period)
                            for period in (5.0, 15.0, 30.0)} if position_index is not None else {})
        trace_heading = _number(row["position"].get("heading_deg"))
        trace_yaw = _number(row["attitude"].get("yaw_rad"))
        trace_heading_yaw = _wrap_degrees(trace_heading - math.degrees(trace_yaw)) if trace_heading is not None and trace_yaw is not None else None
        trace_vx, trace_vy = (_number(row["position"].get(key)) for key in ("vx_m_s", "vy_m_s"))
        trace_vz = _number(row["position"].get("vz_m_s"))
        sequence = _number(row["item"].get("sequence"))
        traces.append({
            "timestamp": row["stamp"].isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "sequence": int(sequence) if sequence is not None and sequence.is_integer() else None,
            "position_velocity_residual_5s_m": trace_residuals.get(5.0),
            "position_velocity_residual_15s_m": trace_residuals.get(15.0),
            "position_velocity_residual_30s_m": trace_residuals.get(30.0),
            "heading_yaw_residual_deg": trace_heading_yaw,
            "gps_age_seconds": _age(row["gps"].get("age_seconds")),
            "position_age_seconds": _age(row["position"].get("age_seconds")),
            "gps_fix_type": _number(row["gps"].get("fix_type")),
            "gps_satellites_visible": _number(row["gps"].get("satellites_visible")),
            "ground_speed_m_s": math.hypot(trace_vx, trace_vy) if trace_vx is not None and trace_vy is not None else None,
            "vertical_speed_m_s": trace_vz,
        })
    return {
        "sample_count": len(rows), "position_sample_count": len(positions),
        "position_velocity_residual_m": position_residual,
        "vertical_velocity_residual_m_s": vertical_residual,
        "msl_relative_offset_drift_m": offset_drift,
        "heading_yaw_residual_deg": heading_yaw,
        "course_heading_residual_deg": course_heading,
        "ground_speed_m_s": speed,
        "gps_position_age_divergence_s": abs(gps_age - position_age) if gps_age is not None and position_age is not None else None,
        "gps_fix_transition_count": fix_transitions,
        "gps_fix_satellite_mismatch_count": mismatch_count,
        "satellite_count_max_step": max(sat_steps) if sat_steps else None,
        "gps_receiver_stuck_fresh": gps_stuck,
        "gps_frozen_fresh_seconds": frozen_seconds,
        "duplicate_timestamp_count": duplicate_timestamps,
        "sequence_replay_count": sequence_replays,
        "latest_ages_seconds": {"gps": gps_age, "position": position_age, "attitude": attitude_age},
        "traces": traces,
    }


__all__ = ["compute_residuals"]
