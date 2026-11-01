# Contributing

1. Open an issue with scope, requirement IDs, acceptance criteria, and test evidence expected.
2. Work on a short-lived branch, such as `docs/scope` or `feat/telemetry-ingestion`.
3. Make small commits; keep hardware, firmware, interfaces, and management changes traceable.
4. Read the [documentation hub](docs/README.md), relevant ADRs, contracts, and safety boundary before changing an interface.
5. Run `.venv/bin/pytest -q`, then `cd apps/management-web && pnpm typecheck && pnpm build` when the change touches the UI or its contracts.
6. For persistence changes, review and apply migrations against a disposable native/local or approved managed PostgreSQL database when available, and record that as manual validation; the former 22-case Docker/Testcontainers integration suite was deleted and has no replacement automated database-integration coverage.
7. Open a pull request, link the issue, and explain implementation versus placeholders.
8. Request a review from a project owner. Record decisions in an ADR when they change boundaries or commitments.

CI checks contracts, synthetic examples, documentation links, the offline generator, the management API, and the frontend build. It does not provide automated PostgreSQL database-integration coverage, and it does not validate aircraft safety, production security, or hardware compatibility.

Do not commit secrets, private operational traces, real location data, or large binary exports. Keep source design files and document an approved artifact-storage location when needed. No branch-protection setting or collaborator access has been changed by this scaffold.
