# ADR-0002: PostgreSQL persistence for the Management API

**Status:** proposed implementation baseline; production deployment approval pending.

## Context

The M1 API currently uses an in-memory store. It loses aircraft, telemetry, maintenance, ingestion outcomes, and evidence records on restart, and the HTTP handlers access some store details directly. The architecture requires durable telemetry history, a rebuildable latest projection, ingestion outcome visibility, maintenance records, evidence, source registration, and auditability.

## Decision

Use PostgreSQL as the first durable-storage target behind a repository/persistence boundary. Keep the in-memory store for local simulation and tests. Select PostgreSQL at runtime only with:

```bash
UCAS_STORAGE=postgres UCAS_DATABASE_URL=postgresql://... \
  .venv/bin/python services/management-api/app.py
```

Install the optional production dependency first:

```bash
.venv/bin/pip install -r requirements-prod.txt
```

Apply numbered migrations with:

```bash
UCAS_DATABASE_URL=postgresql://... \
  .venv/bin/python services/management-api/migrate.py
```

The migration is `services/management-api/migrations/001_initial.sql`.

## Logical schema

- `aircraft`: stable inventory identity and lifecycle.
- `source_registrations`: allowed aircraft/source/environment mapping and future device identity.
- `telemetry_history`: append-oriented accepted/late/out-of-order samples with JSON payload and unique event key.
- `telemetry_ingestion_outcomes`: every ingestion attempt, including duplicates and rejection/outcome metadata.
- `telemetry_latest`: query-optimized current projection keyed by aircraft/source; rebuildable from history.
- `maintenance_records`: human-managed records with version and status constraints.
- `evidence_events`: append-oriented evidence references and integrity metadata.
- `audit_events`: management/service changes and actor/request context.
- `schema_migrations`: migration bookkeeping.

Payloads remain JSONB because the versioned repository contracts are the source of truth and candidate patent-derived extensions are still evolving. High-value query dimensions have typed columns and indexes: aircraft, source, sequence, sampled/received times, status, and event identity. Revisit typed columns after usage and query requirements are measured.

## Transaction and consistency rules

### Telemetry ingestion

One PostgreSQL transaction performs:

1. aircraft existence check;
2. current latest lookup;
3. duplicate/event-key check;
4. ingestion outcome insert;
5. history insert for non-duplicates;
6. latest projection upsert only when the sample wins the ordering rule;
7. evidence event insert.

If any step fails, the transaction rolls back. Duplicate attempts are recorded as outcomes but do not create a second history row or advance latest state. The unique `telemetry_history.event_key` is the database backstop for idempotency.

The current reference code is intentionally synchronous. A queue/outbox or `LISTEN/NOTIFY` path should be added only after delivery/latency requirements justify it. If a queue is introduced, use an outbox or deterministic idempotency key so retries cannot create duplicate accepted history.

### Latest projection

`telemetry_history` is the durable source of truth. `telemetry_latest` is a projection for fast reads. Its update predicate compares `sampled_at`; a late sample is retained but cannot replace a newer latest state. A rebuild job can truncate/recompute the projection from the newest sample per `(aircraft_id, source)`.

### Maintenance

Maintenance writes should become an API transaction that updates the record, increments `version`, and inserts an `audit_events` row with actor/request context. The current repository method covers record persistence; actor authentication and audit insertion remain service hardening work.

## Index and retention strategy

- Use `(aircraft_id, sampled_at DESC, sequence DESC)` for history queries.
- Use `(aircraft_id, source, sampled_at DESC, sequence DESC)` for source-filtered history.
- Use unique `event_key` for replay protection.
- Use `(aircraft_id, received_at DESC)` for ingestion/evidence timelines.
- Keep JSONB GIN indexing only while query needs justify its write/storage cost.
- Start with one PostgreSQL database and separate tables. Consider time partitioning for `telemetry_history` only after measured volume/retention requires it.
- Define retention by environment: simulation may be disposable; lab/production telemetry and evidence need owner-approved retention, export, backup, and deletion rules.

No retention period, fleet size, ingest rate, RPO, RTO, or availability target has been invented by this ADR.

## Migration and cutover plan

1. Apply `001_initial.sql` to a new empty database.
2. Seed the simulation aircraft and source registration through an explicit seed command or migration; do not copy local in-memory state implicitly.
3. Run contract fixtures and repository integration tests against PostgreSQL.
4. Run dual-read comparison in a non-production environment: memory versus PostgreSQL for inventory, latest/history, status, maintenance, and evidence.
5. Enable PostgreSQL behind `UCAS_STORAGE=postgres` for the local management API.
6. Verify restart durability, duplicate replay, late ordering, transaction rollback, projection rebuild, backup, and restore.
7. Only then consider real lab telemetry, with authentication/source registration and the reviewed controlled-bench procedure.

There is no live database, credential, cloud resource, or real telemetry migration performed by this change.

## Failure behavior

- Database connection failure: fail health/readiness and do not claim telemetry freshness.
- Telemetry transaction failure: do not acknowledge persistence; retry policy must be explicit and idempotent.
- Projection failure after history commit: expose projection lag/degraded state and rebuild from history; do not report latest as fresh without a current projection.
- Migration failure: stop deployment; do not run partially applied application code against an unknown schema.
- Backup/restore failure: block real-data deployment until tested evidence exists.

## Alternatives considered

- SQLite: useful for a single-process demo but weaker as the intended shared durable system and less representative of expected concurrency/operations.
- Document database: flexible payloads but weaker fit for relational integrity, source registration, maintenance/audit relationships, and transaction requirements.
- Managed event store/stream first: premature before ingest volume, replay, and operational requirements are known.

## Consequences

The service gains durable relational integrity and explicit transaction semantics, while the API can remain contract-compatible. Operations gain migrations, backups, connection management, monitoring, and schema-change responsibilities. JSONB payload evolution still requires contract versioning and query discipline.

## Open approvals

- Confirm PostgreSQL version/provider and connection/pooling approach.
- Select authentication/authorization and database roles; application must not use a superuser.
- Define backup encryption, retention, restore tests, and environment isolation.
- Define telemetry/evidence retention and any privacy/location policy before real data.
- Add an authenticated source-registration workflow before aircraft adapters.
- Add audit writes for all management mutations before shared deployment.
