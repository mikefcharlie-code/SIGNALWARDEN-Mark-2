"""Warden-NAV scalar-residual baseline; learned classification is unavailable."""
from __future__ import annotations

from collections.abc import Mapping, Sequence
import math
from typing import Any

from .residuals import compute_residuals

MIN_FEATURE_PRESENCE = 0.60
NAV_PATHS = (
    "position.latitude_deg", "position.longitude_deg", "position.altitude_msl_m",
    "position.relative_altitude_m", "position.vx_m_s", "position.vy_m_s",
    "position.vz_m_s", "position.heading_deg", "position.age_seconds",
    "gps.fix_type", "gps.satellites_visible", "gps.age_seconds",
    "attitude.yaw_rad", "attitude.age_seconds",
)


def _number(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(float(value))
    except (OverflowError, ValueError):
        return False


def _path(row: Mapping[str, Any], dotted: str) -> Any:
    current: Any = row
    for part in dotted.split("."):
        current = current.get(part) if isinstance(current, Mapping) else None
    return current


def assess(samples: Sequence[Mapping[str, Any]] | None, *, telemetry_trust: str = "unknown",
           airframe_class: str | None = None) -> dict[str, Any]:
    records = [item for item in (samples or []) if isinstance(item, Mapping)][-1200:]
    cells = sum(_number(_path(record, field)) for record in records for field in NAV_PATHS)
    presence = cells / (len(records) * len(NAV_PATHS)) if records else 0.0
    reasons: list[str] = []
    if not records:
        reasons.append("no_samples")
    if presence < MIN_FEATURE_PRESENCE:
        reasons.append("position_gps_attitude_presence_below_60_percent")
    if not isinstance(airframe_class, str) or not airframe_class.strip():
        reasons.append("airframe_class_unknown_for_learned_head")
    residuals = compute_residuals(records) if presence >= MIN_FEATURE_PRESENCE else None
    return {
        "model_id": "warden-nav",
        "mode": "deterministic_residual_baseline",
        "weights_available": False,
        "learned_inference": "unavailable",
        "status": "abstained" if presence < MIN_FEATURE_PRESENCE or not records else "baseline_only",
        "advisory_only": True,
        "numeric_score": None,
        "feature_presence_ratio": presence,
        "residuals": residuals,
        "telemetry_trust": telemetry_trust if isinstance(telemetry_trust, str) and telemetry_trust in {"trusted", "untrusted", "unknown"} else "unknown",
        "integrity_classification": None,
        "airframe_class_known": isinstance(airframe_class, str) and bool(airframe_class.strip()),
        "abstention_reasons": reasons,
        "limitations": [
            "No pinned Warden-NAV weights or calibrated classification thresholds are installed.",
            "Residual values are descriptive baseline features, not spoofing or navigation-integrity verdicts.",
            "Untrusted telemetry is not evidence of spoofing; no classification is made.",
            "Raw coordinates are not returned by this assessment.",
        ],
    }


__all__ = ["assess", "MIN_FEATURE_PRESENCE", "NAV_PATHS"]
