# Validation and testing guide

## Test layers

1. **Contract/design tests:** JSON Schema shape, RBAC catalog integrity, route declarations, persistence design markers, and Tracegate design behavior.
2. **Unit/reference tests:** Python service behavior, telemetry generator, WebSocket hub/auth/TLS, and Tracegate scenarios.
3. **Frontend checks:** TypeScript diagnostics, Vite production build, route manifest, and managed Preview inspection when UI changes are made.
4. **Database integration:** Testcontainers starts PostgreSQL, applies migrations, verifies transactions, idempotency, projections, maintenance, and rollback.

## Commands

```bash
# fast local suite
.venv/bin/pytest -q -m 'not integration'

# Tracegate focused suite
.venv/bin/python -m unittest tests/test_tracegate_engine.py -v

# database-backed suite; requires Docker
.venv/bin/pytest -q -m integration tests/integration/test_postgres_repository.py

# frontend
cd apps/management-web
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
```

## Evidence vocabulary

- **Passed:** command exited successfully and assertions completed.
- **Skipped:** a test was intentionally not run, usually because Docker is unavailable; it is not a pass.
- **Reference validation:** demonstrates local behavior only and does not validate aircraft safety, regulatory compliance, production security, or hardware compatibility.
- **Integration validation:** demonstrates a boundary under the declared test fixture; it does not prove deployment readiness.

## Change evidence

A pull request should state the commands run, whether integration tests ran or skipped, changed contracts, updated docs, unresolved risks, and any manual Preview inspection. Never use a screenshot or green CI run as a substitute for a safety case or operational authorization.
