# Architecture decisions

Use sequential files such as `0002-management-stack.md`. Record context, alternatives, choice, consequences, evidence, and status. A proposed ADR is not accepted until reviewed by the owner.

- [0001 — Private monorepo and simulation-first foundation](0001-project-foundation.md)
- [0002 — PostgreSQL persistence for the Management API](0002-postgresql-persistence.md)
- 0003 — Aircraft/autopilot and read-only adapter: pending platform review.
- [0004 — Local-first observation assistance and bounded API resilience](0004-local-first-observation-assistance.md) — proposed, implemented for local review only.
- [0005 — Separate civilian operator command gateway](0005-civilian-operator-commands.md) — proposed; operator-authorized bounded civilian runs, disabled by default, no weapon/effector or AI-generated command path.
- [0006 — Local-first advisory Warden integration](0006-warden-advisory-integration.md) — proposed; deterministic foundations only, no learned weights.
- [0007 — Warden-NAV navigation-integrity advisory](0007-navigation-integrity-model.md) — proposed, synthetic-only development slice; no operational validation.
