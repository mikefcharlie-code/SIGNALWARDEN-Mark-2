"""Deterministic, bounded Warden-TH feature preparation.

This module performs no learned inference. It preserves missing values as masks,
uses only finite source numbers, and intentionally does not emit coordinates.
"""
from __future__ import annotations

from datetime import datetime, timezone
import math
from collections.abc import Mapping, Sequence
from typing import Any

FEATURE_PATHS = (
    "health.battery_voltage_v",
    "health.battery_percent",
    "health.link_quality_percent",
    "health.temperature_c",
    "autopilot.heartbeat_age_seconds",
    "position.age_seconds",
    "gps.fix_type",
    "gps.satellites_visible",
    "gps.age_seconds",
    "attitude.roll_rad",
    "attitude.pitch_rad",
    "attitude.yaw_rad",
    "position.vx_m_s",
    "position.vy_m_s",
    "position.vz_m_s",
    "observation.battery_age_seconds",
    "observation.system_status_age_seconds",
)
ROBUST_FIELDS = (
    "health.battery_voltage_v",
    "health.battery_percent",
    "health.link_quality_percent",
    "health.temperature_c",
    "autopilot.heartbeat_age_seconds",
    "gps.age_seconds",
    "gps.satellites_visible",
)


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        result = float(value)
    except (OverflowError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _path(sample: Mapping[str, Any], dotted: str) -> Any:
    value: Any = sample
    for part in dotted.split("."):
        if not isinstance(value, Mapping):
            return None
        value = value.get(part)
    return value


def _stamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.endswith("Z"):
        return None
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
        return parsed.astimezone(timezone.utc) if parsed.tzinfo else None
    except (ValueError, OverflowError):
        return None


def _robust_deviation(values: list[float]) -> float | None:
    """Return median/MAD deviation only when a non-degenerate baseline exists."""
    if len(values) < 4:
        return None
    history = values[:-1]
    ordered = sorted(history)
    middle = len(ordered) // 2
    median = ordered[middle] if len(ordered) % 2 else (ordered[middle - 1] + ordered[middle]) / 2
    deviations = sorted(abs(item - median) for item in history)
    mid = len(deviations) // 2
    mad = deviations[mid] if len(deviations) % 2 else (deviations[mid - 1] + deviations[mid]) / 2
    if mad == 0:
        return 0.0 if values[-1] == median else None
    return 0.6744897501960817 * (values[-1] - median) / mad


def build_features(samples: Sequence[Mapping[str, Any]] | None) -> dict[str, Any]:
    """Build explicit, non-imputed feature summaries from at most 1,200 samples."""
    candidates = [item for item in (samples or []) if isinstance(item, Mapping)][-1200:]
    parsed = [(item, _stamp(item.get("timestamp"))) for item in candidates]
    invalid_time_count = sum(stamp is None for _, stamp in parsed)
    ordered = sorted(((item, stamp) for item, stamp in parsed if stamp is not None), key=lambda pair: (pair[1], pair[0].get("sequence", -1)))
    records = [item for item, _ in ordered]
    stamps = [stamp for _, stamp in ordered]

    presence: dict[str, bool] = {}
    observed: dict[str, float | None] = {}
    ratio = 0.0
    robust: dict[str, float | None] = {}
    if records:
        latest = records[-1]
        presence = {field: _number(_path(latest, field)) is not None for field in FEATURE_PATHS}
        observed = {field: _number(_path(latest, field)) for field in FEATURE_PATHS}
        cells = sum(_number(_path(record, field)) is not None for record in records for field in FEATURE_PATHS)
        ratio = cells / (len(records) * len(FEATURE_PATHS))
        for field in ROBUST_FIELDS:
            series = [_number(_path(record, field)) for record in records]
            robust[field] = _robust_deviation([value for value in series if value is not None]) if series[-1] is not None else None

    observation = records[-1].get("observation") if records and isinstance(records[-1].get("observation"), Mapping) else {}
    deadline = _number(observation.get("field_timeout_seconds"))
    stale_fields: list[str] = []
    if deadline is not None and deadline > 0:
        age_paths = ("position.age_seconds", "gps.age_seconds", "attitude.age_seconds", "autopilot.heartbeat_age_seconds",
                     "observation.battery_age_seconds", "observation.system_status_age_seconds")
        stale_fields = [field for field in age_paths if (age := _number(_path(records[-1], field))) is not None and age > deadline]

    gaps = 0
    sequences = [_number(item.get("sequence")) for item in records]
    for left, right in zip(sequences, sequences[1:]):
        if left is not None and right is not None and right > left + 1:
            gaps += int(right - left - 1)
    ingress_counts = {key: sum(1 for item in records if item.get("ingestion_status") == key) for key in ("late", "duplicate")}
    span = (stamps[-1] - stamps[0]).total_seconds() if len(stamps) > 1 else 0.0
    return {
        "sample_count": len(records),
        "input_sample_count": len(candidates),
        "invalid_timestamp_count": invalid_time_count,
        "window_start": stamps[0].isoformat().replace("+00:00", "Z") if stamps else None,
        "window_end": stamps[-1].isoformat().replace("+00:00", "Z") if stamps else None,
        "source_span_seconds": span,
        "feature_presence_ratio": ratio,
        "presence_mask": presence,
        "latest_observed_features": observed,
        "robust_deviation_features": robust,
        "sequence_gap_count": gaps,
        "late_sample_count": ingress_counts["late"],
        "duplicate_sample_count": ingress_counts["duplicate"],
        "stale_fields_by_gateway_deadline": stale_fields,
        "imputation": "none",
        "resampling": "not_performed",
    }


__all__ = ["FEATURE_PATHS", "build_features"]
