# Interface contracts

Draft JSON Schema 2020-12 contracts for telemetry, aircraft inventory, maintenance records, and bounded operational events. Validate with a format checker; `format` is not necessarily enforced by default in every validator.

- Contract major version: `v1/`; payload version: `1.0`.
- Examples in `examples/` are synthetic and must remain so.
- Timestamps use UTC with a trailing `Z`; percentages are 0–100.
- Unknown properties are rejected. Introduce compatible changes deliberately, and use a new major version for breaking changes.
- Sequence is scoped to a producer session; restart/session semantics are not yet designed.
- `received_at` is an ingestion-side timestamp. The offline generator uses the same fixed synthetic sample/receipt time; a future gateway must set it itself, not trust a device-supplied value.
- A future service must enforce timestamp ordering, aircraft existence, maintenance-state rules, freshness, duplicate/replay policy, and authorization. Schemas do not implement these rules.
- No position, route, payload, or control command contract is included.
- `operational-event.schema.json` is limited to reviewable management/telemetry conditions such as stale data, stream gaps, maintenance watch items, access conflicts, and Tracegate review. It is not a command, mission, targeting, or aircraft-control contract.

Ratify these interfaces in M0 before implementing integrations.

## Read-only MAVLink extension (1.1)

The telemetry schema accepts the unchanged numeric v1.0 synthetic shape and a v1.1 shape with required `autopilot` and `session_id` fields. Only v1.1 permits null health measurements; unknown or expired data must never be represented by invented zeroes or full battery/link values. Consumers must branch on `schema_version` and support nulls before displaying this extension. The existing synthetic UI has not been bound to it.

Optional position (estimated WGS84 latitude/longitude, MSL and relative altitude; NED velocity), attitude (radians), and GPS sections have independent observation ages and disappear when stale. Coordinates are estimates, not a navigation-validity assertion. Link quality stays unknown because device-specific RSSI is not a calibrated percentage. Timestamps represent gateway observation time, not synchronized aircraft sample time.

Event identity includes publisher ID, source category, aircraft ID, session ID (or `legacy` for v1.0), sequence and timestamp. Mapper sessions change after reconnect, heartbeat timeout/recovery or observed boot-clock regression. Latest selection uses timestamp, sequence, then ASCII event-key order consistently across stores; this deterministic tie-break is not a multi-publisher authority or failover policy. See the [integration guide](../../docs/aircraft-integration.md).
