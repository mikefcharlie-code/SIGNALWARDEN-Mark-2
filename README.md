# SignalWarden AI

**Follow the signal. Trace the evidence. See the context.**

A local-first workspace for observations, evidence-linked analysis, source-cited reports, and offline world views. Bring telemetry and spatial context together, then inspect the sources, freshness, and gaps behind each finding. Core workflows run without a model or live feed.

## What you can do

| Capability | Implemented today |
|---|---|
| **Explore observations** | Search platform and sensor records with exact citations, provenance labels, freshness checks, and visible conflicts or missing data. |
| **Ask grounded questions** | Use deterministic evidence assessments and bounded scene queries without a model. Optional local Qwen can organize cited findings. |
| **Build cited reports** | Preview platform status, sensor provenance, incident timelines, data quality, and handoffs; export Markdown or JSON with evidence and coverage limits. |
| **Work in World View** | Explore offline spatial layers, search places or coordinates, annotate and share scenes, replay synthetic tracks, and import/export bounded observation packs. Calculate satellite positions and geometric passes from supplied TLEs. |
| **Receive aircraft telemetry** | Read PX4/ArduPilot MAVLink over serial, UDP, or TCP with normalized observations and source/freshness labels. A separate opt-in WebSocket stream supports telemetry delivery. |
| **Review outages and recovery** | Inspect labeled in-memory snapshots and a return digest that separates API recovery from source recovery. Old observations remain old; reload clears retained state. |
| **Set up local models** | Explicit install, verification, cancellation, and inference workflows for Qwen, SSD-1B, Wan, ResNet-18, and X-CLIP. No automatic weight downloads; generated media stays outside observation evidence. |
| **Explore management demos** | Inventory and maintenance APIs, synthetic fleet views, a six-channel demo Camera Wall, disconnected Training C2, demo RBAC, and deterministic Tracegate evidence-readiness review. |

## Status and scope

**Simulation-first reference implementation—not flight-ready, field-validated, or production-validated.**

- **Receive-only telemetry; separate bounded commands.** The PX4/ArduPilot adapter still receives only and never transmits MAVLink. Synthetic fleet views are not bound to it. A separate, disabled-by-default [civilian operator command gateway](docs/civilian-operator-commands.md) can dispatch signed `hold`, `return_home`, and `land` requests to an independently provisioned civilian HTTPS bridge. It has no extra confirmation prompt. A bounded run may execute a fixed operator-authorized sequence with status visibility and abort; AI-generated live decisions, arbitrary commands, mission upload, targeting, arming, and weapon/effector tasking remain excluded. Training C2 remains browser-local. No real-hardware, SITL/HIL, or flight validation is claimed. Tracegate does not authorize flight or certify safety.
- **Local records, limited external reads.** The observation dataset is mock/offline; actual Lattice integration is absent. Manual, opt-in adapters cover USGS earthquakes, U.S. NOAA/NWS forecasts, and coarse adsb.lol positions—not dependable live-feed coverage. Provider terms, staleness, rate limits, and failures apply.
- **Original World View, not full God's Eye parity.** Imagery/terrain, live AIS, traffic/camera catalogs, FIRMS, and other documented integrations remain unavailable. No upstream assets or datasets are bundled. TLE calculations are geometric estimates, not sightings or visibility forecasts.
- **Validation has boundaries.** Model workflows were checked with fixtures/mocks, not actual weights or GPU inference. Browser checks exercised the SVG fallback, not WebGL. Model output is advisory, not verified detection; display filters do not add sensor capabilities.
- **Keep the reference API local.** Production authorization, rate limiting, and access-control hardening are incomplete. External AI requires separate configuration and export consent; local mode never silently falls back to it. Optional browser speech may use the browser vendor's service.

## Run locally

Requires Python 3.11+, Node.js, and the frontend's pinned pnpm version (10.12.1). From a checkout:

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-dev.txt
python services/management-api/app.py
```

In another terminal:

```bash
cd apps/management-web
pnpm install --frozen-lockfile
pnpm dev
```

Start with **Observations** (`/observations`), **World View** (`/worldview`), and **Reports & documents** (`/reports`). Demonstrations use synthetic/local data; aircraft ingestion, streaming, model inference, and external reads each require separate setup.

The stack is React/TypeScript with Vite, Three.js and satellite.js, backed by a Python API and versioned JSON Schemas. Storage is in-memory by default; optional PostgreSQL setup is in the [API guide](services/management-api/README.md). Model-specific hardware and runtime requirements are in [local AI setup](docs/local-ai-setup.md); Wan requires CUDA.

## Local checks

```bash
.venv/bin/pytest -q
pnpm --dir apps/management-web test
pnpm --dir apps/management-web typecheck
pnpm --dir apps/management-web build
python simulation/generate_telemetry.py --count 5
```

These are development checks, not certification. PostgreSQL has no replacement automated integration suite after removal of the Docker/Testcontainers tests. Record skipped checks in the [release checklist](docs/release-checklist.md).

## Go deeper

- **Start here:** [Documentation hub](docs/README.md) · [Platform guide](docs/platform-guide.md) · [Developer guide](docs/developer-guide.md)
- **Evidence:** [Observations](docs/observation-workspace.md) · [Copilot and recovery](docs/evidence-copilot.md) · [Reports](docs/platform-reports.md)
- **World View:** [Workspace](docs/worldview-workspace.md) · [Scene analyst](docs/worldview-ai-analyst.md) · [Feature gaps](docs/gods-eye-capability-coverage.md) · [Provider terms](docs/worldview-data-sources.md)
- **Integrations:** [Aircraft telemetry](docs/aircraft-integration.md) · [Offline catalog boundary](docs/lattice-readonly-integration.md) · [Local model inference](docs/local-ai-inference.md)
- **Engineering:** [Architecture](docs/architecture.md) · [Safety and security](docs/safety-security.md) · [Validation](docs/validation-and-testing.md) · [Open decisions](docs/project-brief.md)

## Contributing and ownership

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Keep reference behavior distinct from validated integrations; never commit secrets, private operational logs, real location traces, or model weights.

SignalWarden AI is the display name; `ucas-drone-management` and technical identifiers remain unchanged. Documentation is subject to owner review. No open-source license has been selected; visibility alone grants no reuse rights. The [patent source package](source-materials/patent-package-2026-10-06/) and [engineering digest](docs/patent-derived-specifications.md) preserve source concepts, not validated requirements, flight evidence, or legal conclusions.
