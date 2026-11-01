# Telemetry gateway — read-only transport boundary

The repository has two read-only paths: the existing synthetic WebSocket stream and the opt-in `services/aircraft_gateway` MAVLink adapter. The aircraft adapter normalizes common PX4/ArduPilot messages into telemetry schema `1.1` and posts only to the loopback Management API. The existing frontend remains synthetic; it has no live-aircraft integration.

The adapter is deliberately separate from the in-process WebSocket fanout. The API validates and persists telemetry, then can publish normalized events through [`services/telemetry_stream/`](../telemetry_stream/). No path exposes flight-control commands.

The WebSocket stream remains opt-in:

```bash
UCAS_STREAM_ENABLED=1 \
  UCAS_STREAM_JWT_SECRET='at-least-32-characters-of-secret-material' \
  UCAS_STREAM_TLS_CERTFILE=/etc/ucas/tls/server.crt \
  UCAS_STREAM_TLS_KEYFILE=/etc/ucas/tls/server.key \
  .venv/bin/python services/management-api/app.py
```

Tokens need the `telemetry:read` scope and standard issuer, audience, subject, issued-at, not-before, and expiry claims. `UCAS_STREAM_ALLOW_INSECURE=1` is local development only. The MAVLink adapter uses an allowlisted local publisher token for API authorization: `source=aircraft` fails closed unless `UCAS_TELEMETRY_PUBLISHERS_FILE` is configured, and configured mode requires a matching token for every ingest. This token authorizes the gateway process, not aircraft identity; MAVLink signatures/encryption are still not verified. Source registration, replay policy, and multi-instance fanout remain hardening work.

For adapter setup, registration, safety limits, and SITL/bench/HIL/flight gates, read [aircraft integration](../../docs/aircraft-integration.md).
