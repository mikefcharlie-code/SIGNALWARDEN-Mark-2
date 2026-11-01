# UCAS platform guide

## What exists today

UCAS is a private, simulation-first monorepo for aircraft inventory, telemetry, maintenance records, observation, training, and evidence review. The runnable reference surfaces are:

- **Management UI:** React/TypeScript application at `apps/management-web`.
- **Management API:** dependency-light Python reference service at `services/management-api`.
- **Telemetry stream:** opt-in authenticated WebSocket reference path at `services/telemetry_stream`.
- **Tracegate:** deterministic change-to-proof-obligation prototype at `services/tracegate`.
- **Synthetic generator:** offline telemetry fixture producer at `simulation/generate_telemetry.py`.

The UI includes fleet overview, live monitor, six-channel synthetic Camera Wall, Maintenance, RBAC views, disconnected Training C2, simulated autonomy operations, and Tracegate readiness review.

## What does not exist

This repository does not implement a flight controller, aircraft command API, radio/MAVLink path, live camera transport, real coordinates, target selection, weapons functions, tactical coordination, or production autonomy authorization. The Training C2 controls mutate only a browser-local digital twin. The map is invented geometry labeled `SYNTHETIC RANGE / NO GPS`.

Never infer production readiness from a green test, a `READY` Tracegate result, or a simulated state. Those results apply only to the declared synthetic configuration and test scope.

## Local entry points

```bash
# from repository root
.venv/bin/python services/management-api/app.py

# in another terminal
cd apps/management-web
pnpm install --frozen-lockfile
pnpm dev
```

The UI's primary routes are `/`, `/monitor`, `/cameras`, `/training`, `/maintenance`, `/access`, `/roles`, and `/audit`. The browser demo uses synthetic personas and records; server-side authorization remains the intended authority boundary.

## Reading capability claims

Use [requirements](requirements.md) for candidate acceptance criteria, [architecture](architecture.md) for component boundaries, [simulation training](simulation-training-console.md) for the hard simulator boundary, [roadmap-derived capabilities](roadmap-derived-capabilities.md) for Tracegate scope, and [safety/security planning](safety-security.md) for unresolved production controls.
