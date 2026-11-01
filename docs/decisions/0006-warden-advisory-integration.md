# 0006 — Local-first advisory Warden integration

- **Status:** Proposed; implemented in this branch for local review only. Owner approval remains open.
- **Date:** 2026-10-29

## Context

Eight attached Warden design PDFs describe proposed data models and model-backed functions. The repository does not contain Warden weights, benchmarks, or a validation record. Model outputs must not create command, mission-upload, flight-authorization, or targeting paths.

## Decision

Integrate incrementally. Begin with deterministic, read-only feature and residual foundations for telemetry health and navigation, plus fail-closed evidence reliability labels. Keep learned inference explicitly unavailable until pinned weights, calibration, representative evaluation, license review, and human review exist. Keep the other five designs design-only. Make model readiness visible through a local read-only status endpoint and a checked-in registry.

Preserve operational-event schema v1.0 compatibility while allowing v1.1. Any new Warden event type must explicitly state it is advisory-only, issued no command, uploaded no mission, and authorized no flight; SKY event types additionally state they are not a detect-and-avoid system.

## Alternatives considered

1. Claim the proposed schemas are complete, or create placeholder model scores — rejected because no weights, calibration, evaluation, or actual inference are supplied.
2. Add Warden IDs to the existing model installer — rejected because that installer requires pinned downloadable assets and must not trigger large downloads automatically.
3. Treat untrusted navigation signals as spoofing detections — rejected because transport integrity does not establish a navigation attack.
4. Integrate all eight designs at once — rejected because that would conflate unvalidated capabilities and safety boundaries.

## Consequences

The current user-facing result is a provenance label, not a numerical reliability estimate. TH/NAV functions expose deterministic measurements and abstentions, not learned predictions. The registry keeps design-only models visible. No automatic downloads or external AI calls are introduced. Human review and separate model-validation work remain required before learned inference can be enabled.

## Evidence

The implementation is covered by deterministic unit tests and contract compatibility tests. Those tests validate software behavior only and do not establish model performance or safety.
