# World View integration audit

This branch ports compatible additions from both `SIGNALWARDEN-worldview-live-integrations.zip` and `SIGNALWARDEN-worldview-live-integrations-950adb6.zip` onto verified main `e5184e72f2aed2d8c4fb8c338c23888e3932f14f`. It does not replace the repository with either source snapshot. No merge or deployment is authorized or performed.

## Snapshot coverage

The first snapshot contains 399 files: 56 added paths and 41 modified paths relative to main. The update contains 424 files: 81 added paths and the same 41 modified paths. Between snapshots, the update adds 25 paths and modifies nine; it removes none. All source additions are present in the integration. All 63 paths present in main but absent from the snapshots remain present.

Every added or modified source path is accounted for in [the per-path reconciliation manifest](worldview-snapshot-reconciliation.json), including source/current SHA-256 digests and a decision reason. Twenty-nine older modified paths remain at main rather than reintroducing snapshot regressions. Identical file content is not treated as proof of safe runtime behavior: the provider clients, relays, rendering, lifecycle and tests were reviewed and hardened separately.

## Included feature areas

| Area | Included behavior |
|---|---|
| Ocean | GEBCO bathymetry, accurately named NOAA NCEI DEM mosaic, NASA relief/bathymetry, U.S. NOAA ENC display, dated MUR SST/anomaly/sea-ice and VIIRS chlorophyll layers; bounded Marine point/grid sampling; NOAA NDBC buoy relay and CO-OPS station observations/tide predictions. Clear **NOT FOR NAVIGATION** disclosure. |
| Wind and air | GFS/ECMWF/ICON wind grids, height/pressure-level selection, animated particles/arrows and forecast time controls; explicitly modelled CAMS air-quality heatmaps; dated GIBS aerosol/NO₂/smoke-or-dust proxy imagery; measured OpenAQ station markers after per-measurement license checks. |
| Animated live maps | Opt-in RainViewer or U.S. IEM NEXRAD radar and GOES-East/West/Himawari GIBS loops, bounded frame/tile loading, play/pause/step/time controls, feed freshness badges and an aggregated feed-age strip. Credits distinguish current **feed** status from the historical frame being displayed. |
| Imagery and terrain | Keyless/restricted-key basemaps, Terrarium terrain relief including height-only meshes, explicit provider/key states and attribution; validated georeferenced Umbra, nowCOAST and local GeoTIFF surfaces with separate imagery-AOI clipping. Official Google Maps logo is displayed only as required provider attribution. |
| Other public context | Read-only AIS, public traffic/camera catalog, hazards, mobility/street imagery/context, satellite elements/visibility forecasts, radio observations, launch schedules, weather and aircraft-type enrichment, with provider configuration/terms boundaries. |
| Workspace | Existing local layers, analysis, imports/exports, scene history, advisory geometry and offline synthetic context remain available. The provider dock keeps controls usable without pushing the globe off-screen; it is closed by default, internally scrollable, and hideable without treating hiding controls as consent revocation. |

Detailed provider conditions and authoritative links are in [provider terms](worldview-provider-terms.md) and [data sources](worldview-data-sources.md). Configuration is documented alongside each relay; keys are not bundled into browser code.

## Safety and truthful-data repairs

All public-provider panels receive the measured globe-activity gate. The gate starts closed, requires at least 25% physical globe intersection, and also requires a visible document. Provider opt-out or inactive-globe transitions abort work, invalidate late async completions, clear the affected map layers/records where applicable, and do not turn retained historical context into live data. Hiding only SAR/provider controls is distinct from disabling a provider; explicitly consented SAR refresh continues only while the globe is active.

Malformed and stale AIS input cannot leave a feed marked live. Stale mobility fallback responses carry `live: false`. Wind/AQ caches re-evaluate source-run age; duplicate/out-of-range grid locations, inconsistent or unordered time axes, unusable fields and future-only coverage fail closed. Missing model-run time remains **UNKNOWN**, never **LIVE**, including point weather, modelled AQ and optional satellite-visibility cloud forecasts. Empty or malformed-only buoy, tide, hazard and space responses do not become fresh observations. Explicit stale space-relay fallbacks stay stale through cache reads.

Open-Meteo free Forecast, Marine and cloud requests require explicit non-commercial confirmation; a verified configured commercial Forecast/AQ relay is handled separately. RainViewer requires a separate personal/educational-use confirmation. OpenAQ station display requires effective license dates covering each measurement and explicit commercial-use and redistribution permission, with linked license IDs and attribution. Missing, malformed, unknown, non-commercial or expired rights are rejected rather than inferred.

Imagery placement uses validated raster CRS/affine transforms, a validated georeferenced surface, or the exact north-up WMS extent. Source pixels are alpha-masked to the selected imagery AOI. These AOIs are separate from flight-control geofences. Public data and derived overlays remain display/advisory inputs only: no added aircraft command, mission, actuation or effector integration exists.

## Deliberate exclusions and limitations

- **Sentinel browse JPEG draping:** not implemented by guessing from a scene footprint. The current ASF browse asset has no validated raster transform. It remains an explicitly non-georeferenced, footprint-pinned preview. A real Sentinel drape requires an authorized geocoded/RTC product workflow and transform validation. Umbra GeoTIFF, nowCOAST WMS and local georeferenced GeoTIFF draping/clipping are supported and regression-tested. See the [Sentinel boundary](worldview-provider-terms.md#sentinel-browse-georeferencing-boundary).
- **EONET:** bounded, manually requested event metadata is enabled in the hazards panel and has its own Events map toggle (separate from fires). It preserves provider geometry times and individual source names/links, labels the status fresh/stale/unknown/error honestly, and shows point markers or explicitly approximate polygon-ring centres. It never requests EONET layers or linked third-party imagery; source pages are opened only by an explicit user click. NASA's spatial/temporal disclaimer remains visible.
- **Unlicensed OpenAQ stations:** omitted, not substituted with model values or fictitious observations. `UCAS_OPENAQ_API_KEY` must be configured server-side.
- **Restricted providers:** RainViewer remains unavailable without qualifying-use confirmation; direct free Open-Meteo Marine/Forecast/cloud use remains unavailable without its separate non-commercial confirmation. No paid account or commercial entitlement is inferred.
- **Server-only feeds:** NDBC buoy data requires `UCAS_WORLDVIEW_OCEAN_ENABLED=1`; other keyed or gated relays retain their separate disabled-by-default flags and credentials. No keys or feature flags were enabled in a deployed environment.
- **Coverage/display:** there is no Meteosat loop for Europe/Africa. IEM N0Q covers the contiguous U.S., not Alaska/Hawaii/Puerto Rico. ENC imagery is U.S.-waters context and at globe scale often shows chart outlines. Ocean products and model fields have their own latency, resolution and coastal limitations. WebGL overlays are not silently fabricated in the schematic fallback.

## Newer main behavior retained

The snapshots contain older versions of unrelated code. They are not a reason to remove newer capabilities:

| Preserved paths/category | Why not replace with snapshot content |
|---|---|
| `.gitignore`, LocalAI configuration/setup/run/inference scripts, API helpers and tests; `docs/local-ai-setup.md` | Preserve model verification, local-first/offline boundaries, setup fixes and artifact exclusions. |
| `Observations.tsx`, observation network/state, lattice evidence/reports and corresponding tests | Preserve newer evidence grounding, freshness, recovery and explicit unknown-data handling. |
| `EvidenceCopilot.tsx`, `Reports.tsx`, `report-utils.ts` and its tests, `TelemetryInspector.tsx`, telemetry CSS and contract tests | Preserve report provenance, reliability, telemetry inspection and schema coverage rather than roll them back. |
| `local-ai-inference.ts`, operational-event schema, persistence module and persistence tests | Preserve bounded history/persistence and operational-event safeguards. |
| Decision navigation, advisory-only Warden-NAV references and all ground-odometry code/documentation | Preserve existing main-only capabilities and their non-operational/local-only boundaries. |

The manifest lists every exact path and decision. These are preserved capabilities, not omitted compatible World View additions.

## Validation

Backend regression: **828 passed, 2 skipped**. Skips are the optional KISS-ICP wheel and optional ONNX Runtime, neither installed in the test environment. The resolved backend runtime requirement set passes `pip-audit`; its existing license set includes MIT, BSD and optional LGPL-3.0-only psycopg packages. No backend dependency was added by this port.

Frontend regression: **382 passed, 0 failed**. `pnpm typecheck`, `pnpm build` and `pnpm licenses:check` pass; dependency notices were verified for 16 packages. Both `pnpm audit` and `pnpm audit --prod` report no known vulnerabilities. Vite was upgraded to patched `6.4.5` after the initial dependency audit. The production build retains a non-failing bundle-size warning for the approximately 528 kB globe chunk. The final reconciliation contains no missing source additions or main-only files, and the diff passes whitespace checks with no file deletions.

A real browser check at 1265×649 confirmed WebGL globe rendering, NASA Blue Marble bathymetry actually draped over the globe with visible attribution, and a real IEM NEXRAD loop loading 10 frames, displaying provider UTC times and source age, and playing on the globe. The test used one frame-list request with auto-refresh off; all test opt-ins were switched off afterward. RainViewer restricted-use consent and Open-Meteo non-commercial consent were not asserted on the user's behalf. The EONET follow-up was validated with frontend unit tests, typecheck and a production build; no live EONET request was needed for the regression suite. Keyed providers, live model grids and every individual satellite/ocean product were not end-to-end tested against live services; their offline/schema/rendering regressions and configuration gates are not presented as live-service verification.
