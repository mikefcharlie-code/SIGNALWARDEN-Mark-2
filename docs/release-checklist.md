# Release checklist

Use this checklist for a repository milestone, demo handoff, or published reference build. A completed checklist records evidence for the declared scope; it does not authorize flight, field use, or production operations.

## Scope and safety boundary

- [ ] The change has a linked issue, requirement IDs, and an explicit scope/exclusion statement.
- [ ] All aircraft, telemetry, video, map, autonomy, and user records used for review are synthetic or approved lab fixtures.
- [ ] No flight-control, radio, autopilot, gimbal, payload, device-credential, weapons, target-selection, or tactical-command path was added.
- [ ] Training C2, simulated autonomy, and Tracegate remain disconnected from real aircraft and are visibly labeled as simulation or review-only.
- [ ] Any new integration boundary has a reviewed ADR, threat model, owner, and rollback/disable procedure.

## Contracts and backend

- [ ] Changed schemas, examples, API references, and compatibility notes agree.
- [ ] Unknown properties, invalid timestamps, invalid ranges, duplicate/replay handling, late data, and freshness behavior are covered by tests where relevant.
- [ ] Authorization is enforced at the service boundary for every changed route, stream, export, camera session, or administrative mutation; UI hiding is not treated as authorization.
- [ ] Durable-storage changes include migration, transaction, rollback, retention, backup/restore, and projection-rebuild considerations.
- [ ] Stream changes preserve authentication, TLS, bounded-client behavior, `stream_gap` resynchronization, and no query-string token policy.

## Frontend and operator experience

- [ ] TypeScript diagnostics and production build pass.
- [ ] `/manus-routes.json` lists every page route and contains no API or asset routes.
- [ ] Loading, empty, denied, expired, suspended, stale, conflict, and backend-failure states remain understandable where applicable.
- [ ] Synthetic data labels, freshness indicators, read-only language, and unavailable-control language remain visible.
- [ ] The UI does not display tokens, JWT payloads, private keys, passwords, authorization headers, real coordinates, or private operational logs.

## Validation evidence

- [ ] `.venv/bin/pytest -q` passes.
- [ ] If PostgreSQL storage or migrations changed, any manual check against a disposable native/local or approved managed database is recorded with its scope and limitations; no automated database-integration suite exists.
- [ ] `cd apps/management-web && pnpm typecheck && pnpm build` passes.
- [ ] `git diff --check` passes and generated output, caches, secrets, and private data are absent.
- [ ] Any manual Preview/demo inspection records the route, persona, scenario, observed result, and limitations.

## Documentation and handoff

- [ ] The docs hub, API guide, operator guide, and relevant ADRs are updated.
- [ ] Roadmap status distinguishes implemented reference behavior from candidate or production-hardening work.
- [ ] The pull request records tests run, skipped checks, known limitations, follow-up issues, and reviewer/owner decision.
- [ ] The release identifier is recorded from the accepted Git commit; no claim of production readiness is implied.
