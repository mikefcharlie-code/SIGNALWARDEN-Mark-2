# UCAS documentation hub

This directory is the maintained navigation point for the UCAS Drone & Management System. The repository is a simulation-first engineering workspace, not a flight-ready product or certified aircraft-control system.

## Choose a path

### New contributor

1. Read the [project brief](project-brief.md) and [working agreements](../CONTRIBUTING.md).
2. Review the [architecture](architecture.md), [requirements baseline](requirements.md), and [roadmap](roadmap.md).
3. Follow the [developer guide](developer-guide.md).
4. Use the [contracts guide](../packages/contracts/README.md) before changing payloads.

### Management UI or training user

1. Read the [platform guide](platform-guide.md).
2. Open the [simulation training console guide](simulation-training-console.md).
3. Review [RBAC and permission management](rbac-permission-management-ui.md).
4. Use the [operations runbook](operations-runbook.md) for local demonstrations and reset procedures.

### API or integration developer

1. Read the [API overview](api-overview.md).
2. Read the [management API reference](../services/management-api/README.md).
3. Review the [telemetry contracts](../packages/contracts/v1/telemetry.schema.json) and [camera manifest](../packages/contracts/v1/camera-manifest.schema.json).
4. Read [security planning](safety-security.md) and [SECURITY.md](../SECURITY.md) before enabling streams or durable storage.

### Reviewer or release owner

1. Use the [validation and testing guide](validation-and-testing.md).
2. Complete the [release checklist](release-checklist.md).
3. Review [architecture decisions](decisions/README.md) and the [open-source pattern review](open-source-patterns.md).
4. Treat patent and roadmap materials as source concepts only; see [roadmap-derived capabilities](roadmap-derived-capabilities.md) and [source provenance](../source-materials/next-patent-roadmap-package-2026-10-19/README.md).

## Core documents

| Area | Document |
|---|---|
| Scope | [Project brief](project-brief.md) |
| Architecture | [System architecture](architecture.md) |
| Requirements | [Requirements](requirements.md) |
| API | [API overview](api-overview.md) |
| Training | [Simulation and Training C2](simulation-training-console.md) |
| Tracegate | [Tracegate guide](tracegate-guide.md) |
| Security | [Safety and security](safety-security.md) |
| Validation | [Validation and testing](validation-and-testing.md) |
| Operations | [Operations runbook](operations-runbook.md) |
| Release | [Release checklist](release-checklist.md) |
| Reuse | [Open-source patterns](open-source-patterns.md) |
| Terms | [Glossary](glossary.md) |

## Status vocabulary

- **Reference:** runnable locally, synthetic or disconnected, not production-approved.
- **Candidate:** proposed contract or capability requiring design review.
- **Implemented locally:** code and tests exist, but deployment, security, and operational approval are not implied.
- **Production-ready:** not currently claimed anywhere in this repository.

## Documentation rules

Keep claims traceable to code, contracts, tests, or source material. Mark assumptions and unresolved decisions. Never add real aircraft identifiers, live coordinates, private operational logs, secrets, or credentials to examples.
