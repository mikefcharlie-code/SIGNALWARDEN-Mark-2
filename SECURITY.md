# Security

This is an early private scaffold, not a production or flight-certified system.

Do not file issues containing credentials, personal information, or real operational/location traces. Contact the repository owner privately to report sensitive vulnerabilities; agree on a reporting channel before inviting collaborators. No security contact address has been invented for this project.

Before any shared or real-data deployment: threat-model the interfaces, define roles, authenticate devices and users, authorize every endpoint, protect secrets, encrypt transport, bound ingestion, review dependencies, and test backups and incident response.

The reference WebSocket stream now requires an HS256 JWT with `telemetry:read`, issuer/audience/time validation, and optional aircraft/source restrictions. It requires TLS 1.2+ when enabled; `UCAS_STREAM_ALLOW_INSECURE=1` is a local-development-only override. Do not put `UCAS_STREAM_JWT_SECRET`, private keys, or bearer tokens in Git, URLs, issue text, logs, or client bundles. The HS256 secret is a transitional reference mechanism; shared deployments should move to managed asymmetric keys/JWKS and key rotation.

See [safety and security planning](docs/safety-security.md).
