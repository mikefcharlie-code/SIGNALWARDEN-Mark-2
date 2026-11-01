# UCAS Drone & Management System

Private project workspace for organizing a UCAS drone platform and the software used to manage its inventory, telemetry, maintenance, and operations records.

**Status:** M1 simulation-first prototype with an M1.5 receive-only PX4/ArduPilot adapter reference boundary; M2 lab integration is not accepted, and the project is not flight-ready or deployed.

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
14. [Read-only Lattice scaffold and platform catalog](docs/lattice-readonly-integration.md)
15. [Read-only platform reports API](docs/platform-reports.md)

## Repository layout

```text
apps/management-web/       React/TypeScript management UI with synthetic RBAC, telemetry, and camera views
services/management-api/   Reference inventory, telemetry, maintenance, and evidence API
services/aircraft_gateway/ Receive-only PX4/ArduPilot MAVLink telemetry adapter
services/lattice_readonly/ Offline/mock entity observations and informational platform catalog; no Lattice connection
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
python -m pip install -r requirements-dev.txt -r requirements-aircraft.txt
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

PostgreSQL storage remains available as an opt-in mode. Use a native local PostgreSQL installation or an approved managed PostgreSQL database, apply the migrations, and configure `UCAS_STORAGE=postgres` as described in the [Management API guide](services/management-api/README.md). Durable-storage integration coverage is a next-sequence improvement and is not currently part of the automated suite; do not treat a successful in-memory run as database evidence.

For milestone handoff, use the [release checklist](docs/release-checklist.md) and record skipped checks explicitly.

The generator writes newline-delimited JSON to stdout. Its samples contain no real locations or identifying aircraft information. To save a local fixture:

```bash
python simulation/generate_telemetry.py --count 20 > /tmp/ucas-telemetry.ndjson
```

## PX4 and ArduPilot telemetry

Install the optional `requirements-aircraft.txt` dependencies and follow the [aircraft integration guide](docs/aircraft-integration.md). A non-authoritative [reference multicopter configuration](docs/reference-multicopter-configuration.md), with its companion [hardware reference](hardware/reference-multicopter.json), describes a Holybro Pixhawk 6C quadrotor baseline with separate PX4 v1.17.0 and ArduCopter 4.7.2 alternatives on TELEM2. This is not the owner’s hardware or firmware selection and does not provide selection or validation evidence. The guide covers explicit system/component selection, simulated versus aircraft source labels, publisher authorization, and staged receive-only checks. The gateway never transmits MAVLink messages. Autonomous flight remains the autopilot’s responsibility; protocol compatibility is not flight-readiness evidence. No SITL, HIL, or flight validation is claimed.

## Working principles

The [read-only Lattice scaffold](docs/lattice-readonly-integration.md) adds GET-only local status views for synthetic aircraft/sensors and an informational autonomous, sensor, and effector/weapon platform catalog. The [Observation workspace](docs/observation-workspace.md) (`/observations`) brings those local records into a searchable inventory with data-quality attention, source diagnostics, and clearly labeled capability maturity. It has no live Lattice adapter, SDK dependency, real hardware access, tasking, targeting, arming, or firing path. [Local-first advisory assistance and resilient API reads](docs/observation-assistance-networking.md) add explicit model/runtime configuration, separately opted-in external AI, bounded retries, and clearly labeled retained snapshots; they do not add operational AI or a mesh network. Approved Lattice access and sandbox validation remain required before any future live integration. This is an independent UCAS demonstration, not certified Lattice compatibility.

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

### Optional local AI models

The [browser model installer](docs/local-ai-browser-setup.md) lets an authorized administrator launch installation, download, verification and cancellation from the workbench on the Management API host, with explicit consent and live logs; it is disabled by default. The [local AI setup guide](docs/local-ai-setup.md) also provides separate dependency installs, explicitly triggered verified downloads, and local smoke commands for a Qwen LLM, SSD-1B image generation, Wan video generation, ResNet image classification and X-CLIP video classification. All snapshots use pinned Hugging Face revisions and file hashes, with GitHub/source/license references. No model weights download at startup or in CI. CPU/GPU and storage limits are explicit; the roughly 29 GB video-generation bundle is optional. The [explicit local inference workbench](docs/local-ai-inference.md) adds source-cited Qwen summaries/Q&A, visibly synthetic SSD-1B images and Wan video, ResNet uploaded-image top classes, and fixed-label X-CLIP uploaded-video scores. Inference is separately opt-in, requires installed models, and never downloads weights or falls back externally. Generated media never enters the observation/evidence stream; every model output remains advisory with no vehicle or effector control path. External model APIs remain explicit opt-in only.

## World View: read-only global context

PR #18 adds a native `/worldview` workspace alongside the existing observation and local-AI tools. It starts offline with clearly synthetic records, an original schematic globe (SVG fallback without WebGL), local place/coordinate search, cosmetic CRT/NVG/FLIR/Noir/Snow modes, nearby contacts, analyst commands, annotations, scene URLs/files, bounded data packs, a smooth camera director and a synthetic replay example. User-pasted TLEs support local SGP4 geometry and pass estimates; they are not live sightings.

External reads are off by default. The provider panel can manually request bounded USGS earthquakes, NOAA/NWS forecasts (U.S. coverage), and coarse adsb.lol points without API keys. Browser speech input is separately opt-in and may use the browser vendor's speech service. No upstream datasets/models/imagery are bundled, and no new control path touches PX4 or ArduPilot.

See [feature coverage and explicit gaps](docs/gods-eye-capability-coverage.md), [provider terms, attribution and optional-key matrix](docs/worldview-data-sources.md), and [World View usage and validation](docs/worldview-workspace.md). This is not full God’s Eye parity; imagery/terrain, live AIS, live traffic/camera catalogs, FIRMS, and other key/licensed integrations remain explicitly unavailable. No deployment is part of this PR.

### Local-first scene analyst

World View includes a read-only, source-grounded analyst for loaded layers, platform evidence, history and advisory briefings. Deterministic questions need no model or network; configured local Qwen can organize cited findings. External AI is separately opt-in with export disclosure. See [Scene analyst](docs/worldview-ai-analyst.md).
