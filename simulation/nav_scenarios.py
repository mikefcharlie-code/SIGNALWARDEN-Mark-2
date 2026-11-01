"""Seeded synthetic-only navigation-integrity scenarios for development.

The randomized origin is deliberately ephemeral. Consumers must derive
window-relative scalar residuals and must not persist or display coordinates.
No field data or external model/provider is used here.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import math
import random
from typing import Any

SCENARIO_LABELS = {
    "nominal": "nominal",
    "hard_negative_maneuver": "nominal",
    "jamming_like": "jamming_like_pattern",
    "spoofing_drag": "spoofing_like_pattern",
    "spoofing_jump": "spoofing_like_pattern",
    "replay_like": "spoofing_like_pattern",
    "estimator_reset": "sensor_estimator_glitch",
    "compass_glitch": "sensor_estimator_glitch",
    "baro_drift": "sensor_estimator_glitch",
    "stuck_gnss": "sensor_estimator_glitch",
    "low_presence": "abstain",
    "stale": "abstain",
    "untrusted_ingress": "untrusted_ingress",
}
SCENARIOS = tuple(SCENARIO_LABELS)
_START = datetime(2026, 1, 1, tzinfo=timezone.utc)
_KNOWN_AIRFRAMES = {"multicopter-light", "multicopter-heavy", "fixed-wing-lab"}


def _iso(stamp: datetime) -> str:
    return stamp.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _lat_lon(origin_lat: float, origin_lon: float, north_m: float, east_m: float) -> tuple[float, float]:
    lat = origin_lat + north_m / 111_132.0
    scale = max(0.12, math.cos(math.radians(origin_lat)))
    lon = origin_lon + east_m / (111_320.0 * scale)
    return lat, ((lon + 180.0) % 360.0) - 180.0


def generate_window(scenario: str = "nominal", *, seed: int = 0,
                    trust: str = "signature-verified",
                    airframe_class: str | None = "multicopter-light",
                    start: datetime | str | None = None) -> list[dict[str, Any]]:
    """Create exactly 240 synthetic samples spanning a fixed 120-second window."""
    if scenario not in SCENARIO_LABELS:
        raise ValueError(f"unknown Warden-NAV scenario: {scenario}")
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 1_000_000:
        raise ValueError("seed must be an integer from 0 to 1000000")
    if trust not in {"signature-verified", "transport-asserted", "untrusted", "unknown"}:
        raise ValueError("trust must be signature-verified, transport-asserted, untrusted, or unknown")
    if airframe_class is not None and airframe_class not in _KNOWN_AIRFRAMES:
        raise ValueError("airframe_class must be a known class or None")
    if start is None:
        start_dt = _START
    elif isinstance(start, datetime):
        if start.tzinfo is None:
            raise ValueError("start must be timezone-aware")
        start_dt = start.astimezone(timezone.utc)
    elif isinstance(start, str) and start.endswith("Z"):
        try:
            start_dt = datetime.fromisoformat(start[:-1] + "+00:00").astimezone(timezone.utc)
        except ValueError as error:
            raise ValueError("start must be an ISO-8601 UTC timestamp ending in Z") from error
    else:
        raise ValueError("start must be an ISO-8601 UTC timestamp ending in Z")

    rng = random.Random(seed)
    origin_lat = rng.uniform(-62.0, 62.0)
    origin_lon = rng.uniform(-179.0, 179.0)
    onset = 120
    base_speed = 2.0 if airframe_class != "fixed-wing-lab" else 8.0
    if scenario == "hard_negative_maneuver":
        base_speed = 5.5
    north = east = 0.0
    rows: list[dict[str, Any]] = []
    for index in range(240):
        t = index * 0.5
        yaw = 0.35
        speed = base_speed
        if scenario == "hard_negative_maneuver":
            yaw += 0.25 * math.sin(t / 6.0)
            speed += 0.5 * math.sin(t / 8.0)
        elif scenario == "nominal":
            yaw += 0.015 * math.sin(t / 15.0)
            speed += 0.04 * math.sin(t / 11.0)
        elif scenario == "replay_like" and index >= onset:
            elapsed = t - onset * 0.5
            yaw += 0.30 * math.sin(elapsed / 5.0)
            speed += 1.1 * math.sin(elapsed / 4.0)
        sensor_yaw = yaw
        vx, vy = speed * math.cos(yaw), speed * math.sin(yaw)
        north += vx * 0.5
        east += vy * 0.5
        lat, lon = _lat_lon(origin_lat, origin_lon, north, east)
        msl, relative = 100.0, 20.0
        gps_age = position_age = attitude_age = round(0.08 + rng.random() * 0.12, 4)
        sat = 10 + rng.choice((-1, 0, 0, 0, 1))
        fix = 3
        position_lat, position_lon = lat, lon
        if scenario == "hard_negative_maneuver":
            # Small, zero-mean multipath-like perturbations remain below the
            # deterministic alert thresholds and should be treated as a hard negative.
            position_lat, position_lon = _lat_lon(origin_lat, origin_lon, north + rng.uniform(-0.8, 0.8), east + rng.uniform(-0.8, 0.8))
        if scenario == "jamming_like" and index >= onset:
            elapsed = t - onset * 0.5
            fix = 2 if elapsed < 12 else 0
            sat = max(0, 7 - int(elapsed / 8))
            gps_age = min(18.0, 0.2 + elapsed * 0.32)
            if elapsed >= 24:
                position_lat, position_lon = rows[onset - 1]["position"]["latitude_deg"], rows[onset - 1]["position"]["longitude_deg"]
                position_age = min(18.0, 0.2 + elapsed * 0.32)
        elif scenario == "spoofing_drag" and index >= onset:
            elapsed = t - onset * 0.5
            position_lat, position_lon = _lat_lon(origin_lat, origin_lon, north + elapsed * 0.65, east - elapsed * 0.22)
        elif scenario == "spoofing_jump" and index >= onset:
            position_lat, position_lon = _lat_lon(origin_lat, origin_lon, north + 28.0, east - 11.0)
        elif scenario == "replay_like" and index >= onset + 4:
            delayed = rows[index - 4]["position"]
            position_lat, position_lon = delayed["latitude_deg"], delayed["longitude_deg"]
        elif scenario == "estimator_reset" and index == onset:
            position_lat, position_lon = _lat_lon(origin_lat, origin_lon, north + 22.0, east)
        elif scenario == "compass_glitch" and index >= onset:
            sensor_yaw += math.radians(70.0) * math.sin((index - onset) / 6.0)
        elif scenario == "baro_drift" and index >= onset:
            relative += 0.40 * (t - onset * 0.5)
        elif scenario == "stuck_gnss" and index >= onset:
            sat, fix = rows[onset - 1]["gps"]["satellites_visible"], rows[onset - 1]["gps"]["fix_type"]
        elif scenario == "stale" and index >= 210:
            gps_age = position_age = attitude_age = 8.0
        if scenario == "jamming_like" and index >= onset and position_age > 2.0:
            # Do not fabricate a receiver measurement after the hold begins.
            pass
        if scenario == "baro_drift" and index >= onset:
            msl = 100.0
        sequence = index - 4 if scenario == "replay_like" and index >= onset + 4 else index
        if scenario == "low_presence":
            # Deliberately sparse telemetry: no position/GPS/attitude fields in most slots.
            include_nav = index % 5 == 0
        else:
            include_nav = True
        nav_trust = "untrusted" if scenario == "untrusted_ingress" else trust
        row: dict[str, Any] = {
            "schema_version": "1.1", "aircraft_id": "sim-ucas-nav-001",
            "timestamp": _iso(start_dt + timedelta(seconds=t)), "received_at": _iso(start_dt + timedelta(seconds=t)),
            "sequence": sequence, "source": "simulated",
            "position": {
                "latitude_deg": position_lat, "longitude_deg": position_lon,
                "altitude_msl_m": msl, "relative_altitude_m": relative,
                "vx_m_s": vx, "vy_m_s": vy, "vz_m_s": 0.0,
                "heading_deg": math.degrees(yaw) % 360.0, "age_seconds": position_age,
            },
            "attitude": {"roll_rad": 0.01 * math.sin(t / 3.0), "pitch_rad": 0.01 * math.cos(t / 4.0),
                         "yaw_rad": sensor_yaw, "age_seconds": attitude_age},
            "gps": {"fix_type": fix, "satellites_visible": sat, "age_seconds": gps_age},
            "autopilot": {"family": "px4", "system_id": 1, "component_id": 1, "vehicle_type": 2,
                          "armed": True, "base_mode": 128, "custom_mode": 4,
                          "system_status": 4, "heartbeat_age_seconds": 0.1},
            "ingress_security": {"policy": "required-signed", "telemetry_trust": nav_trust,
                                 "flight_ready": False, "counters": {}},
            "synthetic_only": True,
        }
        if not include_nav:
            row.pop("position", None); row.pop("gps", None); row.pop("attitude", None)
        rows.append(row)
    return rows


def scenario_label(scenario: str) -> str:
    if scenario not in SCENARIO_LABELS:
        raise ValueError(f"unknown Warden-NAV scenario: {scenario}")
    return SCENARIO_LABELS[scenario]


__all__ = ["SCENARIOS", "SCENARIO_LABELS", "generate_window", "scenario_label"]
