# Warden model integration status

The attached designs are proposals, not validated models. This branch adds a safe local integration seam and deterministic foundations; it does not claim trained-model inference, flight readiness, or operational validation.

## Implemented in this slice

- **Warden-TH**: deterministic telemetry feature preparation over up to 1,200 retained samples, explicit missingness masks, source-sample summaries, robust-deviation features, and the specified 60% feature-presence abstention gate. Inputs are not silently imputed or resampled.
- **Warden-NAV**: deterministic window-relative ENU and navigation residual features, a 60% position/GPS/attitude presence gate, no-coordinate result objects, and no spoofing/integrity classification. Unknown airframe class keeps a learned head unavailable.
- **Warden-TRUST**: evidence reliability annotations appear in the evidence workspace and generated reports. Synthetic or untrusted evidence is labeled low by hard rule; other records are unscored. No evidence is filtered or removed.
- **All eight designs**: `GET /api/v1/warden/models` exposes the readiness registry. The operational-event schema accepts v1.0 and v1.1; future Warden event types must carry explicit advisory/no-command/no-mission-upload/no-flight-authorization flags. SKY events also require `not_daa: true`.
- **Bounded assessment reads**: the aircraft assessment queries at most 1,201 newest history rows before the 120-second filter, leaving one row to detect the 1,200-sample cap. If all 1,201 are in-window, `source_sample_count_is_lower_bound` is true; PostgreSQL does not fetch the full telemetry history for this endpoint.

## Not implemented

Warden-ENVELOPE, Warden-CHANGE, Warden-GEO, Warden-SKY, and Warden-TRACK remain design-only. None of the eight has installed trained weights. No accuracy, calibration, range, persistence, or safety claims have been validated against field or benchmark data. The status registry's next gates are prerequisites, not commitments.

The existing `configs/local-ai-models.json` installer remains unchanged. Warden weights are not added to its allowlist, no weights are bundled, and no automatic model download occurs in the application or CI. Any later model installation must be an explicit user-selected local action with verified license, revision, size, and digest. External inference is not used by this slice; no silent fallback exists.

## Safety boundary

All Warden outputs are advisory, read-only, and non-authoritative. They do not issue commands, create missions, authorize flight, control an aircraft, or make targeting/engagement recommendations. Warden-NAV residuals are measurements, not a spoofing verdict; untrusted telemetry is not treated as evidence of spoofing. Reliability labels are not physical-world truth. A null numeric score means no score was produced, not zero risk.

## Verification status

Unit and contract tests exercise deterministic behavior, compatibility, abstention, coordinate minimization, non-filtering evidence labels, and safety flags. These tests are not model evaluation, calibration, environmental validation, or safety certification.
