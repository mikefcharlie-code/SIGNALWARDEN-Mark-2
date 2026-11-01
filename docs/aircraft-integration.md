# Read-only aircraft integration

The optional **aircraft gateway** receives common MAVLink telemetry from one explicitly selected PX4 or ArduPilot system and forwards normalized observations to the local Management API. It has no MAVLink transmit path and is not a flight-control, mission, arming, takeoff, offboard, or autonomy service. Autonomous flight remains on PX4/ArduPilot; commission an aircraft through a supported GCS. Connecting this adapter does **not** make an arbitrary aircraft flight-ready.

## Scope and boundaries

- One gateway process per aircraft and a separate UDP port per process; do not share the port with QGroundControl or another consumer.
- `--system-id`, component (default `1`), autopilot family, aircraft record, and source are explicit. Heartbeat family is verified before snapshots are accepted; system/component IDs are pinned.
- `source=simulated` is required for SITL. Use `source=aircraft` only intentionally on a real lab vehicle.
- The API target is HTTP loopback only, default `http://127.0.0.1:8000`; the gateway preflights a registered aircraft and never auto-provisions one.
- For API mode with `source=aircraft`, `--publisher-id` and `--publisher-token-file` are required. The token file must contain at least 32 characters and be mode `0600` (outside the repository). The API fails closed unless `UCAS_TELEMETRY_PUBLISHERS_FILE` points to a JSON mapping of publisher IDs to `{ "token": "...", "aircraft_ids": [...], "sources": ["aircraft"] }`; when configured, every ingest requires a matching token. If it is not configured, only synthetic publishing is allowed.
- Mapped common messages are `HEARTBEAT`, `SYS_STATUS`, `BATTERY_STATUS`, `GLOBAL_POSITION_INT`, `ATTITUDE`, and `GPS_RAW_INT`.
- Schema `1.1` extends the existing v1 telemetry shape; `1.0` remains unchanged. Timestamps are gateway-observed UTC, not synchronized aircraft time; the API applies a future-time bound of five seconds and supplies canonical receipt time. Gateway reconnects, heartbeat recovery and observed boot-clock resets create new random session identities. Values use SI units, position/attitude/GPS sections carry `age_seconds`, and stale/unknown fields are null or omitted. Health may be unknown; link quality is always null because MAVLink RSSI is not a percentage. Battery selection defaults to `battery_id=0`. Custom mode is retained as a raw integer, not a fragile human label. Expired heartbeat stops snapshots.

The branch now has genuine **disarmed passive firmware → gateway → Management API** evidence for [PX4 v1.17.0](validation/px4-sitl.md) and [ArduCopter 4.7.2](validation/ardupilot-sitl.md), including captured heartbeat loss/restart recovery and API stale-state handling. PX4 used no selected airframe/internal SIH startup, not Gazebo/x500 acceptance; ArduCopter used the built-in quad model without flight. These are telemetry-pipeline smoke passes, **not complete SITL dynamics/failsafe acceptance or physical validation**. No bench, HIL, hardware or flight gate has passed. The [reference multicopter](reference-multicopter-configuration.md) and [Pixhawk 6C reference](../hardware/reference-multicopter.json) remain non-authoritative alternatives, not owner-selected hardware, wiring or approved parameters.

## Reception, backlog and freshness

MAVLink reception and sink publication run separately. The receiver records each decoded message's monotonic observation time without waiting for HTTP or stdout writes. One mapper caches the latest supported observation per message type, not an unbounded raw-message queue. A single publisher permits **one in-flight write and one coalesced wakeup**, not a queue of snapshots. If publication is slower than `--interval`, intermediate publication requests are intentionally collapsed/dropped. This is latest-state telemetry, not lossless flight logging; sequence gaps are not a count of lost MAVLink packets.

At dispatch the publisher snapshots the current mapper using the current clock, preserving the original observation ages. Expired heartbeats suppress publication and stale fields are omitted/null; pending requests cannot refresh them. Reconnect resets the mapper/session before future dispatches. A sample already in an HTTP request or stdout write cannot be recalled and may arrive after heartbeat loss or reconnection. Its original snapshot timestamp/session/ages are retained, including on the single HTTP retry; it is never relabeled as a fresh observation. Consumers must apply their own receipt/snapshot-age limits. HTTP uses a three-second socket-operation timeout and at most one retry (no retained retry queue), not a hard end-to-end delivery deadline. Shutdown discards pending work and waits at most seven seconds for the publisher.

These are gateway-reception ages, not aircraft measurement ages: external radio/router/kernel buffering, scheduler starvation and packet loss remain possible and are not quantified. The adapter does not synchronize aircraft clocks or guarantee real-time freshness under arbitrary load. Orderly TCP EOF and resets enter the gateway's close/backoff/reconnect path without pymavlink's stdout EOF flood. Normal idle receive timeouts are not disconnects, including on UDP and serial links.

Reboot detection is conservative and incomplete: it detects a decreasing `time_boot_ms` against the previous observation **of the same supported message type**, or a transport/heartbeat-expiry boundary. A heartbeat alone has no boot identity. A fast reboot without one of these observable boundaries can leave prior sensor values visible until their field timeout; cross-type timestamps are not treated as a globally ordered boot clock. Do not use session identity as proof that no reboot happened. Primary battery-cell zero is a measured value, not the `UINT16_MAX` unknown sentinel; extension-cell zero has different, unknown/not-supported semantics in MAVLink.

Explicit critical/emergency/power-off/termination heartbeat states and fresh selected-battery low/critical/emergency/failed/unhealthy or fault reports map to the existing `health.status=warning`. Normal or missing reports never imply `nominal`. See [aircraft acceptance gates](flight-readiness.md) for warning semantics, required owner information and the physical validation still needed.

### Battery identity and token-file enforcement

Untagged `SYS_STATUS` battery fields are a fallback only for primary battery ID 0 by gateway policy, not proof of identity. Selecting another battery requires fresh matching `BATTERY_STATUS`; missing/stale selected-battery measurements stay unknown even when `SYS_STATUS` is fresh. System sensor-health warnings remain independent of battery selection.

Publisher token files must contain 32–4096 non-whitespace ASCII characters. The gateway validates exact mode `0600`, effective-user ownership and regular-file type on the opened descriptor, refusing symlinks and special files. Token-file publishing requires POSIX and fails closed on unsupported platforms; it does not silently assume Windows ACL protection. Keep credentials outside the repository.

## Register an aircraft first

Start the local API (loopback by default):

```bash
.venv/bin/python services/management-api/app.py
```

Register an inventory record; the gateway will refuse an unknown ID:

```bash
curl -sS -X POST http://127.0.0.1:8000/api/v1/aircraft \
  -H 'Content-Type: application/json' \
  -d '{"schema_version":"1.0","aircraft_id":"sitl-x500-001","display_name":"PX4 SITL X500 001","lifecycle_status":"planned","hardware_revision":"simulated"}'
```

`hardware_revision` is optional. Registration is inventory, not a readiness or identity attestation.

For a publisher-authenticated **isolated lab** run, generate API credentials outside Git. These credentials do not authenticate incoming aircraft telemetry. Also configure the separate [ingress security policy](telemetry-ingress-security.md): aircraft-source reception defaults to required signing with a protected 32-byte key and durable replay ledger. This example uses the placeholder inventory ID `lab-quad-001`; register a matching aircraft record before starting its gateway. Do not reuse the SITL inventory record for a real airframe.

```bash
export UCAS_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/ucas"
install -d -m 700 "$UCAS_CONFIG_DIR"
python3 - <<'PYSETUP'
import json, os, secrets
from pathlib import Path
root = Path(os.environ["UCAS_CONFIG_DIR"])
token = secrets.token_urlsafe(48)
files = {
    "mavlink-publisher.token": token + "\n",
    "telemetry-publishers.json": json.dumps({"mavlink-lab-001": {
        "token": token, "aircraft_ids": ["lab-quad-001"], "sources": ["aircraft"],
        "ingress_policies": ["required-signed"]
    }}) + "\n",
}
for name, content in files.items():
    path = root / name
    # Refuse overwriting an existing credential/configuration.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(content)
PYSETUP
export UCAS_TELEMETRY_PUBLISHERS_FILE="$UCAS_CONFIG_DIR/telemetry-publishers.json"
.venv/bin/python services/management-api/app.py
```

Stop the earlier API process first: exporting a variable does not reconfigure an already running process. In this configured mode every telemetry source needs a publisher entry; the example authorizes only `lab-quad-001` with `source=aircraft`. Use separate explicitly allowed simulated publishers for SITL. Rotate credentials by replacing the configuration atomically; removing a publisher revokes it on the next request. Protect these files and never commit or print their contents.

## Run the gateway

Install development and aircraft dependencies:

```bash
.venv/bin/pip install -r requirements-dev.txt -r requirements-aircraft.txt
```

Run as a module. `--connection` is required and accepts `udpin:host:port`, `tcp:host:port`, or a serial device such as `/dev/ttyUSB0`; `--aircraft-id`, `--autopilot`, `--system-id`, and `--source` are also required:

```bash
.venv/bin/python -m services.aircraft_gateway \
  --connection udpin:127.0.0.1:14540 \
  --aircraft-id sitl-x500-001 --autopilot px4 --system-id 1 \
  --source simulated --max-samples 10
```

For ArduPilot, configure a **dedicated receive-only MAVProxy output** (for example `output add 127.0.0.1:14551` in MAVProxy) and observe it with:

```bash
.venv/bin/python -m services.aircraft_gateway \
  --connection udpin:127.0.0.1:14551 \
  --aircraft-id sitl-quad-001 --autopilot ardupilot --system-id 1 \
  --source simulated --stdout --max-samples 10
```

These commands do not install, start, or validate the autopilot simulator. Follow the official simulator setup links below; confirm the actual IDs and stream configuration for the chosen firmware. The gateway does not request message rates or send a heartbeat: configure telemetry streams through the supported GCS/router. A stream that is not already sending cannot be activated by this receive-only adapter.

Use `--stdout` to print JSON Lines instead of posting to the API. Useful bounded-run options include `--max-samples`, `--interval`, `--heartbeat-timeout`, `--field-timeout`, `--component-id`, and `--battery-id`. For `source=aircraft` API mode, add `--publisher-id mavlink-lab-001 --publisher-token-file "$UCAS_CONFIG_DIR/mavlink-publisher.token"`; the pair is required and the file is read locally. `--api-url` may override the port, but remains restricted to an HTTP loopback URL. There is no outbound MAVLink message code.

## Reproduce the automated checks

```bash
.venv/bin/pytest -q
```

The former 22-case Docker/Testcontainers PostgreSQL integration suite was deleted; there is no replacement automated database-integration coverage. PostgreSQL storage remains available for the Management API, but it is outside this aircraft-gateway validation path. The remaining automated suite passed **222 tests with zero skips** in a clean environment without Docker SDK or Testcontainers installed. Wire regressions include real TCP orderly close/reconnect with JSONL/no-transmit assertions and a slow-sink UDP reception/freshness case. These use synthetic MAVLink producers, not running autopilot firmware. Signing regressions cover valid/unsigned/MAVLink 1, bad signatures without replay-state poisoning, duplicates/out-of-order/stale/future timestamps, unknown IDs, protected keys, lock/storage failure and reconnect/restart persistence. Actual subprocess wire-to-API tests verify signed reception for synthetic packets labeled for both families and zero outbound gateway bytes; a subprocess restart test rejects the previously accepted signed packet. HTTP regressions reject forged authenticated metadata from open simulation or unapproved/revoked publisher policies. These are receiver tests, not provisioned-key firmware signing acceptance. Existing checks include POSIX PTY receive/no-write/unplug/replug, dependency installation, both-stack warnings and duplicate observation ages. PTYs do not establish physical UART/DTR safety. See [response semantics](api-overview.md#latest-telemetry-is-not-a-connectivity-heartbeat) and [unsigned firmware policy reruns](validation/telemetry-signing-evidence.md). These receiver checks are reported separately from database-storage validation.

## Validation gates

Progress in order: (1) staged SITL with synthetic/simulated source; (2) isolated bench with propellers removed and receive-only routing; (3) HIL; (4) supervised flight. Record exact autopilot firmware/version, vehicle/frame, hardware selection, wiring, component IDs, transport, observed messages, stale/heartbeat behavior, and rollback evidence at each gate. Do not claim a gate passed without evidence.

Serial opening may have DTR side effects. Prefer an isolated bench and a receive-only router; never connect an unreviewed serial path to a live vehicle. Strict MAVLink 2 verification/replay rejection is available through the [ingress security policy](telemetry-ingress-security.md); signing does not encrypt and shared-key possession is not unique aircraft identity. Both retained firmware pipelines carry unsigned telemetry and remain untrusted. Unsigned isolated loopback is a lab exception, not production acceptance. Untrusted networks require a reviewed authenticated, integrity-protected, encrypted transport with replay protection and correct endpoint scope; the transport policy flag is only an operator assertion. The local publisher token authorizes an API source; it does not authenticate the aircraft or replace MAVLink security. Every gateway sample and latest API view explicitly retain `flight_ready=false`. Do not expose the API or gateway on a public production network, disable autopilot safety, or disable signing to accommodate it.

## Official references

- [PX4 simulation](https://docs.px4.io/main/en/simulation/): UDP 14540 listener, `make px4_sitl gz_x500`, and other SITL targets; GCS commonly uses 14550.
- [ArduPilot SITL testing](https://ardupilot.org/dev/docs/using-sitl-for-ardupilot-testing.html): `sim_vehicle.py -v ArduCopter`/`ArduPlane`, TCP 5760 without MAVProxy, and MAVProxy output routing.
- [pymavlink](https://mavlink.io/en/mavgen_python/)
- [MAVLink common messages and units](https://mavlink.io/en/messages/common.html)
