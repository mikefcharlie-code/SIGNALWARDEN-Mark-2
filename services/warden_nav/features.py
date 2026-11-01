"""Coordinate-free, missingness-explicit NAV features for the optional ONNX head."""
from __future__ import annotations

import math
from typing import Any, Mapping

VALUE_FEATURES = (
    "position_velocity_residual_5s_m",
    "position_velocity_residual_15s_m",
    "position_velocity_residual_30s_m",
    "vertical_velocity_residual_m_s",
    "msl_relative_offset_drift_m",
    "heading_yaw_residual_deg",
    "course_heading_residual_deg",
    "gps_position_age_divergence_s",
    "gps_fix_transition_count",
    "gps_fix_satellite_mismatch_count",
    "satellite_count_max_step",
    "gps_frozen_fresh_seconds",
    "duplicate_timestamp_count",
    "sequence_replay_count",
    "ground_speed_m_s",
    "gps_age_seconds",
    "position_age_seconds",
    "attitude_age_seconds",
)
META_FEATURES = ("navigation_presence_ratio", "window_coverage_ratio", "fresh_navigation_ratio", "attitude_presence_ratio")
AIRFRAME_FEATURES = ("airframe_multicopter_light", "airframe_multicopter_heavy", "airframe_fixed_wing_lab")
FEATURE_NAMES = VALUE_FEATURES + tuple(f"present_{name}" for name in VALUE_FEATURES) + META_FEATURES + AIRFRAME_FEATURES
FEATURE_COUNT = len(FEATURE_NAMES)


def _finite(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        result = float(value)
    except (OverflowError, ValueError):
        return None
    return result if math.isfinite(result) else None


def model_features(residuals: Mapping[str, Any] | None, window: Mapping[str, Any] | None,
                   airframe_class: str | None) -> list[float]:
    """Map summary residuals to fixed values + masks; absent values are masked, never silently inferred."""
    residuals = residuals if isinstance(residuals, Mapping) else {}
    window = window if isinstance(window, Mapping) else {}
    position = residuals.get("position_velocity_residual_m")
    position = position if isinstance(position, Mapping) else {}
    ages = residuals.get("latest_ages_seconds")
    ages = ages if isinstance(ages, Mapping) else {}
    raw = {
        "position_velocity_residual_5s_m": position.get("5s"),
        "position_velocity_residual_15s_m": position.get("15s"),
        "position_velocity_residual_30s_m": position.get("30s"),
        "vertical_velocity_residual_m_s": residuals.get("vertical_velocity_residual_m_s"),
        "msl_relative_offset_drift_m": residuals.get("msl_relative_offset_drift_m"),
        "heading_yaw_residual_deg": residuals.get("heading_yaw_residual_deg"),
        "course_heading_residual_deg": residuals.get("course_heading_residual_deg"),
        "gps_position_age_divergence_s": residuals.get("gps_position_age_divergence_s"),
        "gps_fix_transition_count": residuals.get("gps_fix_transition_count"),
        "gps_fix_satellite_mismatch_count": residuals.get("gps_fix_satellite_mismatch_count"),
        "satellite_count_max_step": residuals.get("satellite_count_max_step"),
        "gps_frozen_fresh_seconds": residuals.get("gps_frozen_fresh_seconds"),
        "duplicate_timestamp_count": residuals.get("duplicate_timestamp_count"),
        "sequence_replay_count": residuals.get("sequence_replay_count"),
        "ground_speed_m_s": residuals.get("ground_speed_m_s"),
        "gps_age_seconds": ages.get("gps"),
        "position_age_seconds": ages.get("position"),
        "attitude_age_seconds": ages.get("attitude"),
    }
    values: list[float] = []
    masks: list[float] = []
    for name in VALUE_FEATURES:
        value = _finite(raw.get(name))
        masks.append(1.0 if value is not None else 0.0)
        # A zero payload is paired with a zero mask when missing, so zero is not
        # silently interpreted as an observed residual.
        values.append(value if value is not None else 0.0)
    meta = [_finite(window.get("navigation_presence_ratio")),
            _finite(window.get("window_coverage_ratio")),
            _finite(window.get("fresh_navigation_ratio")),
            _finite(window.get("attitude_presence_ratio"))]
    meta_values = [value if value is not None else 0.0 for value in meta]
    airframe_values = [float(airframe_class == name) for name in (
        "multicopter-light", "multicopter-heavy", "fixed-wing-lab")]
    return values + masks + meta_values + airframe_values


__all__ = ["VALUE_FEATURES", "META_FEATURES", "AIRFRAME_FEATURES", "FEATURE_NAMES", "FEATURE_COUNT", "model_features"]
