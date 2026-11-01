# Confidence-aware observation copilot

The Observation workspace now makes gaps in the operating picture visible instead of turning a fluent AI answer into apparent certainty. It is a **read-only data-quality digital twin**, not a physical-world simulation, navigation system, or decision authority. Every finding can be traced to specific evidence, source timestamps, and provenance. Human interpretation is required.

## Read the evidence before the explanation

Open `/observations` and find the evidence copilot. Its deterministic assessment identifies stale or future-dated observations, missing information, unknown or untrusted provenance, and disagreements between independent source reports. Sensor metadata is assessed alongside platform observations. The demonstration is static and synthetic; even a successful API read does not create a live source connection.

Follow a finding's citation to inspect its exact record, subject, source, field, value, original observation timestamp, trust label, freshness, and synthetic flag. A null value or timestamp is an explicit gap, not a measured zero. Missing-evidence markers describe absence in the snapshot, not an observation of the physical world. Informational weapon/effector inventory and location/tactical fields are excluded from the assessment.

Freshness is derived from strict RFC3339 source timestamps against the assessment clock, not accepted from a source's claimed freshness label. The current/stale threshold is 300 seconds. Future timestamps are not fresh evidence; static synthetic evidence is never current or trusted. Receipt time, snapshot generation time, and observation time have different meanings; reconnecting or refreshing never rewrites observation time. Missing/invalid assessment clocks produce an explicit limitation, unknown freshness, and a deterministic epoch sentinel, never an invented current time. Provenance trust is a declared input, not cryptographic verification or proof that a measurement is correct.

A disagreement is a **data-quality conflict**, not a threat or an instruction. Reports must refer to the same subject and field, come from distinct identified sources, and be within a 30-second comparison window. Only the latest version per entity/subject/source/field is assessed; same-source variants at the same time remain a provenance conflict. Historical changes within one source must not be mistaken for independent corroboration. Unknown sources cannot establish independent agreement or disagreement. Disagreements remain visible for review; the software does not choose which physical-world claim is true.

## Local-first, with an honest no-model path

The evidence assessment always runs deterministically. Without a configured local model, the interface identifies the rules engine and shows the evidence summary; it never claims that an LLM ran. A configured but unavailable or invalid local model is explicitly reported as unavailable, with the deterministic evidence still available.

Optional AI assistance is constrained to known data-quality statements. It cannot invent facts, citations, instructions, or free-form operational advice, and cannot suppress deterministic findings. Evidence details remain inspectable independently of model availability. An independently returned explanation is not applied to a different evidence snapshot.

Local mode has no external AI fallback. A configured model endpoint must use literal loopback; operators must also ensure their local runtime does not relay prompts elsewhere. External AI requires an explicit server-side mode, provider, model, credential, and data-export consent. The interface discloses egress. Only the documented redacted aggregate quality payload is eligible for export; detailed evidence stays local. See [local-first assistance settings and payload boundaries](observation-assistance-networking.md) and [optional local-model setup](local-ai-setup.md).

## What changed while the API was unavailable?

The browser keeps a local, memory-only outage baseline when it detects an offline event or a failed overview read. On a successful return, the digest compares accepted evidence with that baseline and describes additions, changes, missing records, recovery, and remaining stale or untrusted information. It distinguishes browser/API recovery from recovery of an observation source.

Recovery is not a new timestamp. Duplicate responses do not create repeated changes. Older source versions cannot overwrite newer accepted evidence; source high-water marks and removal history prevent old reports from resurrecting a missing record. A removed version must be strictly newer to return. Regressed complete receipts are rejected before inventory and citation publication, rather than mixing incompatible findings and evidence. A same-time value disagreement is not accepted as trustworthy recovery. Missing records are not silently merged back from a previous snapshot. Only qualifying newer, fresh, trusted, non-synthetic evidence can establish a recovered observation, and that still says nothing about physical-world certainty. Remaining not-fresh records include stale, future, undated, and synthetic observations; trust remains a separate dimension.

Retained data is historical reference and is marked unverified while the API is unavailable. The interface reevaluates age as time passes; a once-current observation cannot remain current indefinitely while offline. A page reload discards the baseline, high-water marks, and digest. This is **not** durable synchronization, an offline write queue, redundant radio transport, or a mesh implementation.

## API and extension boundary

`GET /api/v1/lattice/overview` includes an `assessment` with `generatedAt`, a content-derived `snapshotId`, a concise summary, findings, exact evidence, and limitations. Each finding has `evidenceIds` resolving to rows in the same assessment. Evidence carries `entityId`, `subjectId`, `sourceId`, `field`, `value`, `observedAt`, `trust`, `freshness`, and `synthetic`. Citation IDs are stable content identifiers, not authentication tokens or signatures. Snapshot identity changes when evidence or its assessed state changes, not merely when an identical snapshot is fetched again.

`GET /api/v1/lattice/assistance` retains engine/provider/status and egress disclosures and includes its own grounded assessment. Overview and assistance may finish independently. These are local UCAS contracts, not a Lattice SDK or live ingestion contract. The synthetic multi-source reports illustrate the projection seam without adding an external transport or changing aircraft inventory.

All observation routes remain GET-only. No prompt submission, targeting, arming, firing, weapon tasking, autonomous engagement, sensor control, or command routing is added. The reference API remains localhost-first and lacks production observation-read authorization and rate limiting: do not expose it publicly or load sensitive operational data.

## Verification and limits

Backend tests exercise exact citations, conflicts, stale/missing/untrusted observations, deterministic deduplication, provider opt-in boundaries, and graceful no-model behavior. Frontend tests cover validation, outage/return comparison, duplicate responses, removal history, and rejection of older source evidence. HTTP tests verify that real API responses carry matching evidence and that writes remain denied. Run the project Python suite, frontend tests, typecheck, and production build as described in the [workspace guide](observation-workspace.md).

These checks do not validate a real sensor, aircraft, Lattice integration, installed model quality, hosted provider acceptance, or field networking. Synthetic disagreements are demonstration data, not operational corroboration. No merge or deployment is implied by passing local checks.
