# Mission Autonomy in SignalWarden AI

SignalWarden AI's **Mission Autonomy** workspace at `/missions` turns high-level, non-weapon mission templates into reviewable tasks for a synthetic team. It implements a browser-local planning and rehearsal loop—not autonomous control of real aircraft.

The design adapts public concepts from [Anduril's Mission Autonomy overview](https://www.anduril.com/lattice/mission-autonomy). It does not copy proprietary software, use a Lattice SDK, connect to Anduril services, or claim compatibility, affiliation, endorsement, or feature parity.

## What you can do

Choose area survey, infrastructure inspection, or search-and-assess. Compile the template into tasks, inspect the proposed allocation and resource constraints, approve the current revision, and start a synthetic rehearsal. Advance tasks explicitly to see completion and audit events. Pause to review, or inject a degraded asset to test the replan-and-reapprove loop. Download a synthetic JSON plan and Markdown debrief.

All roster entries and observations are seeded examples. PX4 quadrotor and ArduPilot fixed-wing labels describe synthetic planning profiles, not validated aircraft integrations. Land and sea assets are simulated reference nodes only. Switching templates or resetting starts a new exercise; leaving the workspace discards session state. Exports are local downloads, not mission upload files.

## How the source concepts apply

| Public source concept | SignalWarden implementation | Important boundary |
|---|---|---|
| Open architecture | Typed asset, capability, task, observation, and mission-state contracts; domain and autopilot labels | Internal extension points only; no third-party plugin loading or device discovery |
| Multi-domain teams | Synthetic air, land, and sea roster with domain/capability matching | No ground, maritime, or underwater hardware adapter |
| Integrated systems | One local state machine connects planning, resource checks, human review, rehearsal, and audit | Not an orchestrator for onboard piloting or real systems |
| Intent to task | Three deterministic non-weapon templates produce explicit task lists | Not natural-language interpretation or an LLM planner |
| Sensor fusion | Freshness-aware correlation of seeded observations by explicit subject ID, with distinct source/sensor labels | Not raw sensor processing, real-time tracking, target identification, or onboard ML; confidence is a reference summary, not calibrated probability |
| Resource management | Availability, known battery reserve, link, freshness, capability, domain, and allocation-capacity checks | No payload, gimbal, weapon, battery, or onboard sensor actuation |
| Dynamic planning | A degraded synthetic asset pauses rehearsal, invalidates approval, and requires explicit reallocation and renewed review | No background replanning or autonomous live retasking |
| Mission design and planning | Template selection, task review, revision tracking, and transparent assignment reasons | Not navigation, airspace clearance, terrain avoidance, geofence verification, or flight authorization |
| Human-supervised operations | Explicit local review, start, pause, and task-step controls | Browser workflow only; not server-enforced authorization or operator identity verification |
| Debrief and learning | Sequenced local audit, completion summary, JSON plan, and Markdown debrief | Human learning only; no model training, automatic policy updates, or deployment |

The original source includes combat and weapon-related features. Those are deliberately not implemented. This adaptation is limited to benign survey, inspection, and search rehearsal.

## Resource and review rules

The reference allocator requires an available asset in the correct domain with the required capability, a known battery at or above 30%, a known link at or above 60%, and observations no older than 30 seconds. Unknown values do not become healthy defaults. These thresholds are illustrative training constraints, **not** flight-safety margins or validated endurance estimates. Allocation is deterministic and bounded; it is not a globally optimal scheduler, energy model, collision-avoidance system, or navigation planner.

A plan revision must have no blocked tasks before it can be approved and started. Replanning or degrading an asset invalidates the previous approval. Task completion occurs only when the user explicitly advances the rehearsal. No wall-clock simulation, onboard autonomy, or hardware state is inferred from those steps. The synthetic observation ages are scenario inputs, not real-time freshness measurements.

Observation correlation groups explicit subject IDs rather than inferring identity from coordinates or imagery. Duplicate source reports are not independent corroboration. Stale or invalid measurements must not increase fresh confidence. A corroborated label is not evidence of ground truth.

## Aircraft boundary stays unchanged

The [aircraft gateway](aircraft-integration.md) remains receive-only for **both PX4 and ArduPilot**. This workspace does not read or write that gateway, the Management API, observation namespace, telemetry WebSocket, local model runtime, radios, autopilots, cameras, or payloads. It does not upload waypoints or send arming, takeoff, offboard, mission, or flight commands. The existing [Training C2 twin](simulation-training-console.md) remains a separate rehearsal surface; this workspace does not secretly drive it.

Real mission execution would require a separately reviewed control architecture, authenticated operator authority, autopilot-specific contracts, safety and failsafe analysis, aircraft and payload selection, and staged SITL/bench/HIL/flight evidence. Nothing in this change passes those gates or changes `flight_ready=false`.

## Code and validation

- `apps/management-web/src/mission-autonomy.ts`: pure typed local engine and exports.
- `apps/management-web/src/MissionAutonomy.tsx`: supervised rehearsal workspace.
- `apps/management-web/tests/mission-autonomy.test.mjs`: deterministic allocation, lifecycle, freshness, export, and invariant regression tests.

From `apps/management-web`, run `pnpm test`, `pnpm typecheck`, and `pnpm build`. From the repository root, run `python -m pytest -q` in the development environment. Browser checks should cover direct `/missions` navigation, complete rehearsal, degradation and reapproval, disabled unsafe transitions, export labels, and responsive layout. These validate local software only, not aircraft readiness or operational autonomy.
