# UCAS Management Web UI

React and TypeScript management console for the UCAS drone project. The first implementation is a synthetic-data reference UI following the Aviation Technical Ledger direction: paper-toned surfaces, dark ink, orange safety accents, compact operational metadata, and explicit simulation labels.

## Run

```bash
pnpm install
pnpm dev
```

The application includes Fleet, Live Monitor, Camera Wall, Training C2, Maintenance, Access Management, Role Catalog, and Access Audit surfaces. The Camera Wall presents six synthetic channels for the selected aircraft (forward/downward EO, forward IR, port/starboard EO, and rear EO), with freshness, signal, stale/degraded states, and a selectable inspector. Training C2 is a disconnected digital-twin rehearsal console with mock flight-phase/navigation intent controls, four simulated autonomy modes, lifecycle management, a synthetic route map, preflight safety gates, scenario clock, an audit queue, and a review-only Tracegate evidence-readiness panel. Use the persona selector in the top-right to inspect the navigation and permission experience for an Access Administrator, Drone Operator, or Telemetry Viewer.

`public/rbac-catalog.json` is the frontend-served copy of the canonical `packages/contracts/v1/rbac-catalog.json` role and permission catalog. The UI loads it at runtime and does not duplicate permission definitions in component code. In a connected deployment, replace this static contract fetch with the server-authoritative catalog endpoint.

The frontend never connects directly to an aircraft and exposes no real command, autonomy authorization, gimbal, radio, flight-controller, payload, or device-credential route. Training C2 commands and autonomous-mode operations mutate only an in-memory digital twin; the map uses invented geometry and no GPS coordinates. There is no command API, radio transport, autopilot adapter, or real-aircraft identifier. Tracegate is informational only: it does not certify safety, authorize release, or gate flight/simulator execution. The current video wall is a synthetic observation reference: a production implementation must provide an authenticated gateway/WebRTC or HLS manifest endpoint and enforce per-camera authorization server-side. It treats server-side authorization as authoritative; demo interactions only create synthetic feedback and do not write production records.

## Fleet explorer

The Fleet page supports all-word search across name, ID, type, source, location, environment label, and status. Combine status/environment filters with **Needs attention only**, sort by name, lowest battery, or oldest sample, and reset the view. Filters are local to this page and reset when navigating away. The selected aircraft remains selected across pages; when filters hide it, the inspector explicitly says so rather than silently switching aircraft.

Summary cards describe the entire demo inventory, not only filtered results. Freshness is derived from synthetic fixture sample ages: fresh at 30 seconds or less, delayed up to 5 minutes, stale beyond that, and unknown for invalid ages. Attention means non-available status, non-fresh data, battery below 30%, or link below 80%. These are demo display rules, not operational limits, live health assessments, or flight-readiness approval. The sample ages are static, not a running clock.

**Export filtered CSV** downloads the visible records in their displayed order, with every row marked `SYNTHETIC DEMO` (including lab-labeled articles). Fields are quoted, embedded quotes/newlines are preserved, and formula-like spreadsheet values are apostrophe-prefixed. The download is UTF-8 with a BOM for spreadsheet compatibility. Nothing is sent to a server. Empty result sets disable export.

Run `pnpm test` for deterministic utility regression tests, then `pnpm typecheck` and `pnpm build`. CI runs all three. The frontend tests use the existing TypeScript compiler and Node's built-in test runner; no test framework dependency is required.
