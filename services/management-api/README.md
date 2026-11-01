# Management API — local reference implementation

This directory contains a dependency-light Python HTTP API for the M1 simulation-first milestone plus an opt-in PostgreSQL persistence implementation. It uses the repository’s JSON Schemas, a repository boundary, and synthetic/read-only boundaries.

**The default is not a production service.** In-memory mode has no durability, authentication/authorization, TLS, rate limiting, device identity, queue, or aircraft connection. PostgreSQL mode adds durable tables and transaction boundaries but is still not production-approved until security, backup/restore, pooling, retention, and source identity are reviewed. No mode exposes an aircraft command route.

## Run locally

From the repository root:

```bash
.venv/bin/python services/management-api/app.py
```

Configuration:

```bash
UCAS_API_HOST=127.0.0.1 UCAS_API_PORT=8000 UCAS_FRESH_AFTER_SECONDS=30 \
  .venv/bin/python services/management-api/app.py
```

The default seed aircraft is `sim-ucas-001`. The service binds to loopback by default.

### Offline Lattice observation scaffold

`UCAS_LATTICE_MODE=mock` (default) exposes static synthetic platform/sensor observations and an informational autonomous/sensor/effector category catalog. `offline` returns an empty observation list with the same catalog. All other modes are rejected; no Lattice credentials, SDK, external observation transport, or live fallback exist. Startup validates this setting before opening the HTTP listener. These observations never enter the aircraft inventory, telemetry store, stream, or training tasking. The frontend's [Observation workspace](../../docs/observation-workspace.md) reads a local overview, catalog, and capability maturity descriptions through a narrow development proxy. See the [integration guide](../../docs/lattice-readonly-integration.md) for public mappings, safety boundaries, and approved-access prerequisites.

The separate advisory assistance endpoint defaults to `UCAS_AI_MODE=local` and deterministic rules with zero provider requests. Actual model inference requires an explicitly configured loopback runtime and model. External AI requires a separate explicit mode, provider, data-export consent, model, and server-side secret; it is never a local-model fallback. See [local-first AI configuration and networking boundaries](../../docs/observation-assistance-networking.md). No model output can issue commands or modify readiness. Do not expose the reference API publicly; production read authorization and rate limits are absent.

For actual model dependencies and weights, follow the [optional local-model setup guide](../../docs/local-ai-setup.md): five independent groups, pinned HF sources/hashes, isolated CPU/CUDA environments and offline smoke tests. No weights download automatically. The local LLM timeout defaults to 45 seconds and is capped at 60; external requests retain a 2-second cap. Image/video runtimes remain standalone advisory smoke runners, not API media or aircraft-control routes.

## Real-time telemetry WebSocket stream

The local reference service can publish every telemetry ingestion outcome to a WebSocket listener beside the HTTP API. It is disabled by default. When enabled, JWT authentication and TLS are required unless `UCAS_STREAM_ALLOW_INSECURE=1` is explicitly set for local development:

```bash
UCAS_STREAM_ENABLED=1 \
  UCAS_STREAM_JWT_SECRET='use-a-secret-at-least-32-characters-long' \
  UCAS_STREAM_TLS_CERTFILE=/etc/ucas/tls/server.crt \
  UCAS_STREAM_TLS_KEYFILE=/etc/ucas/tls/server.key \
  UCAS_STREAM_HOST=127.0.0.1 UCAS_STREAM_PORT=8765 \
  .venv/bin/python services/management-api/app.py
```

Clients connect to `wss://127.0.0.1:8765/ws` and send `Authorization: Bearer <JWT>`. The token must use HS256 and contain `iss`, `aud`, `sub`, `iat`, `nbf`, `exp`, and the `telemetry:read` scope. Configure issuer/audience with `UCAS_STREAM_JWT_ISSUER` and `UCAS_STREAM_JWT_AUDIENCE`. Optional `aircraft_ids` and `sources` claims restrict the token to specific filters. A browser client that cannot set `Authorization` may send the token as a `bearer.<JWT>` WebSocket subprotocol; query-string tokens are rejected to avoid URL/log leakage.

Optional query filters are `aircraft_id` and `source`:

```text
wss://127.0.0.1:8765/ws?aircraft_id=sim-ucas-001&source=simulated
```

The first message is a `hello` frame. Telemetry frames use the versioned stream envelope:

```json
{
  "type": "telemetry",
  "event_id": "stream-...",
  "published_at": "2026-01-01T00:00:01Z",
  "aircraft_id": "sim-ucas-001",
  "source": "simulated",
  "source_id": "local-simulator",
  "sequence": 1,
  "sampled_at": "2026-01-01T00:00:00Z",
  "received_at": "2026-01-01T00:00:01Z",
  "status": "accepted",
  "sample": {"schema_version": "1.0", "...": "normalized telemetry"}
}
```

Accepted, late, and duplicate outcomes are published; duplicate frames intentionally omit the sample payload. Each subscriber has a bounded queue. If a slow client falls behind, it receives a `stream_gap` frame and must refetch `/api/v1/aircraft/{id}/telemetry/latest` and bounded history before trusting the live view. This is a resynchronization signal, not silent data loss.

TLS uses the configured server certificate/key with TLS 1.2 minimum. Optional mutual TLS is enabled with `UCAS_STREAM_TLS_REQUIRE_CLIENT_CERT=1` and `UCAS_STREAM_TLS_CAFILE=/etc/ucas/tls/clients-ca.crt`. The current implementation is an in-process hub suitable for one local/reference API process. It does not provide cross-process fanout, replay, or durable stream offsets. A multi-instance deployment must replace the hub with an authenticated broker or MQTT topic layer, retain the same event envelope, and define replay/retention semantics before real aircraft data is connected.

## PostgreSQL mode

Install the optional PostgreSQL dependency and apply migrations to an empty or approved native/local or managed PostgreSQL database:

```bash
.venv/bin/pip install -r requirements-prod.txt
UCAS_DATABASE_URL=postgresql://user:password@host:5432/ucas \
  .venv/bin/python services/management-api/migrate.py
UCAS_STORAGE=postgres UCAS_DATABASE_URL=postgresql://user:password@host:5432/ucas \
  .venv/bin/python services/management-api/app.py
```

The schema and design are documented in [ADR-0002](../../docs/decisions/0002-postgresql-persistence.md). PostgreSQL ingestion commits the ingestion outcome, history row, latest projection update, and evidence event in one transaction. The `telemetry_history.event_key` unique constraint is the database backstop for replay idempotency. `telemetry_latest` is rebuildable and is not the history source of truth.

Do not place `UCAS_DATABASE_URL` in Git, shell history, issue text, or client-side configuration. Use a least-privileged application role and a separate migration role in shared environments.

## Automated tests

The repository uses pytest for the full test runner. The unit/contract suite does not require PostgreSQL or Docker:

```bash
.venv/bin/pytest -q
```

The former 22-case Docker/Testcontainers PostgreSQL integration suite was deleted. There is no replacement automated database-integration coverage, and no Docker requirement. Use the migration and PostgreSQL storage commands above for an explicitly recorded manual check against a disposable native/local or approved managed database; do not describe that manual check as an automated integration pass.

## Endpoints

All JSON responses use an error envelope such as:

```json
{"error":{"code":"aircraft_not_found","message":"aircraft_id was not found"}}
```

Request bodies must be JSON objects no larger than 1,000,000 bytes. Non-standard
numeric constants (`NaN`, `Infinity`, `-Infinity`), numbers that overflow the
finite float range, and bodies exceeding the JSON parser's nesting capacity are
rejected with HTTP 400 and `invalid_json` before any repository writes. Regression
coverage lives in `tests/test_json_request_validation.py`.

| Method | Route | Purpose |
|---|---|---|
| GET | `/health` | Process health; reports selected storage and no aircraft-control path |
| GET | `/api/v1/aircraft?limit=&cursor=` | Paginated aircraft inventory |
| POST | `/api/v1/aircraft` | Add an aircraft inventory record |
| GET | `/api/v1/aircraft/{id}` | Aircraft detail |
| POST | `/api/v1/telemetry/ingest` | Validate and ingest a telemetry v1 sample; local source header `X-Source-ID` is accepted |
| GET | `/api/v1/aircraft/{id}/telemetry/latest` | Latest state plus `freshness`, age, source, and sequence |
| GET | `/api/v1/aircraft/{id}/telemetry?from=&to=&source=&limit=&cursor=` | Bounded, paginated telemetry history |
| GET | `/api/v1/aircraft/{id}/telemetry/ingestion-status` | Accepted/late/duplicate outcome counts |
| GET | `/api/v1/aircraft/{id}/evidence?limit=&cursor=` | Synthetic evidence records emitted for accepted/late telemetry |
| GET | `/api/v1/aircraft/{id}/maintenance?limit=&cursor=` | Paginated maintenance records |
| POST | `/api/v1/aircraft/{id}/maintenance` | Create a maintenance record |
| PATCH | `/api/v1/maintenance/{record_id}` | Update summary/status/completion/notes |
| WebSocket | `/ws?aircraft_id=&source=` on `UCAS_STREAM_PORT` | Filtered live telemetry and ingestion outcomes; opt-in reference stream |
| GET | `/api/v1/lattice/status` | Explicit offline/mock, disconnected and read-only diagnostics |
| GET | `/api/v1/lattice/catalog?limit=&cursor=` | Local informational platform categories, not callable capabilities |
| GET | `/api/v1/lattice/platforms?limit=&cursor=` | Synthetic entity observations, or empty in offline mode |
| GET | `/api/v1/lattice/platforms/{id}` | One synthetic observation; 404 if absent |
| GET | `/api/v1/lattice/overview` | Coherent snapshot, counts, data-quality attention, and source diagnostics |
| GET | `/api/v1/lattice/capabilities?limit=&cursor=` | Local-demo/design-only/excluded capability descriptions, not executable operations |
| GET | `/api/v1/local-ai/analyst/status` | Protected configuration status (not readiness proof) for the scene analyst local runtime |
| POST | `/api/v1/local-ai/analyst` | Protected, bounded ordering of pre-cited browser findings; explicit local/external mode, no fact authorship or executable tools; see [Scene analyst](../../docs/worldview-ai-analyst.md) |
| GET | `/api/v1/lattice/assistance` | Source-grounded advisory data-quality statements, actual engine/provider status, and data-export disclosure; no prompts or commands |

### Telemetry ingestion example

```bash
curl -sS -X POST http://127.0.0.1:8000/api/v1/telemetry/ingest \
  -H 'Content-Type: application/json' \
  -H 'X-Source-ID: local-simulator' \
  -d @packages/contracts/examples/telemetry.json
```

The service overwrites `received_at` with its own UTC receipt time. Duplicate event keys are idempotent; a late sample is retained with `late` status but cannot replace a newer latest view. Invalid samples are rejected with HTTP 400. `source=aircraft` is accepted by the contract for testing only; this server does not connect to an aircraft.

### Maintenance example

```bash
curl -sS -X POST http://127.0.0.1:8000/api/v1/aircraft/sim-ucas-001/maintenance \
  -H 'Content-Type: application/json' \
  -d '{"schema_version":"1.0","record_id":"maint-001","summary":"Synthetic inspection","status":"open","created_at":"2026-01-01T00:00:00Z"}'
```

Both storage modes validate maintenance PATCH requests against the same merged
record contract before writing. Empty patches, immutable/unknown fields, and
invalid values return HTTP 400 with `invalid_patch`. Moving to `completed`
without an existing or supplied completion timestamp generates a UTC timestamp;
explicit invalid timestamps are rejected. PostgreSQL locks the record during the
read/validate/update transaction, so rejected patches change neither the record
nor its version. This does not introduce a reviewed maintenance-state transition
policy or aircraft-readiness authorization.

## Implementation notes

- `app.py` owns HTTP routing, validation, pagination, freshness projection, and storage selection.
- `persistence.py` defines the repository boundary and the opt-in `PostgresStore`; `InMemoryStore` remains the default for local simulation/tests.
- `migrations/001_initial.sql` defines aircraft, source registration, history, ingestion outcomes, latest projection, maintenance, evidence, audit, and migration tables.
- The former `tests/integration/test_postgres_repository.py` Docker-backed verification suite was deleted; PostgreSQL storage remains opt-in but has no replacement automated database-integration coverage.
- `services/telemetry_stream/` owns the bounded in-process hub and WebSocket server used by the reference stream.
- `packages/contracts/v1/` remains the source of truth for payload shape; application rules such as aircraft existence, deduplication, ordering, and freshness are enforced in code.
- The store separates telemetry history, ingestion outcomes, latest-state calculation, maintenance, and evidence records so a durable implementation can replace it behind the same API.
- The evidence endpoint is deliberately minimal. Confidence/provenance, communications state, model lifecycle, and mission reconciliation fields from `docs/patent-derived-specifications.md` remain candidate contract extensions, not silently added to v1.

## Next production-hardening work

1. Apply ADR-0002 with an owner-approved operational validation strategy, pooling, and a tested projection rebuild; do not treat the deleted integration suite as current coverage.
2. Replace the reference HS256 secret distribution with a managed key/JWKS strategy and rotate keys without downtime.
3. Add source registration, replay protection, and audit events.
4. Define rate limits, queue/retry semantics, retention, backup/restore, and observability.
5. Add contract versions for confidence/provenance, communications, health prediction, and evidence after review.
6. Replace the local source header with authenticated adapter/device identity only after the controlled lab procedure is approved.

## Opt-in aircraft telemetry publishers

The separate [read-only aircraft gateway](../../docs/aircraft-integration.md) supports PX4 and ArduPilot MAVLink observations; the API itself has no aircraft control path. Without `UCAS_TELEMETRY_PUBLISHERS_FILE`, only simulated telemetry is accepted. Configuring this external JSON registry requires a scoped bearer token on every telemetry ingest and binds each publisher ID to permitted aircraft IDs and source categories. Unknown, revoked or mismatched publishers fail before writes. A broken configured registry returns 503, never anonymous fallback. This is local-lab authorization, not complete production identity or authentication of the MAVLink sender. Inventory, maintenance and read routes still require broader production access-control hardening.

Telemetry more than five seconds in the future is rejected. Server receipt time is canonical across history and stream. Version 1.1 adds session-aware autopilot observations with explicit unknown/stale health; version 1.0 retains its numeric baseline. See the [contracts guide](../../packages/contracts/README.md) before binding a live consumer.

## Opt-in public SAR browse relay

`GET /api/v1/public-imagery/sar/browse?product=<Sentinel-1 scene name>` is disabled unless `UCAS_PUBLIC_SAR_ENABLED=1`. It also requires `X-SignalWarden-SAR: enabled` and rejects foreign Origin/cross-site requests. It accepts no URLs, credentials, or observations, constructs a fixed ASF browse path, and follows only strictly validated ASF delivery redirects. No startup, health, or catalog read downloads imagery. Route this narrow prefix on the UI origin; public previews require no account/key. Image bytes are bounded and returned no-store/nosniff. See [SAR operation and limits](../../docs/worldview-sar-imagery.md) and [source/license verification](../../docs/worldview-sar-sources.md). This is unrelated to aircraft commands.
