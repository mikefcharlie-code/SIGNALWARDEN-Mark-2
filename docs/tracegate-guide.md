# Tracegate guide

Tracegate is a deterministic change-to-proof-obligation demonstrator. It maps a declared configuration change through typed dependency edges, selects mapped tests conservatively, evaluates evidence applicability, and returns a bounded readiness status.

## Run the demo

```bash
.venv/bin/python services/tracegate/tracegate_engine.py --demo
.venv/bin/python -m unittest tests/test_tracegate_engine.py -v
```

The service README contains the short interface description. The roadmap-derived capability document contains the source mapping and staged G0–G5 plan.

## Supported concepts

- Versioned configuration snapshots
- Requirements, assumptions, hazards, tests, and evidence records
- Impact closure with an explanatory path
- Criticality-aware mapped test selection
- Missing, stale, contradictory, out-of-domain, failed, or not-run evidence
- Readiness results: `READY`, `READY_WITH_RESTRICTIONS`, `BLOCKED_UNKNOWN`, and `REVIEW_REQUIRED`
- Event identity, policy version, configuration fingerprint, and audit-oriented output

## Reference scenarios

The UI provides sensor/calibration change, model upgrade, payload swap, expired evidence, and configuration conflict scenarios. These are benign digital-twin scenarios; they do not represent live aircraft configuration.

## Interpretation rules

A passing test set is not absolute safety. A `READY` result is bounded by the exact configuration, requirements, evidence, assumptions, domain, and policy evaluated. Missing or contradictory evidence must not produce an unqualified result. Human review remains required where the prototype reports it.

Tracegate is not a safety controller, certification authority, release authorization service, aircraft command interface, mission planner, tactical coordinator, or weapons function. Do not connect it to a flight controller or operational mission network without a separately reviewed architecture, threat model, safety case, and authorization decision.
