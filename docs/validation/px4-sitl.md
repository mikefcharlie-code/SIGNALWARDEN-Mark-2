# PX4 v1.17.0: passive telemetry pipeline passed

**Genuine release firmware → receive-only gateway → isolated Management API passed. This is not flight readiness or autopilot failsafe validation.** The run was disarmed, used the internal SIH startup with no selected airframe, and reported missing/uncalibrated sensors. It did not exercise Gazebo/x500 flight dynamics.

## Exact firmware and configuration

Official [PX4 v1.17.0](https://github.com/PX4/PX4-Autopilot/releases/tag/v1.17.0), peeled commit `d6f12ad1c4f70ad3230afd7d86e971421e02fef4`, built with `make px4_sitl_default -j2` after recursive pinned submodule setup. Annotated tag object: `a5eb12d2ab591251faa009f76b2685b8cc64405d`.

Binary SHA-256: `c9bd20a03da4f17b37aff294047242fe339ca7b26d8c46943b636ede07eadc73`.

The final startup was regenerated from that exact commit, not copied from another release. Only default MAVLink routing was replaced with local UDP 14582 → loopback 14550 and common telemetry stream configuration; `param show -a` recorded configured parameters without changing them. Environment `PX4_*` overrides were removed and the working directory was fresh. Upstream POSIX simulation defaults were retained—not approved aircraft parameters. The log confirms `CBRK_SUPPLY_CHK=0` and `COM_LOW_BAT_ACT=3`, plus expected preflight failures. No arming, control, or MAVLink parameter-write commands were sent by the bridge or harness.

## Captured result

[Machine-readable evidence and representative API readbacks](evidence/px4-passive-pipeline.json) record the command, exact firmware checksum, messages, sessions and artifact hashes. The final artifact directory is `artifacts/px4-v1.17-exact-api-final/`.

- 658 firmware UDP datagrams; decoded core messages included HEARTBEAT, SYS_STATUS and BATTERY_STATUS. Common position/attitude/GPS coverage was **not** established in this no-airframe PX4 run.
- All four captured heartbeats were system/component 1/1 and disarmed. Unsupported dialect messages were not mapped.
- Normal snapshots advanced through the gateway and actual HTTP ingestion/readback with `source=simulated`.
- Stopping firmware caused `connectivity=stale` and overall `freshness=stale` while the separately reported snapshot was still within the 30-second snapshot window. Effective heartbeat age at the loss readback was about 3.22 seconds against a 2-second deadline.
- No publication sequence advancement after timeout; restart recovered with a different session and no cached sensor resurrection.
- The relay observed zero outbound gateway datagrams. Independent `tcpdump -r loopback.pcap 'udp src port <gateway-port>'` inspection also found zero. This is an observation of this run, not physical receive-only wiring proof.

## Reproduce after installing official PX4 build prerequisites

See [PX4 building](https://docs.px4.io/main/en/dev_setup/building_px4) and [SIH](https://docs.px4.io/main/en/sim_sih/index). Install this repository's development/aircraft requirements and `tcpdump`. Build the exact source/tag above, then from this repository (adjust checkout paths; choose new output/work directories):

```bash
PX4=/tmp/ucas-px4-sitl
.venv/bin/python scripts/prepare_px4_passive.py --px4 "$PX4" --output /tmp/px4-passive.rcS
mkdir -p /tmp/px4-passive-work
.venv/bin/python scripts/validate_passive_pipeline.py --family px4 \
  --firmware-command-json "[\"$PX4/build/px4_sitl_default/bin/px4\",\"-d\",\"-s\",\"/tmp/px4-passive.rcS\",\"$PX4/build/px4_sitl_default/etc\",\"-w\",\"/tmp/px4-passive-work\"]" \
  --firmware-cwd "$PX4/build/px4_sitl_default" --ingress-port 14550 \
  --output "$PWD/artifacts/px4-passive-new" --capture
```

`<rootfs_directory>` must point to the built `etc` directory for a fresh PX4 working directory, not its parent `rootfs` state directory. The harness creates a separate loopback memory API and gateway port, records PCAP/raw frames/readbacks/logs, and cleans process groups.

## What remains open

An older v1.15.4 smoke test and a v1.17.0 binary run using inherited older startup defaults were superseded, not counted as final release acceptance. An initial exact-startup attempt failed because the ROMFS root pointed at the wrong directory; its failed result remains under `artifacts/px4-v1.17-exact-api/`. The corrected final run above is the accepted passive result.

No selected-airframe/Gazebo flight test, signed-sender/replay validation, RC/GCS/offboard/battery/GPS/EKF/geofence failsafe execution, hardware, bench, HIL or flight validation passed. Passive firmware stoppage tests the bridge's feed-loss behavior, not an autopilot failsafe response. Continue with the [aircraft-specific acceptance gates](../flight-readiness.md).
