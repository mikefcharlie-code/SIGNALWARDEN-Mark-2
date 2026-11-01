# ADR-0003 — Borrow safe open-source patterns without importing control paths

- **Status:** Proposed for owner review
- **Date:** 2026-10-21
- **Scope:** Management UI, telemetry reference services, simulation, RBAC, Tracegate, and future read-only lab integration

## Context

The repository has reached an M1 simulation-first prototype. Mature open-source projects provide useful patterns for telemetry pipelines, digital-twin schemas, relationship-based authorization, dashboards, operational events, and fleet adapters. Some adjacent drone and robotics projects also contain live control, navigation, or autonomy code that is outside this repository’s approved boundary.

## Decision

Adopt the *patterns* from OpenTelemetry Collector, OpenFGA, Digital Twins Definition Language, Grafana, OpenObserve, and Open-RMF as documented in [open-source patterns](../open-source-patterns.md). Do not add those projects as runtime dependencies in M1. Prefer small local contracts, fixtures, tests, and explainable boundaries until an owner-approved integration requirement justifies a dependency.

The immediate design direction is:

- staged telemetry processing with explicit validation, normalization, persistence, projection, and publish stages;
- a versioned, simulation-only twin model with explicit relationships and capabilities;
- relationship-oriented RBAC decisions with allow/deny explanations and scoped test fixtures;
- dashboard panels and annotations derived from queryable state and event records;
- a bounded operational-event and incident-review vocabulary;
- a future read-only adapter boundary that remains separate from flight-control responsibilities.

## Rejected alternatives

Importing a drone ground-control station, autopilot SDK, radio protocol, mission planner, navigation stack, target-selection system, weapons function, or autonomous vehicle command path was rejected. These would expand the system into real-world control or military C2 rather than improve the safe management reference prototype.

Adding a large observability or authorization platform immediately was also rejected because deployment, data retention, identity ownership, scale, and operational support are not yet selected.

## Consequences

This approach keeps the repository dependency-light and makes the selected ideas testable in the existing Python/React/PostgreSQL/WebSocket stack. It also creates deliberate follow-up work: define the operational-event contract, add authorization-decision fixtures, and document pipeline-stage evidence. These are candidate M1/M2 improvements, not claims of production readiness.

## Evidence

See [open-source patterns and safe reuse](../open-source-patterns.md) for source links and feature mapping. PostgreSQL storage remains supported through native/local or managed deployments, but the former 22-case Docker/Testcontainers database-integration suite was deleted and has no replacement automated coverage. Validation must distinguish automated checks from explicitly recorded manual database, hardware, and aircraft checks.
