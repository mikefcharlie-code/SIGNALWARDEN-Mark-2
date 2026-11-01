# Developer guide

## Prerequisites

- Python 3.11 or newer
- Node.js and pnpm matching the frontend lockfile
- A native/local or approved managed PostgreSQL database only when manually exercising PostgreSQL storage and migrations
- GitHub CLI only when working with the configured repository

## First checkout

```bash
gh repo clone mikefcharlie-code/ucas-drone-management
cd ucas-drone-management
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-dev.txt
```

For frontend work:

```bash
cd apps/management-web
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
```

## Change workflow

1. Open or update an issue with scope, requirement IDs, acceptance criteria, and expected evidence.
2. Read the relevant architecture decision and contract before editing an interface.
3. Keep synthetic/reference behavior separate from production-boundary documentation.
4. Add or update tests close to the changed behavior.
5. Run the focused checks, then the full non-integration suite and frontend build.
6. Use `git diff --check`, review generated files, and avoid committing `dist/`, caches, secrets, or real operational data.
7. Explain placeholders, safety boundaries, and unresolved decisions in the pull request.

## Project map

| Path | Responsibility |
|---|---|
| `apps/management-web` | React/TypeScript UI and browser-local simulation surfaces |
| `services/management-api` | HTTP API, repository boundary, migrations, persistence tests |
| `services/telemetry_stream` | Authenticated WebSocket hub and TLS helpers |
| `services/tracegate` | Rules-based evidence/readiness prototype |
| `packages/contracts/v1` | Versioned JSON Schemas and RBAC catalog |
| `simulation` | Synthetic telemetry generation |
| `tests` | Contract, service, stream, Tracegate, and design tests |
| `docs/decisions` | Architecture decision records |

## Standard checks

```bash
.venv/bin/pytest -q
cd apps/management-web && pnpm typecheck && pnpm build
```

The former 22-case Docker/Testcontainers PostgreSQL integration suite was deleted; there is no replacement automated database-integration coverage. PostgreSQL storage and migrations remain supported for manual validation against a disposable native/local or approved managed database; see the [Management API guide](../services/management-api/README.md) and [validation and testing](validation-and-testing.md) for evidence expectations.
