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

The v1 API intentionally has no aircraft command, mission, route, autonomy, gimbal, payload, or live-camera control endpoint.

The operational-event contract is review-oriented. It carries severity, lifecycle status, entity identity, correlation, and scalar attributes for management conditions; it cannot represent commands, routes, targeting, payload actions, or aircraft-control instructions.

## Storage modes

- **In-memory:** default local/reference mode; reset on process restart.
- **PostgreSQL:** opt-in durable repository with migration `001_initial.sql`, transaction boundaries, history, latest projection, ingestion outcomes, maintenance, evidence, and audit tables.

Durable storage does not make the service production-approved. Authentication, authorization, pooling, backup/restore, retention, key management, observability, and deployment review remain required.

## Telemetry stream

The opt-in WebSocket stream publishes accepted, late, and duplicate ingestion outcomes through a bounded in-process hub. Enabled deployments require JWT validation and TLS unless the explicitly named local insecure override is used. Slow clients receive a `stream_gap` message and must refetch latest state and bounded history before trusting the live view.

The browser Camera Wall is not a stream client in this reference build. It renders synthetic observation records. A future video gateway must authenticate every camera session server-side and must not expose device credentials to the browser.

## Contract change rules

Schemas reject unknown properties and use major-version directories. Compatible additions require deliberate review; breaking changes require a new major version. Schema validation does not enforce application rules such as authorization, aircraft existence, deduplication, ordering, freshness, retention, or source identity.
