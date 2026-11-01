# Patent-package-derived engineering specifications

**Source package:** `source-materials/patent-package-2026-10-06/`  
**Ingested:** 2026-10-16  
**Status:** draft engineering interpretation for review; not legal advice, a filed patent, a patentability conclusion, or validated flight requirements.

## 1. Purpose and interpretation boundary

The source package is a revised patent drafting package titled **“AI-Controlled High-Performance Uncrewed Aircraft with Confidence-Gated Adaptive Flight Management.”** It describes an onboard autonomy concept. This document translates only the architecture-relevant concepts into candidate interfaces and work items for this repository’s management system.

The package contains placeholders and attorney-review instructions. The repository must not treat patent claims as proof that a component exists, is safe, is implementable on a selected aircraft, or is legally protected. Engineering acceptance requires a separate owner-reviewed requirement, interface definition, implementation, and test evidence.

## 2. Source-derived architecture concepts

| Source concept | Package reference | Candidate engineering interpretation | Status in this repository |
|---|---:|---|---|
| Heterogeneous sensor ingestion | 112, 200 | Telemetry may contain multiple source measurements and source identity. | Proposed telemetry extension; no real adapter |
| Confidence-aware state estimation | 204 | Publish fused-state confidence/uncertainty and estimator provenance with health telemetry. | Proposed data contract; threshold policy pending |
| Environment model with uncertainty | 206 | Represent environment-feature summaries and uncertainty separately from aircraft state. | Candidate future contract; position/routes intentionally not added yet |
| Mission-contract interpreter | 208, 230 | Management service may store/display contract metadata and lifecycle state; aircraft remains authority for acceptance. | Candidate management record; no command path |
| AI candidate planning | 210 | UI may display model/planning evidence summaries, not issue trajectories or control actions. | Future evidence view only |
| Forward evaluator | 213 | Record candidate evaluation summary, model/version, and outcome for audit/review. | Future evidence event type |
| Deterministic safety envelope | 212 | Surface safety-gate outcome and reason as evidence; do not implement the onboard gate in the management service. | Onboard responsibility; management read model only |
| Health-aware reconfiguration | 214 | Health telemetry can include predicted degradation, health state, confidence, and planning-impact summary. | Proposed health/evidence extension |
| Flight-control interface | 216 | Remains onboard and outside the management API. | Explicitly out of scope |
| Resilient communications | 218 | Publish link quality, latency/loss/authentication state, channel state, and degraded-policy state. | Proposed telemetry extension; transport not selected |
| Evidence logging | 220, 238 | Ingest selected append-oriented evidence events with model, confidence, health, provenance, and safety decisions. | Future evidence stream; retention/integrity design pending |
| Mission-state reconciliation | 222 | Management UI can display local/remote sequence, authority, provenance, validity, and conflict status. | Candidate read-only status view; no automatic merge |
| Human supervisory station | 240 | Management UI is a candidate supervisory/evidence view, not automatically a command station. | M1 monitoring only; command scope excluded |
| Model lifecycle / rollback | 236, 239 | Track model ID, compatibility, validation, signing/authorization status, deployment scope, and rollback reference. | Future inventory/evidence records |
| Shadow evaluation | Claim 17 / description | Store comparison outcomes from non-commanding evaluators. | Future evidence record |

## 3. Management system integration boundary

### 3.1 Proposed logical flow

```text
Onboard aircraft systems
  sensor sources -> state estimator -> health estimator
  environment model -> planner -> forward evaluator
  deterministic safety envelope -> flight-control interface
  communications manager / reconciliation / evidence logger
                |
                | read-only, authenticated telemetry and selected evidence
                v
Telemetry adapter -> ingestion service -> history + latest projections
                                      |
                                      v
                           Management API -> management UI
```

The aircraft retains local enforcement of protected limits and fallback behavior. A remote service outage must not disable onboard safety functions. No repository component may turn a UI action or a stale remote record into an aircraft command without a new, separately reviewed architecture.

### 3.2 Candidate telemetry envelope extension

The existing `packages/contracts/v1/telemetry.schema.json` remains the baseline health contract. The following fields are **candidate additions for a future compatible contract or a new major version**, not silently accepted requirements:

```json
{
  "state_estimation": {
    "estimator_id": "estimator-name@version",
    "confidence": 0.0,
    "uncertainty_summary": { "position_m": 0.0, "velocity_mps": 0.0 },
    "provenance": [
      { "source_id": "sensor-imu-01", "acquired_at": "2026-01-01T00:00:00Z", "quality": 0.0 }
    ]
  },
  "health": {
    "...": "existing v1 health fields",
    "health_state": "nominal",
    "predicted_degradation": { "class": "none", "probability": 0.0 },
    "planning_impact": "none"
  },
  "communications": {
    "link_state": "nominal",
    "latency_ms": 0,
    "packet_loss_percent": 0.0,
    "authentication_state": "authenticated",
    "degraded_policy_state": "normal"
  },
  "evidence": {
    "event_id": "evt-0001",
    "model_ids": ["model@version"],
    "safety_decision": "accepted",
    "integrity_reference": "hash-or-external-reference"
  }
}
```

Interface questions to resolve before ratification:

- Are confidence values scalar, vector, interval, or distribution-based?
- What coordinate frames and units are used for uncertainty summaries?
- Which fields may be absent during degraded sensing?
- Is predicted degradation a model output, a human-reviewed state, or both?
- What is the provenance privacy/retention policy?
- Which evidence events are sent in real time versus retained onboard for later export?
- How are source identity, signing, replay protection, and device registration represented?

### 3.3 Candidate evidence event

A separate evidence stream is preferable to overloading ordinary health telemetry. Candidate event fields:

- `event_id`, `aircraft_id`, `event_type`, `occurred_at`, `received_at`
- `source_identity` and `sequence`
- `model_ids` and model package validation/deployment scope
- state snapshot reference, confidence/uncertainty summary, and health state
- communications state and degraded-policy state
- candidate/action identifier, if an onboard policy permits its export
- safety-envelope decision: `accepted`, `modified`, `rejected`, or `fallback`
- provenance references and integrity/hash-chain reference
- conflict status for mission-state reconciliation events

The management system should store the evidence as append-only where practical and provide a review/export view. It must not claim that a hash chain proves the underlying sensor measurement was truthful; it only supports record-integrity checking.

## 4. UI implications

### Fleet view

- Aircraft lifecycle and hardware revision from inventory.
- Latest sample/receipt timestamps and server-derived freshness.
- Source label: `simulated`, `aircraft`, or another explicitly registered source.
- Health state and predicted degradation summary, when available.
- Communications state: link quality/latency/loss/authentication/degraded policy.
- A visible distinction between **API reachable**, **telemetry fresh**, **communications authenticated**, and **safe to operate**. The UI must never collapse these into one “online” badge.

### Aircraft detail view

- Current health and confidence/uncertainty summary with units and estimator version.
- Sensor/source provenance and data-quality warnings.
- Recent ingestion outcomes: accepted, duplicate, late, rejected, or missing.
- Evidence timeline with safety decisions, model IDs, communications transitions, and reconciliation conflicts.
- Maintenance records and hardware/firmware revisions in a separate section.
- No direct controls, mission execution button, or command composer in M1.

### Mission/evidence view — future

- Read-only mission-contract metadata: ID, issuer, validity, authorized action classes, constraints, revocation state.
- Local versus remote mission sequence, authority, timestamp, provenance, validity, and conflict status.
- Explicit `non-executable / unresolved conflict` state.
- Model package lifecycle: validation status, authorization scope, active/rollback references.

## 5. Candidate requirements to ratify

| ID | Candidate requirement | Evidence needed |
|---|---|---|
| PAT-001 | Store confidence and provenance alongside any fused state shown to the management UI. | Contract tests and UI rendering with missing/low-confidence examples |
| PAT-002 | Preserve sample time, ingestion time, source identity, estimator/model versions, and state snapshot references. | End-to-end synthetic replay and audit query |
| PAT-003 | Keep aircraft health telemetry distinct from management/API health. | Failure-injection tests and UI state matrix |
| PAT-004 | Represent communication quality/authentication/degraded-policy status independently from telemetry freshness. | Synthetic transitions and UI tests |
| PAT-005 | Keep evidence events append-oriented and traceable to model, confidence, health, provenance, and safety decision. | Event schema, integrity/replay tests, export/restore test |
| PAT-006 | Represent unresolved mission-state conflicts as non-executable/read-only review states. | Reconciliation fixture tests; no auto-merge behavior |
| PAT-007 | Record model package identity, compatibility, validation, authorization scope, and rollback reference before showing model state. | Model registry/evidence tests |
| PAT-008 | Do not expose or implement a management-to-aircraft command path without a separate approved safety/security design. | API route allowlist and architecture review |
| PAT-009 | Validate confidence, health, and safety-gate semantics on a controlled test bench before using real aircraft data. | Review procedure and test evidence |

These IDs are candidate requirements only. Promote them into `docs/requirements.md` after scope/owner review.

## 6. Traceability to package sections

- Specification paragraphs [0005]–[0012]: integrated modules and evidence concepts.
- Specification paragraphs [0023]–[0029]: sensor fusion, confidence, provenance, uncertainty, planning, and health-aware constraints.
- Specification paragraphs [0030]–[0034]: communications degradation, mission reconciliation, model lifecycle, rollback, and evidence logging.
- Claims 1–6: fused state, uncertainty, candidate evaluation, and deterministic safety gating.
- Claims 7–11: authenticated mission contracts, degraded communications, reconciliation, and non-executable conflicts.
- Claims 12–19: evidence, integrity, model lifecycle, shadow evaluation, fallback, and distributed compute.
- Claims 20–24: method and computer-readable-medium coverage.
- Drawing figures 2–8: subsystem relationships and review vocabulary.

## 7. Review gates

Before implementation uses these concepts with real aircraft data:

1. Patent counsel and the project owner decide what is confidential, publishable, or implementation-specific; this repository is private but Git history is still a record.
2. Engineering owners define measurable semantics, units, thresholds, timing, and failure behavior.
3. The selected aircraft/autopilot and onboard responsibilities are documented separately from the management service.
4. Contracts and synthetic fixtures are ratified, including negative cases and replay/idempotency behavior.
5. Controlled lab tests validate read-only ingestion, disconnect behavior, clock skew, low confidence, degraded communications, conflicts, and evidence integrity.
6. Safety/security reviewers approve any future command or supervisory capability; M1 remains monitoring/evidence only.

## 8. Source-package caveats to retain

The package itself says that inventor names, applicant/assignee, priority, government interest, disclosure history, attorney docket, fees/forms, novelty/non-obviousness, and final drawing compliance remain for verification. The IDS list is preliminary and not a complete patentability search. The package’s removal of unverified dimensions/specifications is retained here: no aircraft performance values are inferred from the drawings or generated artwork.
