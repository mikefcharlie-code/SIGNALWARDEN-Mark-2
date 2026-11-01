# Glossary

| Term | Meaning in this repository |
|---|---|
| **Aircraft record** | An inventory and lifecycle record managed by the reference API. It is not a live vehicle identity or command endpoint. |
| **Autonomy rehearsal** | A browser-local simulation of an autonomy lifecycle. It is not autonomy authorization and cannot reach an aircraft. |
| **Camera Wall** | The management UI’s six-channel synthetic observation surface. It is read-only and does not represent a live camera transport. |
| **Digital twin** | An in-memory model used by Training C2 to rehearse state transitions, mock commands, and review events. |
| **Evidence event** | A bounded record associated with an accepted or late telemetry outcome. In the reference implementation it is not certification evidence. |
| **Freshness** | A derived assessment of how old the latest received sample is relative to the configured threshold. It is not a claim that the aircraft is reachable or safe. |
| **Ingestion outcome** | The result assigned to a telemetry sample, such as `accepted`, `late`, or `duplicate`. |
| **Lab article** | A synthetic or future controlled-lab inventory category. It does not imply a deployed or flight-ready aircraft. |
| **Latest projection** | A rebuildable view of the newest eligible telemetry state. Telemetry history remains the source of truth. |
| **Management API** | The reference HTTP service for inventory, telemetry, maintenance, and evidence records. It has no aircraft command route. |
| **RBAC** | Role-based access control. In this project the catalog defines roles and permissions, while a future production service must enforce them server-side. |
| **Read-only adapter** | A proposed future boundary for controlled lab telemetry. It must not be confused with a flight-control or command adapter. |
| **Reference implementation** | Runnable code intended to demonstrate contracts and behavior locally; it is not a production approval. |
| **Simulation environment** | The synthetic-data boundary used by fixtures, the UI, Training C2, autonomy rehearsal, and demos. |
| **Stale** | A state in which data exceeds the declared freshness threshold or a camera feed has not advanced within its expected interval. |
| **Stream gap** | A telemetry WebSocket signal that a bounded subscriber fell behind and must refetch latest state and bounded history. |
| **Synthetic data** | Invented identifiers, timestamps, measurements, video placeholders, users, and map geometry used for safe development and tests. |
| **Telemetry history** | Ordered records of received samples and their ingestion status. It is retained separately from the latest projection. |
| **Tracegate** | A deterministic prototype that maps a configuration change to impact closure, tests, evidence, and a bounded review status. It does not certify or authorize flight. |
| **Training C2** | A disconnected console for rehearsal of management workflows and digital-twin transitions. The name does not mean it is a military command-and-control system. |
