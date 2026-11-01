# Operator and training user guide

## Before opening the UI

Confirm that you are working in the synthetic/reference environment. The current UI uses demo personas, simulated aircraft, synthetic telemetry, synthetic camera feeds, and an invented training map. Do not paste real aircraft identifiers, coordinates, credentials, or operational logs into the demo.

## Fleet and telemetry

The Fleet view summarizes synthetic aircraft inventory and freshness. Live Monitor separates latest state from event history and labels stale/degraded conditions. A late or duplicate sample is a data-quality event, not permission to infer current aircraft state.

## Camera Wall

Camera Wall is an observation-only surface. Select a synthetic aircraft and inspect channel state, freshness, signal, and degraded/stale treatment. Feeds are not live aircraft video and cannot control a camera, gimbal, payload, or radio.

## Training C2

Training C2 rehearses sequencing against a browser-local digital twin. The safety gates should remain visible before any exercise: digital twin selected, transport disabled, local command scope, audit stream, synthetic geofence, and unavailable aircraft path.

The autonomy manager supports four rehearsal modes: supervised autonomy, bounded route, degraded-link recovery, and sensor-confidence hold. Use **Start simulated mode**, **Pause**, **Inject review event**, and **Reset** only to rehearse local state transitions. The route map is invented and carries `NO GPS` labeling.

## Tracegate review

Select a benign configuration-change scenario, inspect impact closure, affected requirements, selected tests, and the reason code. A `READY` or review disposition is informational for the digital twin. It is not a flight authorization, safety certificate, release approval, or proof that an aircraft is safe.

## RBAC surfaces

Access Management and Role Catalog explain synthetic assignments and permissions. The UI is an explanation surface; a production API must re-authorize every endpoint, export, stream, camera session, and administrative mutation at the service boundary.

## Reset and incident response

For a confused demo state, reset the twin and reload the browser. If a real credential, real coordinate, or real operational record is accidentally entered, stop sharing it, preserve only the minimum facts needed for private reporting, and follow [SECURITY.md](../SECURITY.md). Do not continue a demonstration with real data.
