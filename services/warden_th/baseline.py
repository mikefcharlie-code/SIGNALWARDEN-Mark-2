"""Warden-TH deterministic baseline; learned model weights are not installed."""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from .features import build_features

MIN_FEATURE_PRESENCE = 0.60


def assess(samples: Sequence[Mapping[str, Any]] | None) -> dict[str, Any]:
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
            "No pinned Warden-TH weights or calibrated baseline parameters are installed.",
            "Source samples are summarized as received; this baseline does not resample to 2 Hz.",
            "No probability, anomaly class, flight authorization, or action recommendation is produced.",
        ],
    }


__all__ = ["assess", "MIN_FEATURE_PRESENCE"]
