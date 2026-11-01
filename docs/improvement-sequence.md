# Improvement sequence

This branch, `improvement/reliability-security-hardening`, is the working line for the next repository-improvement cycle. It starts from `main` at commit `b68d913` and follows the sequence below. Each phase should land as a reviewable, evidence-backed change; later phases must not imply that an earlier phase is complete without its required evidence.

**Current status:** Phase 1 is complete on this branch. Phase 2 remains open until its CI PostgreSQL job passes. Phase 3 is complete: the deterministic local evidence-bundle demo, regression test, documented command, and byte-for-byte repeatability evidence are present.

## Product profiles and scope

Before implementation work expands, keep the repository organized around three profiles:

- **Simulation:** synthetic telemetry, digital-twin training, Tracegate, and mock state changes that remain local to the simulation.
- **Passive lab:** receive-only telemetry behind reviewed adapters and shared contracts; no transmission, mission upload, targeting, payload, weapon, or flight-control path.
- **Production:** not implemented and not authorized by this repository.

Every new feature must identify its profile, data source, authorization boundary, and evidence status. UI labeling is not sufficient authorization; server-side policy remains authoritative for any production-bound claim.

## Ordered phases

### 1. Reconcile M1/M2 documentation and release language

Align `README.md`, `docs/roadmap.md`, aircraft-integration guidance, flight-readiness guidance, and the release checklist. State clearly that the current product is simulation-first; passive adapter code is a separately reviewed boundary; and no receive-only adapter implies flight readiness or production authorization.

**Exit evidence:** documentation links agree on milestone status, profile definitions, and explicit exclusions.

### 2. Restore durable-database integration coverage

Reintroduce an opt-in PostgreSQL integration profile using Testcontainers, a CI PostgreSQL service, or an equivalent approved environment. Cover migrations, commit/rollback, duplicate and out-of-order telemetry, maintenance and evidence persistence, concurrent repository access, and restart/recovery behavior. Keep fast in-memory tests separate from durable-storage evidence.

**Exit evidence:** the integration profile passes in its declared environment, and skipped runs are reported as skipped rather than passed.

### 3. Add a deterministic end-to-end simulation demonstration

Add a repeatable local demo that generates synthetic telemetry, exercises valid/delayed/duplicate/malformed ingestion, records a maintenance event and operational event, runs Tracegate, and writes a machine-readable evidence bundle to a temporary directory. It must terminate without external systems or real operational data.

**Exit evidence:** a documented command produces a deterministic summary, telemetry fixture, operational-event output, and Tracegate result.

**Completion evidence:** `.venv/bin/python scripts/run_reference_demo.py` was run twice with identical output artifacts; the focused Phase 3/contract/Tracegate suite passed 13 tests. The generated summary records accepted, late, duplicate, and malformed telemetry handling, one maintenance record, a schema-valid operational event, a Tracegate result, and false external-system/aircraft-command safety flags.

### 4. Centralize server-side RBAC enforcement

Create one deny-by-default policy path for management endpoints. Add scope-aware organization/site/fleet/aircraft checks, structured allow/deny explanations, and audit records for expired, suspended, conflicting, and missing assignments. Treat frontend personas as demo presentation only; they must not grant access.

**Exit evidence:** endpoint-level tests prove that changing browser state cannot bypass backend authorization.

### 5. Add the threat model and security evidence package

Document trust boundaries and threats for token replay, WebSocket authentication, telemetry spoofing, stale data, browser/device separation, local-AI export, provider access, uploads, and dependency/model supply chain. Add practical CI checks for secrets, dependency vulnerabilities, and an SBOM where supported.

**Exit evidence:** the security-control matrix maps each material threat to an implemented control, test, or explicitly accepted gap.

### 6. Formalize HTTP and WebSocket contracts

Add a machine-readable HTTP contract and documented WebSocket envelope. Include accepted, delayed, duplicate, rejected, stale, and error examples; error codes; correlation IDs; pagination/filtering; and compatibility/versioning rules. Contract tests should cover both backend behavior and representative frontend consumption.

**Exit evidence:** generated or checked-in contract artifacts match the implemented endpoints and stream messages.

### 7. Refactor the frontend into feature boundaries

Gradually separate application shell, routing, personas, shared status/freshness components, API clients, safety-boundary banners, and feature modules for fleet, telemetry, observations, World View, reports, local AI, training, and access. Preserve existing behavior while reducing central integration risk.

**Exit evidence:** feature modules have clear ownership and the existing frontend tests/build remain green.

### 8. Improve accessibility and initial-load performance

Add keyboard/focus coverage, non-color status cues, reduced-motion behavior, screen-reader labels for maps/charts/camera tiles, responsive checks, and a measurable initial-load budget. Lazy-load World View, analyst, provider, and local-AI code that is not needed on the default fleet route.

**Exit evidence:** accessibility checks and performance measurements are recorded; warnings are either resolved or documented with rationale.

### 9. Prepare release and ownership materials

Choose or explicitly defer licensing, add a changelog and versioning policy, document supported toolchains, name ownership/security contacts, and complete the release checklist. Record all skipped hardware, database, or lab checks without presenting them as passes.

**Exit evidence:** a reviewer can reproduce the supported local checks and identify the owner, scope, limitations, and evidence for the release.

## Guardrails

This branch must not add real-world aircraft commands, mission execution, targeting, payload control, weapons functionality, autonomous vehicle-control paths, device credentials, live operational traces, or browser-to-device connections. Receive-only telemetry remains observational and must stay separate from flight-control responsibility.
