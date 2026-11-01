# Project brief

**Current status:** M1 simulation-first prototype. The repository now contains runnable synthetic UI, API, stream, persistence, and Tracegate reference paths; none is flight-ready or production-approved.

## Goal

Organize development of a UCAS drone and its management system in one traceable workspace. The initial outcome is a reviewed scope, documented interfaces, and a simulation-based management prototype before hardware integration.

## Confirmed by the owner

- A UCAS drone project is desired.
- A related management system is desired.
- A GitHub repository and initial organization are desired.

## Provisional defaults used for this foundation

These are reversible organizing choices, not approved product specifications.

- Private repository in the connected personal GitHub account.
- Monorepo with separate hardware, firmware, integration, and management areas.
- Start with synthetic telemetry and read-only monitoring.
- Management scope proposes inventory, health visibility, maintenance, and operations records.
- No procurement, infrastructure spending, real flights, hardware configuration, or existing aircraft changes.
- React/TypeScript and Python are the current reference implementation choices only; no autopilot, radio, aircraft platform, deployment vendor, or production architecture is selected.

## Decisions to resolve

| Decision | Questions | Needed before |
|---|---|---|
| UCAS definition and use | What does UCAS stand for here? What problem and users should it serve? | Requirements baseline |
| Aircraft platform | New design or existing aircraft? Multirotor, fixed wing, or other? | Hardware design |
| Operating context | Country/jurisdiction, test site, indoor/outdoor, intended operating conditions? | Lab/field validation plan |
| Performance envelope | Payload, endurance, range, size, and budget targets? | Component selection |
| Autopilot/integration | Existing flight controller or firmware? Is a companion computer needed? | Adapter implementation |
| Management workflow | Single aircraft or fleet? Who manages maintenance and operations records? | API and UI design |
| Hosting/access | Local-only, on-premises, or cloud? Offline behavior? Number and roles of users? | Stack and deployment ADR |
| Data policy | Retention, real location handling, backups, access controls? | Real-data integration |
| Control scope | Monitoring only, or a separately reviewed control integration later? | Any command path design |
| Ownership/license | Sole owner or collaborators? Distribution plans? | Sharing or release |

## Proposed first demonstration

A user can view a synthetic aircraft record, replay its health telemetry, distinguish stale data from fresh data, and inspect a maintenance record. The demonstration is explicitly marked simulated and does not connect to or control an aircraft.

## Current M1 simulation-first prototype state

- Clear repository layout and starter contributor workflow.
- Draft scope, architecture, requirements, and staged roadmap.
- Versioned telemetry, aircraft, and maintenance contracts with valid synthetic examples.
- Repeatable local checks and a GitHub Actions workflow.
- Reference Management API with in-memory and PostgreSQL repository paths, transaction tests, maintenance, evidence, and ingestion outcomes.
- Opt-in authenticated/TLS WebSocket telemetry reference stream with bounded subscribers and resynchronization signaling.
- React/TypeScript management UI with synthetic fleet, telemetry, camera observation, RBAC, training, simulated autonomy, and Tracegate review surfaces.
- Expanded contributor, operator, API, validation, operations, release, and glossary documentation.

M2 read-only lab integration remains a future, separately reviewed milestone. No real aircraft connection, command path, field test, or production rollout is claimed by this prototype.
