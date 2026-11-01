# World View in SignalWarden AI

Open **World View** in the navigation, or visit `/worldview` in the local management UI. This is a read-only situational-awareness workspace, not an aircraft controller or an operational navigation map. The existing PX4 and ArduPilot telemetry support is unchanged.

## Start offline

The initial scene contains original, clearly labeled synthetic examples across aircraft, vessels, satellites, earthquakes, fires, weather, aggregate traffic, public-camera locations and ALPR locations. No third-party imagery, models, camera catalog, plate records or event dataset is bundled. If WebGL is unavailable, the workspace uses an interactive SVG orthographic globe; real 3D glyphs and oblique camera perspective require WebGL.

Drag the globe to rotate it, use the zoom control, or choose a city preset. Enter a city, decimal coordinates such as `38.9072, -77.0369`, or a `geo:` URI into local search and press Enter. Search covers nine original city presets and imported records, not a global geocoder.

The nearby roster has 250 km, 1,000 km and global scopes. Selecting a contact focuses the view; **Follow selected view** follows that observation's position in presentation only. **Global context** saves the local center, zoom, obliqueness and layer switches, displays global context, and can restore the saved view. At most 500 unique valid contacts are rendered on the globe at once, with selection prioritized; bounded packs may contain up to 5,000 observations. Dense labels are not a production decluttering system.

## Commands, notes and display

The local command field supports `search London`, `search geo:38.9,-77.0`, `count aircraft`, `filter earthquake`, `rank`, `annotate Review this area`, `reset` and `north up`. Counts are scoped to the active nearby radius; rank selects by stated confidence and timestamp, not by a threat score. `weather` and `pass` point to their explicit provider/orbit controls rather than claiming an automatic answer.

Voice is optional browser speech input, followed by manual command execution. Both the opt-in switch and an explicit browser confirmation are required; the browser vendor's speech service may process audio. Browser support and microphone permission vary. There is no realtime voice agent, synthesized response or local/offline transcription guarantee.

CRT, NVG, FLIR, Noir and Snow are cosmetic presentation filters—not sensor modalities. Detection overlays are drawn contact emphasis, not a computer-vision model, recognition result or evidence of a detection. Notes are bounded geographic annotations, not source evidence. No face/plate recognition, identity lookup, weapon tasking or actuation is exposed.

## Scenes, director and synthetic replay

Capture at least two centers, then play the director path. Up to eight keyframes interpolate center/zoom smoothly, including across the date line. Pause or scrub the timeline. This directs the local view only; it does not operate a camera or aircraft.

**Synthetic replay** animates a two-minute original demo scenario. It never generates plausible-looking trajectories from fetched real provider contacts. Replay records are explicitly synthetic and are not historical world reconstruction. Pause/scrub works independently of provider snapshots. A shared scene or exported scene preserves geographic/display state, annotations and director keyframes—not fetched observations, playback progress, voice permission or network opt-in.

Share view validates the scene, writes an encoded URL and copies it when clipboard permission allows. URLs over 8,000 characters are rejected with a recommendation to export a file. Export/import scene and observation pack are separate operations. Files are size/schema checked before use; observations allow only bounded primitive metadata, credential-like fields are rejected, and duplicate IDs are rejected. This is not an authenticity, privacy-consent or runtime-data-license verifier. Never import or redistribute restricted upstream event packs.

## Optional external reads

External requests start **off** and require a manual refresh. The browser sends the chosen coordinates to the named provider for weather/aircraft requests. There is no key-entry control because the three implemented sources are keyless. The [provider matrix](worldview-data-sources.md) distinguishes these from integrations that require credentials, contracts or licenses and do **not** yet exist.

- **USGS:** up to 100 earthquakes from the trailing 24 hours. Event timestamps are distinct from snapshot retrieval time. This is not an early-warning system.
- **NOAA/NWS:** U.S. `weather.gov` gridpoint forecast. The record includes forecast-period temperature, unit, wind, short description and validity. Its timestamp is forecast issuance, not an observed weather measurement; expired periods are stale. No global forecast, radar, lightning or real thermal data is implied.
- **adsb.lol:** at most 100 nautical miles around the selected center; up to 500 normalized contacts. Position age comes from the provider timestamp and reported position age. Callsign, registration, owner and person lookup are excluded. ODbL/provider attribution remains visible. Production terms/contact requirements still apply.

Adapters have HTTPS host allowlists, redirect rejection, bounded timeouts, streamed 1 MB caps, manual refresh limits of at least 60 seconds, and explicit stale/failure handling. They do not automatically substitute demo observations for failed live reads. CORS, provider availability or rate limits can make a source unavailable; this PR does not introduce a proxy to bypass provider restrictions.

NASA EONET live requests are **disabled** pending event-source license review. Fire markers are synthetic or user-authorized imported metadata only. FIRMS detections, live AIS, live traffic, public-camera feed catalogs, imagery/terrain and the other [documented gaps](gods-eye-capability-coverage.md) are not secretly enabled by adding a key.

## Orbital geometry

Paste a two-line TLE you are authorized to use. The local satellite.js SGP4 module validates line lengths/checksums, plots a current estimated position and computes geometric rise/peak/set passes above a 10-degree elevation threshold over the next 24 hours. It fetches no catalog and bundles no orbital dataset. It does not assess cloud cover, lighting, visual visibility, collision risk or actual sightings. Old elements lose accuracy; inspect the TLE epoch before relying on the estimate.

## Validation and known limits

Local validation for this change:

- Frontend TypeScript check and production build succeeded; 102 frontend tests passed, including credential/pack sanitization, scene validation, geographic/director math, mocked provider security/freshness and orbital propagation.
- All 511 backend regression tests passed, including existing aircraft-related coverage. No backend or autopilot control code changed.
- Browser checks exercised the offline fallback, city focus, annotations containing `%`, NVG style, two-keyframe interpolation/pause, encoded scene sharing and reload restoration. No horizontal page overflow was found at the tested desktop viewport.
- NOAA forecast refresh succeeded in the actual browser. USGS timed out and adsb.lol failed to fetch in that environment; both displayed explicit failure without a fabricated live replacement. Mocked adapters passed deterministically. These are not claims of reliable live coverage.
- This browser did not provide WebGL, so the SVG fallback was verified visually; the real GPU renderer/oblique view still needs a WebGL-capable device smoke test. Voice/microphone capture and every provider's production licensing were not end-to-end certified.
- The lazy-loaded Three.js vendor chunk produces a build-size warning (about 526 kB minified / 131 kB gzip). Existing platform routes do not load the World View entry until it is selected.

Run locally with `pnpm --dir apps/management-web dev`. Validate with `pnpm --dir apps/management-web test`, `pnpm --dir apps/management-web typecheck`, `pnpm --dir apps/management-web build`, and the repository's Python test environment. This workspace is included in main through PR #18 (merge commit `b68d913`). Merge status does not establish deployment, Lattice sandbox validation, production provider configuration, or operational readiness.

## Source-grounded scene analyst

World View now includes a local-first analyst for bounded natural-language questions over loaded region/time/layer and platform evidence, observation history, source-quality explanations, and cited advisory briefing/annotation drafts. It defaults to model-free deterministic tools, optionally uses configured loopback Qwen to organize fixed findings, and never silently falls back to external AI. See [the analyst guide](worldview-ai-analyst.md) for setup, egress consent, voice filtering and limitations.
