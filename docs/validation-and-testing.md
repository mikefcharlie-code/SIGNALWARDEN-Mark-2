# Validation and testing guide

## Test layers

1. **Contract/design tests:** JSON Schema shape, RBAC catalog integrity, route declarations, persistence design markers, and Tracegate design behavior.
2. **Unit/reference tests:** Python service behavior, telemetry generator, WebSocket hub/auth/TLS, and Tracegate scenarios.
3. **Frontend checks:** TypeScript diagnostics, Vite production build, route manifest, and managed Preview inspection when UI changes are made.
4. **PostgreSQL storage (manual):** PostgreSQL remains a supported storage mode, but the former 22-case Docker/Testcontainers database-integration suite was deleted. There is no replacement automated database-integration coverage; use a disposable native/local or approved managed database only for explicitly recorded manual migration/storage checks.

## Commands

```bash
# fast local suite
.venv/bin/pytest -q

# Tracegate focused suite
.venv/bin/python -m unittest tests/test_tracegate_engine.py -v

# frontend
cd apps/management-web
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
```

## Evidence vocabulary

- **Passed:** command exited successfully and assertions completed.
- **Manual PostgreSQL check:** a migration or storage check run against a native/local or approved managed database; this is not automated integration coverage and must not be reported as a test-suite pass.
- **Reference validation:** demonstrates local behavior only and does not validate aircraft safety, regulatory compliance, production security, or hardware compatibility.
- **Manual boundary validation:** demonstrates a boundary under an explicitly recorded local or managed fixture; it does not prove deployment readiness.

## Change evidence

A pull request should state the commands run, any manual PostgreSQL migration/storage check and its database context, changed contracts, updated docs, unresolved risks, and any manual Preview inspection. Never use a screenshot or green CI run as a substitute for a safety case or operational authorization.

## Evidence copilot checks

Run `python -m pytest -q tests/test_observation_evidence.py tests/test_observation_assistance.py tests/test_lattice_api.py` for deterministic assessment, record/timestamp citations, source disagreement, stale/missing/untrusted data, mocked model boundaries, no-model behavior, and read-only HTTP contracts. Run `pnpm test` from `apps/management-web` for browser-state validation, bounded network reads, outage/return comparison, deduplication, and source-version/removal guards; also run typecheck and the production build.

For a manual local browser check, open `/observations`, inspect the explicitly synthetic conflict and follow its citations. Confirm that exact values, original source times, trust, and unknowns are readable. Temporarily stop only the review API, refresh, and verify the retained snapshot is marked unverified. Restart the same local API, refresh again, and inspect the return digest: API availability must not turn old fixture data into current or recovered observations. Test a configured but unavailable loopback model and verify the interface reports deterministic rules, not successful inference or external fallback. Never enable a real external provider merely to run these checks.

See the [copilot guide](evidence-copilot.md) for assumptions and memory-only recovery limits. Unit/model mocks and a stopped-local-API check do not establish field outage resilience, installed-model quality, live transport compatibility, or production authorization.
