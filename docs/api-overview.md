# API and integration overview

## Management API

The local reference HTTP service lives in `services/management-api/app.py`. It serves inventory, telemetry ingestion and projections, maintenance, evidence, and health endpoints. The complete endpoint table and startup commands are in the [management API README](../services/management-api/README.md).

### Endpoint groups

| Group | Routes | Contract/source |
|---|---|---|
| Health | `GET /health` | Runtime diagnostics; reports storage mode and no-control boundary |
| Aircraft | `/api/v1/aircraft` | [`aircraft.schema.json`](../packages/contracts/v1/aircraft.schema.json) |
| Telemetry | `/api/v1/telemetry/ingest`, aircraft telemetry routes | [`telemetry.schema.json`](../packages/contracts/v1/telemetry.schema.json) |
| Maintenance | aircraft maintenance collection and record patch | [`maintenance.schema.json`](../packages/contracts/v1/maintenance.schema.json) |
| Evidence | aircraft evidence collection | Reference output; not certification evidence |
| Operational events | bounded review events such as stale data, stream gaps, maintenance watch, and access conflicts | [`operational-event.schema.json`](../packages/contracts/v1/operational-event.schema.json) |
| Live stream | WebSocket `/ws` on the configured stream port | Versioned event envelope documented in the API README |
| Lattice scaffold | GET-only `/api/v1/lattice/status`, `/catalog`, `/platforms`, `/platforms/{id}`, `/overview`, `/capabilities`, `/assistance` | [Offline/mock observations and informational catalog](lattice-readonly-integration.md), [workspace snapshots and capability maturity](observation-workspace.md); no live Lattice connection. [AI assistance](observation-assistance-networking.md) is local-first, with external calls separately opted in |

The v1 API intentionally has no aircraft command, mission, route, autonomy, gimbal, payload, or live-camera control endpoint.

The operational-event contract is review-oriented. It carries severity, lifecycle status, entity identity, correlation, and scalar attributes for management conditions; it cannot represent commands, routes, targeting, payload actions, or aircraft-control instructions.

### Latest telemetry is not a connectivity heartbeat

The latest telemetry response preserves `sample` as the original historical snapshot and adds query-time freshness metadata, identically for in-memory and PostgreSQL storage:

- `snapshot_freshness`: snapshot timestamp within `UCAS_FRESH_AFTER_SECONDS` (default 30 seconds), independent of aircraft connectivity. Both stores use the same finite positive configuration parser; invalid values fail stale.
- `connectivity`: `live`, `stale`, or `unknown`, calculated from original heartbeat age plus elapsed time and the gateway's recorded heartbeat timeout. This means recent observation, not authenticated sender identity or guaranteed current radio connectivity.
- `effective_ages`: current ages for `heartbeat`, `battery`, `system_status`, `position`, `attitude`, and `gps`. Ages are seconds or null. Elapsed time is the greater of nonnegative time since snapshot and since API receipt, so delayed delivery cannot renew observation ages.
- `field_freshness`: `fresh`, `stale`, `unknown`, or `missing` for battery, system-status and sensor groups, against the gateway's recorded field timeout. A fresh observation may still carry unknown/null measurements. Battery observation age also covers battery-fault reports without numeric readings; it is not a statement that every battery measurement is available.
- Compatibility `freshness`: for schema 1.1, never `fresh` when heartbeat connectivity is stale/unknown; for legacy schema 1.0, the existing snapshot-only behavior remains. Missing observation metadata in older 1.1 snapshots yields unknown connectivity rather than an invented timeout.

`telemetry_trust` is separately `untrusted` (including missing/legacy metadata), `signature-verified`, or `transport-asserted`; `flight_ready` is always false, including missing-sample views. A fresh/live unsigned lab sample is still untrusted. Signature/transport assertions require a bearer-authenticated publisher explicitly authorized for that ingress policy in server configuration (`ingress_policies`); the open synthetic endpoint cannot self-label as authenticated. The API authenticates the configured gateway's assertion, not the aircraft signature itself. `transport-asserted` is a deployment assertion, not a packet-signature result or automatic VPN check. See [ingress security](telemetry-ingress-security.md).

Deadlines are inclusive and computed with fractional seconds. Raw `sample.health`, `sample.autopilot`, and nested original ages are **not rewritten** on reads; consumers must use effective metadata and never display the raw historical armed/health values as current by themselves. System sensor warnings and selected-battery warnings have distinct observation ages; heartbeat warnings use the heartbeat age. Stream/history envelopes remain historical observations and require elapsed-age checks on the consumer, not just their arrival time. Future timestamps tolerated by ingestion introduce bounded clock uncertainty; this is not synchronized aircraft measurement time, authenticated telemetry or a real-time safety guarantee.

## Storage modes

- **In-memory:** default local/reference mode; reset on process restart.
- **PostgreSQL:** opt-in durable repository with migration `001_initial.sql`, transaction boundaries, history, latest projection, ingestion outcomes, maintenance, evidence, and audit tables.

Durable storage does not make the service production-approved. Authentication, authorization, pooling, backup/restore, retention, key management, observability, and deployment review remain required.

## Telemetry stream

The opt-in WebSocket stream publishes accepted, late, and duplicate ingestion outcomes through a bounded in-process hub. Enabled deployments require JWT validation and TLS unless the explicitly named local insecure override is used. Slow clients receive a `stream_gap` message and must refetch latest state and bounded history before trusting the live view.

The browser Camera Wall is not a stream client in this reference build. It renders synthetic observation records. A future video gateway must authenticate every camera session server-side and must not expose device credentials to the browser.

## Contract change rules

Schemas reject unknown properties and use major-version directories. Compatible additions require deliberate review; breaking changes require a new major version. Schema validation does not enforce application rules such as authorization, aircraft existence, deduplication, ordering, freshness, retention, or source identity.
