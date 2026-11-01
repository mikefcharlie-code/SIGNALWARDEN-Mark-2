# SignalWarden AI web workspace

React 19 and TypeScript reference application built with Vite, Three.js, and satellite.js. It provides local-first observations, cited analysis and reports, offline spatial context, synthetic management views, and disconnected training. It is not production- or field-validated.

## Run

```bash
pnpm install --frozen-lockfile
pnpm dev
```

The application includes Fleet, Telemetry Inspector, Camera Wall, Training C2, Maintenance, Access Management, Role Catalog, and Access Audit surfaces. Camera Wall shows six synthetic channels for the selected aircraft (forward/downward EO, forward IR, port/starboard EO, and rear EO), with freshness, signal, stale/degraded states, and an inspector. Training C2 is a disconnected digital-twin console with mock flight-phase/navigation intent controls, four simulated autonomy modes, lifecycle management, a synthetic route map, preflight gates, scenario clock, audit queue, and review-only Tracegate evidence-readiness. The persona selector shows the navigation and permission experience for an Access Administrator, Drone Operator, or Telemetry Viewer.

`public/rbac-catalog.json` is the frontend-served copy of `packages/contracts/v1/rbac-catalog.json`. The UI loads it at runtime rather than duplicating permission definitions. In a connected deployment, replace the static fetch with the server-authoritative catalog endpoint.

The **Observation workspace** at `/observations` is available to every demo persona. It uses relative `GET /api/v1/lattice/*` requests and displays explicit offline/error states; it never substitutes fixture data after API failure. Failed refreshes retain the last successful memory-only snapshot with a `NOT CURRENTLY VERIFIED` warning and unchanged timestamps. Reads use bounded timeout/retry, cancellation, and reconnect recovery; this is API resilience, not mesh networking. The assistance panel reports rules versus model status, evidence and human-review limits, and external export disclosure. See [local-first AI and networking configuration](../../docs/observation-assistance-networking.md). Vite proxies `/api/v1/lattice`, `/api/v1/local-ai`, and `/api/v1/reports` to `http://localhost:8000`.

The frontend never connects directly to an aircraft and exposes no vehicle or weapon/effector command path. The repository has a separate optional receive-only PX4/ArduPilot MAVLink adapter; synthetic fleet/monitor views are not bound to it. Training controls mutate only an in-memory digital twin with invented, non-GPS geometry. World View separately supports geographic coordinates and opt-in provider observations. Tracegate is informational, not safety certification or flight authorization. Camera Wall is synthetic, not authenticated live video. Demo personas and permission views are not production authorization; server-side enforcement remains incomplete.

## Spatial context and optional AI

Open `/worldview` for offline layers, local place/coordinate search, annotations, scene sharing/export, a view director, synthetic replay, and bounded observation-pack import/export. User-supplied TLEs support local SGP4 position/pass estimates, not sightings. USGS, U.S. NOAA/NWS, and coarse adsb.lol reads are manual and opt-in; provider failures stay visible. Other feed categories and imagery/terrain remain unavailable. This is not full God's Eye View parity.

The scene analyst provides deterministic cited findings without a model; optional configured local Qwen can organize them. Model setup and inference are separate. Real weights, GPU inference, performance, and WebGL rendering are unvalidated; prior browser checks verified the SVG fallback. Generated media is not evidence. External AI and browser speech have separate opt-ins and egress disclosures. See [World View](../../docs/worldview-workspace.md), [scene analyst](../../docs/worldview-ai-analyst.md), and [local inference](../../docs/local-ai-inference.md).

## Fleet explorer

The Fleet page searches all words across name, ID, type, source, location, environment label, and status. Combine status/environment filters with **Needs attention only**, sort by name, lowest battery, or oldest sample, and reset the view. Filters are page-local and reset when navigating away. The selected aircraft persists across pages; if filters hide it, the inspector says so rather than switching aircraft.

Summary cards cover the full demo inventory. Freshness uses synthetic sample ages: fresh at 30 seconds or less, delayed through 5 minutes, stale beyond that, and unknown for invalid ages. Attention means non-available status, non-fresh data, battery below 30%, or link below 80%. These are display rules, not operational limits or flight-readiness approval; sample ages are static.

**Export filtered CSV** downloads visible records in display order, marking every row `SYNTHETIC DEMO` (including lab-labeled articles). Fields are quoted, embedded quotes/newlines preserved, and formula-like values apostrophe-prefixed. The UTF-8 download includes a BOM for spreadsheet compatibility and sends nothing to a server. Empty results disable export.

Run `pnpm test` for deterministic utility regression tests, then `pnpm typecheck` and `pnpm build`. CI runs all three. Tests use the existing TypeScript compiler and Node's built-in test runner.

## Telemetry inspector

Open `/monitor` or choose **Telemetry**. This is an offline synthetic reference: it issues no telemetry HTTP/WebSocket request or aircraft command. The top bar identifies a demo persona. Choose an aircraft directly; the selection is shared with Fleet and Camera Wall. Switching aircraft resets telemetry controls so what-if scenarios do not carry over.

Each article has its own fixture. The first has flight-state measurements; the maintenance article has battery/link history but no fabricated altitude, heading, or ground speed; the lab-labeled article has no ingestion history or flight-state measurements. Unknown values are not rendered as zero or borrowed. Ages are static fixture metadata.

Freshness follows Fleet rules: fresh through 30 seconds, delayed through 300 seconds, then stale. Delayed measurements are labeled last-known; stale, invalid-age, and nonfinite measurements display **Unavailable**. These are presentation thresholds, not safety limits.

Switch between battery, link quality, and altitude histories with 1-, 5-, or 15-minute windows. Axes are fixed by metric (percentage 0–100, altitude 0–200 m), missing samples are gaps, and an expandable table provides the values without chart interpretation. Times are relative to the fixture snapshot; charts remain historical when snapshot values are suppressed.

The two simulated articles support **What-if: link loss** and **What-if: recovery**. These are deterministic local previews, not detected outages, actual recovery, or Fleet updates. The lab article's selector is disabled. **Reset demo view** restores the fixture and defaults; it does not resync or fetch.

Ingestion outcomes show per-aircraft synthetic accepted, late, duplicate, and rejected examples. Search by sequence, source, event ID, or reason and combine with an outcome filter. A selected row shows disposition, source, event ID, and aircraft identity. Counts cover the selected fixture before event filtering. Empty histories/results stay explicit, and controls reset when leaving the page.

The deterministic utility tests run with `pnpm test` alongside Fleet tests. No backend interfaces, persistence, aircraft transport, production access-control behavior, merge, or deployment is changed.

## Reports & documents

Open `/reports` for platform/fleet status, descriptive sensor/ISR metadata, incident/event timeline, data-quality/communications gaps, or operator handoff. The default scope is canonical repository and read-only observation data, not decorative frontend fixture cards. Platform, reported sensor, and inclusive time filters are optional. Preview claims link to exact evidence; Markdown and JSON downloads preserve provenance and explicit unknowns. Reports are advisory derived artifacts, not verified source evidence.

Run the management API on `localhost:8000` alongside `pnpm dev`; Vite proxies `/api/v1/reports` to it. Templates require no model. Local assistance is an explicit selection with deterministic fallback and no external-AI path. API or schema errors show an error rather than substituting data. See [platform reports](../../docs/platform-reports.md) for coverage and limitations.
