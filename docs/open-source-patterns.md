# Open-source patterns and safe reuse

This document records patterns reviewed from mature open-source projects and the subset selected for the UCAS simulation-first management system. The goal is to reuse durable engineering ideas without importing live aircraft control, tactical coordination, targeting, weapons, or unsafe autonomy paths.

## Selected patterns

### OpenTelemetry Collector — staged telemetry pipelines

The OpenTelemetry Collector describes a vendor-neutral pipeline organized around receivers, processors, and exporters, with a unified treatment of metrics, logs, and traces [1]. UCAS should adopt the pattern, not the dependency: keep ingestion, normalization/validation, enrichment, routing, persistence, and delivery as explicit stages. This makes source identity, duplicate handling, freshness, redaction, and stream delivery testable independently.

**Adopt now:** document a pipeline stage model, add stage/result metadata to test fixtures, and preserve the existing HTTP/WebSocket boundaries. **Defer:** a general-purpose collector runtime or additional protocol adapters until a real integration requirement exists.

### OpenFGA — explainable relationship-based authorization

OpenFGA provides fine-grained authorization modeled through relationships and supports APIs, multiple storage backends, authorization-model testing, and a local playground [2]. UCAS should borrow the explainability and testability: represent `user -> role -> scope -> resource` relationships, return a reason for allow/deny decisions, and test inherited, expired, suspended, and conflicting assignments.

**Adopt now:** extend the RBAC design with a normalized relationship vocabulary and authorization-decision evidence. **Defer:** adding an external authorization service until shared deployment and a measured scale requirement justify it.

### Digital Twins Definition Language — explicit twin models and versions

DTDL describes IoT entities through versioned interfaces, telemetry, schemas, and semantic relationships [3]. UCAS should use a smaller local equivalent for the digital twin: stable model identity, schema version, capabilities that are explicitly simulation-only, state properties, relationships, and configuration fingerprint.

**Adopt now:** keep the twin model versioned and make the simulator’s capabilities deny-by-construction outside the browser-local rehearsal boundary. **Avoid:** modeling a live aircraft command surface as a “capability” merely because a twin schema can describe it.

### Grafana — queryable dashboards and annotations

Grafana emphasizes querying and visualizing multiple data sources, reusable dashboards, ad-hoc exploration, and alert rules [4]. UCAS should borrow the separation between source data, derived panels, alert rules, and annotations. A telemetry freshness warning should be a derived, explainable condition tied to sample and receipt times, not an opaque color.

**Adopt now:** define dashboard panels around latest state, bounded history, ingestion outcomes, maintenance, and audit annotations. **Defer:** adopting Grafana as a runtime dependency until the project has a deployment and data-retention decision.

### OpenObserve — unified operational signals and incidents

OpenObserve combines logs, metrics, traces, dashboards, alerts, incidents, and ingest-time pipelines, and describes OpenTelemetry-native ingestion and normalization [5]. UCAS should borrow the operational vocabulary: correlate an ingestion failure, stream gap, stale camera, maintenance state, or RBAC conflict into an incident-like review record with severity, lifecycle, owner, and evidence links.

**Adopt now:** define a small internal operational-event envelope and incident lifecycle in documentation and tests. **Defer:** a full observability platform, alert-notification integrations, and long-term retention architecture.

### Open-RMF — fleet abstractions and simulation-first integration

Open-RMF is a multi-fleet robotics-management platform with simulation demonstrations, versioned distributions, adapters, and documented integration boundaries [6]. UCAS should borrow the separation between fleet-management concepts, adapters, simulation, and release-tested versions.

**Adopt now:** keep future lab integration behind a read-only adapter contract and versioned fixtures. **Avoid:** importing task dispatch, navigation, or vehicle-control components into the management UI.

## Explicitly not selected

Do not copy flight-control, radio, autopilot, mission execution, targeting, tactical coordination, weapons, or real-world autonomy features from drone or robotics repositories. A repository being open source, popular, or simulation-capable does not make its operational-control path appropriate for this project.

## Implementation sequence

1. **Contract layer:** add a versioned operational-event envelope and simulator/twin metadata without changing the aircraft or telemetry command boundary.
2. **Authorization layer:** add explainable decision records and relationship fixtures to the existing RBAC design.
3. **Telemetry layer:** document and test explicit receive, validate, normalize, persist, project, and publish stages.
4. **Operator layer:** add dashboard annotations and incident-like review records for stale, duplicate, stream-gap, maintenance, and access-conflict events.
5. **Integration layer:** define a read-only adapter interface only after the M2 platform and lab procedure are approved.

## Sources

[1]: https://github.com/open-telemetry/opentelemetry-collector "OpenTelemetry Collector repository"
[2]: https://github.com/openfga/openfga "OpenFGA repository"
[3]: https://github.com/Azure/opendigitaltwins-dtdl "Digital Twins Definition Language repository"
[4]: https://github.com/grafana/grafana "Grafana repository"
[5]: https://github.com/openobserve/openobserve "OpenObserve repository"
[6]: https://github.com/open-rmf/rmf "Open-RMF repository"
