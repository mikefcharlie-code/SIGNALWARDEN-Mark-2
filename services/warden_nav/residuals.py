"""Coordinate-minimizing navigation residual features for Warden-NAV.

Coordinates are projected to a local WGS-84 ENU frame only in memory. Returned
objects contain scalar residuals and counts, never raw location fields.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
import math
from typing import Any

_A = 6_378_137.0
_E2 = 6.69437999014e-3


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


def _ecef(lat_deg: float, lon_deg: float, altitude_m: float) -> tuple[float, float, float]:
    lat, lon = math.radians(lat_deg), math.radians(lon_deg)
    sin_lat, cos_lat = math.sin(lat), math.cos(lat)
    radius = _A / math.sqrt(1 - _E2 * sin_lat * sin_lat)
    return ((radius + altitude_m) * cos_lat * math.cos(lon),
            (radius + altitude_m) * cos_lat * math.sin(lon),
            (radius * (1 - _E2) + altitude_m) * sin_lat)


def _enu(lat_deg: float, lon_deg: float, altitude_m: float,
         origin: tuple[float, float, float, float, float, float]) -> tuple[float, float, float]:
    lat0, lon0, x0, y0, z0, _alt0 = origin
    x, y, z = _ecef(lat_deg, lon_deg, altitude_m)
    dx, dy, dz = x - x0, y - y0, z - z0
    lat, lon = math.radians(lat0), math.radians(lon0)
    east = -math.sin(lon) * dx + math.cos(lon) * dy
    north = -math.sin(lat) * math.cos(lon) * dx - math.sin(lat) * math.sin(lon) * dy + math.cos(lat) * dz
    up = math.cos(lat) * math.cos(lon) * dx + math.cos(lat) * math.sin(lon) * dy + math.sin(lat) * dz
    return east, north, up


def _wrap_degrees(value: float) -> float:
    return (value + 180.0) % 360.0 - 180.0


def compute_residuals(samples: Sequence[Mapping[str, Any]] | None) -> dict[str, Any]:
    rows: list[tuple[Mapping[str, Any], datetime, Mapping[str, Any], Mapping[str, Any], Mapping[str, Any]]] = []
    for item in samples or []:
        if not isinstance(item, Mapping):
            continue
        stamp = _stamp(item.get("timestamp"))
        pos = item.get("position") if isinstance(item.get("position"), Mapping) else {}
        gps = item.get("gps") if isinstance(item.get("gps"), Mapping) else {}
        attitude = item.get("attitude") if isinstance(item.get("attitude"), Mapping) else {}
        required = [pos.get("latitude_deg"), pos.get("longitude_deg"), pos.get("altitude_msl_m"),
                    pos.get("relative_altitude_m"), pos.get("vx_m_s"), pos.get("vy_m_s"), pos.get("vz_m_s")]
        if stamp is not None and all(_number(value) is not None for value in required):
            rows.append((item, stamp, pos, gps, attitude))
    rows.sort(key=lambda row: (row[1], row[0].get("sequence", -1)))
    if not rows:
        return {"sample_count": 0, "position_velocity_residual_m": {"5s": None, "15s": None, "30s": None},
                "vertical_velocity_residual_m_s": None, "msl_relative_offset_drift_m": None,
                "heading_yaw_residual_deg": None, "course_heading_residual_deg": None,
                "gps_position_age_divergence_s": None, "gps_fix_transition_count": 0,
                "satellite_count_max_step": None}

    first_pos = rows[0][2]
    lat0, lon0 = float(first_pos["latitude_deg"]), float(first_pos["longitude_deg"])
    x0, y0, z0 = _ecef(lat0, lon0, float(first_pos["altitude_msl_m"]))
    origin = (lat0, lon0, x0, y0, z0, float(first_pos["altitude_msl_m"]))
    projected = [(row, _enu(float(row[2]["latitude_deg"]), float(row[2]["longitude_deg"]), float(row[2]["altitude_msl_m"]), origin)) for row in rows]
    latest_item, latest_stamp, latest_pos, latest_gps, latest_att = rows[-1]

    velocity_residuals: dict[str, float | None] = {}
    end_seconds = latest_stamp.timestamp()
    for period in (5, 15, 30):
        eligible = [entry for entry in projected if entry[0][1].timestamp() <= end_seconds - period]
        if not eligible:
            velocity_residuals[f"{period}s"] = None
            continue
        start = eligible[-1]
        actual_dt = (latest_stamp - start[0][1]).total_seconds()
        if actual_dt < period * 0.5 or actual_dt > period * 1.5 or actual_dt <= 0:
            velocity_residuals[f"{period}s"] = None
            continue
        # vx/vy follow N/E order; integrate with trapezoidal source samples.
        segment = [entry for entry in projected if start[0][1] <= entry[0][1] <= latest_stamp]
        east_integral = north_integral = 0.0
        for left, right in zip(segment, segment[1:]):
            dt = (right[0][1] - left[0][1]).total_seconds()
            lvx, rvx = _number(left[0][2].get("vx_m_s")), _number(right[0][2].get("vx_m_s"))
            lvy, rvy = _number(left[0][2].get("vy_m_s")), _number(right[0][2].get("vy_m_s"))
            if dt <= 0 or None in (lvx, rvx, lvy, rvy):
                continue
            north_integral += (lvx + rvx) * 0.5 * dt
            east_integral += (lvy + rvy) * 0.5 * dt
        de = projected[-1][1][0] - start[1][0] - east_integral
        dn = projected[-1][1][1] - start[1][1] - north_integral
        velocity_residuals[f"{period}s"] = math.hypot(de, dn)

    total_dt = (latest_stamp - rows[0][1]).total_seconds()
    vertical_residual = None
    offset_drift = None
    if total_dt > 0:
        start_pos = rows[0][2]
        avg_vz = sum(float(row[2]["vz_m_s"]) for row in rows) / len(rows)
        vertical_residual = (float(latest_pos["relative_altitude_m"]) - float(start_pos["relative_altitude_m"])) / total_dt + avg_vz
        start_offset = float(start_pos["altitude_msl_m"]) - float(start_pos["relative_altitude_m"])
        end_offset = float(latest_pos["altitude_msl_m"]) - float(latest_pos["relative_altitude_m"])
        offset_drift = end_offset - start_offset

    heading_yaw = course_heading = None
    heading = _number(latest_pos.get("heading_deg"))
    yaw = _number(latest_att.get("yaw_rad"))
    if heading is not None and yaw is not None:
        heading_yaw = _wrap_degrees(heading - math.degrees(yaw))
    vx, vy = _number(latest_pos.get("vx_m_s")), _number(latest_pos.get("vy_m_s"))
    if heading is not None and vx is not None and vy is not None and math.hypot(vx, vy) > 3.0:
        course_heading = _wrap_degrees(math.degrees(math.atan2(vy, vx)) % 360.0 - heading)

    gps_age, pos_age = _number(latest_gps.get("age_seconds")), _number(latest_pos.get("age_seconds"))
    fix_values = [_number(row[3].get("fix_type")) for row in rows]
    fix_transitions = sum(1 for left, right in zip(fix_values, fix_values[1:]) if left is not None and right is not None and left != right)
    sat_values = [_number(row[3].get("satellites_visible")) for row in rows]
    sat_steps = [abs(right - left) for left, right in zip(sat_values, sat_values[1:]) if left is not None and right is not None]
    return {
        "sample_count": len(rows),
        "position_velocity_residual_m": velocity_residuals,
        "vertical_velocity_residual_m_s": vertical_residual,
        "msl_relative_offset_drift_m": offset_drift,
        "heading_yaw_residual_deg": heading_yaw,
        "course_heading_residual_deg": course_heading,
        "gps_position_age_divergence_s": abs(gps_age - pos_age) if gps_age is not None and pos_age is not None else None,
        "gps_fix_transition_count": fix_transitions,
        "satellite_count_max_step": max(sat_steps) if sat_steps else None,
    }


__all__ = ["compute_residuals"]
