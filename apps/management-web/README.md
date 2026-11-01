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
