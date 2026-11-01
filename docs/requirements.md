# Draft requirements

All items below are **proposed** unless marked foundation-delivered. They require owner review before becoming the product baseline.

## Management system

| ID | Requirement | Acceptance evidence | Phase |
|---|---|---|---|
| MGMT-001 | Track aircraft inventory with stable identifiers and lifecycle state. | Synthetic record can be listed and viewed; duplicate IDs rejected by the future service. | M1 |
| MGMT-002 | Display latest health telemetry with sample and receipt times. | Contract-valid samples can be replayed and viewed. | M1 |
| MGMT-003 | Distinguish simulated, fresh, stale, and missing data. | Tests for absent, delayed, duplicate, and out-of-order samples; timeout selected and documented. | M1 |
| MGMT-004 | Track maintenance records tied to aircraft. | Create/update/read workflow and timestamp validation tested. | M1 |
| MGMT-005 | Enforce access roles when deployed for multiple users. | Role matrix and authorization tests cover every endpoint. | Before shared deployment |
| MGMT-006 | Preserve a traceable audit history of management changes. | Actor, time, entity, and change information can be inspected without secrets. | Before real-data writes |
| MGMT-007 | Support data export and tested restoration. | Documented round-trip test with synthetic records. | Before real-data deployment |
| MGMT-008 | Keep monitoring and management records separate from aircraft control. | No command path in M1; reviewed boundaries for later integrations. | M1–M2 |
| MGMT-009 | Provide role-based access for telemetry viewers and drone operators. | Synthetic authorization fixtures prove deny-by-default, aircraft/source scope, role separation, expiry, suspension, and no aircraft-control permission. | Before shared deployment |
| MGMT-010 | Provide a permission-management UI for authorized administrators. | UI design and implementation cover users, immutable roles, scoped assignments, effective access, review/confirm, version conflicts, and safe denied/empty states. | Before shared deployment |
| MGMT-011 | Audit access-policy and authentication changes without secrets. | Assignment, invite, suspension, session, token, and policy events contain actor/time/scope/result/request ID and exclude credentials/tokens. | Before shared deployment |

## Drone and integration workstream

| ID | Requirement | Acceptance evidence | Phase |
|---|---|---|---|
| DRONE-001 | Define aircraft use and operating envelope before component selection. | Reviewed brief includes platform, payload, endurance, environment, and budget targets. | M0 |
| DRONE-002 | Maintain traceable hardware inventory, interfaces, and revisions. | Inventory and interface records identify actual components and sources. | M0–M2 |
| DRONE-003 | Identify the autopilot and permitted read-only telemetry interface. | Versioned integration ADR and lab plan reviewed. | M2 |
| DRONE-004 | Document loss-of-link and failsafe ownership independently of the management app. | Reviewed responsibility and test matrix for the selected platform. | Before hardware use |
| DRONE-005 | Introduce real telemetry only through a reviewed lab validation procedure. | Contract compliance, invalid-data behavior, and disconnect behavior tested on a controlled bench. | M2 |

## Foundation requirements

| ID | Requirement | State |
|---|---|---|
| FOUND-001 | Separate hardware, firmware, management, interfaces, simulation, and operations areas. | Foundation-delivered |
| FOUND-002 | Provide JSON Schemas and synthetic examples for initial domain entities. | Foundation-delivered |
| FOUND-003 | Provide repeatable automated contract and simulator checks. | Foundation-delivered |
| FOUND-004 | Track scope and delivery decisions in documentation and GitHub. | Foundation-delivered |

## Nonfunctional decisions not yet quantified

Do not invent limits at this stage. Confirm telemetry rate, maximum fleet size, latency/freshness targets, availability, storage retention, offline behavior, backup objectives, and supported clients during M0. Document measured acceptance thresholds before claiming any of these targets are met.

## Outside the starter scope

Flight-ready firmware, physical aircraft design validation, autopilot selection, real-time command/control, autonomous execution, equipment procurement, flight permissions, and production hosting are not part of this repository foundation. Their possible future scope depends on the reviewed use case and project decisions.

## Candidate requirements from the 2026-10-06 patent package

The source package describes an onboard autonomy concept. The following are **candidate engineering requirements for review**, not accepted requirements, legal conclusions, patent claims, or evidence that the corresponding aircraft functions exist. See [`docs/patent-derived-specifications.md`](patent-derived-specifications.md) for the source mapping and proposed data structures.

| ID | Candidate requirement | Acceptance evidence | Phase |
|---|---|---|---|
| PAT-001 | Preserve confidence and provenance when a fused state is exposed to management. | Versioned contract plus low-confidence/missing-provenance tests and UI rendering. | M1/M2 review |
| PAT-002 | Preserve sample time, receipt time, source identity, estimator/model versions, and state snapshot references. | Synthetic end-to-end replay and auditable query. | M1 |
| PAT-003 | Keep aircraft health, telemetry freshness, communications state, and API process health distinct. | Failure-injection matrix and UI state tests. | M1 |
| PAT-004 | Represent link quality, latency/loss, authentication state, and degraded-policy state independently from telemetry freshness. | Synthetic communications transitions and contract tests. | M2 review |
| PAT-005 | Store selected evidence events with model, confidence, health, provenance, safety-decision, and integrity references. | Evidence schema, replay/integrity tests, and export/restore test. | M2 review |
| PAT-006 | Represent unresolved local/remote mission-state conflicts as read-only and non-executable. | Reconciliation fixtures; no automatic merge into commands. | Future review |
| PAT-007 | Track model identity, compatibility, validation/authorization scope, and rollback reference. | Model lifecycle records and authorization tests. | Future review |
| PAT-008 | Do not expose management-to-aircraft commands without a separate reviewed safety/security architecture. | Route allowlist and architecture review. | M1/M2 boundary |
| PAT-009 | Validate confidence, health, safety-gate, communications, and evidence semantics on a controlled bench before real-aircraft data. | Reviewed procedure and recorded test evidence. | Before real integration |

Promote or revise these items only after the project owner confirms that the patent-derived concepts are desired product behavior and engineering owners define measurable units, thresholds, timing, retention, and failure semantics.
