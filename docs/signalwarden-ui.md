# SignalWarden AI reference UI

**SignalWarden AI** is the provisional platform display name: signal/sensor awareness plus protective watch. It is used in the app shell, browser title, home/demo splash, and local preview logo. This is not trademark clearance. Repository, package, API, environment-variable, protocol, fixture, and aircraft identifiers are unchanged.

## Find the new capabilities

The home splash links to **Observations** and **Local AI & media**. Both are visible to every existing demo persona. The camera wall also links to the standalone media setup workflows; it does not feed camera data into them.

`/observations` has direct section links to inventory, source diagnostics, evidence/citations, advisory status, and capability boundaries. Its connectivity cards distinguish:

- Browser connectivity from actual workspace API reachability.
- Successful API receipt from verification of the underlying source.
- Retained API receipt age from original source age. Neither changes the original source timestamp.
- Evidence conflicts from browser-outage return comparisons. A recovered API is not a recovered live source.

Exact evidence links open a keyboard-focused provenance detail panel. Findings and citations remain tied to their snapshot. Refresh/error/offline states withhold current verification and model highlights; retained evidence stays visible with warnings. Recovery uses the existing memory-only digest, preserving source ages and unresolved uncertainty. Reloading clears retained state. No browser persistence, mesh, redundant transport, or source failover is implied.

The advisory status panel shows the server-reported mode, provider, engine, model status, receipt time, and egress disclosure. A failed/unconfigured local model remains explicitly rules-based. It never silently falls back to external AI.

## Optional local models

`/ai` provides a selector for the five pinned model groups in `configs/local-ai-models.json`: language model, image generation, video generation, image classification, and video classification. Resource budgets and license caveats are shown before installation, with explicit command handoffs for planning/status, dependency setup, separately consented weight download, integrity verification, and bounded smoke runs.

**These are shell handoffs, not browser-executed jobs.** There are no model installation, model filesystem/status, GPU inspection, media upload, or media inference API endpoints in this build. The browser therefore reports optional model readiness as **Not checked**, not installed or available. Command selection does not change the server's model. Check the registry/CLI on the deployment host before running commands. Setup may install dependencies; the separate download command fetches weights only when deliberately executed. Nothing downloads automatically from opening this UI, building it, or running its tests.

Only the local LLM has a workspace-advisory integration path, using the existing separately launched literal-loopback OpenAI-compatible server and server-side environment configuration. Image/video outputs use the existing standalone CLI smoke runners with fixed benign synthetic fixtures/prompts. Output paths and synthetic/advisory labels are explicit. They do not analyze the camera wall, real observations, vehicle state, or effector metadata. Smoke scores are not calibrated physical-world confidence.

The external-AI acknowledgement is a disclosure/configuration aid, **not an applied server setting or an authorization to send from the browser**. External mode additionally requires explicit server provider/model/consent/credential configuration. Credentials never belong in browser fields. The advisory status panel, not the acknowledgement checkbox, is the source of actual runtime disclosure. The existing external adapter exports only bounded aggregate data-quality counts; identifiers, coordinates, source text, exact citations, inventory, readiness, and health values remain local. External requests were not exercised for this UI change.

## Boundaries

This is a synthetic/offline local reference, not a real Lattice integration or authorized sandbox. The observation API remains GET-only. No firing, arming, targeting, tasking, engagement, vehicle control, or command routing was added. Weapon/effector categories remain descriptive catalog metadata. Existing browser-local simulation exercises stay separate from observations and AI; no AI outputs are routed to them.

The display uses system font fallbacks and a local SVG mark rather than fetching external fonts or a placeholder logo. The existing local reference/demo persona switch is not production authentication or an authorization guarantee.

## Validation

Frontend unit tests cover snapshot age and verification states, brand/package identity, existing network retries, cancellation, validation, coherent evidence, and recovery behavior. Model command handoffs have focused tests. TypeScript and production build checks are required. Backend regression tests use mocks/synthetic fixtures, not actual downloaded weights or GPU inference.

Manual browser checks include home/navigation, exact citation details and keyboard focus, unavailable-model deterministic disclosure, real local API stop/refresh/retention/restart/recovery, and optional-model selection/egress acknowledgement. No deployment or merge is part of this change.
