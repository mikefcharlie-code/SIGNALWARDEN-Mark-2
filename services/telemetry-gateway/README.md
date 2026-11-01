# Telemetry gateway — read-only transport boundary

The M1 reference transport is an opt-in WebSocket stream embedded beside the Management API. The API validates and persists telemetry first, then publishes a normalized event through the bounded in-process hub in [`services/telemetry_stream/`](../telemetry_stream/).

This path is simulation-safe and has no aircraft connection or command/control route. It supports UI filters by `aircraft_id` and `source`, emits explicit accepted/late/duplicate statuses, and sends a `stream_gap` recovery signal when a slow subscriber exceeds its bounded queue.

The stream is started with JWT verification and TLS by default:

```bash
UCAS_STREAM_ENABLED=1 \
  UCAS_STREAM_JWT_SECRET='at-least-32-characters-of-secret-material' \
  UCAS_STREAM_TLS_CERTFILE=/etc/ucas/tls/server.crt \
  UCAS_STREAM_TLS_KEYFILE=/etc/ucas/tls/server.key \
  .venv/bin/python services/management-api/app.py
```

Tokens must contain the `telemetry:read` scope plus standard issuer, audience, subject, issued-at, not-before, and expiry claims. Optional `aircraft_ids` and `sources` claims narrow access. `UCAS_STREAM_ALLOW_INSECURE=1` is reserved for local development and must not be used for shared or real-data deployments.

A future multi-instance or aircraft-adapter deployment must replace the in-process fanout with an authenticated broker/MQTT layer or another reviewed transport. Preserve the event envelope and keep source identity, replay protection, TLS, authorization, retention, and resynchronization semantics explicit. Never treat a WebSocket connection as proof that an aircraft is reachable, and never expose flight-control commands through this gateway.
