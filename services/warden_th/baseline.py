"""Warden-TH deterministic baseline; learned inference remains a separate output."""
from __future__ import annotations

from collections.abc import Mapping, Sequence
import math
from typing import Any

from .features import build_features
from .window import CHANNEL_NAMES, PRESENCE_THRESHOLD

MIN_FEATURE_PRESENCE = PRESENCE_THRESHOLD
KNOWN_AIRFRAME_CLASSES = {"multicopter-light", "multicopter-heavy", "fixed-wing-lab"}


def assess(samples: Sequence[Mapping[str, Any]] | None) -> dict[str, Any]:
    """The existing PR #26 baseline contract; it never invents a learned score."""
    features = build_features(samples)
    reasons: list[str] = []
    if features["sample_count"] == 0:
        reasons.append("no_valid_timestamped_samples")
    if features["feature_presence_ratio"] < MIN_FEATURE_PRESENCE:
        reasons.append("feature_presence_below_60_percent")
    return {
        "model_id": "warden-th",
        "mode": "deterministic_baseline",
        "weights_available": False,
        "learned_inference": "unavailable",
        "status": "abstained" if reasons else "baseline_only",
        "advisory_only": True,
        "numeric_score": None,
        "feature_summary": features,
        "abstention_reasons": reasons,
        "limitations": [
            "No production Warden-TH weights or field calibration are installed.",
            "This summary does not resample to 2 Hz; fixed-grid development windows are built separately.",
            "No probability, anomaly class, flight authorization, or action recommendation is produced.",
        ],
    }


def _series(window: Mapping[str, Any], name: str) -> list[tuple[int, int | None, float]]:
    try:
        index = CHANNEL_NAMES.index(name)
    except ValueError:
        return []
    result = []
    for row_index, row in enumerate(window.get("rows", [])):
        values = row.get("values", [])
        value = values[index] if len(values) > index else None
        sequence = row.get("sequence")
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value)):
            result.append((row_index, sequence if isinstance(sequence, int) else None, float(value)))
    return result


def _slope_per_second(points: list[tuple[int, int | None, float]]) -> float | None:
    if len(points) < 4:
        return None
    xs = [point[0] / 2.0 for point in points]
    ys = [point[2] for point in points]
    xbar, ybar = sum(xs) / len(xs), sum(ys) / len(ys)
    denom = sum((x - xbar) ** 2 for x in xs)
    return sum((x - xbar) * (y - ybar) for x, y in zip(xs, ys)) / denom if denom else None


def assess_window(window: Mapping[str, Any], *, airframe_class: str | None,
                  samples: Sequence[Mapping[str, Any]] | None = None) -> dict[str, Any]:
    """Scoreless deterministic rules for the synthetic 120-second demo window."""
    presence = window.get("field_presence_ratio", 0.0)
    abstentions: list[str] = []
    if not isinstance(presence, (int, float)) or presence < MIN_FEATURE_PRESENCE:
        abstentions.append("feature_presence_below_60_percent")
    if airframe_class not in KNOWN_AIRFRAME_CLASSES:
        abstentions.append("airframe_class_unknown")
    findings: list[dict[str, Any]] = []
    if not abstentions:
        checks = (
            ("power", "power.dv_dt", lambda value: value < -0.012, "battery_voltage_v"),
            ("power", "power.temperature_c", lambda value: False, "temperature_c"),
            ("power", "power.percent_voltage_residual", lambda value: value < -0.0010, "battery_percent,battery_voltage_v"),
            ("power", "power.battery_voltage_v", lambda value: False, "battery_voltage_v"),
            ("link", "link.quality_percent", lambda value: value < 70.0, "link_quality_percent"),
            ("link", "link.heartbeat_age_seconds", lambda value: value > 2.0, "heartbeat_age_seconds"),
            ("link", "link.sequence_gap", lambda value: value > 0.0, "sequence"),
            ("navigation", "navigation.position_jump_m", lambda value: value > 10.0, "position.*,gps.fix_type"),
            ("navigation", "navigation.velocity_position_residual_m_s", lambda value: value > 5.0, "position.*,position.vx_m_s,position.vy_m_s"),
            ("attitude", "attitude.rate_magnitude_rad_s", lambda value: value > 0.65, "attitude.roll_rad,attitude.pitch_rad,attitude.yaw_rad"),
            ("attitude", "attitude.high_frequency_energy", lambda value: value > 0.015, "attitude.roll_rad,attitude.pitch_rad"),
            ("autopilot", "autopilot.mode_change", lambda value: value > 0.0, "autopilot.base_mode,autopilot.custom_mode"),
            ("autopilot", "autopilot.status_transition", lambda value: value > 0.0, "autopilot.system_status"),
        )
        emitted: set[str] = set()
        for subsystem, channel, predicate, evidence_channels in checks:
            if subsystem in emitted:
                continue
            points = _series(window, channel)
            flagged = [point for point in points if predicate(point[2])]
            if channel == "power.battery_voltage_v" and len(points) > 20:
                values = [point[2] for point in points[-40:]]
                if max(values) - min(values) < 1e-6:
                    # A frozen reading is advisory only when fresh samples continue.
                    flagged = points[-40:]
            if flagged:
                emitted.add(subsystem)
                findings.append({
                    "subsystem": subsystem,
                    "detected": True,
                    "rule": f"deterministic_threshold:{channel}",
                    "evidence_channels": evidence_channels,
                    "sequence_from": flagged[0][1],
                    "sequence_to": flagged[-1][1],
                    "window_start_index": flagged[0][0],
                    "window_end_index": flagged[-1][0],
                    "score": None,
                })
        temperature_points = _series(window, "power.temperature_c")
        if "power" not in emitted and _slope_per_second(temperature_points[-40:]) is not None and _slope_per_second(temperature_points[-40:]) > 0.025:
            flagged = temperature_points[-40:]
            findings.append({"subsystem": "power", "detected": True,
                             "rule": "deterministic_threshold:temperature_rate_c_per_s",
                             "evidence_channels": "temperature_c", "sequence_from": flagged[0][1],
                             "sequence_to": flagged[-1][1], "window_start_index": flagged[0][0],
                             "window_end_index": flagged[-1][0], "score": None})

    battery_points = _series(window, "power.battery_percent")
    slope = _slope_per_second(battery_points)
    latest_percent = battery_points[-1][2] if battery_points else None
    endurance = None
    if not abstentions and slope is not None and latest_percent is not None and slope < -0.0001 and latest_percent > 20:
        median = max(0.0, (latest_percent - 20.0) / (-slope * 60.0))
        # This deliberately broad baseline interval is a heuristic, not a calibrated confidence interval.
        endurance = {"p10_minutes": round(median * 0.75, 2), "p50_minutes": round(median, 2),
                     "p90_minutes": round(median * 1.25, 2), "method": "deterministic_recent_percent_slope",
                     "calibration": "heuristic_only_not_flight_validated"}
    return {
        "status": "abstained" if abstentions else "baseline_available",
        "advisory_only": True,
        "field_presence_ratio": round(float(presence), 6) if isinstance(presence, (int, float)) else 0.0,
        "findings": findings,
        "endurance_band": endurance,
        "abstention_reasons": abstentions,
        "telemetry_trust": window.get("telemetry_trust", "unknown"),
        "limitations": [
            "Synthetic-development deterministic rules only; thresholds are not aircraft-calibrated.",
            "Battery endurance band is a slope-based heuristic, not a learned or flight-validated forecast.",
            "No finding is a command, mission, effector, or flight-readiness instruction.",
        ],
    }


__all__ = ["assess", "assess_window", "MIN_FEATURE_PRESENCE"]
