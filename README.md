# UCAS Drone & Management System

Private project workspace for organizing a UCAS drone platform and the software used to manage its inventory, telemetry, maintenance, and operations records.

**Status:** M1 simulation-first prototype; not a flight-ready system or deployed application.

> UCAS is retained as the project name. Its expanded meaning, intended use, airframe, payload, operating jurisdiction, and performance targets are not yet confirmed. Nothing in this scaffold selects them on your behalf.

## Start here
1. [Documentation hub](docs/README.md)
2. [Project brief and open decisions](docs/project-brief.md)
3. [System architecture](docs/architecture.md)
4. [Draft requirements](docs/requirements.md)
5. [Milestones and backlog](docs/roadmap.md)
6. [Safety, security, and validation](docs/safety-security.md)
7. [Patent-derived engineering specifications](docs/patent-derived-specifications.md)
8. [RBAC and permission-management UI design](docs/rbac-permission-management-ui.md)
9. [Video observation and camera gateway](docs/video-observation.md)
10. [Disconnected simulation and training C2 console](docs/simulation-training-console.md)
11. [Tracegate engine](services/tracegate/README.md)

## Repository layout

```text
apps/management-web/       React/TypeScript management UI with synthetic RBAC, telemetry, and camera views
services/management-api/   Reference inventory, telemetry, maintenance, and evidence API
services/telemetry-gateway/ Read-only transport boundary and stream notes
services/telemetry_stream/  WebSocket hub and live telemetry delivery
firmware/                 Onboard integration planning and configuration guidance
hardware/                 Airframe/electronics documentation and inventory templates
packages/contracts/       Versioned JSON Schemas and synthetic examples
                         RBAC role/permission catalog
simulation/               Offline sample telemetry generator
infrastructure/           Deployment planning; no cloud resources provisioned
operations/               Checklists, maintenance, and incident record templates
docs/                     Scope, architecture, requirements, roadmap, decisions
tests/                    Contract and simulator checks
.github/                  CI, issue templates, pull-request template
```

The management UI is an executable React/TypeScript synthetic-data reference frontend with a six-channel Camera Wall, a disconnected Training C2 console, four simulated autonomy modes, and a review-only Tracegate evidence-readiness panel. The executable reference path also includes an **offline synthetic telemetry generator**, a management API, and an opt-in simulation-safe WebSocket stream. The Camera Wall is hardware-free and read-only; Training C2 mutates only an in-memory digital twin with an invented no-GPS map. Tracegate is a deterministic prototype and does not authorize flight, certify safety, or issue commands. Future gateway and simulator boundaries are described in [video observation and camera gateway](docs/video-observation.md) and [disconnected simulation and training C2 console](docs/simulation-training-console.md). No radio, real aircraft connection, or real command execution is implemented.

## Local checks

Requires Python 3.11+ for the reference API and development tooling. The implementation choices remain reversible and are not aircraft or deployment specifications.

```bash
gh repo clone mikefcharlie-code/ucas-drone-management
cd ucas-drone-management
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-dev.txt
.venv/bin/pytest -q -m 'not integration'
python simulation/generate_telemetry.py --count 5
```

The frontend can be checked independently:

```bash
cd apps/management-web
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
```

The PostgreSQL integration suite uses Testcontainers and requires Docker:

```bash
.venv/bin/pytest -q -m integration tests/integration/test_postgres_repository.py
```

For milestone handoff, use the [release checklist](docs/release-checklist.md) and record skipped checks explicitly.

The generator writes newline-delimited JSON to stdout. Its samples contain no real locations or identifying aircraft information. To save a local fixture:

```bash
python simulation/generate_telemetry.py --count 20 > /tmp/ucas-telemetry.ndjson
```

## Working principles

- One monorepo initially; independent drone and management workstreams.
- Agree on requirements and interface contracts before choosing components.
- Validate with synthetic data before a read-only lab integration.
- Keep management records and monitoring separate from flight-control responsibilities.
- Record important choices in [architecture decision records](docs/decisions/README.md).
- Do not commit secrets, private operational logs, real location traces, or large binary artifacts.

## Contribution and ownership

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Use GitHub issues for accepted work, milestones for delivery stages, and pull requests for review. Documentation is a draft until reviewed by the project owner.

No open-source license has been selected. Repository privacy and licensing are separate decisions; choose a license before external distribution.

## Source package

The extracted [patent package](source-materials/patent-package-2026-10-06/) is retained as draft source material. Its architecture-relevant concepts have been mapped into a separate [engineering digest](docs/patent-derived-specifications.md), but patent claims are not treated as validated product requirements, flight evidence, or legal conclusions.
