"""Fixed-grid, coordinate-free Warden-NAV feature windowing.

Raw positions are accepted only to derive ephemeral residuals. This module's
returned window carries masks, ages, trust and sequence/time evidence, never
latitude, longitude, projected position, or a navigation solution.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
import math
from typing import Any

WINDOW_SECONDS = 120
SAMPLE_RATE_HZ = 2
WINDOW_STEPS = WINDOW_SECONDS * SAMPLE_RATE_HZ
STRIDE_SECONDS = 5
PRESENCE_THRESHOLD = 0.60
MAX_FRESH_AGE_SECONDS = 2.0

NAV_FIELDS = (
    "position.latitude_deg", "position.longitude_deg", "position.altitude_msl_m",
    "position.relative_altitude_m", "position.vx_m_s", "position.vy_m_s",
    "position.vz_m_s", "position.heading_deg", "position.age_seconds",
    "gps.fix_type", "gps.satellites_visible", "gps.age_seconds",
)
ATTITUDE_FIELDS = ("attitude.yaw_rad", "attitude.age_seconds")
MODE_FIELDS = ("autopilot.armed", "autopilot.custom_mode")
PRESENCE_FIELDS = NAV_FIELDS + ATTITUDE_FIELDS + MODE_FIELDS


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        result = float(value)
    except (OverflowError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _get(item: Mapping[str, Any], dotted: str) -> Any:
    value: Any = item
    for part in dotted.split("."):
        if not isinstance(value, Mapping):
            return None
        value = value.get(part)
    return value


def _mode_value(item: Mapping[str, Any] | None, field: str) -> bool | int | None:
    if item is None:
        return None
    value = _get(item, field)
    if field == "autopilot.armed":
        return value if isinstance(value, bool) else None
    number = _number(value)
    return int(number) if number is not None and number.is_integer() else None


def _mode_summary(selected: Sequence[Mapping[str, Any] | None]) -> dict[str, Any]:
    armed = [_mode_value(item, "autopilot.armed") for item in selected]
    modes = [_mode_value(item, "autopilot.custom_mode") for item in selected]

    def adjacent_changes(values: Sequence[bool | int | None]) -> int:
        return sum(left is not None and right is not None and left != right
                   for left, right in zip(values, values[1:]))

    present = sum(value is not None for value in armed) + sum(value is not None for value in modes)
    return {
        "autopilot_mode_presence_ratio": present / max(1, 2 * len(selected)),
        "armed_state_change_count": adjacent_changes(armed),
        "custom_mode_change_count": adjacent_changes(modes),
    }


def _timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.endswith("Z"):
        return None
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except (ValueError, OverflowError):
        return None
    return parsed.astimezone(timezone.utc) if parsed.tzinfo else None


def _trust(item: Mapping[str, Any]) -> str:
    security = item.get("ingress_security")
    declared = security.get("telemetry_trust") if isinstance(security, Mapping) else None
    if declared in {"signature-verified", "trusted"}:
        return "trusted"
    if declared == "untrusted":
        return "untrusted"
    return "unknown"


def _sample_age(item: Mapping[str, Any] | None) -> dict[str, float | None]:
    if item is None:
        return {"position": None, "gps": None, "attitude": None}
    return {
        "position": _number(_get(item, "position.age_seconds")),
        "gps": _number(_get(item, "gps.age_seconds")),
        "attitude": _number(_get(item, "attitude.age_seconds")),
    }


def _grid_samples(samples: Sequence[Mapping[str, Any]] | None, *, end: datetime | None = None
                  ) -> tuple[list[Mapping[str, Any] | None], list[datetime], list[Mapping[str, Any]]]:
    candidates = [item for item in (samples or []) if isinstance(item, Mapping)][-2400:]
    valid = [(item, _timestamp(item.get("timestamp"))) for item in candidates]
    valid = [(item, stamp) for item, stamp in valid if stamp is not None]
    valid.sort(key=lambda pair: (pair[1], _number(pair[0].get("sequence")) or -1))
    if end is None and valid:
        latest = valid[-1][1]
        end = datetime.fromtimestamp(round(latest.timestamp() * SAMPLE_RATE_HZ) / SAMPLE_RATE_HZ, timezone.utc)
    elif end is not None:
        if end.tzinfo is None:
            raise ValueError("window end must be timezone-aware")
        end = end.astimezone(timezone.utc)
        end = datetime.fromtimestamp(round(end.timestamp() * SAMPLE_RATE_HZ) / SAMPLE_RATE_HZ, timezone.utc)
    else:
        end = datetime(1970, 1, 1, tzinfo=timezone.utc)
    start = end - timedelta(seconds=(WINDOW_STEPS - 1) / SAMPLE_RATE_HZ)
    grid_stamps = [start + timedelta(seconds=index / SAMPLE_RATE_HZ) for index in range(WINDOW_STEPS)]
    selected: list[Mapping[str, Any] | None] = [None] * WINDOW_STEPS
    best_delta = [float("inf")] * WINDOW_STEPS
    for item, stamp in valid:
        index = round((stamp - start).total_seconds() * SAMPLE_RATE_HZ)
        if not 0 <= index < WINDOW_STEPS:
            continue
        delta = abs((stamp - grid_stamps[index]).total_seconds())
        if delta <= 0.25 and delta < best_delta[index]:
            selected[index], best_delta[index] = item, delta
    window_start, window_end = grid_stamps[0], grid_stamps[-1]
    in_window = [item for item, stamp in valid if window_start <= stamp <= window_end]
    return selected, grid_stamps, in_window


def build_window(samples: Sequence[Mapping[str, Any]] | None, *, end: datetime | None = None,
                 airframe_class: str | None = None) -> dict[str, Any]:
    """Resample to exactly 240 slots at 2 Hz; missing fields remain explicitly missing."""
    selected, stamps, in_window = _grid_samples(samples, end=end)
    rows = []
    present_cells = 0
    nav_present_cells = 0
    nav_possible = len(NAV_FIELDS) * WINDOW_STEPS
    all_possible = len(PRESENCE_FIELDS) * WINDOW_STEPS
    stale_cells = 0
    age_observations = 0
    for stamp, item in zip(stamps, selected):
        mask = {field: (_mode_value(item, field) is not None if field in MODE_FIELDS
                        else _number(_get(item, field)) is not None if item is not None else False)
                for field in PRESENCE_FIELDS}
        present_cells += sum(mask.values())
        nav_present_cells += sum(mask[field] for field in NAV_FIELDS)
        ages = _sample_age(item)
        for group, fields in (("position", [field for field in NAV_FIELDS if field.startswith("position.")]),
                              ("gps", [field for field in NAV_FIELDS if field.startswith("gps.")])):
            age = ages[group]
            for field in fields:
                if mask[field] and age is not None:
                    age_observations += 1
                    stale_cells += int(age > MAX_FRESH_AGE_SECONDS)
        sequence = _number(item.get("sequence")) if item is not None else None
        rows.append({
            "timestamp": stamp.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "sequence": int(sequence) if sequence is not None and sequence.is_integer() else None,
            "presence_mask": mask,
            "ages_seconds": ages,
            "trust": _trust(item) if item is not None else "unknown",
        })
    nav_ratio = nav_present_cells / nav_possible if nav_possible else 0.0
    all_ratio = present_cells / all_possible if all_possible else 0.0
    trust_values = [_trust(item) for item in in_window]
    if "untrusted" in trust_values:
        trust = "untrusted"
    elif trust_values and all(value == "trusted" for value in trust_values):
        trust = "trusted"
    else:
        trust = "unknown"
    last = in_window[-1] if in_window else None
    latest_ages = _sample_age(last)
    stale_fields = [name for name, value in latest_ages.items() if value is not None and value > MAX_FRESH_AGE_SECONDS]
    unknown_age_fields = [name for name, value in latest_ages.items() if value is None]
    mode_summary = _mode_summary(selected)
    sequence_values = [_number(item.get("sequence")) for item in in_window]
    sequence_values = [int(value) for value in sequence_values if value is not None and value.is_integer()]
    return {
        "schema_version": 1,
        "window_seconds": WINDOW_SECONDS,
        "sample_rate_hz": SAMPLE_RATE_HZ,
        "window_steps": WINDOW_STEPS,
        "stride_seconds": STRIDE_SECONDS,
        "window_start": rows[0]["timestamp"],
        "window_end": rows[-1]["timestamp"],
        "rows": rows,
        "sample_count": sum(item is not None for item in selected),
        "window_coverage_ratio": sum(item is not None for item in selected) / WINDOW_STEPS,
        "field_presence_ratio": all_ratio,
        "navigation_presence_ratio": nav_ratio,
        "attitude_presence_ratio": sum(_number(_get(item, field)) is not None for item in in_window for field in ATTITUDE_FIELDS) / max(1, len(in_window) * len(ATTITUDE_FIELDS)),
        "fresh_navigation_ratio": 1.0 - stale_cells / age_observations if age_observations else 0.0,
        "telemetry_trust": trust,
        "latest_ages_seconds": latest_ages,
        "stale_fields": stale_fields,
        "unknown_age_fields": unknown_age_fields,
        **mode_summary,
        "airframe_class": airframe_class if isinstance(airframe_class, str) else None,
        "airframe_class_known": airframe_class in {"multicopter-light", "multicopter-heavy", "fixed-wing-lab"},
        "sequence_from": sequence_values[0] if sequence_values else None,
        "sequence_to": sequence_values[-1] if sequence_values else None,
    }


__all__ = ["build_window", "WINDOW_SECONDS", "SAMPLE_RATE_HZ", "WINDOW_STEPS", "STRIDE_SECONDS",
           "PRESENCE_THRESHOLD", "MAX_FRESH_AGE_SECONDS", "NAV_FIELDS", "ATTITUDE_FIELDS", "MODE_FIELDS"]
