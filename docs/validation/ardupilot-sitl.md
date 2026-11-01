# ArduCopter 4.7.2: passive telemetry pipeline passed

**Genuine release firmware → receive-only gateway → isolated Management API passed. This is not flight readiness or autopilot failsafe validation.** The built-in quad SITL model stayed disarmed. No hardware was flashed or connected, and no control/arming commands were issued.

## Exact firmware and configuration

Official [ArduPilot source](https://github.com/ArduPilot/ardupilot/tree/Copter-4.7.2), tag `Copter-4.7.2`, commit `fb773567896014da007bca58358704d4a0d8516f`. Recursively initialized pinned submodules; built with `./waf configure --board sitl && ./waf copter -j8`. The binary identifies itself as `ArduCopter V4.7.2 (fb773567)`.

Binary SHA-256: `0c7e26db576c6fc0c742021e4b1c694a55fc7375bf4041b6a4696c665c53438b`.

The direct SITL binary used `-M quad`, a fresh wiped simulation EEPROM, the release's `Tools/autotest/default_params/copter.parm`, and the committed [passive observer rates](../../scripts/sitl/arducopter-4.7.2-observer.parm). Only telemetry stream defaults were added; no extra safety/failsafe parameters were weakened. SERIAL0 sent to loopback UDP 14581, base port 15760. Other simulator ports used their normal SITL defaults; they were not used for control and all processes were stopped afterward. This is not an aircraft parameter set.

## Captured result

[Machine-readable evidence and representative API readbacks](evidence/ardupilot-passive-pipeline.json) contain commands, firmware checksum, sessions and artifact hashes. Raw artifacts are in `artifacts/arducopter-4.7.2-api/`.

- 70 firmware UDP datagrams. Decoded supported messages: HEARTBEAT, SYS_STATUS, BATTERY_STATUS, ATTITUDE, GLOBAL_POSITION_INT and GPS_RAW_INT.
- All seven captured heartbeats were system/component 1/1 and disarmed; observed system states were boot/standby (1/3), not induced failsafe states.
- API samples advanced with `source=simulated`. A normal sample mapped 12.6 V / 100% and position/attitude/GPS sections. Initial position values were still zeros: these observations do **not** establish navigation readiness or accurate position.
- Firmware stop produced `connectivity=stale` and overall `freshness=stale` while snapshot age remained within its separate 30-second window. Effective heartbeat age at loss was about 3.70 seconds against a 2-second deadline; publication sequence then stopped advancing.
- Restart recovered under a different session. The first recovered API sample had unknown battery and no old position/attitude/GPS sections.
- Both relay observation and independent PCAP inspection found zero outbound UDP packets from the gateway port. Boot console text on SERIAL0 appeared as `BAD_DATA` and was ignored; unsupported ArduPilot dialect messages were not mapped. This was not a silent corruption claim.

## Reproduce after installing official SITL prerequisites

Use the official [Linux SITL setup](https://ardupilot.org/dev/docs/setting-up-sitl-on-linux.html) and [SITL testing guide](https://ardupilot.org/dev/docs/using-sitl-for-ardupilot-testing.html). Install this repository's development/aircraft dependencies and `tcpdump`; build the exact tag above. From this repository (adjust checkout paths; choose fresh output/work directories):

```bash
AP=/tmp/ucas-ardupilot-sitl
mkdir -p /tmp/arducopter-passive-work
.venv/bin/python scripts/validate_passive_pipeline.py --family ardupilot \
  --firmware-command-json "[\"$AP/build/sitl/bin/arducopter\",\"-w\",\"-M\",\"quad\",\"--base-port\",\"15760\",\"--serial0=udpclient:127.0.0.1:14581\",\"--defaults\",\"$AP/Tools/autotest/default_params/copter.parm,$PWD/scripts/sitl/arducopter-4.7.2-observer.parm\"]" \
  --firmware-cwd /tmp/arducopter-passive-work --ingress-port 14581 \
  --output "$PWD/artifacts/arducopter-passive-new" --capture
```

The harness starts its own loopback memory API, pre-registers a simulated aircraft, creates a dedicated gateway port, captures UDP traffic, saves actual API readbacks and cleans process groups. Captured default/observer parameter files and simulation EEPROM are retained with the local evidence bundle.

## What remains open

An earlier unpinned-source smoke run was superseded and is not counted as 4.7.2 acceptance. The release run did not command a mission, arm, fly, or induce/verify RC, GCS, offboard, battery, GPS/EKF or geofence failsafe actions. Physical serial/DTR effects, signed telemetry identity/general replay protection, bench, HIL and supervised aircraft flight remain unvalidated. Passive feed loss is not GCS-loss failsafe: the bridge never establishes a GCS heartbeat. Continue with the [aircraft-specific acceptance gates](../flight-readiness.md).
