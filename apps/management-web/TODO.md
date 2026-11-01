# UCAS Management Web UI — delivery checklist

## Role-aware application shell and navigation

- [x] Provide a React/TypeScript application shell with Fleet, Live Monitor, Maintenance, Access, Audit, and Profile navigation.
- [x] Show role-aware navigation for telemetry viewers, drone operators, access administrators, and system administrators while treating server authorization as authoritative.
- [x] Never expose aircraft commands, autonomy authorization, device credentials, or direct browser-to-aircraft connections.

## Fleet, telemetry, and maintenance surfaces

- [x] Show synthetic aircraft inventory, assignment scope, availability, operational status, and a persistent simulated-data label.
- [x] Show synthetic live telemetry metrics, freshness indicators, connection status, explicit stale-data presentation, and no command controls.
- [x] Show maintenance condition, due items, history summaries, and unavailable or suspended aircraft states.

## Multi-camera video observation

- [x] Provide a Camera Wall route showing all six synthetic camera channels for the selected aircraft: forward EO, downward EO, forward IR, port EO, starboard EO, and rear EO.
- [x] Show per-feed freshness, signal health, resolution, frame rate, state, stale/degraded treatment, selectable focus, and a live synthetic frame counter.
- [x] Keep video read-only and visibly separate from aircraft command, gimbal, radio, flight-controller, and device-credential paths.

## Disconnected simulation and training C2

- [x] Provide a Training C2 route that operates only on an in-memory digital twin with a scenario clock, deterministic state, safe training-zone map, and resettable aircraft state.
- [x] Provide mock flight-phase and navigation-intent controls for taxi, simulated takeoff, simulated landing, altitude, heading, hold, and return-to-home rehearsal; each action must be visibly labeled as synthetic and local.
- [x] Show preflight safety gates proving digital-twin selection, closed transport, limited command scope, audit activity, synthetic geofence, and unavailable aircraft control path.
- [x] Record every mock command in a scenario-timestamped rehearsal queue while preserving the hard boundary against radios, autopilots, gimbals, payloads, device credentials, and real-aircraft identifiers.

## Tracegate evidence-readiness feature

- [x] Include Tracegate as a review-only, deterministic change-to-proof-obligation feature in Training C2.
- [x] Show impact closure, affected requirements, selected tests, policy version, review-required state, and explicit informational-only language.
- [x] Keep Tracegate disconnected from flight, simulator transport, release authorization, safety certification, and aircraft command paths.

## Simulated autonomous operations

- [x] Provide four browser-local autonomy rehearsal modes: supervised autonomy, bounded-route execution, degraded-link recovery, and sensor-confidence hold.
- [x] Provide mode lifecycle management with start, pause, reset, injected review event, synthetic geofence, route checkpoints, and explicit `Ready`, `Running`, `Paused`, and `Review` states.
- [x] Show an invented, clearly labeled synthetic map with no GPS or live aircraft coordinates, and preserve the boundary that no autonomy state, route, recovery action, or mode can leave the digital twin.

## RBAC and permission management

- [x] Review synthetic users, roles, scopes, assignments, effective permissions, status, and expiry.
- [x] Source role and permission reference data from `public/rbac-catalog.json`, synchronized from `packages/contracts/v1/rbac-catalog.json`, without duplicating permission definitions in UI code.
- [x] Provide permission-change workflows with review/confirmation feedback and denied, expired, suspended, and concurrent-conflict outcomes.
- [x] Represent audit metadata without displaying tokens, JWT payloads, private keys, passwords, or authorization headers.

## Resilient state treatment

- [x] Implement consistent loading, empty, denied, expired, suspended, stale, conflict, and backend-failure states.
- [x] Keep synthetic data visibly labeled as simulation in fleet, telemetry, maintenance, and access views.

## Verification and delivery

- [x] Configure TypeScript diagnostics and build tooling.
- [x] Serve `/manus-routes.json` with the complete frontend route set.
- [x] Run typecheck and production build checks.
- [x] Start Preview on the configured port and verify readiness.
- [x] Save a checkpoint to the managed project Git repository.
