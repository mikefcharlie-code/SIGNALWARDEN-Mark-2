# Roadmap and starter backlog

Delivery gates, not promised dates. GitHub milestones and issues are the live work tracker; this file captures the initial plan. No collaborators or issue assignees have been selected.

## M0 — Scope and foundation

**Exit gate:** the owner has resolved core scope decisions and accepted a requirements baseline.

- Confirm UCAS meaning, intended users, use case, aircraft/platform, jurisdiction, and budget.
- Baseline hardware requirements and draft an actual bill of materials.
- Choose management stack and deployment constraints through ADR-0002.
- Review and ratify telemetry, aircraft, and maintenance contracts.
- Review risk register, data policy, and test strategy.

The repository scaffold, synthetic examples, issue templates, and validation workflow are initial deliverables; they do not complete the scope review.

## M1 — Simulation-first management prototype

**Exit gate:** a documented local demo works entirely on synthetic data, with tests.

- Implement management API and synthetic inventory/history storage.
- Implement management UI: inventory, aircraft detail, health and stale/missing data states.
- Implement a maintenance workflow and audit design.
- Add replay/ingestion handling for invalid, duplicate, delayed, and out-of-order data.
- Run an end-to-end simulation demo and record results.

### M1 hardening inspired by open-source patterns

- Define explicit receive, validate, normalize, persist, project, and publish stages for the telemetry reference path.
- Add versioned simulation-twin metadata and relationship-oriented RBAC decision fixtures with explainable allow/deny results.
- Define a bounded operational-event vocabulary for stale data, duplicate/late samples, stream gaps, maintenance watch items, and access conflicts.
- Keep these as local contracts and tests first; do not add live vehicle-control, navigation, radio, targeting, weapons, or military C2 dependencies.

## M2 — Read-only lab integration

**Exit gate:** the selected aircraft interface is documented and independently reviewed; controlled lab telemetry tests pass.

- Identify autopilot/firmware versions and read-only adapter boundaries.
- Implement a read-only gateway behind the same contracts used in simulation.
- Record bench readiness, disconnect behavior, and data-quality tests.
- Review authentication, authorization, retention, backups, and incident procedures before sharing real data.

No real flight or production rollout is authorized merely by reaching this milestone.

Open-source reuse for M2 is limited to a separately reviewed read-only adapter, versioned fixtures, and operational evidence. Any repository or dependency containing a command, navigation, radio, payload, or autonomous vehicle-control path requires a new architecture and safety/security review before consideration.

## Initial risks

| Risk | Why it matters | Mitigation / next action |
|---|---|---|
| Ambiguous UCAS meaning and use | Could lead to the wrong project | Resolve first in scope issue |
| Hardware/software premature coupling | Can force rework | Contracts and adapters; postpone stack/platform selection |
| Stale telemetry presented as current | Misleads operators | Explicit sample/receipt times, freshness thresholds, disconnect tests |
| Simulated and real data mixed | Invalid operational conclusions | Mandatory source field and segregated environments |
| Credentials or locations in Git | Privacy and security exposure | Synthetic fixtures, ignore rules, review before commits |
| Management dependency on flight safety | Unreviewed failure paths | Separate flight-control responsibility and read-only initial scope |
| Undefined ownership and maintenance | Work becomes untracked | One issue per deliverable, owner-selected assignees, ADRs |

## Definition of done for future issues

- Acceptance criteria met and linked requirement IDs identified.
- Tests added or updated, and CI passes.
- Documentation and interface examples reflect the implementation.
- No secrets or real operational traces included.
- Relevant safety/security implications reviewed.
- Reviewer records evidence; placeholders are not presented as working features.
