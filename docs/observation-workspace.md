# UCAS observation workspace

A single read-only workspace brings the local aircraft, sensor, and generic platform scaffold into the management UI. Open **Observation workspace** (`/observations`) to inspect synthetic observations, their data quality, advisory assistance, and the limits of the integration. This is an independent UCAS demonstration, not Lattice software or a compatible implementation.

## Feature sets

The inspiration is Anduril's public [Lattice Command & Control overview](https://www.anduril.com/lattice/command-and-control): a shared operating picture, decision support, extensible integrations, and resilient networking. UCAS implements only bounded observation and data-quality features. It does not reproduce the reference's tasking or engagement functions.

| Feature set | Local capability | Boundary |
|---|---|---|
| Shared observation picture | Snapshot of synthetic platforms, sensors, location availability, and freshness counts; searchable inventory and selected-entity details | Static observations, not real-time tracking or a fused operational picture |
| Operator attention | Deterministic explanations of stale, future, missing, and reported-offline data | Data-quality review only; no threat ranking, targeting, or operational recommendations |
| Advisory assistance | Rules default with zero provider calls; explicitly configured local model inference; separately opted-in external provider support | Source-grounded data-quality statements only, visible engine/status and disclosure, human review required |
| Resilient API reads | Timeouts, bounded retries/backoff, cancellation, reconnect recovery, last successful memory-only snapshot | Workspace-to-local-API transport only; not mesh, redundant platform links, or distributed synchronization |
| Cross-domain inventory | Generic air, ground, surface, undersea, sensor, and informational effector/weapon categories | Local taxonomy, not actual products or supported hardware; inventory membership is not sensor capability |
| Extensible observation seam | Allowlisted entity projection, explicit category assignment, separate read-only API namespace | No live Lattice adapter, SDK, authentication client, or compatibility claim |
| Source diagnostics | Source transport/device state, last available source time, and fixture provenance | Reported platform connection is historical fixture metadata; workspace API success does not imply a live source |
| Capability maturity | `local-demo`, `design-only`, and `excluded` labels supported by the UI | A local-demo label never implies field validation or production readiness |

## How to use it

Start the reference API with development dependencies installed:

```bash
UCAS_LATTICE_MODE=mock python services/management-api/app.py
```

In another terminal:

```bash
cd apps/management-web
pnpm install --frozen-lockfile
pnpm dev
```

Visit `http://localhost:3000/observations`. The Vite development server forwards only `/api/v1/lattice` to the local API on port 8000. A production/static build requires a separately configured same-origin API route; the development proxy is not bundled into the build. Do not expose this localhost-first reference API publicly or load sensitive data: it has no production observation-read authentication/authorization.

Search/filter the inventory and select a record or attention item to inspect details. Refresh retrieves a new local snapshot; it never changes fixture source timestamps to make them current. Snapshot generation, browser receipt, and source observation time are separate. Unknown data stays unknown, and altitude references remain distinct rather than converted or relabeled.

With `UCAS_LATTICE_MODE=offline`, the catalog and capability descriptions remain, but no observations exist. An initial API failure produces no fallback records. A later failure retains only the last successfully validated in-memory snapshot, labels it **NOT CURRENTLY VERIFIED**, and keeps the original timestamps. A page reload clears retained data. Per-endpoint failures stay explicit.

The assistance panel distinguishes rules from actual model inference and shows configuration status, data-export disclosure, evidence-linked statements, and human-review limitations. For local runtime setup, explicit external opt-in, payload boundaries, and retry behavior, see [Local-first assistance and resilient observation reads](observation-assistance-networking.md). Default rules make no provider calls; real local inference requires an explicitly configured installed runtime and model. External AI is never an automatic fallback.

## Confidence-aware evidence copilot

The [evidence copilot guide](evidence-copilot.md) explains the new read-only digital-twin view: exact record/field/timestamp citations, unknown or untrusted provenance, missing information, comparable cross-source disagreements, and a local outage/return digest. The view exposes incompleteness rather than a physical-world certainty score. Follow a citation to inspect supporting data; a model can assist with fixed data-quality explanations but cannot invent evidence or hide deterministic findings. Static synthetic source reports demonstrate disagreement without implying a live connection.

The browser retains only memory-local recovery history. Duplicate or older source reports cannot renew observation timestamps or silently restore removed records. API recovery and source recovery are separate; stale or untrusted evidence does not become reliable because a request succeeded. Human interpretation is always required.

## Read-only API additions

- `GET /api/v1/lattice/overview` returns a coherent local snapshot: mode, boundaries, generation time, counts, platforms, data-quality attention, and source diagnostics. All freshness values use one clock instant.
- `GET /api/v1/lattice/assistance` returns a separately timestamped advisory snapshot with engine/provider status and grounded data-quality statements. It cannot accept prompts or issue commands.
- `GET /api/v1/lattice/capabilities?limit=100` returns descriptions and maturity using the existing `items`, `count`, `next_cursor` envelope.
- Existing status, catalog, and platform list/detail endpoints remain. See the [scaffold guide](lattice-readonly-integration.md) for mapping, pagination, and mode rules.

These are UCAS contracts, not Lattice SDK responses. Attention remains deterministic and independent of AI. Weapon/effector inventory is excluded from model inputs and operational recommendations. No control or task payloads are exposed.

## Not implemented

Live Lattice access, true streaming/fusion, operational AI decisions, resilient mesh routing, redundant-platform transport failover, cross-site synchronization, authorized third-party observation transports, and production access controls remain unimplemented. Weapon control, arming, firing, targeting, mission tasking, autonomous engagement, and sensor/gimbal commands are excluded, not hidden behind credentials.

A future read-only provider integration requires approved developer access, documented read/watch contracts and scopes, licensing/security review, permitted representative fixtures, and sandbox validation. No enrollment, license acceptance, Lattice credential collection, or live connection is performed.

## Local verification

```bash
python -m pytest -q
cd apps/management-web
pnpm test
pnpm typecheck
pnpm build
```

Tests validate local behavior and mocked provider boundaries only. They do not demonstrate real model quality, hosted-provider acceptance, live compatibility, hardware networking, flight safety, weapon readiness, or production approval.
