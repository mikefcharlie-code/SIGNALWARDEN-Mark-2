# Read-only Lattice integration scaffold

## What works now

This repository has a local, **offline-only** observation scaffold inspired by the public Lattice entity model. It displays synthetic aircraft and sensor status plus an informational catalog of autonomous, sensor, and effector/weapon platform categories. **It is not connected to Lattice, Anduril hardware, government systems, or any real-world platform.** There is no compatibility certification or partner endorsement.

The adapter lives in `services/lattice_readonly/`. The reference Management API provides GET-only views in a separate `/api/v1/lattice/` namespace. These records do not enter aircraft telemetry ingestion, streams, maintenance, training tasking, or flight-readiness calculations. The management frontend's [Observation workspace](observation-workspace.md) reads this local namespace; existing fleet, camera, telemetry, and training surfaces remain separate.

No weapon firing, arming, targeting, mission tasking, autonomous engagement, gimbal control, or platform command interface is implemented. Weapon/effector categories are inventory and status metadata only, not an indication that an asset is available or authorized for use. No operational weapon performance parameters or engagement recommendations are included.

## Try it locally

With the repository's development dependencies installed:

```bash
# Default: static synthetic observations, not a service connection.
UCAS_LATTICE_MODE=mock python services/management-api/app.py

# In another terminal:
curl http://127.0.0.1:8000/api/v1/lattice/status
curl 'http://127.0.0.1:8000/api/v1/lattice/catalog?limit=10'
curl 'http://127.0.0.1:8000/api/v1/lattice/platforms?limit=10'
curl http://127.0.0.1:8000/api/v1/lattice/overview
curl 'http://127.0.0.1:8000/api/v1/lattice/capabilities?limit=100'
```

Use a returned `entityId` as the path identifier with `GET /api/v1/lattice/platforms/{entityId}` for one observation. Lists use the existing API's `limit` (1–100) and opaque `cursor` pagination envelope: `items`, `count`, `next_cursor`.

`UCAS_LATTICE_MODE=offline` keeps the local category catalog available but returns no platform observations. `mock` is the default. Any other mode, including `live` and `sandbox`, is rejected: command-line startup fails before opening its HTTP listener, and scaffold requests report `503 lattice_mode_unavailable` if the environment is changed while the process runs. There are no Lattice endpoint or token settings, Lattice network transport, SDK dependency, or hidden live fallback. Separate opt-in AI provider settings do not enable Lattice access. Setting Lattice-looking credentials cannot enable a connection.

`POST` and `PATCH` requests in this namespace return `405 read_only_integration`; unimplemented HTTP methods are rejected by the reference HTTP server. There is no entity-publish, task, or command route. The service does not write anything to Lattice. The reference HTTP API is localhost-first and does not provide production authentication/authorization for observation reads; do not expose it publicly or load sensitive operational data.

## What the catalog represents

The local taxonomy distinguishes autonomous platforms across air, ground, surface, and undersea domains; fixed/mobile sensor platforms; and informational effector/weapon platform categories. Sensor descriptions include EO/IR, radar, and passive RF categories. These are generic examples of the types of systems such a platform might manage, **not exact Anduril product specifications or claims of supported hardware**.

Catalog identity and capability descriptions are local UCAS metadata, separate from the public Lattice wire fields. An observation's category is assigned explicitly, not inferred from a name, a sensor reading, or an undocumented weapon field. An unrecognized platform remains unknown rather than being classified as a weapon automatically. The catalog is not a task catalog and does not advertise callable operations.

## Public entity mapping

The [public concept overview](https://developer.anduril.com/guides/concepts/overview) describes integrations that push and/or pull data using Entities, Tasks, and Objects APIs. This scaffold implements none of those network APIs. The [publish-entity guide](https://developer.anduril.com/guides/entities/publish) is used only as a reference for the structure of local entity-shaped data; its examples do not establish a consumer/watch API contract.

| Public field | Local observation use and limits |
|---|---|
| `entityId`, `aliases.name` | Observation identity and display name; no automatic linking to an aircraft/device |
| `ontology.template`, `ontology.platformType` | Asset shape and provider platform label; `TEMPLATE_ASSET` and `UAV` are documented examples, not a complete taxonomy |
| `location.position.latitudeDegrees`, `longitudeDegrees` | Validated optional observation position; no route, targeting, or map tasking |
| `altitudeHaeMeters`, `altitudeAglMeters`, `altitudeAsfMeters`, `pressureDepthMeters` | Preserve each reference and unit separately; never relabel MSL as HAE or convert without a validated source |
| `health.connectionStatus`, `health.healthStatus` | Reported historical health/connection metadata; unknown or missing values do not become healthy/online |
| `sensors.sensors[].sensorId`, `sensorType`, `operationalState` | Read-only sensor metadata, not sensor configuration or raw feeds |
| `provenance.sourceUpdateTime` | Observation age/freshness; missing, future, and stale data must not be presented as current |
| `isLive` | Provider metadata only; never proof that this adapter is connected or that observations are authenticated |
| `taskCatalog` and unknown fields | Excluded from the local projection, including control/weapon payloads |

The adapter projects an allowlist rather than forwarding a raw entity. It validates input shape and finite numeric position values and returns defensive copies. Mock fixture timestamps are static: they are not refreshed on each read to make old samples look live. Reported health and query-time freshness are separate; even a sample labeled healthy is synthetic, may be stale, and is never proof of readiness or authorization. Location is informational only. No live observations were collected to create these fixtures.

The local projection helper `map_entity(raw, *, now=None, catalog_id=None)` is for offline fixture validation only and always labels its output synthetic. A known local catalog ID must be assigned explicitly. Missing templates are tolerated for partial fixtures; explicit non-asset templates are rejected. Only the enum examples verified in the public guide are recognized: online/offline connection, healthy health, camera sensor type, and operational sensor state. Other values become `unknown`, even when a future approved schema may define them. This conservative subset is not a complete Lattice schema validator.

Freshness is `current` for a source timestamp from zero through 300 seconds old, `stale` beyond 300 seconds, `future` for a negative age, and `unknown` if absent or invalid. It describes only fixture age, not connectivity. Records without observation data—including the informational weapon and effector fixtures—have unknown health and freshness. Catalog capability descriptions are local informational labels, not wire-level task definitions. Health/component update times and entity expiry are not yet incorporated; validate those semantics before a future live adapter.

## What needs approved access

The [Lattice Partner Program](https://www.anduril.com/lattice/lattice-partner-program) describes developer resources, sandbox environments, representative data, and testing/validation. The user currently has no approved development environment or credentials. A future network adapter requires an authorized environment and expressly approved read permissions, official API/authentication details for that environment, and owner review of data handling and deployment boundaries. Do not use someone else's account or infer credentials from public examples.

No Lattice SDK is bundled, installed, or required here. Before adopting one, review the [SDK license](https://developer.anduril.com/license), applicable API/data terms, organizational approval, and relevant export/access restrictions. Public documentation access is not permission to use a private service or distribute SDK materials. No license acceptance or partner enrollment has been performed on the user's behalf.

Before claiming even read-only sandbox compatibility, validate:

1. The permitted entity **read/watch** endpoint, protocol/version, authentication, scopes, and sandbox-specific authorization. The publishing example is not evidence of a tested read integration.
2. Actual JSON field casing/wrappers, pagination/watch envelopes, deletion/expiry behavior, reconnect/backoff, rate limits, errors, and identity/provenance semantics.
3. Supported platform taxonomy, health and sensor enum values, unknown/future fields, and explicitly approved catalog assignments. Generic local effector categories are not an official Lattice effector schema.
4. Position validity, altitude references, timestamp/clock behavior, health-update cadence, and how stale or unavailable components should display. In particular, reported connection status is not a transport heartbeat for this application.
5. Contract fixtures from permitted representative sandbox data, least-privilege observation-only authorization, bounded storage/retention, audit/redaction, and proof that no write/task/control API is accessible from the integration.

A future live implementation is a separate reviewed change, not an environment-variable toggle in this scaffold. Actual products, device protocols, effectors, operational deployment, and write/control integrations remain outside this implementation.

## Tests and remaining gaps

```bash
python -m pytest -q tests/test_lattice_readonly.py tests/test_lattice_api.py
python -m pytest -q
```

Unit tests exercise local projection, catalog, mocked observations, unknown/malformed data, freshness, mode restrictions, and defensive copies. HTTP tests exercise status/list/detail handling, catalog pagination, offline behavior, rejected writes, invalid modes, and separation from aircraft ingestion. No external network or device access is needed for these tests.

The overview adds coherent local counts, deterministic data-quality attention, and honest source diagnostics. Capability descriptions distinguish local demonstrations from excluded tasking/control. Local-first advisory assistance and bounded browser-to-API resilience are now implemented; they are not operational AI or mesh networking. See [assistance and networking](observation-assistance-networking.md) for explicit local runtime and external opt-in settings. See the [workspace guide](observation-workspace.md) for feature sets and local UI verification.

There is **no** live/sandbox Lattice validation, SDK conformance test, product-specific mapping validation, hardware access, or operational security review. PostgreSQL integration coverage remains absent following the prior removal of Docker-dependent database tests; this scaffold neither needs nor adds a database. Passing local tests is not flight, weapon, safety, or production-readiness evidence.
