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
