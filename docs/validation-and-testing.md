# Validation and testing guide

## Test layers

1. **Contract/design tests:** JSON Schema shape, RBAC catalog integrity, route declarations, persistence design markers, and Tracegate design behavior.
2. **Unit/reference tests:** Python service behavior, telemetry generator, WebSocket hub/auth/TLS, and Tracegate scenarios.
3. **Frontend checks:** TypeScript diagnostics, Vite production build, route manifest, and managed Preview inspection when UI changes are made.
4. **PostgreSQL storage (opt-in integration):** PostgreSQL remains a supported storage mode. The durable repository suite is marked `integration`, requires `UCAS_DATABASE_URL`, and must target a disposable database. It skips when no DSN is configured; a skip is not a pass.

## Commands

```bash
# fast local suite
.venv/bin/pytest -q -m 'not integration'

# opt-in durable-storage suite (disposable PostgreSQL only)
UCAS_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/ucas_test \
  .venv/bin/python services/management-api/migrate.py
UCAS_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/ucas_test \
  .venv/bin/pytest -q -m integration

# Tracegate focused suite
.venv/bin/python -m unittest tests/test_tracegate_engine.py -v

# deterministic end-to-end simulation bundle
.venv/bin/python scripts/run_reference_demo.py

# frontend
cd apps/management-web
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
```

## Evidence vocabulary

- **Passed:** command exited successfully and assertions completed.
- **PostgreSQL integration pass:** the marked suite completed against the explicitly configured disposable `UCAS_DATABASE_URL`; migration and repository assertions ran against durable tables.
- **PostgreSQL integration skip:** no DSN was configured, so no durable-storage assertions ran. This is not a pass.
- **Reference validation:** demonstrates local behavior only and does not validate aircraft safety, regulatory compliance, production security, or hardware compatibility.
- **Phase 3 demo evidence:** the deterministic bundle must show accepted, late, duplicate, and malformed telemetry handling, one synthetic maintenance record, one schema-valid operational event, and a Tracegate result. Its safety fields must remain false for external-system use and aircraft/simulator commands.
- **Manual boundary validation:** demonstrates a boundary under an explicitly recorded local or managed fixture; it does not prove deployment readiness.

## Change evidence

A pull request should state the commands run, any manual PostgreSQL migration/storage check and its database context, changed contracts, updated docs, unresolved risks, and any manual Preview inspection. Never use a screenshot or green CI run as a substitute for a safety case or operational authorization.

## Evidence copilot checks

Run `python -m pytest -q tests/test_observation_evidence.py tests/test_observation_assistance.py tests/test_lattice_api.py` for deterministic assessment, record/timestamp citations, source disagreement, stale/missing/untrusted data, mocked model boundaries, no-model behavior, and read-only HTTP contracts. Run `pnpm test` from `apps/management-web` for browser-state validation, bounded network reads, outage/return comparison, deduplication, and source-version/removal guards; also run typecheck and the production build.

For a manual local browser check, open `/observations`, inspect the explicitly synthetic conflict and follow its citations. Confirm that exact values, original source times, trust, and unknowns are readable. Temporarily stop only the review API, refresh, and verify the retained snapshot is marked unverified. Restart the same local API, refresh again, and inspect the return digest: API availability must not turn old fixture data into current or recovered observations. Test a configured but unavailable loopback model and verify the interface reports deterministic rules, not successful inference or external fallback. Never enable a real external provider merely to run these checks.

See the [copilot guide](evidence-copilot.md) for assumptions and memory-only recovery limits. Unit/model mocks and a stopped-local-API check do not establish field outage resilience, installed-model quality, live transport compatibility, or production authorization.
