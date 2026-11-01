"""Fail-closed, rule-only Warden-TRUST labels for retained evidence.

No model weights are present, so numeric reliability scores are deliberately
withheld. These labels annotate evidence; they never filter or delete records.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any


def evidence_reliability(row: Mapping[str, Any]) -> dict[str, Any]:
    raw_trust, raw_freshness = row.get("trust"), row.get("freshness")
    trust = raw_trust if isinstance(raw_trust, str) and raw_trust in {"trusted", "untrusted", "unknown"} else "unknown"
    freshness = raw_freshness if isinstance(raw_freshness, str) and raw_freshness in {"current", "stale", "future", "unknown"} else "unknown"
    synthetic = row.get("synthetic") is True
    factors_down: list[str] = []
    if synthetic:
        factors_down.append("synthetic_or_fixture_evidence")
    if trust != "trusted":
        factors_down.append(f"provenance_{trust}")
    if freshness != "current":
        factors_down.append(f"freshness_{freshness}")
    if not isinstance(row.get("sourceId"), str) or row.get("sourceId") in {"unknown", "absence"}:
        factors_down.append("source_identity_missing")
    factors_down.extend(("source_agreement_and_history_features_unavailable", "trained_weights_and_calibration_unavailable"))

    hard_rule = "synthetic_evidence" if synthetic else "untrusted_ingress_cap" if trust == "untrusted" else None
    band = "low" if hard_rule else "unscored"
    return {
        "score": None,
        "band": band,
        "factorsUp": [],
        "factorsDown": factors_down,
        "hardRule": hard_rule,
    }


def annotate_evidence(rows: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Return copies with additive labels; preserve every input row and its ID."""
    return [{**dict(row), "reliability": evidence_reliability(row)} for row in rows]


__all__ = ["evidence_reliability", "annotate_evidence"]
