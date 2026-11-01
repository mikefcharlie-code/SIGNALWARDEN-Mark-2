# Telemetry authentication is not flight readiness

The receive-only gateway now supports strict MAVLink 2 signature verification and durable replay rejection. **It is still not flight-ready.** No aircraft was armed, controlled, flashed or flown for this work. Firmware capture findings are recorded separately in [signing evidence](validation/telemetry-signing-evidence.md).

## Choose an explicit ingress policy

| Policy | What is accepted | Reported trust |
| --- | --- | --- |
| `required-signed` | Valid, fresh MAVLink 2 signatures from the selected system/component, with strictly increasing timestamps per link ID | `signature-verified` after successful verification |
| `secure-transport` | Decoded telemetry delivered by an operator-configured authenticated transport | `transport-asserted`, **not** MAVLink signature verification |
| `unauthenticated` | Decoded telemetry without cryptographic identity verification | `untrusted` |

Aircraft-source runs default to `required-signed` and fail closed without a protected key and replay ledger, including `--stdout` runs. Simulation defaults to `unauthenticated` and is marked untrusted. Unauthenticated network reception is restricted to isolated loopback; remote/wildcard network addresses are rejected. An operator can explicitly select `--ingress-policy unauthenticated` for a diagnostic aircraft-source run; it never becomes authenticated because it has a plausible heartbeat, family, sysid, component ID, location, or API publisher token. Loopback/serial isolation remains an operator responsibility, not physical aircraft authentication.

`secure-transport` additionally requires `--secure-transport-reference` naming the reviewed deployment configuration. This is an **operator assertion**, not an automatic tunnel health check. Merely supplying a string, using localhost, or installing a VPN does not establish secure ingress. On untrusted networks require authenticated, integrity-protected, encrypted transport with replay protection. Before deployment, restrict the receiver to the intended authenticated peer/interface, authenticate both endpoints, apply least-privilege peer/route/firewall rules, prevent any plaintext bypass into the same receiver, protect the aircraft-to-tunnel-endpoint segment, and verify fail-closed behavior on tunnel failure. A tunnel ending at a radio/router cannot authenticate an otherwise spoofable upstream segment. A specific topology and owner review are still required; no such transport deployment was validated here.

Every emitted gateway sample carries `ingress_security` with the policy, trust label, counters and `flight_ready=false`. API latest views expose `telemetry_trust` separately from freshness and connectivity, defaulting old/missing metadata to `untrusted`; `flight_ready` is always false. Metadata is an assertion by the gateway publisher, not independent API proof of aircraft identity. Keep API publisher credentials scoped and protected. The schema rejects an `unauthenticated` policy claiming signature or transport verification.

The API rejects signature/transport assertions from the open simulation endpoint. An authenticated publisher must additionally be authorized by server configuration with `ingress_policies: ["required-signed"]` or `["secure-transport"]`, respectively, alongside its exact aircraft/source binding. Omitted publisher policies authorize only untrusted telemetry. Configure the smallest necessary policy set; never authorize a diagnostic unsigned gateway to claim verified ingress. Policy revocation is read on the next ingest. The API still relies on the authorized gateway to perform actual packet verification, so a compromised publisher credential/gateway remains a trust boundary.

## Strict signed reception

The gateway uses Pymavlink's MAVLink 2 framing/CRC and signed-message rejection path with a hardened signature verification hook. It never sends MAVLink messages and configures `sign_outgoing=False`. A v2-capable parser is selected before reception so Pymavlink's protocol auto-upgrade cannot erase the policy. MAVLink 1, unsigned messages (including HEARTBEAT), invalid signatures and malformed frames do not update mapper observations. There is no discovery or recovery allowlist.

The hook verifies the protocol's SHA-256/48-bit MAC with a constant-time comparison **before** changing replay state. This avoids the installed Pymavlink parser's pre-verification stream-timestamp mutation. It rejects another system/component even when the key is valid. Signing proves possession of a shared key, **not the unique physical identity** of that system/component: another trusted key holder can impersonate those IDs.

Every accepted signature timestamp must be within 60 seconds of the gateway's trusted UTC clock (both past and future), and strictly greater than the stored timestamp for that link ID. This policy is intentionally stricter than implementations that apply an age check only when first seeing a stream. Correct clock discipline is a deployment prerequisite. Misclocked/rebooted senders stop being accepted; the receiver does not silently relax checks. A valid signed packet captured but never previously accepted can still be delayed/replayed once within the 60-second acceptance window. This is **not zero-latency freshness, exactly-once sensor measurement delivery, or protection against a compromised key holder**.

Replay high-water marks survive socket reconnects, mapper/heartbeat resets and gateway process restarts. Each accepted high-water mark is atomically replaced and file/directory-fsynced **before** the packet is accepted. The single-writer lock prevents concurrent receivers sharing one ledger. Storage errors stop the receiver, not acceptance without persistence. Per-packet durable writes add latency and I/O load; production throughput, flash wear, power-loss behavior and platform filesystem guarantees remain unvalidated.

## Keys and durable state

`--signing-key-file` must name an effective-user-owned regular binary file with exact mode `0600`, containing exactly 32 bytes and not an all-zero key. Symlinks and special files are refused. Keep it outside Git and logs. This receiver does not generate, request, provision, rotate or transmit aircraft keys. An owner must arrange key provisioning over a separately reviewed trusted path; never disable signing to accommodate the bridge.

`--signing-state-file` must be in a dedicated effective-user-owned `0700` directory on durable local storage, with operator-protected trusted path ancestors (only the immediate directory is automatically checked). Existing state must be an owned regular `0600` file and match the key fingerprint, aircraft ID, autopilot family, source, connection configuration and pinned system/component IDs. Lock files have the same file protection. Use unique per-aircraft keys; configuration binding does not make shared-key IDs unique. A missing/corrupt/mismatched ledger fails closed. For a **new** deployment only, add `--initialize-signing-state` once; then remove that flag from service startup. Initialization refuses to overwrite an existing ledger. Signing/storage protection currently requires POSIX file permissions and advisory locking.

Example flag additions to an otherwise configured gateway (paths are placeholders, no real key is provided):

```text
--ingress-policy required-signed
--signing-key-file /protected/ucas/telemetry.key
--signing-state-file /protected/ucas/replay/state.json
```

Never delete/restore/roll back a ledger to fix a rejected timestamp, reuse it for another identity, or initialize new state for an existing key without a reviewed replay-risk procedure. Protect backups and storage against rollback/tampering; filesystem permissions alone do not defeat privileged attackers or restored snapshots. Key rotation and new-state commissioning require owner review. There is no automatic fallback from required signing to plaintext.

## Firmware-specific limits

[PX4's current signing documentation](https://docs.px4.io/main/en/mavlink/message_signing) describes signed outgoing telemetry when a key is provisioned, while allowing some **incoming-to-PX4** unsigned safety messages. That firmware allowlist does not weaken this receiver's strict policy. It is not evidence that a particular retained PX4 capture is signed or that the pinned release has been validated with a provisioned key.

[ArduPilot's signing documentation](https://ardupilot.org/copter/docs/common-MAVLink2-signing.html) says telemetry downlink remains available when command signing is enabled. Command authentication is not proof that this bridge's incoming telemetry is signed. The retained ArduCopter 4.7.2 capture is unsigned. It therefore cannot pass `required-signed`; use a fully scoped authenticated transport or explicitly accept the clearly untrusted diagnostic mode. Do not extrapolate that capture to all firmware configurations or transports.

The [MAVLink signing specification](https://mavlink.io/en/guide/message_signing.html) defines the signature, per-stream timestamps and key handling. Signing authenticates and detects modification; **it does not encrypt telemetry**. No provisioned-key firmware-to-gateway signing acceptance was performed in this change. Synthetic signed wire tests demonstrate receiver behavior, not a signed PX4/ArduPilot firmware pipeline.

## What still needs the owner and hardware

Before any trusted deployment, select the actual airframe, controller, pinned firmware/build, IDs and transport topology; review provisioning, key custody, clock discipline, secure transport boundaries and replay-ledger lifecycle. PX4 still has no owner-selected airframe in the retained pipeline. Physical UART/DTR behavior, bench, HIL, full SITL dynamics/failsafes and supervised flight remain unvalidated. See [flight-readiness gates](flight-readiness.md). No telemetry trust setting bypasses these gates or confers flight-control authority.
