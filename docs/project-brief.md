# SignalWarden AI project brief

**Current status:** simulation-first reference application for observations, evidence-grounded analysis, and spatial context. Optional receive-only aircraft telemetry and external reads do not establish production readiness or field validation.

## Goal

Bring platform and sensor information into a local-first workspace where users can inspect source evidence, freshness, declared trust, and uncertainty; ask bounded questions; and export cited reports. Monitoring, synthetic demonstrations, model assistance, and aircraft control remain separate.

SignalWarden AI is the app's display brand. The repository remains `ucas-drone-management`; UCAS package names, API routes, configuration variables, and fixtures are unchanged. The UCAS expansion and intended aircraft use remain unresolved.

## Implemented reference capabilities

- Receive-only PX4/ArduPilot MAVLink over serial, UDP, or TCP, with normalized observations and a separate opt-in WebSocket stream. Synthetic frontend fleet views are not connected to this adapter.
- Mock/offline platform and sensor observations, an informational catalog, source diagnostics, exact citations, and deterministic freshness/trust/conflict assessment. No actual Lattice connection.
- Local-first evidence and scene analysis with a deterministic no-model path, optional configured local Qwen assistance, and explicit external-AI consent boundaries.
- Platform-wide status, sensor metadata/provenance, incident-timeline, data-quality, and handoff reports over canonical records and local observations, with cited Markdown/JSON exports.
- Labeled in-memory outage snapshots and recovery digests that preserve observation timestamps and distinguish API recovery from source recovery.
- Offline World View layers, local search, annotations, shared/exported scenes, view direction, synthetic replay, and bounded observation packs. Three.js rendering includes an SVG fallback.
- Local SGP4 satellite geometry from supplied TLEs and opt-in manual USGS, NOAA/NWS, and adsb.lol reads, subject to coverage and visible failure states.
- Optional pinned-model installation and inference workflows for Qwen, SSD-1B, Wan, ResNet-18, and X-CLIP; generated media remains separate from evidence.
- Inventory/maintenance APIs, synthetic camera and fleet views, demo RBAC, disconnected training, and deterministic Tracegate review.

## Reference stack

React 19, TypeScript, Vite, Three.js, and satellite.js in the browser; Python 3.11+ services and versioned JSON Schemas; in-memory storage by default with optional PostgreSQL; optional pymavlink/pyserial aircraft ingestion and authenticated/TLS WebSocket streaming. Local models use separately installed runtimes with per-model hardware and license requirements. This is not a certified deployment or supported-OS matrix.

## Boundaries and validation

World View is inspired by God's Eye View, not full parity. Imagery/terrain and several live-feed categories remain unavailable; proposed providers require implementation, terms/license review, and sometimes credentials. Implemented reads can fail and must not be replaced with fabricated live data.

No real hardware, SITL/HIL, flight, actual Lattice integration, installed model weights, GPU inference, or WebGL rendering has been validated. Prior browser checks used the SVG fallback because WebGL was unavailable. Model quality, latency, and GPU compatibility remain unverified. PostgreSQL has no current automated database-integration coverage.

This is not autonomous aircraft control, a navigation authority, or a weapon/effector system. There is no mission upload, targeting, arming, firing, or physical tasking path. Training mutates only a local digital twin. Production identity, authorization, rate limiting, deployment, and operational approval remain incomplete; keep the reference API local.

## Decisions still requiring owner approval

| Decision | Open questions |
|---|---|
| Intended use | What does UCAS mean here, who uses the system, and for what approved purpose? |
| Aircraft and hardware | Which airframe, autopilot/version, sensors, radios, and companion computer, if any? Reference configurations are not owner selections. |
| Operating context | Which jurisdiction, test site, conditions, payload, endurance, range, and budget? |
| Real-data access | Which sources are authorized, licensed, and suitable for the intended use? |
| Deployment and access | Local/on-premises/cloud, user roles, identity, secrets, and network boundaries? |
| Data policy | Retention, location handling, backups, audit, privacy, and distribution rights? |
| Validation | Which staged lab, hardware, renderer, model, database, and field checks are required? |
| Ownership and licensing | Collaborators, distribution plans, and license selection? |

Any future control integration requires separate scope and safety review. The current workspace does not authorize one.

See the [platform guide](platform-guide.md), [documentation hub](README.md), and [validation guide](validation-and-testing.md) for workflows and evidence requirements.
