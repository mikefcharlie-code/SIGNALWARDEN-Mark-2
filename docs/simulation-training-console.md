# Disconnected simulation and training C2 console

**Status:** implemented as a browser-local digital-twin reference; no aircraft transport.

The management UI's `/training` route is a realistic rehearsal surface for operator sequencing, preflight discipline, state monitoring, incident response, and after-action review. It is intentionally not an aircraft control product. The console mutates an in-memory twin only and is resettable at any time.

## Simulation model

The twin has a phase (`Grounded`, `Taxi`, `Airborne`, or `Return to home`), altitude, heading, ground speed, battery, link quality, scenario clock, and a synthetic safe training zone. The map contains no real coordinates. The scenario clock and state transitions are deterministic enough for demos and UI tests; a future simulator service may replace the browser-local reducer without changing the safety-facing contract.

## Mock command deck

The current controls are intentionally limited to benign rehearsal intents:

- Begin taxi
- Simulate takeoff
- Simulate land
- Set 120 m synthetic altitude
- Set heading 042°
- Hold position
- Return to home

Each control creates a scenario-timestamped audit event and changes only the local twin state. It does not call a management API, publish to the telemetry WebSocket, mint a video session, open a radio, send MAVLink, change a real autopilot, move a gimbal, operate a payload, or identify a real aircraft.

## Safety gates

The console presents six gates before an exercise: digital twin selected, transport disabled, command scope limited to the browser session, audit stream active, synthetic geofence loaded, and aircraft control path unavailable by construction. The last gate is not a warning that an operator may dismiss; it is an invariant of this reference implementation.

A production training service should preserve these invariants server-side as well. It should use a separate simulator namespace and credentials, reject real aircraft identifiers, deny hardware transport configuration, make scenario reset and replay explicit, and expose only a mock-command contract. Any hardware-in-the-loop work must keep actuators disabled and require an independently reviewed test harness; it is outside this UI change.

## Future simulator boundary

If the browser-local reducer is replaced by a simulator service, the safe boundary should remain:

```text
Training UI -> Training API -> Simulator / digital twin
                                      X
             no route to radios, autopilots, payloads, gimbals, or aircraft networks
```

The simulator may expose deterministic scenario state, command acceptance/rejection, event timestamps, faults, and replay checkpoints. It must not share production aircraft credentials or use an adapter that can route commands beyond the simulator namespace.

## Simulated autonomous operations

Training C2 now includes a browser-local autonomy operations manager with four rehearsal modes: supervised autonomy, bounded-route execution, degraded-link recovery, and sensor-confidence hold. The manager shows mode state (`Ready`, `Running`, `Paused`, or `Review`), a synthetic route map with checkpoints, a training geofence, lifecycle steps, and a review-event injector for benign fault rehearsal.

These are autonomous behaviors of the digital twin only. `Start simulated mode` advances the local scenario; `Pause`, `Reset`, and `Inject review event` update local training state and audit context. The map uses invented geometry and explicitly carries `SYNTHETIC RANGE / NO GPS`; it is not a navigation map and does not contain aircraft coordinates. No mode manager, route, recovery action, or autonomy state leaves the browser-local sandbox.

The operational boundary is therefore:

```text
Training UI -> local digital twin -> synthetic autonomy state/map
                                  X
       no route to aircraft, autopilot, radio, payload, or live mission network
```
