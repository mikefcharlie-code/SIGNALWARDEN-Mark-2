# Multicopter reference configuration: Pixhawk 6C

This project uses **Holybro Pixhawk 6C + a quadrotor** as a reference for planning the receive-only MAVLink integration with **either PX4 1.17.0 or ArduCopter 4.7.2**. These are alternative firmware stacks, not firmware to run simultaneously on one controller. This is not the owner's confirmed hardware, a complete bill of materials, an installable parameter set, or a flight-readiness claim.

The [machine-readable reference](../hardware/reference-multicopter.json) records the same baseline and unresolved choices. It is documentation data only: no gateway, API, firmware installer, or parameter loader consumes it. It does not register an aircraft or change runtime defaults. Facts were checked against the linked official sources on October 22, 2026; upstream documentation and stable channels can change.

## Why this board and these versions

| Item | Reference choice | Evidence and limit |
| --- | --- | --- |
| Controller | Holybro Pixhawk 6C | [PX4 lists support by its maintenance and test teams](https://docs.px4.io/main/en/flight_controller/pixhawk6c); [ArduPilot documents the board and Copter setup](https://ardupilot.org/copter/docs/common-holybro-pixhawk6C.html). Upstream board support does not validate this application. |
| Vehicle | Multicopter, quadrotor | A project reference choice, not a detected or confirmed owner airframe. Geometry, motors, ESCs, power, sensors, RC, and mounting remain unspecified. Fixed-wing and VTOL are outside this baseline. |
| PX4 alternative | 1.17.0 | The [official GitHub release](https://github.com/PX4/PX4-Autopilot/releases/tag/v1.17.0) is a published, non-draft, non-prerelease release and includes the `px4_fmu-v6c_default.px4` artifact. This identifies the reference artifact; it is not an installation, checksum verification, or project test. |
| ArduPilot alternative | ArduCopter 4.7.2 | The [official announcement](https://discuss.ardupilot.org/t/copter-4-7-2-released/145800) calls it stable/official for multicopters and traditional helicopters, and the [official stable Pixhawk6C version file](https://firmware.ardupilot.org/Copter/stable/Pixhawk6C/firmware-version.txt) reports `4.7.2-FIRMWARE_VERSION_TYPE_OFFICIAL`. Neither is project test evidence. |

PX4's [official release asset](https://github.com/PX4/PX4-Autopilot/releases/download/v1.17.0/px4_fmu-v6c_default.px4) is `px4_fmu-v6c_default.px4`; ArduPilot's official stable version file is for the `Pixhawk6C` folder. Do not substitute a 6C Mini, 6X, or specialized build without reviewing that hardware separately. No firmware was downloaded, flashed, or upgraded for this reference. Review the full release and upgrade warnings in the linked sources before choosing an artifact.

## TELEM2 is the reference connection, not verified wiring

[PX4 serial configuration](https://docs.px4.io/main/en/peripherals/serial_configuration) documents TELEM2 as the default wired onboard/companion-computer MAVLink port. Its [Pixhawk 6C mapping](https://docs.px4.io/main/en/flight_controller/pixhawk6c) identifies **UART5, `/dev/ttyS3`, TELEM2**. The `/dev/ttyS3` name is inside the flight controller; it is **not** the companion computer's device path.

[ArduPilot's Pixhawk 6C mapping](https://ardupilot.org/copter/docs/common-holybro-pixhawk6C.html) identifies **SERIAL2 → UART5 → TELEM2**, with RTS/CTS pins. Pin availability does not establish that flow control is enabled, wired, or supported by the project connection path.

**Pixhawk 6C is a cross-stack reference example, not confirmed owner hardware.** Inspect every setting below against the specific board revision, installed firmware and saved parameters. The linked PX4 `main` and ArduPilot documentation can describe newer firmware than the reference versions. These are separate documentation profiles, not an installable parameter file, automatic configuration or commissioning approval. Actual hardware baud and flow control remain unset in the JSON's `flight_controller` record.

### PX4 TELEM2 profile example

The [official PX4 MAVLink peripherals guide](https://docs.px4.io/main/en/peripherals/mavlink_peripherals) describes these usual companion-port defaults, not guaranteed values on a particular board:

| Parameter | Reference example | Meaning / caveat |
| --- | --- | --- |
| `MAV_1_CONFIG` | `TELEM 2` | Assign MAVLink instance 1 to TELEM2; instance numbers are not physical UART numbers. Check port ownership/conflicts. |
| `MAV_1_MODE` | `Onboard` | Companion stream profile; verify actual messages and rates. |
| `MAV_1_RATE` | `0` | Half the theoretical maximum data rate in **bytes/second**, not zero traffic and not the serial baud setting. |
| `MAV_1_FORWARD` | `Disabled` | Do not forward traffic received on this instance to other MAVLink interfaces. This is not physical one-way isolation. |
| `SER_TEL2_BAUD` | `921600` | Serial baud; companion/router must explicitly match. Hardware, adapter and link capacity may require another mutually supported rate. |

Follow the [PX4 serial configuration sequence](https://docs.px4.io/main/en/peripherals/serial_configuration): select the port, reboot to expose its additional parameters, then configure baud and stream/profile settings. Reboot where required after parameter changes and inspect the resulting values. Review `MAV_1_FLOW_CTRL` against that firmware and the actual wiring; the profile above makes no RTS/CTS selection. Do not infer enabled flow control from the available pins.

### ArduCopter TELEM2 profile example

For this board only, [ArduPilot maps `SERIAL2` to UART5/TELEM2](https://ardupilot.org/copter/docs/common-holybro-pixhawk6C.html). [Logical serial numbering is board-specific](https://ardupilot.org/copter/docs/common-serial-options.html); do not copy this mapping onto another controller.

| Parameter | Reference example | Meaning / caveat |
| --- | --- | --- |
| `SERIAL2_PROTOCOL` | `2` | Explicitly select MAVLink2. The [telemetry setup guide](https://ardupilot.org/copter/docs/common-telemetry-port-setup.html) describes MAVLink1 as the general telemetry default; inspect the actual firmware rather than assuming MAVLink2. |
| `SERIAL2_BAUD` | `115` (115200 baud) | Deliberately chosen illustration, **not an asserted ArduCopter default**. Set the companion/router to 115200 too. The [official parameter reference](https://ardupilot.org/copter/docs/parameters.html#serial2-baud-telemetry-2-baud-rate) lists encoded values (`115` → 115200, `921` → 921600); confirm the installed firmware's metadata. |
| `BRD_SER2_RTSCTS` | `0` (Disabled), for the illustrated no-flow-control link only | The [telemetry setup guide](https://ardupilot.org/copter/docs/common-telemetry-port-setup.html) identifies this board flow-control parameter. The [parameter reference](https://ardupilot.org/copter/docs/parameters.html#brd-ser2-rtscts-serial-2-flow-control) lists `0` Disabled, `1` Enabled and `2` Auto. Enabled/Auto are not substitutes for reviewed wiring and compatible settings at both endpoints. |

Do not assume ArduCopter's baud default equals PX4's 921600 example or the gateway CLI's 115200 default. Explicitly match the two endpoints and reboot where the firmware metadata requires it (including protocol/flow-control changes), then inspect the saved values. MAVLink2 selection alone does **not** enable signing or satisfy the [ingress security policy](telemetry-ingress-security.md). The receiver does not request streams; review firmware-side stream configuration separately, and do not assume `SRx` stream indices equal `SERIALx` port numbers.

### TELEM2 pinout and wiring caveats

The [manufacturer's Pixhawk 6C ports page](https://docs.holybro.com/autopilot/pixhawk-6c/pixhawk-6c-ports) lists this six-pin TELEM2 connector. Directions are from the flight controller's perspective; verify connector orientation against its diagram, not wire color or an assumed viewing direction.

| Pin | Flight-controller signal | Voltage | Connection caveat |
| --- | --- | --- | --- |
| 1 | VCC | +5 V | Not UART logic voltage; leave unconnected unless the power design has been verified. |
| 2 | UART5 TX (out) | 3.3 V | To companion RX. |
| 3 | UART5 RX (in) | 3.3 V | From companion TX only if a separately reviewed connection requires that path; not needed for telemetry-only receive wiring. |
| 4 | UART5 CTS (in) | 3.3 V | From companion RTS only when both endpoints support and are configured for hardware flow control. |
| 5 | UART5 RTS (out) | 3.3 V | To companion CTS under that same condition. |
| 6 | GND | GND | Common signal ground with the companion/adapter. |

**Verify companion UART voltage compatibility and power/current requirements before connecting VCC. Never assume the +5 V pin can power an onboard computer.** Check the specific board revision's supply limits, companion startup/peak demand, back-powering risk and approved power arrangement. Do not connect incompatible 5 V logic or RS-232 voltage levels to the 3.3 V UART signals. Match **TX ↔ RX and common GND**, not TX-to-TX. Use **CTS/RTS only when both sides are configured** and correctly cross-wired; otherwise leave those signals disconnected and explicitly review a no-flow-control configuration at both ends. A generic bidirectional UART diagram does not authorize adding a companion transmit path to this receive-only bridge.

Before any physical connection, review the actual board revision, cable/adapter, grounding, power budget, port ownership, baud and flow-control policy. Record the companion's device path separately. The gateway exposes `--baud` but no RTS/CTS configuration flag; these firmware examples do not add flow-control support or prove serial compatibility. No owner's hardware or firmware parameters were changed for this update.

Prefer a reviewed, isolated receive-only router for bench observation. The adapter sends no MAVLink messages, but opening a serial device can still have DTR side effects. No claim of electrical one-way isolation is made. Keep propellers removed during bench work, preserve autopilot safety controls and signing policy, and commission through a supported GCS.

## Use the existing observer without changing its authority

Follow [aircraft integration](aircraft-integration.md) for dependencies, inventory registration, scoped API publisher authentication, and gateway usage. The JSON reference contains **simulated UDP observation examples** compatible with the existing CLI, not a new launch mechanism. The listed system/component IDs (`1`/`1`) and aircraft IDs are placeholders and must be checked against the actual simulator configuration. The examples print JSON to stdout and do not register inventory or post to the API.

For the PX4 example, start and configure PX4 quadrotor SITL separately and route observations to a dedicated loopback port 14540. For ArduPilot, start ArduCopter quadrotor SITL separately and configure a dedicated MAVProxy/router output to loopback port 14551. These ports belong to their separate gateway listeners, not to a shared GCS socket. A quadrotor SITL model is not physical Pixhawk 6C validation. No simulator was installed or run for this reference.

The observer still requires an already active stream. It does not send heartbeats, request rates, write parameters, upload missions, arm, take off, change modes, or send setpoints. The supported observations remain `HEARTBEAT`, `SYS_STATUS`, `BATTERY_STATUS`, `GLOBAL_POSITION_INT`, `ATTITUDE`, and `GPS_RAW_INT`; missing or stale observations do not become known health. A publisher token authenticates the local API publisher, not the aircraft sender, and the gateway does not verify MAVLink signatures.

## Evidence required before advancing

All gates below are **not run** for both alternatives. Existing unit/wire tests use synthetic MAVLink producers; passing them is not running autopilot firmware.

| Gate | Required record before claiming a pass |
| --- | --- |
| SITL, separately for PX4 and ArduCopter | Exact firmware tag/commit and simulator model, routing and IDs, received messages, SI mapping, stale/heartbeat-loss and reconnect/session behavior, no outbound MAVLink packets, and repeatable logs. Use `source=simulated`. |
| Isolated bench, propellers removed | Owner-confirmed board/revision, exact firmware artifact/checksum, backed-up parameter revision, approved wiring/voltage/baud/flow-control review, observed streams, receive-only behavior and rollback record. Use separate real-aircraft inventory and explicit authenticated `source=aircraft` publishing if posting to the API. |
| HIL | Approved setup and scenario matrix for both intended configurations, fault/recovery observations and saved evidence. Never relabel synthetic packet tests as HIL. |
| Supervised flight | Approved operating/test plan, qualified supervision, completed prior gates, safety/failsafe and regulatory checks, controlled results, and stop/rollback criteria. This document authorizes no flight. |

Before the first physical gate, the owner must confirm the actual controller/revision, airframe geometry and propulsion/power components, selected firmware alternative and exact artifact, companion/adapter and wiring, security policy, and commissioning owner. Until then the reference stays separate from actual inventory, and no SITL, bench, HIL, or flight gate is passed.
