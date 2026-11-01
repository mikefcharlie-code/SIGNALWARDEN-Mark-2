# Telemetry signing evidence (passive SITL captures)

## Scope and interpretation

This is a byte-level audit of the retained `firmware-mavlink.raw` artifacts from the PX4 v1.17.0 and ArduCopter 4.7.2 passive SITL validations. It is **not** a signature-verification result, an aircraft-security assessment, or evidence that either firmware is incapable of signing. No network aircraft connection, arming/control command, flashing, or key provisioning was performed.

The audit scans MAVLink frame boundaries and reads the MAVLink header flags:

- MAVLink 1 (`0xFE`) has no signed-frame flag in its header; a MAVLink 1 frame is therefore counted as `v1 unsigned/flag unavailable`.
- MAVLink 2 (`0xFD`) is signed when header `incompatibility_flags & 0x01` (`MAVLINK_IFLAG_SIGNED`) is set. The audit counts that bit only. It does **not** validate the 13-byte signature block, link ID, timestamp, key, or MAC.
- Text before the first frame is ignored. A frame is counted only when its declared length fits the capture; CRC/signature authenticity is deliberately not asserted.

These are observations of these captures, not generalized firmware or transport claims.

## Current policy rerun

The updated passive harness was rerun with the exact existing binary hashes, fresh simulator work directories, separate loopback APIs/ports and no key provisioning. Both disarmed firmware-to-gateway-to-API runs passed: **PX4 produced 721 unsigned MAVLink 2 frames; ArduCopter produced 61 unsigned MAVLink 2 frames; neither produced a signed frame.** No hardware was connected or flashed and no arming/control commands were issued.

Initial/normal, feed-loss, and restart API readbacks all retained `telemetry_trust=untrusted` and `flight_ready=false`. Feed loss became stale while the snapshot was still within its separate 30-second window; restart used a new session. The relay and an independent `tcpdump -r` source-port filter each found zero outbound gateway datagrams in both runs. This verifies the unsigned lab policy, **not signed firmware acceptance**. The newer counts reflect new captures, not alterations to the retained captures below.

[Machine-readable rerun evidence](evidence/ingress-security-policy.json) records the validated source hashes, commands, exact binary/artifact hashes, representative API phases and independent PCAP checks. Raw evidence remains under `artifacts/px4-ingress-policy-validation/` and `artifacts/arducopter-ingress-policy-validation/`, not committed as binaries/log bundles.

## Counts

| Stack / artifact | Capture bytes | SHA-256 | MAVLink 1: flag unavailable | MAVLink 2 unsigned flag | MAVLink 2 signed flag | Parsed frames |
|---|---:|---|---:|---:|---:|---:|
| PX4 v1.17.0, final exact API run: `artifacts/px4-v1.17-exact-api-final/firmware-mavlink.raw` | 53,390 | `7bc9b369c4b0d5eb4512e20f688669d1793497a273b7273966f93dbb6285b52c` | 0 | 658 | 0 | 658 |
| PX4 v1.17.0, earlier API run: `artifacts/px4-v1.17-api/firmware-mavlink.raw` | 58,427 | `7fc54e1f75b61c269b68d5497658c8c45aa00942b93bcb661806c252e111c832` | 0 | 714 | 0 | 714 |
| ArduCopter 4.7.2 API run: `artifacts/arducopter-4.7.2-api/firmware-mavlink.raw` | 2,173 | `c3686527ad2a219ae1484ee4c77f82d1df8fae511ceb1338b40ff1b198a77bab` | 0 | 56 | 0 | 56 |

`artifacts/px4-v1.17-exact-api/firmware-mavlink.raw` is zero bytes (SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`) and contributes no frames; it is not evidence of signing state.

The ArduCopter result is the retained 56-frame capture. The independent passive-capture review reports five `ATTITUDE` messages with increasing timestamps; that finding is unrelated to signing and does not change the flag count.

### Independent PCAP review

The Flight Agent independently checked the retained PCAP hashes against committed evidence without launching a simulator or replaying traffic:

| PCAP | SHA-256 | Firmware frame findings |
| --- | --- | --- |
| `artifacts/px4-v1.17-exact-api-final/loopback.pcap` | `b4c7fb73b75fbc6de117a95d054e71cf7bba03bf2aad1f00d400bd632a544ee0` | 519 unique firmware MAVLink 2 frames, all unsigned; 1,038 total includes 519 identical relay copies |
| `artifacts/arducopter-4.7.2-api/loopback.pcap` | `193574350f7a39ec76080c779d0820f39b49485bb1887f260e89996ff1a1d5f0` | 56 firmware MAVLink 2 frames, all unsigned |

The separately retained PX4 raw stream has 658 frames; it is not the same capture boundary as the PCAP and is not a contradictory frame count. ArduCopter's five `ATTITUDE.time_boot_ms` values increase from 2609 to 3409; this capture does not reproduce the synthetic duplicate-timestamp case. Neither PCAP demonstrates provisioned-key firmware signing validation. Unsigned isolated loopback is a lab exception only and remains untrusted. On untrusted networks, deployment requires an authenticated, integrity-protected, encrypted transport with replay protection and reviewed endpoints; a tunnel does not automatically authenticate the autopilot upstream of its endpoint.

## Provenance and manifests inspected

### PX4 v1.17.0

The manifest is [`docs/validation/evidence/px4-passive-pipeline.json`](evidence/px4-passive-pipeline.json), with the final artifact directory `artifacts/px4-v1.17-exact-api-final/`. The accompanying validation document identifies official tag `v1.17.0`, peeled source commit `d6f12ad1c4f70ad3230afd7d86e971421e02fef4`, and binary SHA-256 `c9bd20a03da4f17b37aff294047242fe339ca7b26d8c46943b636ede07eadc73`. The manifest records `source: simulated`, `arming_or_control_commands_sent: false`, and a receive-only/passive scope. The local passive startup config routes MAVLink to loopback UDP and sets streams; it contains no signing key provisioning or signing setup.

The earlier `px4-v1.17-api` manifest is `artifacts/px4-v1.17-api/result.json`; it records 714 firmware datagrams and the same passive/no-control boundary. Its raw capture is included above for transparency but is not substituted for the final exact run.

### ArduCopter 4.7.2

The corresponding manifest is [`docs/validation/evidence/ardupilot-passive-pipeline.json`](evidence/ardupilot-passive-pipeline.json), with `artifacts/arducopter-4.7.2-api/result.json` and the raw capture above. The validation document identifies tag `Copter-4.7.2`, source commit `fb773567896014da007bca58358704d4a0d8516f`, and binary SHA-256 `0c7e26db576c6fc0c742021e4b1c694a55fc7375bf4041b6a4696c665c53438b`. The manifest records `source: simulated`, `arming_or_control_commands_sent: false`, and a passive telemetry/feed-loss scope. The observer parameter file only sets telemetry stream rates (`MAV1_EXT_STAT`, `MAV1_POSITION`, `MAV1_EXTRA1`, `MAV1_EXTRA3`); no signing key was provisioned.

## Source and documentation boundary

The pinned ArduPilot tree is locally present at commit `fb773567896014da007bca58358704d4a0d8516f`. Its `libraries/GCS_MAVLink/GCS_Signing.cpp` contains an outgoing-signing path conditional on `status->signing` and `MAVLINK_SIGNING_FLAG_SIGN_OUTGOING`; `GCS_config.h` gates support with `AP_MAVLINK_SIGNING_ENABLED`. This confirms that the source has a signing path, but does not establish the runtime key/configuration used by this capture.

The pinned PX4 tree is locally present at commit `d6f12ad1c4f70ad3230afd7d86e971421e02fef4`. The inspected `src/modules/mavlink` tree did not expose a direct signing configuration/path in the searched files; that limited source search is inconclusive and is not used to infer capability.

MAVLink signing authenticates possession of a configured key; it does not create unique vehicle identities by itself. PX4 documentation describes outgoing signing when a key is provisioned. ArduPilot documentation notes that telemetry downlink is unaffected by command signing; that statement does **not** prove packets are unsigned under a provisioned signing configuration. Accordingly, the only safe conclusion here is: **all parsed frames in the listed captures had the MAVLink 2 signed bit clear, and no MAVLink 1 signed flag exists to count. Signature validity and firmware capability remain unestablished.**

## Reproducibility

The audit was performed passively with Python: scan for `0xFE`/`0xFD`, use the declared payload length, add 13 bytes only when MAVLink 2 bit 0 is set, and count `(version, bit state)`. Re-run from the repository root with:

```bash
python3 - <<'PY'
from pathlib import Path
from collections import Counter
for p in sorted(Path('artifacts').glob('*/firmware-mavlink.raw')):
    b = p.read_bytes(); i = 0; counts = Counter()
    while i < len(b):
        if b[i] == 0xfe:
            if i + 8 > len(b): break
            n = 8 + b[i + 1]; key = ('MAVLink1', 'flag-unavailable')
        elif b[i] == 0xfd:
            if i + 12 > len(b): break
            signed = bool(b[i + 2] & 1); n = 12 + b[i + 1] + (13 if signed else 0)
            key = ('MAVLink2', 'signed-flag-set' if signed else 'signed-flag-clear')
        else:
            i += 1; continue
        if i + n > len(b): break
        counts[key] += 1; i += n
    print(p, len(b), dict(counts))
PY
```
