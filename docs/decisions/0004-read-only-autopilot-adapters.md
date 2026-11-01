# ADR-0004: Receive-only PX4 and ArduPilot adapters

**Status:** proposed for owner review; implemented as a local-lab reference.

## Decision

Support both user-requested autopilot families through common MAVLink telemetry. Keep stabilization, mission execution, failsafes, arming, takeoff and all flight-control authority on the commissioned autopilot. Do not connect the disconnected Training C2 UI to aircraft commands.

Use one explicitly configured system/component and autopilot family per gateway. Require explicit simulated/aircraft labeling; simulator traffic remains simulated. Use a new telemetry v1.1 shape for unknown health, optional flight observations and session identity without weakening the existing v1.0 shape.

Authorize real-aircraft API publishers through a local external registry and scoped bearer tokens. Fail closed when that registry is unavailable. Reject materially future-dated observations; use canonical API receipt time. Include source category/session in event identity and use identical deterministic ordering across memory/PostgreSQL stores.

## Consequences

This makes a receive-only integration path available for serial/UDP/TCP MAVLink streams. It does not select an airframe, board, autopilot release, radio, parameter set, production network, mission planner or flight envelope. Autopilot-family recognition and unit tests are not hardware certification or proof of fully autonomous operation.

Receiver-side MAVLink signing verification and durable replay rejection are implemented with synthetic tests; actual provisioned-key firmware acceptance remains open. Both pinned disarmed passive firmware-to-API runs passed but carried unsigned telemetry and remain untrusted. See the [ingress policy](../telemetry-ingress-security.md) for strict signing, explicit untrusted lab mode, authorized API assertions and the operator-asserted secure-transport boundary. Production access control outside telemetry ingestion, publisher failover policy, live UI binding, selected-airframe dynamics/failsafes, bench/HIL tests and supervised-flight evidence remain separate gates. The current gateway is limited to an isolated local lab; it must not be deployed as an operational aircraft-control system.

See the [integration guide](../aircraft-integration.md) for commands, evidence and commissioning gates.
