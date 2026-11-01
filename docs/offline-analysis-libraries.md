# Offline spatial analysis and telemetry charts

SignalWarden adds two focused open-source capabilities: local scene geometry checks with Turf.js, and interactive synthetic telemetry charts with uPlot. Neither adds an aircraft control path, external data service, or model download.

## Why these libraries

| Selection | Exact direct dependency | User benefit | Source and license |
|---|---|---|---|
| Modular Turf.js | `@turf/distance`, `@turf/boolean-intersects`, `@turf/helpers`, each `7.4.0` | Measure distances and check local scene points / a simulated route against a user-defined rectangular geofence | [Turf.js source](https://github.com/Turfjs/turf), MIT; [intersection documentation](https://turfjs.org/docs/api/booleanIntersects) |
| uPlot | `uplot` `1.6.32` | Canvas2D time-series inspection with UTC timestamps, cursor values and explicit missing-value gaps | [uPlot source](https://github.com/leeoniya/uPlot), MIT |

Only the Turf modules actually used are included; the all-in-one `@turf/turf` package is not installed. uPlot is dynamically imported when the telemetry chart is mounted, not on initial fleet-page load. Direct versions are exact-pinned in `package.json`; all resolved transitive versions and integrity hashes are recorded in `pnpm-lock.yaml`. Existing dependencies have not been upgraded as part of this change.

CesiumJS, deck.gl and MapLibre GL JS were considered but are **not** added. Main already has a procedural Three.js globe, bounded contact rendering and an SVG fallback. A second globe/rendering stack would duplicate those functions and increase bundle size without a reviewed local terrain/tile dataset or a demonstrated overlay scale requirement. Cesium is capable of offline operation, but its [official offline guide](https://github.com/CesiumGS/cesium/blob/main/Documentation/OfflineGuide/README.md) requires explicitly disabling default online providers. There is no Cesium ion, tiles, geocoder or external basemap configuration in this change.

## Local spatial checks

The World View panel is an advisory analysis tool for synthetic or explicitly eligible local records. Live/provider observations are not silently repurposed as simulated aircraft, obstacles or mission tasks. Importing a pack validates its schema, not its provenance or rights.

Eligibility requires `freshness: "synthetic"` plus an explicit synthetic source prefix: the built-in SignalWarden synthetic demo/replay, or `synthetic`, `local synthetic`, `demo synthetic`, or `imported synthetic`. Other imported records are deliberately excluded. These are user-supplied labels, not authenticated provenance. The adapter rejects more than 5,000 input records and the panel displays up to eight matching records with the full match count.

The geofence is a local rectangular longitude/latitude boundary, not an operational aircraft geofence. Point contact with its boundary counts as intersection. A route is a user/synthetic straight segment in coordinate space, not a flyable mission, terrain-clearance analysis or aviation safety constraint. Distance is spherical great-circle distance in kilometres; the planar intersection result and spherical measurement answer different questions.

Inputs are finite and bounded. Unsupported dateline/polar or ambiguous large-region intersection cases are rejected rather than reported as safe. There is no altitude, uncertainty, weather, regulatory, collision-avoidance or terrain model. Scene queries have explicit work bounds. The existing globe and offline fallback are preserved.

## Historical telemetry

The telemetry inspector continues to use **local synthetic fixtures only**. A fixed, explicitly labelled synthetic fixture timestamp anchors offsets; it is not the current time, a real aircraft observation time, or proof of a live connection. Plot coordinates use Unix seconds and visible timestamps use UTC. Missing and non-finite measurements remain gaps, never zero or interpolated values. The adapter normalizes ordering and duplicate timestamps before uPlot sees the series.

The fixed synthetic snapshot is `2025-01-01T12:00:00.000Z`. Later input wins a duplicate timestamp. Any missing interval longer than the fixture's 30-second cadence inserts a null break. Inputs above 5,000 samples are rejected; after complete bounded normalization, at most 2,000 plot positions are retained, favouring the most recent samples. Current demo histories contain only 31 samples. This is not a general live telemetry import or downsampling pipeline.

The chart uses Canvas2D, not WebGL. Responsive resizing and disposal are local browser concerns. The accessible value table remains available, and the SVG chart is retained as a fallback if the chart renderer cannot initialize. Aircraft with no recorded fixture history continue to show an empty state instead of another aircraft's data.

## Data, provider and license prerequisites

No API keys are needed. These libraries do not require a hosted account, tiles, remote data reads on page load, model assets, or acceptance of new provider terms. No provider adapter, opt-in setting, data attribution rule or existing provider term is changed. See the [existing provider/data checklist](worldview-data-sources.md) before enabling any external data source; software licenses do not license data or imagery.

Full upstream license texts are shipped with the frontend at [offline-library-notices.txt](../apps/management-web/public/offline-library-notices.txt), including the selected packages' dependency closure. Turf and uPlot are MIT; transitive notices also include ISC, 0BSD and Unlicense. Existing [Three.js and satellite.js notices](../apps/management-web/public/worldview-software-notices.txt) remain intact. Both feature surfaces link to software notices.

To regenerate or verify the notices after an intentional dependency update:

```sh
cd apps/management-web
pnpm install --frozen-lockfile
node scripts/library-notices.mjs
pnpm licenses:check
```

The generator reads installed package manifests/license files locally and fails if a license is missing. Frontend tests verify that the distributed notices match the installed dependency closure.

## Aircraft and review boundaries

Both PX4 and ArduPilot remain receive-only. There are no new aircraft, mission-command or payload APIs, transport writes, autopilot parameters, firmware changes or backend changes. Geometry and route results are advisory/simulation-only and cannot be submitted to an aircraft.

This work branches directly from main commit `d594f8518b30709c5acb2ab00fdedee2bd54c88c`. The open [Mission Autonomy PR #20](https://github.com/mikefcharlie-code/ucas-drone-management/pull/20) was inspected for scope and remains unchanged. This independent review does not merge its workspace, imply integration with it, or provide flight, HIL or operational readiness evidence.
