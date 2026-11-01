# UCAS Drone & Management System

Private project workspace for organizing a UCAS drone platform and the software used to manage its inventory, telemetry, maintenance, and operations records.

**Status:** M1 simulation-first prototype with an opt-in receive-only PX4/ArduPilot telemetry adapter; not flight-ready or deployed.

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
12. [PX4 and ArduPilot aircraft integration](docs/aircraft-integration.md)
13. [Reference multicopter configuration](docs/reference-multicopter-configuration.md)

## Repository layout

```text
apps/management-web/       React/TypeScript management UI with synthetic RBAC, telemetry, and camera views
services/management-api/   Reference inventory, telemetry, maintenance, and evidence API
services/aircraft_gateway/ Receive-only PX4/ArduPilot MAVLink telemetry adapter
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

The management UI is an executable React/TypeScript synthetic-data reference frontend with a six-channel Camera Wall, a disconnected Training C2 console, four simulated autonomy modes, and a review-only Tracegate evidence-readiness panel. The executable reference path also includes an **offline synthetic telemetry generator**, a management API, and an opt-in simulation-safe WebSocket stream. The Camera Wall is hardware-free and read-only; Training C2 mutates only an in-memory digital twin with an invented no-GPS map. Tracegate is a deterministic prototype and does not authorize flight, certify safety, or issue commands. Future gateway and simulator boundaries are described in [video observation and camera gateway](docs/video-observation.md) and [disconnected simulation and training C2 console](docs/simulation-training-console.md). An opt-in receive-only MAVLink adapter now supports PX4 and ArduPilot telemetry over serial/UDP/TCP. The frontend remains synthetic: it is not bound to the adapter. No real command execution, mission upload, or autonomous flight planner is implemented.

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

## PX4 and ArduPilot telemetry

Install the optional `requirements-aircraft.txt` dependencies and follow the [aircraft integration guide](docs/aircraft-integration.md). A non-authoritative [reference multicopter configuration](docs/reference-multicopter-configuration.md), with its companion [hardware reference](hardware/reference-multicopter.json), describes a Holybro Pixhawk 6C quadrotor baseline with separate PX4 v1.17.0 and ArduCopter 4.7.2 alternatives on TELEM2. This is not the owner’s hardware or firmware selection and does not provide selection or validation evidence. The guide covers explicit system/component selection, simulated versus aircraft source labels, publisher authorization, and staged receive-only checks. The gateway never transmits MAVLink messages. Autonomous flight remains the autopilot’s responsibility; protocol compatibility is not flight-readiness evidence. No SITL, HIL, or flight validation is claimed.

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
