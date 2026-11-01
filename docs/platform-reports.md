# Platform reports

The read-only reports API provides deterministic, advisory summaries over the
canonical management repository and the local `OfflineLattice` observation
snapshot. It never saves a report or evidence artifact and it has no control,
tasking, targeting, weapon, effector, or transport connection.

## Endpoints

- `GET /api/v1/reports/options` returns the report types and the currently
  available canonical platform and sensor IDs.
- `POST /api/v1/reports/generate` accepts a JSON options object and returns a
  deterministic report. Supported options are `type`, `start`, `end`,
  `platformIds`, `sensorIds`, and `engine` (`template` or `local`). Times are
  RFC 3339 values; `start` and `end` are inclusive. Unknown fields and invalid
  types, IDs, or ranges are rejected.

Supported report types are `platform-status`, `sensor-isr`,
`incident-timeline`, `data-quality`, and `operator-handoff`.

## Data coverage and safety

The adapter reads aircraft lifecycle status, telemetry battery and link quality,
maintenance status, ingestion status, and bounded ingestion events through the
public store interfaces. It preserves source IDs and observed times when the
repository provides them. Missing source identity, time, or provenance fails
closed as `unknown`; synthetic values are never marked trusted. Maintenance
notes and all raw coordinates are excluded, as are tactical, control, weapon,
effector, and inventory fields.

The platform-wide default combines those repository records with the local
read-only `OfflineLattice` overview. Decorative frontend mock fleet, camera,
user, and training data are not a report source. Reports are snapshots, not an
historical truth reconstruction: a missing or short-retention repository cannot
recreate a complete outage timeline. Coverage gaps and limitations are returned
in the report.

Reports are advisory and always require human review. The `local` engine option
uses the local fallback policy; there is no external model or external data
fallback. Evidence is returned as bounded citations only, and generation is
read-only.

## Use the workspace

Open **Reports & documents** in the sidebar (`/reports`), select a document
purpose, and choose **Generate preview**. Leave all filters blank for the
platform-wide dataset. Optional platform and sensor dropdowns contain only IDs
available from canonical records; selecting a sensor does not invent a collection
payload. Time controls use the browser's local time zone and send inclusive UTC
bounds to the API. Undated records cannot establish membership in a bounded time
range and are excluded with a coverage disclosure.

The preview links every material claim to its exact report evidence record,
including source ID, original observation timestamp, freshness at generation,
provenance trust, synthetic status and unknown physical-world confidence.
Freshness is frozen at generation time, not a live verification. Use **Download
Markdown** or **Download JSON** to save the exact preview artifact. Markdown
includes a source appendix; JSON retains structured sections, filters and
citations. Changing a filter clears the old preview to avoid exporting a document
under a different scope.

Deterministic templates are the default and need no AI runtime. Explicit local
assistance is limited to selecting fixed, cited data-quality highlights using
the configured loopback local runtime. Missing/unavailable local inference falls
back to deterministic content; it never switches to external AI, even if another
workspace has external assistance configured. No arbitrary model narrative is
accepted as evidence.

## Boundaries and current limits

ISR here means descriptive sensor metadata and collection provenance only. The
current fixtures do not include image/video collection payloads or verified
physical-world detections. A sensor type or historical offline flag does not
establish an incident, outage duration, target, threat or current connection.
No target scoring, identification prioritization, firing/arming, weapon employment,
autonomous engagement or platform control is provided.

Repository records are read through existing interfaces; this is not a new
append-only archive or a cross-store transactional snapshot. Accepted/late events
are summarized when recorded, and aggregate ingestion counts may include outcomes
without per-event history. Missing history, unknown timestamps and trust remain
visible rather than being inferred. No report is persisted to the platform or
added to its observation/evidence store. Review and distribution remain human
responsibilities. The local reference API has no new production identity or RBAC
implementation; deploy only behind the project's existing access boundary.
