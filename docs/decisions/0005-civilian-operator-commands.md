# 0005 — Separate civilian operator command gateway

**Status:** Proposed for owner review; implemented locally, not approved for deployment or flight.

## Decision

Add a separate, disabled-by-default command gateway for explicit human-operator requests to enrolled civilian aircraft. The complete operation allowlist is `hold`, `return_home`, and `land`. Each request is signed by an authorized operator. A bounded run can execute a fixed sequence pre-authorized by that operator, with visible status and an interrupt/abort control. There is no extra confirmation prompt for these non-weapon commands. Authentication, authorization, signature verification, identity, freshness, durable replay rejection, validation, and audit are mandatory gates, not confirmation dialogs.

Weapon/effector operations remain unavailable, not merely hidden behind confirmation. There is no arbitrary opcode, payload control, targeting, engagement, arming, takeoff, route upload, mission execution, open-ended autonomous planner, unbounded chaining, scheduling, or model-generated command path. The change does not relax any existing weapon/effector safeguard.

The new gateway is independent of the Management API, receive-only MAVLink adapter, telemetry ingestion and fanout, observation catalog, demo RBAC, Training C2, and advisory AI. Those components acquire no command permissions or transport handles. Fresh telemetry alone is never authorization to command an aircraft.

## Transport boundary

The gateway communicates only with an independently provisioned civilian bridge through mutually authenticated HTTPS. A trusted deployment configuration pins operator identities, aircraft identity, authorized actions, keys, and bridge endpoint. Signed fresh bridge status is required before dispatch; the bridge must enforce the same restrictions and aircraft-local safety gates. An authenticated acknowledgement establishes receipt only, not successful physical execution.

The repository does not implement or provision that bridge, certify an aircraft, or establish that a label such as “civilian” proves the physical platform's configuration. Enrollment must be reviewed against the actual airframe and attached systems. Mixed-use, weapon-equipped, effector-equipped, or uncertain platforms must not be enrolled. Aircraft-local failsafes remain authoritative.

## Failure behavior

Consume replay state and persist dispatch intent before sending. Do not retry automatically. If the transport or acknowledgement fails after a possible send, the outcome is unknown; an operator must reconcile with the independent bridge and actual aircraft before deciding on any new action. Never replay a consumed request or reset state to recover a failed command. Storage/audit failures fail closed.

## Evidence and limits

Acceptance requires mocked positive tests for the three actions without confirmation and negative tests for prohibited commands, unauthorized identities, stale or tampered envelopes, replay across restart, and unavailable storage/transport. Existing receive-only wire tests remain part of regression validation. Tests use synthetic identities and mock bridges only; they are not firmware, hardware, SITL/HIL, flight, or production-security validation. Bounded-run tests must also cover authorization, limits, completion gating, visible status, abort, and no dispatch after interruption. The PR must remain unmerged and undeployed pending review.
