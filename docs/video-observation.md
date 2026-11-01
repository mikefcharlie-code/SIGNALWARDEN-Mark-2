# Video observation and camera gateway

**Status:** synthetic reference implementation in M1; production gateway design for M2 review.

The management UI now includes a Camera Wall at `/cameras`. It presents six synthetic channels for the selected aircraft: forward electro-optical, downward electro-optical, forward infrared, port electro-optical, starboard electro-optical, and rear electro-optical. Each card exposes channel identity, freshness, link health, resolution, frame rate, and `live`, `degraded`, or `stale` state. The selected-feed inspector and the synthetic frame counter make the expected live-observation interaction concrete without pretending that a browser is connected to an aircraft.

## Production boundary

The browser must never connect directly to a camera, gimbal, radio, flight controller, onboard network, or device credential. A future video gateway owns camera transport and returns only an authenticated, short-lived, per-camera stream manifest. The gateway may expose WebRTC for low-latency observation and HLS/CMAF for fallback playback, but transport choice is deferred until camera hardware, network, codec, retention, and jurisdictional requirements are reviewed.

The management API remains the authorization boundary. A camera manifest request must verify the caller's role, aircraft scope, camera scope, suspension/expiry status, and environment. The UI is an explanation surface and must treat a server `403`, `401`, expired assignment, suspended aircraft, stale manifest, or gateway outage as an explicit state rather than infer access from a cached page.

## Proposed endpoints

| Endpoint | Purpose | Boundary |
|---|---|---|
| `GET /v1/aircraft/{aircraft_id}/cameras` | Return the versioned camera manifest | Server-side `camera.read` and aircraft-scope authorization required |
| `POST /v1/aircraft/{aircraft_id}/cameras/{camera_id}/session` | Mint a short-lived observation session or WebRTC offer | No command scopes; never returns device credentials |
| `GET /v1/video/sessions/{session_id}` | Return session state and freshness | Session is revocable, bounded, and audit-correlated |
| `DELETE /v1/video/sessions/{session_id}` | End an observation session | Ends gateway observation only; no aircraft action |

The manifest contract is [`packages/contracts/v1/camera-manifest.schema.json`](../packages/contracts/v1/camera-manifest.schema.json). A manifest `source=simulated` is mandatory for the current M1 UI and must remain visibly labeled. Production media URLs should be relative or gateway-owned references; bearer tokens, query-string secrets, private keys, raw authorization headers, and camera credentials must not appear in the manifest or audit log.

## Operational states

`live` means the gateway has received a fresh keyframe or media heartbeat within the configured threshold; it does not mean that the aircraft is safe to operate. `degraded` means the channel remains observable but has elevated loss, latency, or reduced frame rate. `stale` means the UI may show the last keyframe only and must not present it as current. `suspended` means playback is blocked by policy or aircraft state. Missing, malformed, or unauthorized manifests fail closed.

The current Camera Wall deliberately renders synthetic feed treatments rather than opening external media. This keeps development, CI, and Preview hardware-free while preserving the intended user experience and the safety boundary for later gateway work.
