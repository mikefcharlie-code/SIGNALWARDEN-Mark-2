"""Fixed, inspectable Warden-NAV residual thresholds.

This baseline reports internal telemetry disagreements only. It does not infer
an RF source, produce a position, or direct a vehicle. Thresholds are synthetic
engineering starting points, not validated operational limits.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from .residuals import compute_residuals
from .window import MAX_FRESH_AGE_SECONDS, PRESENCE_THRESHOLD, build_window

MODEL_ID = "warden-nav-residual-baseline-v1"
THRESHOLDS = {
    "position_velocity_residual_m": {"5s": 5.0, "15s": 12.0, "30s": 20.0},
    "vertical_velocity_residual_m_s": 0.25,
    "msl_relative_offset_drift_m": 5.0,
    "heading_yaw_residual_deg": 45.0,
    "course_heading_residual_deg": 50.0,
    "gps_position_age_divergence_s": 2.0,
    "gps_fix_transition_count": 4,
    "gps_fix_satellite_mismatch_count": 12,
    "satellite_count_max_step": 4.0,
    "gps_frozen_fresh_seconds": 30.0,
}


def _sequence_bounds(window: Mapping[str, Any]) -> tuple[int | None, int | None]:
    return window.get("sequence_from"), window.get("sequence_to")


def _finding(name: str, subsystem: str, value: Any, threshold: float, units: str,
             evidence_channels: str, bounds: tuple[int | None, int | None]) -> dict[str, Any]:
    observed = round(float(value), 6)
    return {
        "finding_id": name,
        "subsystem": subsystem,
        "residual": name,
        "observed": observed,
        "threshold": threshold,
        "units": units,
        "evidence_channels": evidence_channels,
        "sequence_from": bounds[0],
        "sequence_to": bounds[1],
        "baseline_only": True,
    }


def assess_window(samples: Sequence[Mapping[str, Any]] | None, *, telemetry_trust: str | None = None,
                  airframe_class: str | None = None, window: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Assess one bounded NAV window; threshold values remain fully visible."""
    window = dict(window or build_window(samples, airframe_class=airframe_class))
    residuals = compute_residuals(samples, airframe_class=airframe_class)
    trust = telemetry_trust or window.get("telemetry_trust", "unknown")
    if trust not in {"trusted", "untrusted", "unknown"}:
        trust = "unknown"
    ratio = float(window.get("navigation_presence_ratio", 0.0) or 0.0)
    coverage = float(window.get("window_coverage_ratio", 0.0) or 0.0)
    stale_fields = list(window.get("stale_fields", []))
    age_unknown = [name for name in ("gps", "position") if name in window.get("unknown_age_fields", [])]
    reasons: list[str] = []
    if ratio < PRESENCE_THRESHOLD:
        reasons.append("feature_presence_below_60_percent")
    if coverage < PRESENCE_THRESHOLD:
        reasons.append("window_coverage_below_60_percent")
    if stale_fields:
        reasons.append("stale_navigation_fields")
    if age_unknown:
        reasons.append("navigation_age_unknown")
    if trust != "trusted":
        reasons.append("telemetry_trust_not_verified")
    if not window.get("airframe_class_known", False):
        reasons.append("airframe_class_unknown_for_learned_head")
    if window.get("fresh_navigation_ratio", 0.0) < 0.60:
        reasons.append("fresh_navigation_presence_below_60_percent")

    sparse = ratio < PRESENCE_THRESHOLD or coverage < PRESENCE_THRESHOLD
    findings: list[dict[str, Any]] = []
    bounds = _sequence_bounds(window)
    if not sparse:
        traces = residuals.get("traces", [])
        for period, threshold in THRESHOLDS["position_velocity_residual_m"].items():
            value = residuals["position_velocity_residual_m"].get(period)
            trace_key = f"position_velocity_residual_{period}_m"
            peak = max((row[trace_key] for row in traces if row.get(trace_key) is not None), default=None)
            if peak is not None and (value is None or peak > value):
                value = peak
            if value is not None and value > threshold:
                findings.append(_finding("position_velocity_disagreement", "navigation_consistency", value,
                                         threshold, "m", "position.velocity_integrated_displacement_residual", bounds))
                break
        value = residuals.get("vertical_velocity_residual_m_s")
        if value is not None and abs(value) > THRESHOLDS["vertical_velocity_residual_m_s"]:
            findings.append(_finding("altitude_rate_disagreement", "navigation_consistency", abs(value),
                                     THRESHOLDS["vertical_velocity_residual_m_s"], "m/s",
                                     "position.relative_altitude_m,position.vz_m_s", bounds))
        value = residuals.get("msl_relative_offset_drift_m")
        if value is not None and abs(value) > THRESHOLDS["msl_relative_offset_drift_m"]:
            findings.append(_finding("msl_relative_offset_drift", "navigation_consistency", abs(value),
                                     THRESHOLDS["msl_relative_offset_drift_m"], "m",
                                     "position.altitude_msl_m,position.relative_altitude_m", bounds))
        value = residuals.get("heading_yaw_residual_deg")
        if value is not None and abs(value) > THRESHOLDS["heading_yaw_residual_deg"]:
            findings.append(_finding("heading_yaw_disagreement", "navigation_consistency", abs(value),
                                     THRESHOLDS["heading_yaw_residual_deg"], "deg",
                                     "position.heading_deg,attitude.yaw_rad", bounds))
        value = residuals.get("course_heading_residual_deg")
        if value is not None and abs(value) > THRESHOLDS["course_heading_residual_deg"]:
            findings.append(_finding("course_heading_disagreement", "navigation_consistency", abs(value),
                                     THRESHOLDS["course_heading_residual_deg"], "deg",
                                     "position.vx_m_s,position.vy_m_s,position.heading_deg", bounds))
        gps_reasons = []
        ages = residuals.get("latest_ages_seconds", {})
        gps_age, position_age = ages.get("gps"), ages.get("position")
        divergence = residuals.get("gps_position_age_divergence_s")
        if divergence is not None and divergence > THRESHOLDS["gps_position_age_divergence_s"]:
            gps_reasons.append(("gps_position_age_divergence", divergence, "s"))
        if gps_age is not None and gps_age > MAX_FRESH_AGE_SECONDS:
            gps_reasons.append(("gps_measurement_stale", gps_age, "s"))
        if position_age is not None and position_age > MAX_FRESH_AGE_SECONDS:
            gps_reasons.append(("position_measurement_stale", position_age, "s"))
        if residuals.get("gps_fix_transition_count", 0) >= THRESHOLDS["gps_fix_transition_count"]:
            gps_reasons.append(("gps_fix_state_instability", residuals["gps_fix_transition_count"], "count"))
        if residuals.get("gps_fix_satellite_mismatch_count", 0) >= THRESHOLDS["gps_fix_satellite_mismatch_count"]:
            gps_reasons.append(("gps_state_satellite_inconsistency", residuals["gps_fix_satellite_mismatch_count"], "count"))
        sat_step = residuals.get("satellite_count_max_step")
        if sat_step is not None and sat_step > THRESHOLDS["satellite_count_max_step"]:
            gps_reasons.append(("gps_satellite_count_step", sat_step, "satellites"))
        if residuals.get("gps_receiver_stuck_fresh"):
            gps_reasons.append(("gps_receiver_state_stuck_fresh", residuals.get("gps_frozen_fresh_seconds", 0), "s"))
        for name, value, units in gps_reasons:
            threshold = THRESHOLDS.get(name, 1.0)
            findings.append(_finding(name, "gps_state_consistency", value, float(threshold), units,
                                     "gps.fix_type,gps.satellites_visible,gps.age_seconds,position.age_seconds", bounds))
        if residuals.get("duplicate_timestamp_count", 0) or residuals.get("sequence_replay_count", 0):
            count = residuals.get("duplicate_timestamp_count", 0) + residuals.get("sequence_replay_count", 0)
            findings.append(_finding("replay_or_sequence_reuse", "telemetry_ordering", count, 0.0, "count",
                                     "timestamp,sequence", bounds))

    return {
        "schema_version": "1.0",
        "model_id": MODEL_ID,
        "status": "abstained" if sparse else "baseline_only",
        "read_only": True,
        "advisory_only": True,
        "weights_available": False,
        "numeric_score": None,
        "integrity_classification": None,
        "telemetry_trust": trust,
        "trust_interpretation": "untrusted_ingress" if trust == "untrusted" else "verified_ingress" if trust == "trusted" else "trust_unknown",
        "window": {key: window[key] for key in (
            "window_seconds", "sample_rate_hz", "window_steps", "stride_seconds", "window_start", "window_end",
            "sample_count", "window_coverage_ratio", "field_presence_ratio", "navigation_presence_ratio",
            "attitude_presence_ratio", "fresh_navigation_ratio", "latest_ages_seconds", "stale_fields",
            "unknown_age_fields", "autopilot_mode_presence_ratio", "armed_state_change_count",
            "custom_mode_change_count", "sequence_from", "sequence_to", "airframe_class",
            "airframe_class_known") if key in window},
        "feature_presence_ratio": ratio,
        "window_coverage_ratio": coverage,
        "residuals": None if sparse else residuals,
        "thresholds": THRESHOLDS,
        "baseline_findings": findings,
        "abstention_reasons": list(dict.fromkeys(reasons)),
        "limitations": [
            "Describes internal telemetry consistency only; it does not determine the true position or correct navigation.",
            "A spoofing-like residual pattern is not evidence of spoofing, intent, an RF source, or its location.",
            "Untrusted ingress is a provenance label, not a spoofing-like telemetry classification.",
            "Thresholds are development baselines and are not flight validated or operational limits.",
            "No raw absolute coordinates, corrected position, navigation solution, or control recommendation is emitted.",
        ],
    }


__all__ = ["assess_window", "THRESHOLDS", "MODEL_ID"]


def assess(samples, *, telemetry_trust=None, airframe_class=None):
    """Public API adapter retained for the management API read-only route."""
    return assess_window(samples, telemetry_trust=telemetry_trust, airframe_class=airframe_class)


__all__ = ["assess", "assess_window", "THRESHOLDS", "MODEL_ID"]
