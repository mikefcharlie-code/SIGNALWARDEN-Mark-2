"""Coordinate-free, evidence-linked Warden-NAV advisory event construction."""
from __future__ import annotations

import hashlib
import json
from typing import Any, Mapping, Sequence


def _event_id(payload: Mapping[str, Any]) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return "nav-" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:24]


def build_advisory_events(*, assessment: Mapping[str, Any], aircraft_id: str,
                           occurred_at: str, received_at: str | None = None,
                           trust: str | None = None, scenario: str | None = None,
                           seed: int | None = None, model_hash: str | None = None,
                           learned_findings: Sequence[Mapping[str, Any]] = ()) -> list[dict[str, Any]]:
    """Link scalar residual findings to telemetry sequence ranges, never coordinates."""
    trust = trust or str(assessment.get("telemetry_trust", "unknown"))
    window = assessment.get("window") if isinstance(assessment.get("window"), Mapping) else {}
    sequence_from, sequence_to = window.get("sequence_from"), window.get("sequence_to")
    baseline = assessment.get("baseline_findings") if isinstance(assessment.get("baseline_findings"), list) else []
    findings: list[tuple[Mapping[str, Any], str]] = [(row, "warden-local") for row in baseline if isinstance(row, Mapping)]
    findings.extend((row, "local-ai") for row in learned_findings if isinstance(row, Mapping))
    if trust == "untrusted":
        findings.append(({
            "finding_id": "untrusted_ingress",
            "subsystem": "telemetry_provenance",
            "residual": "untrusted_ingress",
            "observed": None,
            "threshold": None,
            "units": None,
            "evidence_channels": "ingress_security.telemetry_trust",
            "sequence_from": sequence_from,
            "sequence_to": sequence_to,
        }, "warden-local"))
    events = []
    for finding, source in findings:
        group = str(finding.get("subsystem", "navigation_consistency"))
        event_type = "gnss_integrity" if group == "gps_state_consistency" else "navigation_consistency"
        finding_id = str(finding.get("finding_id", finding.get("residual", "nav_residual")))
        # Trust provenance is never rewritten as a spoofing-like pattern.
        if trust == "untrusted":
            summary = "Navigation telemetry ingress is untrusted; residuals do not classify a spoofing-like pattern or its source."
            pattern = "untrusted_ingress"
        else:
            summary = f"Warden-NAV advisory: {finding_id.replace('_', ' ')} observed in internal navigation telemetry."
            pattern = finding.get("pattern", "residual_threshold_exceeded")
        attributes: dict[str, Any] = {
            "advisory_only": True,
            "command_issued": False,
            "mission_uploaded": False,
            "flight_authorized": False,
            "assessment_kind": "internal_navigation_consistency",
            "finding_id": finding_id,
            "residual_group": group,
            "pattern_label": pattern,
            "telemetry_trust": trust,
            "evidence_channels": str(finding.get("evidence_channels", "navigation_residuals")),
            "sequence_from": finding.get("sequence_from", sequence_from),
            "sequence_to": finding.get("sequence_to", sequence_to),
            "baseline_only": source == "warden-local",
            "synthetic_only": assessment.get("synthetic_only") is True,
        }
        if finding.get("observed") is not None:
            attributes["residual_value"] = float(finding["observed"])
        if finding.get("threshold") is not None:
            attributes["development_threshold"] = float(finding["threshold"])
        if finding.get("units") is not None:
            attributes["units"] = str(finding["units"])
        if scenario is not None:
            attributes["synthetic_scenario"] = scenario
        if seed is not None:
            attributes["synthetic_seed"] = int(seed)
        if model_hash:
            attributes["model_sha256"] = model_hash
        event_core = {
            "schema_version": "1.1",
            "event_type": event_type,
            "severity": "warning" if finding_id != "untrusted_ingress" else "info",
            "status": "open",
            "occurred_at": occurred_at,
            "received_at": received_at or occurred_at,
            "source": source,
            "entity": {"kind": "aircraft", "id": aircraft_id},
            "correlation_id": f"nav-{aircraft_id}-{sequence_from or 0}-{sequence_to or 0}",
            "summary": summary,
            "attributes": attributes,
        }
        events.append({"event_id": _event_id(event_core), **event_core})
    return events


__all__ = ["build_advisory_events"]
