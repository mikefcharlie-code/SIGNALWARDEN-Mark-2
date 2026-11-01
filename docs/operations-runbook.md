# Local operations runbook

## Start a management API demo

```bash
.venv/bin/python services/management-api/app.py
curl -fsS http://127.0.0.1:8000/health
```

The default service is loopback-bound and uses in-memory storage. It should report the selected storage and the absence of an aircraft-control path.

## Generate synthetic telemetry

```bash
.venv/bin/python simulation/generate_telemetry.py --count 20 > /tmp/ucas-telemetry.ndjson
```

Do not replace synthetic values with real coordinates or identifiers. Use the example payloads under `packages/contracts/examples/` for API exercises.

## Start the frontend

```bash
cd apps/management-web
pnpm install --frozen-lockfile
pnpm dev
```

Open `/training` to inspect the digital-twin console. Reload or use **Reset twin** to clear local state.

## PostgreSQL reference mode

Use the migration runner only against an approved disposable or development database. Keep `UCAS_DATABASE_URL` out of Git, shell history, issue text, and browser configuration. See [management API README](../services/management-api/README.md) and [ADR-0002](decisions/0002-postgresql-persistence.md).

## Stream troubleshooting

The WebSocket stream is disabled by default. When enabled, verify JWT issuer, audience, scope, expiry, TLS certificate/key, and optional client-certificate settings. A `stream_gap` message requires a latest-state and bounded-history refetch. Do not solve a stream problem by disabling authorization or TLS outside a local disposable test.

## Stop and clean up

Stop local processes, remove temporary NDJSON fixtures, and ensure `git status --short` does not show generated or sensitive files. Do not delete shared databases or alter remote infrastructure from this reference runbook.
