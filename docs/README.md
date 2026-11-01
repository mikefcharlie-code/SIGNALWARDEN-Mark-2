# SignalWarden AI documentation hub

SignalWarden AI is a local-first reference workspace for observations, evidence-grounded analysis, cited reports, and offline spatial context. Optional aircraft ingestion, external reads, and model workflows require explicit setup. The aircraft adapter is receive-only for PX4/ArduPilot. A separate [civilian operator command gateway](civilian-operator-commands.md) is disabled by default and requires an independently provisioned bridge; bounded runs require explicit operator authorization, monitoring, and abort. This repository does not claim production readiness, field validation, or validated aircraft control.

## Choose a path

### New contributor

1. Read the [project brief](project-brief.md) and [working agreements](../CONTRIBUTING.md).
2. Review the [architecture](architecture.md), [requirements baseline](requirements.md), and [roadmap](roadmap.md).
3. Follow the [developer guide](developer-guide.md).
4. Use the [contracts guide](../packages/contracts/README.md) before changing payloads.

### Workspace or training user

1. Start with the [platform guide](platform-guide.md) and [Observation workspace](observation-workspace.md).
2. Review [World View](worldview-workspace.md), the [scene analyst](worldview-ai-analyst.md), and [provider coverage and terms](worldview-data-sources.md).
3. Generate [source-cited reports](platform-reports.md), or review [local-model setup](local-ai-setup.md) and [inference workflows](local-ai-inference.md).
4. For disconnected demos, read the [training console guide](simulation-training-console.md), [demo RBAC design](rbac-permission-management-ui.md), and [operations runbook](operations-runbook.md).

### API or integration developer

1. Read the [API overview](api-overview.md) and [management API reference](../services/management-api/README.md).
2. Review the [telemetry contracts](../packages/contracts/v1/telemetry.schema.json) and [camera manifest](../packages/contracts/v1/camera-manifest.schema.json).
3. Follow the [PX4/ArduPilot integration guide](aircraft-integration.md) for the optional receive-only adapter.
4. Treat the [reference multicopter configuration](reference-multicopter-configuration.md) and [Holybro Pixhawk 6C hardware reference](../hardware/reference-multicopter.json) as non-authoritative baselines; owner selection and evidence remain open.
5. Read [security planning](safety-security.md) and [SECURITY.md](../SECURITY.md) before enabling streams or durable storage.

### Reviewer or release owner

1. Use the [validation and testing guide](validation-and-testing.md) and complete the [release checklist](release-checklist.md).
2. Review [architecture decisions](decisions/README.md) and [open-source patterns](open-source-patterns.md).
3. Treat patent and roadmap materials as source concepts; see [roadmap-derived capabilities](roadmap-derived-capabilities.md) and [source provenance](../source-materials/next-patent-roadmap-package-2026-10-19/README.md).

## Core documents

| Area | Document |
|---|---|
| Scope | [Project brief](project-brief.md) |
| Architecture | [System architecture](architecture.md) |
| Requirements | [Requirements](requirements.md) |
| API | [API overview](api-overview.md) |
| Offline catalog | [Mock/offline observations and integration boundary; no live Lattice connection](lattice-readonly-integration.md) |
| Observation workspace | [Feature sets, capability maturity, and local UI](observation-workspace.md) |
| Evidence copilot | [Exact citations, uncertainty, and outage/return digest](evidence-copilot.md) |
| Local-first assistance | [Local runtime, external opt-in, and resilient API reads](observation-assistance-networking.md) |
| Optional local models | [Installation and hardware limits](local-ai-setup.md), [browser installer](local-ai-browser-setup.md), and [advisory inference workflows](local-ai-inference.md) |
| Spatial workspace | [World View](worldview-workspace.md), [scene analyst](worldview-ai-analyst.md), and [feature gaps](gods-eye-capability-coverage.md) |
| Offline analysis libraries | [Turf spatial checks, uPlot telemetry charts, licenses and limits](offline-analysis-libraries.md) |
| External sources | [Opt-in adapters, coverage, provider terms, and unavailable integrations](worldview-data-sources.md) |
| Reports | [Platform-wide cited previews and Markdown/JSON exports](platform-reports.md) |
| Aircraft integration | [PX4/ArduPilot telemetry](aircraft-integration.md) and [reference multicopter configuration](reference-multicopter-configuration.md) |
| Training | [Simulation and Training C2](simulation-training-console.md) |
| Mission Autonomy | [Supervised synthetic team planning, rehearsal, and debrief](mission-autonomy.md) |
| Tracegate | [Tracegate guide](tracegate-guide.md) |
| Security | [Safety and security](safety-security.md) |
| Validation | [Validation and testing](validation-and-testing.md) |
| Operations | [Operations runbook](operations-runbook.md) |
| Release | [Release checklist](release-checklist.md) |
| Reuse | [Open-source patterns](open-source-patterns.md) |
| Terms | [Glossary](glossary.md) |

## Status vocabulary

- **Reference:** runnable locally with synthetic or disconnected data; not production-approved.
- **Candidate:** proposed contract or capability requiring design review.
- **Implemented locally:** code and tests exist; deployment, security, and operational approval are not implied.
- **Production-ready:** not claimed in this repository.

Keep claims traceable to code, contracts, tests, or source material. Mark assumptions and unresolved decisions. Never add real aircraft identifiers, live coordinates, private operational logs, secrets, or credentials to examples.
