# Tracegate

Tracegate is a deterministic change-to-proof-obligation demonstrator. It walks an explicitly marked dependency graph, selects mapped tests conservatively, and classifies evidence by integrity, provenance, result, freshness, configuration fingerprint, and domain.

It is **not** a safety controller, certification tool, production release gate, legal proof of patentability, flight authorization system, or aircraft command interface. The training console uses Tracegate only as a review-only readiness signal for the disconnected digital twin; it cannot start, stop, steer, arm, or communicate with any aircraft or simulator transport.

## Run

```bash
python3 services/tracegate/tracegate_engine.py --demo
```

The engine is intentionally small and auditable. Keep production integrations behind a separately reviewed adapter that signs/verifies evidence and preserves the fail-closed statuses (`BLOCKED_UNKNOWN`, `REVIEW_REQUIRED`, and `CONDITIONAL`).
