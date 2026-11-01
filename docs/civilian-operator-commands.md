# Civilian operator command gateway

## What this adds

A separate, opt-in CLI/library dispatch path supports exactly three commands: `hold`, `return_home`, and `land`. Each must be signed by an explicitly authorized human operator and address one enrolled civilian aircraft. There is no extra confirmation prompt for these non-weapon commands. Mandatory security checks still run for every request.

A bounded autonomous run may execute one to three fixed, signed commands within at most 30 seconds, explicitly pre-authorized by the operator, with visible status and an interrupt/abort control. It is not an open-ended planner: no AI-generated live decisions, arbitrary schedules, unbounded chaining, background fallback, or automatic retries are permitted. Each return-home or landing request remains one of the operator-authorized actions; this does not add route or mission planning.

## What remains forbidden

Weapon, effector, payload, targeting, engagement, arming, takeoff, mission upload/execution, arbitrary modes, offboard setpoints, parameter writes, actuator control, broadcast commands, and custom opcodes are not supported. Unknown actions and extra request fields are rejected rather than forwarded. There is no override, confirmation-based escape hatch, or general-purpose message tunnel.

The receive-only MAVLink adapter is unchanged and still sends no heartbeat, stream request, or command. The Management API, telemetry ingestion, telemetry WebSocket, observation catalog, advisory AI, Training C2, and demo RBAC acquire no command route or command permission. Telemetry credentials and freshness labels do not authorize commands.

## Security gates

The command gateway is disabled by default. A protected deployment configuration separately enrolls human operators, aircraft, permitted actions, command credentials, and a fixed HTTPS bridge endpoint. Requests are strict, signed, short-lived envelopes bound to the deployment, operator, aircraft, command identity, sequence, and action. Durable replay state and audit are independent of telemetry storage. Missing, invalid, or unavailable security state fails closed; initialization is an explicit one-time deployment step, not a replay-recovery mechanism.

The HTTPS path requires server certificate verification and a client certificate. It has no HTTP fallback, redirect following, environment-proxy fallback, or request-controlled destination. Fresh, signed, request-correlated bridge status is required before dispatch. Signed acknowledgement identity and freshness are checked after dispatch. Deployment keys must remain outside Git and separate from telemetry publisher/read credentials.

Replay reservation and dispatch intent must be durable before the command can be sent. Each request is consumed at most once. A timeout or unverifiable acknowledgement after a possible send is an **unknown outcome**, never success and never an invitation to retry. Reconcile with the independent bridge and aircraft before deciding on a new operator action. Receipt by a bridge is not proof that an aircraft executed the request.

## The bridge is a separate prerequisite

This repository implements the gateway-side transport and validation, not an aircraft bridge or MAVLink transmitter. A deployment needs an independently implemented and reviewed bridge that authenticates operators, enforces the same action/aircraft restrictions, rejects stale and replayed commands, applies aircraft-local safety gates, and returns authenticated status and acknowledgements. Do not point the gateway at an arbitrary aircraft service.

“Civilian” is a reviewed enrollment policy, not proof supplied by an untrusted request or telemetry message. Do not enroll weapon-equipped, effector-equipped, mixed-use, or uncertain platforms. These commands can still cause physical harm; aircraft-specific failsafes, operator qualifications, site authorization, and platform review remain mandatory. No code here establishes flight readiness or replaces aircraft-local safety functions.

## Review and validation

The [architecture decision](decisions/0005-civilian-operator-commands.md) records the proposed boundary. The implementation lives in `services/civilian_commands/`; mocked behavior and denial regressions live in `tests/test_civilian_commands.py` and `tests/test_civilian_bounded_runs.py`. See the [exact configuration, bridge contract, CLI monitoring, and abort semantics](../services/civilian_commands/README.md).

Run local development validation with:

```bash
.venv/bin/pytest -q tests/test_civilian_commands.py tests/test_civilian_bounded_runs.py
.venv/bin/pytest -q
```

These checks must use mock transports and synthetic identities only. They do not connect to real aircraft or prove bridge, firmware, hardware, SITL/HIL, flight, or production-security compatibility. No bridge is configured or started by the normal application startup. The command gateway must remain disabled and undeployed until separate owner and safety/security review.
