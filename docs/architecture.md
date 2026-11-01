# System architecture — management UI and telemetry service

**Status:** proposed design for M1/M2 review. This document defines boundaries and data flow; it does not select a production framework, database vendor, autopilot, radio, or deployment provider.

**Implementation update:** the optional [PX4/ArduPilot gateway](aircraft-integration.md) now implements receive-only MAVLink ingestion with scoped local publishers and telemetry v1.1. The frontend remains synthetic, and the proposed production security/deployment design below is not certified or complete.

## 1. Design goals and non-goals

### Goals

- Give operators a trustworthy view of aircraft inventory and health.
- Accept telemetry from simulation first and a reviewed read-only aircraft adapter later.
- Preserve both the original sample time and the service receipt time.
- Make stale, delayed, missing, invalid, duplicate, and simulated data visible.
- Keep historical telemetry separate from the low-latency “latest state” view.
- Provide a stable API boundary for the management UI.
- Keep maintenance and inventory records auditable and independent from telemetry ingestion.
- Make the M1 system runnable with synthetic data and testable without aircraft hardware.

### Non-goals

- No flight-control commands, mission upload, autonomy, stabilization, failsafe implementation, or safety-critical decision-making.
- No direct browser-to-aircraft connection.
- No assumption that a management UI is an operator-of-record system until roles, authorization, and jurisdictional requirements are reviewed.
- No production-scale performance or availability claims before M0 requirements are quantified.

## 2. Logical architecture

```text
                         +-----------------------------+
                         |        Management UI        |
                         | fleet / detail / history    |
                         | maintenance / data status   |
                         +--------------+--------------+
                                        | HTTPS/JSON (read)
                                        | HTTPS/JSON (managed writes)
                                        v
                         +-----------------------------+
                         |       Management API        |
                         | authz boundary / query API  |
                         | freshness projection        |
                         | maintenance + audit writes |
                         +------+----------------------+
                                |
              latest-state read |                         | historical query
                                v                         v
                  +-------------+----+          +--------+---------+
                  | Latest State Store |          | Telemetry History |
                  | one current row   |          | append/query data |
                  +-------------+------+          +--------+---------+
                                ^                          ^
                                | accepted normalized     | accepted normalized
                                +------------+-------------+
                                             |
                                  +----------+-----------+
                                  | Telemetry Ingestion |
                                  | validate / dedupe   |
                                  | order / normalize   |
                                  | classify / publish  |
                                  +----------+-----------+
                                             ^
                        +--------------------+--------------------+
                        |                                         |
             +----------+-----------+                 +-----------+----------+
             | Synthetic Simulator  |                 | Read-only Adapter    |
             | M1 deterministic data |                 | M2 reviewed lab path |
             +----------------------+                 +----------------------+

  Maintenance records and aircraft inventory are managed through the API.
  No arrow from the API/UI back to the aircraft is part of this design.
```

The diagram describes logical responsibilities, not a deployment topology. The latest-state store and history store may initially be implemented with one database, but their access patterns and retention policies remain separate.

A rendered version is available at [`docs/diagrams/management-telemetry-flow.png`](diagrams/management-telemetry-flow.png); the editable source is [`docs/diagrams/management-telemetry-flow.mmd`](diagrams/management-telemetry-flow.mmd).

The proposed operator/viewer RBAC model and permission-management UI are documented in [`docs/rbac-permission-management-ui.md`](rbac-permission-management-ui.md). Its server-side authorization boundary applies to HTTP reads/writes, WebSocket subscriptions, exports, and any future broker transport. The UI is an explanation and workflow surface, not the authorization authority.

The synthetic multi-camera observation surface and future authenticated gateway boundary are documented in [`docs/video-observation.md`](video-observation.md). The current Camera Wall is read-only and hardware-free; a production gateway must mediate every camera manifest/session request and must never expose a direct browser-to-aircraft path.

The disconnected training surface is documented in [`docs/simulation-training-console.md`](simulation-training-console.md). Its mock command deck mutates only a digital twin and is not a command path to aircraft, radios, autopilots, payloads, gimbals, or vehicle networks.

Tracegate is integrated as a standalone deterministic evidence-readiness demonstrator under [`services/tracegate/`](../services/tracegate/). Training C2 may display its impact closure, selected tests, and evidence status, but Tracegate is informational only: it is not a flight gate, safety certificate, release authorization, or aircraft command authority.

Training C2 also exposes a local simulated-autonomy manager with supervised, bounded-route, degraded-link-recovery, and sensor-confidence-hold rehearsal modes. Its route map is invented geometry without GPS, and its lifecycle state cannot leave the digital twin. It is not an autonomy controller or mission network.

## 3. Component responsibilities

| Component | Responsibilities | Explicit boundary |
|---|---|---|
| **Management UI** | Fetch inventory, latest state, bounded history, and maintenance records; present freshness/source/error state; submit reviewed management-record changes | Never talks to an aircraft or infers connectivity from a cached value |
| **Management API** | Authenticate/authorize requests when enabled; expose versioned query/mutation endpoints; calculate freshness projections; enforce domain rules; write audit events | Not a flight controller, telemetry transport, or safety-failsafe authority |
| **Telemetry ingestion service** | Receive simulator/adapter payloads; attach trusted receipt metadata; validate, normalize, deduplicate, order-check, classify, and persist accepted samples | Does not issue commands or silently repair unsafe/ambiguous values |
| **Latest-state projection** | Maintain one query-optimized current view per aircraft/source/session; expose last accepted sample and freshness classification | Not the source of truth for history; must be rebuildable from accepted history |
| **Telemetry history** | Append accepted samples and ingestion outcomes with bounded query access and retention policy | Not directly writable by the browser |
| **Aircraft inventory** | Stable aircraft identity, lifecycle, display name, hardware revision, source registrations | Does not prove that an aircraft is currently reachable |
| **Maintenance/audit records** | Human-entered maintenance records, state transitions, actor/time/change history | Not derived from telemetry and not a flight authorization |
| **Simulator** | Deterministic synthetic telemetry for local development/CI/demo | Must label every sample `source=simulated`; no network/hardware access |
| **Read-only aircraft adapter** | Later translation from the selected platform’s reviewed interface into the common contract | Added only after platform and lab validation review; no command API |

## 4. Data flow

### 4.1 Ingestion flow: simulator or lab adapter to storage

1. **Produce** — simulator or reviewed adapter emits a versioned telemetry envelope.
2. **Authenticate source** — in M2, verify the adapter/device identity at the transport boundary. M1 simulator uses an explicitly configured synthetic source; it is not treated as an aircraft identity.
3. **Stamp receipt** — ingestion sets `received_at` using the service clock. It never trusts a producer-supplied receipt time.
4. **Parse and schema-validate** — reject malformed JSON, unsupported schema versions, unknown fields, invalid units/ranges, and non-UTC timestamps.
5. **Resolve identity** — verify `aircraft_id` exists and that the source is allowed to publish for it. For simulation, use a separate synthetic aircraft or environment namespace.
6. **Deduplicate** — calculate an event identity from source/session, aircraft ID, sequence, and sample timestamp according to the ratified contract. Replays are idempotent and do not advance latest state twice.
7. **Order-check** — classify samples as accepted, late, out-of-order, or rejected according to the selected producer-session policy. Do not silently reorder history.
8. **Normalize** — preserve the original contract fields and add service-owned metadata such as `ingestion_status`, `received_at`, `source_identity`, and a server event ID.
9. **Persist accepted history** — append the normalized sample and outcome metadata to telemetry history.
10. **Update projection** — update latest state only if the sample wins the current ordering rule; late samples remain queryable but cannot overwrite a newer current view.
11. **Publish/read** — the API reads the latest projection and bounded history. The reference service can also publish a normalized event to its opt-in WebSocket hub after ingestion; a slow client receives an explicit gap/recovery signal and must resync over HTTP.
12. **Observe** — count accepted/rejected/duplicate/late samples, ingestion delay, projection lag, and source freshness without logging secrets or sensitive payloads by default.

### 4.2 UI read flow

1. UI loads the aircraft list from `GET /api/v1/aircraft`.
2. UI requests each selected aircraft’s latest state from `GET /api/v1/aircraft/{id}/telemetry/latest`.
3. API returns the latest accepted sample plus server-derived `freshness`, `age_seconds`, `sampled_at`, `received_at`, and `source`.
4. UI renders explicit states: **fresh**, **stale**, **missing**, **invalid/rejected recently**, and **simulated**. It does not show “online” merely because an API request succeeded.
5. UI requests bounded history only for the selected aircraft/time window; the API enforces limits and pagination.
6. UI requests maintenance records separately. A maintenance update is a managed write, produces an audit event, and does not alter telemetry state.
7. On API/network failure, UI preserves the last fetched view with a visible “view unavailable / last fetched at” indicator; it must not relabel cached data as current.

### 4.3 Maintenance write flow

1. Authorized user submits a maintenance record through the API.
2. API validates aircraft existence, field lengths, status transition, actor authorization, and timestamps.
3. API writes the maintenance record and audit event transactionally where the chosen storage supports it.
4. API returns the canonical record and revision/version.
5. UI refreshes the record list; telemetry projection is unaffected.

## 5. Data ownership and storage model

The logical model below is technology-neutral. Primary keys, indexes, partitioning, and retention periods require the stack ADR.

| Record/view | Write owner | Read clients | Retention / rebuild |
|---|---|---|---|
| `aircraft` | Management API/admin workflow | UI/API | Durable; changes audited |
| `telemetry_history` | Ingestion service only | API, analytics/export later | Retention to be decided; append-only accepted samples |
| `telemetry_ingestion_outcome` | Ingestion service | API/operations/admin | Retain enough to explain rejected/late/duplicate data |
| `telemetry_latest` | Projection worker/service | API/UI | Rebuildable from history; one current row per aircraft/source/session policy |
| `maintenance_record` | Management API | UI/API | Durable; revisions/audit required |
| `audit_event` | API and controlled service actions | Authorized operations/admin | Durable and append-oriented; sensitive values minimized |
| `source_registration` | Admin/configuration workflow | Ingestion service/API | Durable; maps source identity to aircraft/environment |

Recommended first implementation is one durable store with separate tables/collections and clear ownership, not separate infrastructure products. Split storage only when measured access, retention, or isolation needs justify it.

## 6. Freshness and state semantics

Freshness thresholds are configuration, not yet product requirements. The API should return a classification computed on the server so every UI client uses the same clock and policy.

```json
{
  "aircraft_id": "sim-ucas-001",
  "sample": { "...": "normalized telemetry v1" },
  "sampled_at": "2026-01-01T00:00:04Z",
  "received_at": "2026-01-01T00:00:04Z",
  "source": "simulated",
  "freshness": "fresh",
  "age_seconds": 2,
  "last_accepted_sequence": 4,
  "last_ingestion_status": "accepted"
}
```

Proposed classifications:

- **fresh:** newest accepted sample age is within the configured fresh window.
- **stale:** a previously accepted sample exists but exceeds the fresh window.
- **missing:** no accepted sample exists for the selected aircraft/source or the retention/query window has no sample.
- **rejected_recently:** recent ingestion attempts exist but were rejected; this is an ingestion-health signal and must not be conflated with aircraft reachability.
- **simulated:** source metadata is shown alongside freshness; simulation is never presented as a real aircraft.

Clock uncertainty, future-dated samples, delayed networks, producer restart, and source failover must be covered in M1 tests. The UI should display timestamps in the user’s locale only after retaining the UTC value in the API response.

## 7. API boundary — v1 local reference implementation

The repository now includes a dependency-light local reference implementation in `services/management-api/app.py`. It uses the v1 contracts, an in-memory store, and synthetic/read-only scope. It is not a production stack decision: durable storage, authentication/authorization, TLS, source identity, rate limits, retention, and deployment remain ADR-0002 work. The browser never receives direct storage credentials.

| Method | Route | Purpose | Key response/behavior |
|---|---|---|---|
| `GET` | `/health` | Process health/readiness | No sensitive config; distinguish process ready from telemetry fresh |
| `GET` | `/api/v1/aircraft` | Inventory list | Bounded cursor pagination; implemented locally |
| `POST` | `/api/v1/aircraft` | Add inventory record | Contract validation; local reference only |
| `GET` | `/api/v1/aircraft/{id}` | Aircraft detail | Identity and lifecycle, not reachability claim |
| `POST` | `/api/v1/telemetry/ingest` | Ingest telemetry | Contract validation, receipt stamping, dedupe/order classification; separate producer boundary in production |
| `GET` | `/api/v1/aircraft/{id}/telemetry/latest` | Current health view | Server freshness projection and source metadata |
| `GET` | `/api/v1/aircraft/{id}/telemetry?from=&to=&cursor=&limit=` | History | Bounded UTC range, cursor pagination, maximum limit |
| `GET` | `/api/v1/aircraft/{id}/telemetry/ingestion-status` | Data-quality status | Recent accepted/rejected/late/duplicate counts and last receipt |
| `GET` | `/api/v1/aircraft/{id}/evidence` | Evidence view | Minimal synthetic ingestion evidence; future event contract pending |
| `GET` | `/api/v1/aircraft/{id}/maintenance` | Maintenance list | Cursor pagination and status filter |
| `POST` | `/api/v1/aircraft/{id}/maintenance` | Create maintenance record | Local validation; auth/audit hardening pending |
| `PATCH` | `/api/v1/maintenance/{record_id}` | Update maintenance record | Validated update; auth/audit hardening pending |

The reference push delivery is an opt-in WebSocket stream on a separate port, implemented by `services/telemetry_stream/`. Enabled deployments require a signed JWT with `telemetry:read`, validate issuer/audience/time claims, enforce optional aircraft/source claims, and use TLS 1.2+ by default. An explicit insecure override exists only for local development. It is an in-process, single-instance fanout with bounded subscriber queues and no replay offsets. Clients must treat `stream_gap` as a mandatory resynchronization instruction: refetch latest state and bounded history before displaying the stream as continuous. For multiple API instances or real adapter traffic, replace the hub with an authenticated broker/MQTT topic layer after defining replay, retention, authorization, TLS, source identity, and cross-instance ordering. A WebSocket connection never proves aircraft reachability. The local reference exposes an ingestion route for simulator tests; in a deployed design it must be a separate authenticated producer boundary, never a browser route. The local service intentionally has no aircraft command endpoint.

## 8. Failure and recovery behavior

| Failure | Ingestion behavior | API/UI behavior |
|---|---|---|
| Malformed/unsupported sample | Reject with reason; increment metric; do not write latest/history accepted record | Show recent ingestion issue separately from aircraft state |
| Duplicate sample/replay | Record idempotent duplicate outcome; do not advance projection | Latest remains unchanged; history does not duplicate accepted event |
| Late/out-of-order sample | Preserve outcome; append only if policy allows; never overwrite a newer latest projection | History can indicate late status; latest remains based on ordering rule |
| Unknown aircraft/source | Reject/quarantine; alert/configure source mapping | Aircraft remains inventory-only; no fabricated telemetry |
| History store unavailable | Do not acknowledge accepted persistence; use bounded retry/queue only if designed | UI shows last known state plus API/data freshness error |
| Latest projection unavailable | Keep accepted history; mark projection lag; rebuild projection | API may return degraded state, never claim fresh from process health |
| API unavailable | No writes; browser retains cached data with last-fetched timestamp | Visible unavailable state; no false online indicator |
| Source disconnected | No new samples; freshness ages into stale/missing | UI shows stale/missing based on policy, not an inferred flight action |
| Clock skew/future sample | Reject or quarantine based on configured bound | Expose data-quality issue; do not silently clamp time |

Retry and queue semantics must be designed carefully: at-least-once delivery is acceptable only with deterministic idempotency. The first M1 implementation may use synchronous ingestion and fail closed rather than introduce an unreviewed queue.

## 9. Security and safety boundaries

- Transport authentication belongs between producers and ingestion, and between UI/API clients and the API before shared deployment.
- Authorization is enforced by the API, not the UI. The UI may hide controls, but hidden controls are not a security boundary.
- Store source credentials and signing keys outside Git and outside browser storage where possible.
- Minimize telemetry logs; never log credentials or sensitive location/payload data by default.
- Separate simulation and real-data namespaces and credentials.
- Management API health does not mean aircraft health; telemetry freshness does not mean safe-to-operate.
- The API has no command routes in M1/M2. Any future control integration must be a separate reviewed architecture with explicit authorization, safety ownership, and validation.

## 10. Implementation sequence

1. **M0:** ratify envelope fields, source/session identity, freshness thresholds, rejection/idempotency/order policy, auth assumptions, retention, and quantified limits.
2. **M1.1:** implement contract validation and simulator adapter at an in-process or local boundary.
3. **M1.2:** implement history plus latest projection, synchronous ingestion, and API read routes.
4. **M1.3:** implement UI inventory/detail/history/maintenance views with explicit status rendering.
5. **M1.4:** add integration tests for duplicate, late, missing, stale, API failure, and simulated source flows; record a demo.
6. **M2:** select and review aircraft adapter; add authenticated read-only lab ingestion behind the same boundary; validate disconnect and data-quality behavior.

## 11. Open decisions for ADR-0002 / ADR-0003

- Management stack and local development workflow.
- Durable store and migration strategy.
- Polling interval and freshness windows by source.
- AuthN/AuthZ model, roles, source registration, and audit policy.
- Synchronous versus queued ingestion after measured needs.
- History retention, export, backup, and restore objectives.
- API pagination, error envelope, idempotency-key format, and rate limits.
- Aircraft adapter protocol, identity, and lab test procedure.

## 12. Acceptance criteria for this design

- A reviewer can trace a telemetry sample from simulator/adapter through validation, history, latest projection, API, and UI state.
- The design distinguishes sample time, receipt time, API process health, source freshness, simulated source, and aircraft reachability.
- Duplicate, late, invalid, missing, and disconnected cases have explicit behavior.
- Maintenance writes and audit events are separated from telemetry ingestion.
- No management-to-aircraft command path is introduced.
- The design identifies decisions that remain open instead of inventing platform or performance requirements.

## 13. Patent-package-derived integration boundary

The extracted patent package describes an onboard autonomy stack with confidence/provenance-aware state estimation, an environment model with uncertainty, health-aware planning constraints, deterministic safety-envelope gating, authenticated mission contracts, degraded-link reconciliation, model lifecycle controls, and evidence logging. These concepts are summarized and traced in [`docs/patent-derived-specifications.md`](patent-derived-specifications.md).

For this repository, the management system receives only a **read-only, authenticated telemetry/evidence feed** from the selected aircraft integration. Candidate management views may show confidence, provenance, health prediction, communications state, model identity, safety-gate decisions, and mission-state conflicts. The aircraft retains local flight-control and protected-safety authority. The management API does not expose a command path in M1/M2.

Candidate future interfaces are deliberately separate from the baseline health telemetry contract:

- state-estimation confidence, uncertainty summaries, estimator identity, and measurement provenance;
- predicted degradation, health-state classification, and planning-impact summary;
- communications link quality, latency, loss, authentication state, and degraded-policy state;
- append-oriented evidence events referencing model identity, state snapshot, safety decision, provenance, and integrity record;
- read-only mission-contract and reconciliation status, including unresolved conflicts marked non-executable;
- model package identity, compatibility, validation/authorization status, and rollback reference.

These are **candidate extensions, not ratified requirements**. Their units, thresholds, retention, signing/replay model, and failure semantics must be defined before real-aircraft integration. Do not infer aircraft performance, safety, or patent protection from the source package.
