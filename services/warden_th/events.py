"""Evidence-linked Warden-TH advisory event projection; events are not persisted."""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
import hashlib
from typing import Any


def _iso(value: Any, fallback: str) -> str:
    if isinstance(value, str) and value.endswith("Z"):
        try:
            datetime.fromisoformat(value[:-1] + "+00:00")
            return value
        except ValueError:
            pass
    return fallback


def _event_id(scenario: str, seed: int, ordinal: int, kind: str) -> str:
    token = hashlib.sha256(f"{scenario}:{seed}:{ordinal}:{kind}".encode()).hexdigest()[:12]
    return f"th-{seed}-{ordinal}-{token}"


def build_advisory_events(*, aircraft_id: str, scenario: str, seed: int,
                          occurred_at: str, received_at: str,
                          baseline: Mapping[str, Any], learned: Mapping[str, Any] | None = None,
                          model_hash: str | None = None, trust: str = "unknown") -> list[dict[str, Any]]:
    """Create flat, contract-valid event objects with exact synthetic evidence bounds."""
    generated: list[dict[str, Any]] = []
    fallback_time = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    occurred_at, received_at = _iso(occurred_at, fallback_time), _iso(received_at, fallback_time)
    findings: list[Mapping[str, Any]] = [item for item in baseline.get("findings", []) if isinstance(item, Mapping)]
    learned_findings = learned.get("subsystem_findings", []) if isinstance(learned, Mapping) else []
    merged: dict[str, dict[str, Any]] = {}
    for item in findings:
        subsystem = item.get("subsystem")
        if isinstance(subsystem, str):
            merged[subsystem] = {"baseline_agrees": False, "evidence_channels": item.get("evidence_channels", ""),
                                 "sequence_from": item.get("sequence_from"), "sequence_to": item.get("sequence_to")}
    for item in learned_findings:
        if not isinstance(item, Mapping) or item.get("detected") is not True:
            continue
        subsystem = item.get("subsystem")
        if isinstance(subsystem, str):
            row = merged.setdefault(subsystem, {"baseline_agrees": False})
            row["learned_detected"] = True
            row["nominal_percentile"] = item.get("nominal_percentile")
            row["evidence_channels"] = item.get("evidence_channels", row.get("evidence_channels", ""))
            row["sequence_from"] = item.get("sequence_from", row.get("sequence_from"))
            row["sequence_to"] = item.get("sequence_to", row.get("sequence_to"))
    baseline_subsystems = {item.get("subsystem") for item in findings}
    for item in learned_findings:
        if isinstance(item, Mapping) and item.get("detected") is True and item.get("subsystem") in baseline_subsystems:
            merged[item["subsystem"]]["baseline_agrees"] = True

    for ordinal, (subsystem, row) in enumerate(sorted(merged.items()), 1):
        if isinstance(row.get("sequence_from"), bool) or not isinstance(row.get("sequence_from"), int):
            continue
        if isinstance(row.get("sequence_to"), bool) or not isinstance(row.get("sequence_to"), int):
            continue
        attributes: dict[str, Any] = {
            "model": "warden-th",
            "model_hash": model_hash or "unavailable",
            "subsystem": subsystem,
            "evidence_sequence_from": row["sequence_from"],
            "evidence_sequence_to": row["sequence_to"],
            "evidence_channels": str(row.get("evidence_channels", ""))[:500],
            "baseline_agrees": bool(row.get("baseline_agrees")),
            "trust": trust,
            "synthetic": True,
            "scenario": scenario,
            "seed": seed,
            "advisory_only": True,
            "command_issued": False,
            "mission_uploaded": False,
            "flight_authorized": False,
        }
        if isinstance(row.get("nominal_percentile"), (int, float)):
            attributes["nominal_percentile"] = round(float(row["nominal_percentile"]), 3)
        generated.append({
            "schema_version": "1.1",
            "event_id": _event_id(scenario, seed, ordinal, "anomaly"),
            "event_type": "telemetry_anomaly",
            "severity": "warning",
            "status": "open",
            "occurred_at": occurred_at,
            "received_at": received_at,
            "source": "warden-local",
            "entity": {"kind": "aircraft", "id": aircraft_id},
            "summary": f"Synthetic Warden-TH advisory: {subsystem} telemetry anomaly window requires human review.",
            "attributes": attributes,
        })
    band = learned.get("endurance_band") if isinstance(learned, Mapping) else None
    method = "learned_synthetic_model" if isinstance(band, Mapping) else "deterministic_slope_baseline"
    if band is None:
        band = baseline.get("endurance_band")
    if isinstance(band, Mapping) and all(isinstance(band.get(key), (int, float)) for key in ("p10_minutes", "p50_minutes", "p90_minutes")):
        ordinal = len(generated) + 1
        generated.append({
            "schema_version": "1.1",
            "event_id": _event_id(scenario, seed, ordinal, "endurance"),
            "event_type": "endurance_forecast",
            "severity": "info",
            "status": "open",
            "occurred_at": occurred_at,
            "received_at": received_at,
            "source": "warden-local",
            "entity": {"kind": "aircraft", "id": aircraft_id},
            "summary": "Synthetic battery-endurance band for review; not a flight recommendation.",
            "attributes": {
                "model": "warden-th",
                "model_hash": model_hash or "unavailable",
                "method": method,
                "p10_minutes": round(float(band["p10_minutes"]), 2),
                "p50_minutes": round(float(band["p50_minutes"]), 2),
                "p90_minutes": round(float(band["p90_minutes"]), 2),
                "trust": trust,
                "synthetic": True,
                "advisory_only": True,
                "command_issued": False,
                "mission_uploaded": False,
                "flight_authorized": False,
            },
        })
    return generated
