# Roadmap-derived platform capabilities

**Source:** user-provided `NEXT_PATENT_ROADMAP_PACKAGE.zip`, prepared 19 October 2026.

**Status:** candidate capabilities and prototype scope; not engineering validation, patent advice, certification, or production authorization.

## Capability update

The roadmap package identifies a cross-project gap: a typed configuration change should be connected to the exact requirements, assumptions, tests, and evidence that must be refreshed before a bounded readiness result is issued. The UCAS platform now represents this as a Tracegate capability inside the disconnected Training C2 console.

The implementation keeps the package's safe boundary. Tracegate is a pre-deployment, maintenance-change, and software/model-release review feature. It does not plan routes, allocate missions, select targets, command a vehicle, replace an onboard safety supervisor, or authorize flight.

## Implemented reference capabilities

1. **Configuration-linked change scenarios.** The training surface represents benign changes such as sensor/calibration updates, model upgrades, payload swaps, expired evidence, and configuration conflicts.
2. **Typed dependency and impact closure.** The standalone engine traverses explicitly propagating graph edges from changed components to affected requirements.
3. **Conservative test selection.** Mapped tests are selected with criticality and mandatory-test rationale; missing mappings, failed tests, and not-run tests remain visible.
4. **Evidence applicability.** Evidence is evaluated for result, integrity, provenance, validity window, target configuration fingerprint, and domain.
5. **Bounded readiness states.** The prototype emits `READY`, `READY_WITH_RESTRICTIONS`, `BLOCKED_UNKNOWN`, or `REVIEW_REQUIRED` with reason codes. The UI defaults to human review and never treats the result as flight or release authorization.
6. **Audit and reproducibility.** The engine returns event identity, configuration fingerprint, evaluation time, policy version, impact paths, test rationale, evidence records, and outstanding problems.

## Staged roadmap alignment

- **G0/G1 — identity and problem specification:** keep source provenance, platform identity, intended-use, contributor, and ownership questions unresolved until reviewed.
- **G2 — prototype:** implemented as the rules-based Tracegate engine, demo scenarios, tests, and Training C2 panel.
- **G3 — validation:** next safe increment is a benign scenario corpus with full-regression comparison, stale/conflicting evidence injection, reproducibility checks, revocation/reopen behavior, and reviewer usability measures.
- **G4/G5 — patent and filing decisions:** outside the software implementation. The source package requires claim-focused prior-art work and counsel review; this repository makes no novelty or patentability claim.

## Deferred capabilities

A future simulator service may provide versioned configuration snapshots, requirement/hazard/assumption graphs, reproducible test adapters, signed evidence packages, reviewer dispositions, change revocation, and exportable audit packages. Those services must remain simulator-only and must reject real aircraft identifiers and hardware transport configuration.

Cross-portfolio ideas such as autonomy planning, tactical coordination, swarm allocation, energy-aware flight recovery, target selection, or weapons functions are deliberately not added. The roadmap expressly positions Tracegate as a verification/evidence layer distinct from those operational systems.

## Source caveats carried forward

The package is concept-stage drafting material. It does not establish novelty, freedom to operate, filing, inventorship, performance, certification, regulatory permission, or ownership. The source also flags an AQUAVANTIS-G identity discrepancy—its supplied text describes a civilian UGV despite other contextual references—so the UCAS repository does not merge that concept into the aircraft platform.
