#!/usr/bin/env python3
"""TRACEGATE proof-of-concept: deterministic change-to-proof-obligation engine.

This is an engineering demonstrator, not a safety controller, certification tool,
production release gate, or legal proof of patentability. It intentionally uses a
small, auditable rules engine rather than ML to make the baseline behavior clear.
"""
from __future__ import annotations
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Dict, List, Set, Iterable, Any
import argparse
import json
from pathlib import Path


@dataclass(frozen=True)
class Node:
    node_id: str
    node_type: str
    label: str
    criticality: str = "medium"


@dataclass(frozen=True)
class Edge:
    source: str
    target: str
    relation: str
    propagates_impact: bool = False


@dataclass(frozen=True)
class TestSpec:
    test_id: str
    label: str
    covers: List[str]
    cost_units: int = 1
    mandatory: bool = False


@dataclass(frozen=True)
class Evidence:
    evidence_id: str
    requirement_id: str
    test_id: str
    result: str
    configuration_fingerprint: str
    produced_at: str
    valid_until: str
    integrity_ok: bool = True
    provenance_ok: bool = True
    domain: str = "inspection"


CRITICALITY_ORDER = {"low": 1, "medium": 2, "high": 3, "critical": 4}


class TracegateEngine:
    """Simple deterministic graph closure and conservative test selector."""
    def __init__(self, nodes: Iterable[Node], edges: Iterable[Edge], tests: Iterable[TestSpec]):
        self.nodes: Dict[str, Node] = {n.node_id: n for n in nodes}
        self.edges: List[Edge] = list(edges)
        self.tests: Dict[str, TestSpec] = {t.test_id: t for t in tests}
        self._validate_graph()

    def _validate_graph(self) -> None:
        for e in self.edges:
            if e.source not in self.nodes or e.target not in self.nodes:
                raise ValueError(f"Edge references unknown node: {e.source} -> {e.target}")
        for t in self.tests.values():
            for req in t.covers:
                if req not in self.nodes or self.nodes[req].node_type != "requirement":
                    raise ValueError(f"Test {t.test_id} covers unknown/non-requirement node {req}")

    def impact_closure(self, changed_nodes: Iterable[str]) -> tuple[Set[str], Dict[str, List[str]]]:
        """Walk only explicitly marked propagating edges; return impact set and paths."""
        starts = list(dict.fromkeys(changed_nodes))
        for start in starts:
            if start not in self.nodes:
                raise ValueError(f"Unknown changed node: {start}")
        impacted: Set[str] = set(starts)
        paths: Dict[str, List[str]] = {s: [s] for s in starts}
        queue = list(starts)
        while queue:
            current = queue.pop(0)
            for edge in self.edges:
                if edge.source != current or not edge.propagates_impact:
                    continue
                nxt = edge.target
                if nxt not in impacted:
                    impacted.add(nxt)
                    paths[nxt] = paths[current] + [f"-{edge.relation}->", nxt]
                    queue.append(nxt)
        return impacted, paths

    def affected_requirements(self, impacted: Set[str]) -> Set[str]:
        return {nid for nid in impacted if self.nodes[nid].node_type == "requirement"}

    def select_tests(self, affected_requirements: Set[str]) -> tuple[List[TestSpec], Dict[str, str]]:
        """Select all covering tests for impacted requirements; critical requirements
        require every mapped test. Noncritical overlapping tests are collapsed only
        when coverage is redundant and a stable cost/test-id tie-break permits it.
        The prototype defaults to selecting all mapped tests for every affected
        requirement, intentionally favoring safety over efficiency.
        """
        rationale: Dict[str, str] = {}
        selected: Dict[str, TestSpec] = {}
        for req_id in sorted(affected_requirements):
            req = self.nodes[req_id]
            mapped = [t for t in self.tests.values() if req_id in t.covers]
            mapped.sort(key=lambda t: (not (t.mandatory or req.criticality in ("high", "critical")), t.cost_units, t.test_id))
            if not mapped:
                rationale[req_id] = "NO_TEST_MAPPING: no registered test covers this impacted requirement"
                continue
            for test in mapped:
                selected[test.test_id] = test
                rationale[test.test_id] = (
                    f"selected for impacted requirement {req_id}; "
                    + ("mandatory by policy/criticality" if test.mandatory or req.criticality in ("high", "critical") else "included by conservative baseline policy")
                )
        return sorted(selected.values(), key=lambda t: t.test_id), rationale

    @staticmethod
    def _is_past(iso_utc: str, now: datetime) -> bool:
        dt = datetime.fromisoformat(iso_utc.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt <= now

    def classify_evidence(self, evidence: Iterable[Evidence], target_fingerprint: str,
                          affected_requirements: Set[str], domain: str,
                          now: datetime | None = None) -> Dict[str, Dict[str, Any]]:
        now = now or datetime.now(timezone.utc)
        out: Dict[str, Dict[str, Any]] = {}
        by_req: Dict[str, List[Evidence]] = {}
        for ev in evidence:
            by_req.setdefault(ev.requirement_id, []).append(ev)
        for req_id in sorted(set(self.nodes) - set()):
            if self.nodes[req_id].node_type != "requirement":
                continue
            req_ev = by_req.get(req_id, [])
            valid_candidates = []
            statuses = []
            for ev in req_ev:
                if not ev.integrity_ok or not ev.provenance_ok:
                    status, reason = "CONTRADICTED", "integrity or provenance check failed"
                elif ev.result.lower() not in ("pass", "passed"):
                    status, reason = "CONTRADICTED", f"evidence result is {ev.result}"
                elif self._is_past(ev.valid_until, now):
                    status, reason = "STALE", "evidence validity window expired"
                elif ev.domain != domain:
                    status, reason = "CONDITIONAL", f"evidence domain {ev.domain!r} does not match target domain {domain!r}"
                elif ev.configuration_fingerprint != target_fingerprint and req_id in affected_requirements:
                    status, reason = "STALE", "configuration fingerprint differs and requirement is impacted"
                else:
                    status, reason = "VALID", "integrity, provenance, result, freshness, domain and applicability checks pass"
                    valid_candidates.append(ev)
                statuses.append({"evidence_id": ev.evidence_id, "status": status, "reason": reason})
            if valid_candidates:
                overall = "VALID"
            elif any(s["status"] == "CONTRADICTED" for s in statuses):
                overall = "CONTRADICTED"
            elif any(s["status"] == "STALE" for s in statuses):
                overall = "STALE"
            elif any(s["status"] == "CONDITIONAL" for s in statuses):
                overall = "CONDITIONAL"
            else:
                overall = "MISSING"
            out[req_id] = {"status": overall, "records": statuses}
        return out

    def evaluate(self, scenario: Dict[str, Any]) -> Dict[str, Any]:
        event_id = scenario.get("event_id", "TRACEGATE-EVENT-UNSET")
        changed_nodes = scenario.get("changed_nodes", [])
        target_fp = scenario.get("target_configuration_fingerprint", "UNSPECIFIED")
        domain = scenario.get("target_domain", "inspection")
        conflict = bool(scenario.get("unresolved_configuration_conflict", False))
        now = datetime.fromisoformat(scenario.get("evaluation_time", "2026-10-20T12:00:00+00:00").replace("Z", "+00:00"))
        impacted, paths = self.impact_closure(changed_nodes)
        affected = self.affected_requirements(impacted)
        tests, test_rationale = self.select_tests(affected)
        evidence_input = [Evidence(**e) for e in scenario.get("evidence", [])]
        executed = scenario.get("test_results", {})
        test_reports = []
        for test in tests:
            result = executed.get(test.test_id, "NOT_RUN")
            test_reports.append({"test_id": test.test_id, "label": test.label,
                                 "result": result,
                                 "selection_rationale": test_rationale.get(test.test_id, "selected by impacted requirement mapping")})
        # A PASS in this prototype represents a new evidence record produced by the
        # selected test adapter and bound to the exact target configuration. In a
        # production design this record would be signed/verified by an adapter.
        for rep in test_reports:
            if str(rep["result"]).upper() in ("PASS", "PASSED"):
                spec = self.tests[rep["test_id"]]
                for req_id in spec.covers:
                    if req_id in affected:
                        evidence_input.append(Evidence(
                            evidence_id=f"EXEC-{event_id}-{spec.test_id}-{req_id}",
                            requirement_id=req_id,
                            test_id=spec.test_id,
                            result="PASS",
                            configuration_fingerprint=target_fp,
                            produced_at=now.isoformat(),
                            valid_until=scenario.get("new_evidence_valid_until", "2030-01-01T00:00:00+00:00"),
                            integrity_ok=True,
                            provenance_ok=True,
                            domain=domain,
                        ))
        evidence_status = self.classify_evidence(evidence_input, target_fp, affected, domain, now)
        unmapped = [r for r in affected if "NO_TEST_MAPPING" in test_rationale.get(r, "")]
        failed = [t["test_id"] for t in test_reports if str(t["result"]).upper() in ("FAIL", "FAILED", "ERROR")]
        not_run = [t["test_id"] for t in test_reports if str(t["result"]).upper() in ("NOT_RUN", "PENDING", "UNKNOWN")]
        evidence_problems = []
        for req_id in affected:
            info = evidence_status.get(req_id, {"status": "MISSING", "records": []})
            if info["status"] != "VALID":
                evidence_problems.append({"requirement_id": req_id, "status": info["status"]})
        if conflict:
            status = "REVIEW_REQUIRED"
            reasons = ["UNRESOLVED_CONFIGURATION_CONFLICT"]
        elif unmapped:
            status = "BLOCKED_UNKNOWN"
            reasons = ["IMPACTED_REQUIREMENT_WITHOUT_TEST_MAPPING"]
        elif failed:
            status = "BLOCKED_UNKNOWN"
            reasons = ["REQUIRED_TEST_FAILED"]
        elif not_run:
            status = "BLOCKED_UNKNOWN"
            reasons = ["REQUIRED_TEST_NOT_RUN"]
        elif any(self.nodes[r].criticality in ("high", "critical") for r in affected) and evidence_problems:
            status = "BLOCKED_UNKNOWN"
            reasons = ["MANDATORY_EVIDENCE_NOT_VALID"]
        elif evidence_problems:
            status = "REVIEW_REQUIRED"
            reasons = ["EVIDENCE_REQUIRES_DISPOSITION"]
        elif scenario.get("approved_restriction"):
            status = "READY_WITH_RESTRICTIONS"
            reasons = ["READY_ONLY_WITH_RECORDED_RESTRICTION"]
        else:
            status = "READY"
            reasons = ["ALL_MAPPED_TESTS_PASSED_AND_REQUIRED_EVIDENCE_VALID"]
        return {
            "system": "TRACEGATE prototype",
            "prototype_notice": "Demonstrator only; not a safety certificate or production authorization.",
            "event_id": event_id,
            "target_configuration_fingerprint": target_fp,
            "target_domain": domain,
            "changed_nodes": changed_nodes,
            "impact_closure": sorted(impacted),
            "impact_paths": paths,
            "affected_requirements": sorted(affected),
            "selected_tests": test_reports,
            "evidence_status_by_requirement": {k: evidence_status[k] for k in sorted(affected)},
            "unmapped_requirements": sorted(unmapped),
            "evidence_problems": sorted(evidence_problems, key=lambda x: x["requirement_id"]),
            "readiness_status": status,
            "reason_codes": reasons,
            "evaluation_time": now.isoformat(),
            "policy_version": scenario.get("policy_version", "TRACEGATE-RULES-0.1"),
        }


def make_demo_engine() -> TracegateEngine:
    nodes = [
        Node("component.camera", "component", "Inspection camera", "high"),
        Node("calibration.camera", "calibration", "Camera calibration", "high"),
        Node("model.perception", "model", "Perception model", "critical"),
        Node("component.payload", "component", "Payload module", "high"),
        Node("assumption.inspection_domain", "assumption", "Approved inspection domain", "high"),
        Node("requirement.perception_quality", "requirement", "Perception quality remains within acceptance criteria", "critical"),
        Node("requirement.time_sync", "requirement", "Sensor time alignment remains within limits", "high"),
        Node("requirement.compute_latency", "requirement", "Inference latency remains within budget", "high"),
        Node("requirement.payload_power", "requirement", "Payload power/thermal budget remains valid", "high"),
    ]
    edges = [
        Edge("component.camera", "requirement.perception_quality", "AFFECTS", True),
        Edge("component.camera", "requirement.time_sync", "AFFECTS", True),
        Edge("calibration.camera", "requirement.perception_quality", "AFFECTS", True),
        Edge("calibration.camera", "requirement.time_sync", "AFFECTS", True),
        Edge("model.perception", "requirement.perception_quality", "AFFECTS", True),
        Edge("model.perception", "requirement.compute_latency", "AFFECTS", True),
        Edge("component.payload", "requirement.payload_power", "AFFECTS", True),
        Edge("assumption.inspection_domain", "requirement.perception_quality", "CONDITIONS", True),
    ]
    tests = [
        TestSpec("T-CAL-01", "Camera calibration and alignment bench", ["requirement.perception_quality", "requirement.time_sync"], 2, True),
        TestSpec("T-PER-02", "Recorded-data perception replay", ["requirement.perception_quality"], 3, True),
        TestSpec("T-TIME-03", "Timestamp and sensor synchronization test", ["requirement.time_sync"], 2, True),
        TestSpec("T-LAT-04", "Inference latency and compute-load test", ["requirement.compute_latency"], 2, True),
        TestSpec("T-PWR-05", "Payload power / thermal budget test", ["requirement.payload_power"], 2, True),
    ]
    return TracegateEngine(nodes, edges, tests)


def demo_scenarios() -> List[Dict[str, Any]]:
    return [
        {
            "event_id": "DEMO-01-CAMERA-SWAP", "changed_nodes": ["component.camera", "calibration.camera"],
            "target_configuration_fingerprint": "cfg-demo-camera-r2", "target_domain": "inspection",
            "evaluation_time": "2026-10-20T12:00:00+00:00",
            "test_results": {"T-CAL-01": "PASS", "T-PER-02": "PASS", "T-TIME-03": "PASS"},
            "evidence": [
                {"evidence_id": "E-OLD-PER", "requirement_id": "requirement.perception_quality", "test_id": "T-PER-02", "result": "PASS", "configuration_fingerprint": "cfg-demo-camera-r1", "produced_at": "2026-10-01T10:00:00+00:00", "valid_until": "2027-01-01T00:00:00+00:00"},
                {"evidence_id": "E-OLD-TIME", "requirement_id": "requirement.time_sync", "test_id": "T-TIME-03", "result": "PASS", "configuration_fingerprint": "cfg-demo-camera-r1", "produced_at": "2026-10-01T10:00:00+00:00", "valid_until": "2027-01-01T00:00:00+00:00"},
            ]
        },
        {
            "event_id": "DEMO-02-MODEL-UPGRADE", "changed_nodes": ["model.perception"],
            "target_configuration_fingerprint": "cfg-demo-model-r8", "target_domain": "inspection",
            "evaluation_time": "2026-10-20T12:00:00+00:00",
            "test_results": {"T-CAL-01": "PASS", "T-PER-02": "PASS", "T-LAT-04": "FAIL"},
            "evidence": []
        },
        {
            "event_id": "DEMO-03-PAYLOAD-SWAP", "changed_nodes": ["component.payload"],
            "target_configuration_fingerprint": "cfg-demo-payload-r3", "target_domain": "inspection",
            "evaluation_time": "2026-10-20T12:00:00+00:00",
            "test_results": {"T-PWR-05": "PASS"},
            "evidence": []
        },
        {
            "event_id": "DEMO-04-EXPIRED-CALIBRATION", "changed_nodes": ["calibration.camera"],
            "target_configuration_fingerprint": "cfg-demo-camera-r1", "target_domain": "inspection",
            "evaluation_time": "2026-10-20T12:00:00+00:00",
            "test_results": {"T-CAL-01": "NOT_RUN", "T-PER-02": "NOT_RUN", "T-TIME-03": "NOT_RUN"},
            "evidence": [
                {"evidence_id": "E-EXPIRED", "requirement_id": "requirement.perception_quality", "test_id": "T-PER-02", "result": "PASS", "configuration_fingerprint": "cfg-demo-camera-r1", "produced_at": "2025-01-01T10:00:00+00:00", "valid_until": "2026-01-01T00:00:00+00:00"}
            ]
        },
        {
            "event_id": "DEMO-05-CONFLICTING-ID", "changed_nodes": ["component.camera"],
            "target_configuration_fingerprint": "cfg-demo-conflicted", "target_domain": "inspection",
            "evaluation_time": "2026-10-20T12:00:00+00:00", "unresolved_configuration_conflict": True,
            "test_results": {"T-CAL-01": "PASS", "T-PER-02": "PASS", "T-TIME-03": "PASS"}, "evidence": []
        },
    ]


def run_scenarios(scenarios: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    engine = make_demo_engine()
    return [engine.evaluate(s) for s in scenarios]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", type=Path, help="Path to one JSON scenario")
    parser.add_argument("--demo", action="store_true", help="Run all included demonstration scenarios")
    parser.add_argument("--out", type=Path, help="Optional JSON output path")
    args = parser.parse_args()
    if args.scenario:
        scenarios = [json.loads(args.scenario.read_text())]
    else:
        scenarios = demo_scenarios() if (args.demo or not args.scenario) else []
    results = run_scenarios(scenarios)
    payload = {"notice": "Prototype demonstration only; not a certification or production release authorization.", "results": results}
    serialized = json.dumps(payload, indent=2)
    if args.out:
        args.out.write_text(serialized + "\n")
    print(serialized)

if __name__ == "__main__":
    main()
