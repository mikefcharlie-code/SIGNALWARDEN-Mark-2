# SignalWarden AI platform guide

## Implemented reference surfaces

SignalWarden AI runs with synthetic/local data by default. Optional aircraft ingestion, external reads, and model workflows require explicit setup.

| Surface | Implemented capability and boundary |
|---|---|
| Observations (`/observations`) | Search mock/offline platform and sensor records; inspect exact evidence, freshness, declared trust, conflicts, and source diagnostics. Retained outage snapshots are memory-only and labeled unverified. No live Lattice connection. |
| World View (`/worldview`) | Offline layers, local search, annotations, shared scenes, view direction, synthetic replay, imported packs, and source-grounded scene questions. Three.js globe with SVG fallback; not full God's Eye View parity or an operational navigation map. |
| Reports & documents (`/reports`) | Cited platform-status, sensor metadata/provenance, incident-timeline, data-quality, and handoff previews from canonical records and local observations; export Markdown/JSON. Missing history remains a coverage gap. |
| Evidence and scene analysts | Deterministic queries and summaries work without a model. Optional configured local Qwen organizes cited content; output is advisory, not evidence. External AI is separately opt-in with export disclosure. |
| Local AI workbench | Install/verify/cancel and inference workflows for five pinned model groups. No automatic weight downloads; real model/GPU behavior is unvalidated. Generated artifacts stay outside observation evidence. |
| Fleet, monitor, Camera Wall, and training | Synthetic management views, six demo camera channels, demo RBAC, and a browser-local training digital twin. These are not real camera streams or aircraft control. |
| Tracegate | Deterministic evidence-readiness review for a declared reference configuration; not flight authorization or safety certification. |

## Services and optional connections

The React/TypeScript UI uses Vite, Three.js, and satellite.js. Python 3.11+ services provide the Management API, versioned JSON Schema contracts, inventory/maintenance records, reports, and local-AI workflows. Storage is in-memory by default; PostgreSQL is optional and lacks automated database-integration coverage.

The optional aircraft gateway receives PX4/ArduPilot MAVLink over serial, UDP, or TCP and never transmits MAVLink. A separate opt-in WebSocket stream supports authenticated/TLS delivery and explicit resynchronization signals. Synthetic fleet/monitor views are not live bindings to this adapter. See the [aircraft guide](aircraft-integration.md); no real hardware or flight validation is claimed.

World View offers manual, opt-in USGS earthquake, U.S. NOAA/NWS forecast, and coarse adsb.lol position reads. Availability, terms, CORS, rate limits, timestamps, and failures remain visible. Satellite positions/passes are local SGP4 estimates from user-supplied TLEs, not sightings. See [source coverage](worldview-data-sources.md) for implemented and unavailable adapters.

## Scope and validation limits

There is no flight controller, autonomous aircraft control, mission upload, real camera transport, actual Lattice integration, target selection, weapon/effector control, or production autonomy authorization. Training uses invented geometry labeled `SYNTHETIC RANGE / NO GPS`; World View separately supports geographic coordinates and optional provider observations.

Installed model weights, GPU inference, WebGL rendering, reliable live-feed coverage, real hardware, SITL/HIL, field use, and production readiness remain unvalidated. Prior browser checks verified the SVG fallback because WebGL was unavailable. Demo RBAC is not server-side production authorization; keep the reference API local. Do not infer readiness from a green test, `READY` Tracegate result, API refresh, installed-model status, or simulated state.

## Local entry points

After the [developer setup](developer-guide.md):

```bash
# from repository root
.venv/bin/python services/management-api/app.py

# in another terminal
cd apps/management-web
pnpm install --frozen-lockfile
pnpm dev
```

Start with `/observations`, `/worldview`, or `/reports`. Existing demo routes include `/`, `/monitor`, `/cameras`, `/training`, `/maintenance`, `/access`, `/roles`, and `/audit`. Aircraft telemetry, streaming, PostgreSQL, model installation/inference, and external reads are separate; starting the UI does not enable them.

## Explore further

[Observation workspace](observation-workspace.md) · [Evidence and recovery](evidence-copilot.md) · [World View](worldview-workspace.md) · [Scene analyst](worldview-ai-analyst.md) · [Reports](platform-reports.md) · [Local AI](local-ai-inference.md) · [Capability gaps](gods-eye-capability-coverage.md) · [Safety and security](safety-security.md) · [Validation](validation-and-testing.md)
