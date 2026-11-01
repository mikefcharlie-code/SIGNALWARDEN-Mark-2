# Aircraft gateway

A receive-only PX4/ArduPilot MAVLink adapter. Start it with `python -m services.aircraft_gateway`. It reads one pinned MAVLink system/component, verifies the selected family from `HEARTBEAT`, maps common telemetry, and emits schema `1.1` observations. It never sends MAVLink messages.

## CLI

Required flags:

```text
--connection udpin:host:port | tcp:host:port | /dev/tty...
--aircraft-id ID
--autopilot px4|ardupilot
--system-id 1..255
--source simulated|aircraft
```

Optional flags include `--component-id` (default `1`), `--baud` (serial default `115200`), `--api-url` (default `http://127.0.0.1:8000`, loopback HTTP only), `--interval`, `--heartbeat-timeout`, `--field-timeout`, `--battery-id` (default `0`), `--stdout`, and `--max-samples`. In API mode with `--source aircraft`, `--publisher-id` and `--publisher-token-file` are a required pair; the token file must contain 32+ characters and be mode `0600` outside the repository.

Examples:

```bash
.venv/bin/pip install -r requirements-dev.txt -r requirements-aircraft.txt
.venv/bin/python -m services.aircraft_gateway --connection udpin:127.0.0.1:14540 --aircraft-id sitl-x500-001 --autopilot px4 --system-id 1 --source simulated --stdout --max-samples 5
```

Without `--stdout`, the gateway GETs `/api/v1/aircraft/{id}` first, then POSTs `/api/v1/telemetry/ingest`; registration is mandatory and there is no auto-provisioning. The API allows synthetic publishing by default only when no publisher file is configured. Set `UCAS_TELEMETRY_PUBLISHERS_FILE` to an external JSON publisher mapping to require tokens for every ingest and to allow an intentional aircraft publisher only when its token, aircraft ID, and source are explicitly listed. Run one process per aircraft on a dedicated UDP port; do not bind the same port as QGC.

The mapper accepts `HEARTBEAT`, `SYS_STATUS`, `BATTERY_STATUS`, `GLOBAL_POSITION_INT`, `ATTITUDE`, and `GPS_RAW_INT`. Unknown or stale values remain null/omitted, with per-section ages. Heartbeat expiry stops snapshots and a family mismatch is rejected. `source=simulated` identifies SITL; `source=aircraft` is reserved for an intentional real lab connection.

## Ingress authentication

Aircraft-source reception defaults to `--ingress-policy required-signed`, including stdout mode. Supply `--signing-key-file` (32 binary bytes, owned regular 0600 file) and `--signing-state-file` (durable replay ledger in an owned 0700 directory). Use `--initialize-signing-state` once for a new deployment only; remove it on restart. Missing/corrupt state or invalid/unsigned/replayed packets fail closed. State persists across reconnects and process restarts. Signed timestamps require a trusted UTC clock and a +/-60-second window. The receiver never provisions keys or sends signing setup messages.

Simulation defaults to `unauthenticated` and reports `untrusted`; unauthenticated network connections are restricted to isolated loopback. Aircraft lab diagnostics must explicitly opt into that policy. `--ingress-policy secure-transport --secure-transport-reference CONFIG_REFERENCE` reports `transport-asserted`, not signature verification: the operator must deploy and review an authenticated, integrity-protected, encrypted ingress transport with replay protection and no plaintext bypass. The flag does not establish or monitor a VPN. Every sample includes policy/counters and `flight_ready=false`; API views keep trust separate from freshness. Read the [full security policy](../../docs/telemetry-ingress-security.md) before commissioning.

This adapter is telemetry observation only: no mission upload, arming, takeoff, offboard setpoints, autonomous planner, or arbitrary flight-readiness claim. The local publisher token authenticates the gateway to the API, not the aircraft. Signature verification authenticates shared-key possession, not unique physical sysid identity; signing does not encrypt. Both retained firmware SITL captures are unsigned, so synthetic receiver signing tests do not establish signed firmware acceptance. Keep the link isolated and do not weaken autopilot safety/signing. Keep it off public production networks. Serial open can toggle DTR; use propeller-removed isolated benches and preferably a receive-only router.

See the [aircraft integration guide](../../docs/aircraft-integration.md) for validation gates and official PX4/ArduPilot/MAVLink references.
