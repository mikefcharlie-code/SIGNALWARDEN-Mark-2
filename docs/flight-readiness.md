# Aircraft acceptance: not yet flight-ready

The bridge is a **receive-only telemetry observer** for PX4 and ArduPilot, not a flight controller. Passing software checks or running simulator firmware does not approve a real aircraft for flight. PR #12 stays draft, unmerged and stacked on PR #11. Both autopilot alternatives remain supported; neither has been selected for the owner's aircraft.

## What the bridge can and cannot tell an operator

A fresh heartbeat permits telemetry publication. Heartbeat expiry suppresses new snapshots; recovery starts a new session and clears old sensor observations. Disconnect/reconnect and observed backwards boot-clock boundaries also invalidate cached state. Fields age independently. A latest-state publisher coalesces pending work instead of retaining an unbounded backlog. Already in-flight output cannot be recalled: downstream consumers still need receipt/snapshot-age checks.

Explicit heartbeat `MAV_STATE` critical (5), emergency (6), power-off (7) and flight-termination (8) reports produce `health.status=warning`. A fresh selected battery's low/critical/emergency/failed/unhealthy charge state (2–6), or nonzero reported battery fault bitmap, also warns. The raw heartbeat state remains in `autopilot.system_status`. These rules follow the [MAVLink common definitions](https://mavlink.io/en/messages/common.html). A normal heartbeat, absent battery extensions, or warning clearance produces **unknown**, not a declaration of healthy or safe to arm. Battery warnings expire with that battery observation; a continuing critical heartbeat still warns.

`warning` is intentionally a coarse existing schema value, not an emergency severity classifier or annunciator. Unknown enum values remain raw/unknown rather than guessed. No battery voltage threshold is inferred, no failsafe is commanded, and no warning proves that RTL/land/termination actually executed. Firmware-specific causes, intended response and response completion require autopilot logs and a supported GCS. The web UI is still synthetic, not an aircraft safety display.

## Telemetry trust is still an open gate

The local publisher token authorizes an API writer; it does **not** authenticate the aircraft. The receiver now offers [strict signed ingress with durable replay rejection](telemetry-ingress-security.md), protected keys/state and synthetic signing regressions, but **neither retained firmware pipeline has provisioned-key signing acceptance**. Both actual pinned firmware captures are unsigned and remain untrusted. Incorrect signatures/unsigned frames are rejected in required-signed mode, including HEARTBEAT. IDs and family are filters, not unique physical identity. An unsigned lab exception must be explicit; untrusted networks require reviewed authenticated, integrity-protected, encrypted transport with replay protection and scoped endpoints, not just a free-text transport reference. API signature/transport assertions require a bearer-authenticated publisher with a server-authorized ingress policy. No trust label makes this an authoritative aircraft safety display, and all latest views retain `flight_ready=false`.

Repeated same-type `time_boot_ms` values are ignored without refreshing sensor age; decreasing values invalidate the session until another heartbeat. In unauthenticated mode this remains only a limited duplicate-age defense, not general replay protection. Required-signed mode independently verifies MACs and strict per-link timestamp increases with a +/-60-second trusted-clock window and fsynced replay state across reconnects/process restarts. This prevents reaccepting already-accepted signed frames under an intact ledger, not first-seen delayed traffic within the window, compromised-key traffic, storage rollback, external buffering, or unknown actual measurement ages. Firmware signing provisioning, owner-specific transport/key/clock/state lifecycle, flood/load/power-loss behavior and physical validation remain open deployment gates.

## Owner information needed before bench connection

Record these for **each aircraft and each chosen firmware stack**; do not fill gaps with the Pixhawk 6C reference example:

- Flight-controller manufacturer, exact model, board/hardware revision and serial identifier; carrier board and companion hardware/OS/power arrangement.
- Airframe/frame geometry, motor/ESC/propeller models, motor order and rotation, battery chemistry/cell count/capacity, power module and measured sensor calibration.
- Exact PX4 or ArduPilot firmware artifact, version, source/tag and SHA-256; vehicle target and complete exported parameter set. If testing both stacks on one controller, keep separate configurations and acceptance records.
- Telemetry wiring pinout, voltage levels/common ground, port mapping, baud/flow control, companion device path, router/radio topology and dedicated receive-only destination. Serial DTR behavior must be assessed with props removed.
- Aircraft inventory ID, expected MAVLink system/component IDs, selected battery ID, intended stream messages/rates, timeout settings and trusted sender/routing/signing policy. System IDs are not sender authentication.
- RC/manual takeover, kill/disarm controls, geofence and return/landing policy, RC/GCS/data-link/offboard/GPS/EKF/battery failsafe parameters, home/altitude reference and legal operating location.
- Named qualified pilot/safety observer, test authority, permitted envelope/weather, exclusion zone, abort criteria and recovery/rollback plan.

## Required staged physical evidence

1. **SITL acceptance for the exact intended firmware and vehicle.** Use actual firmware plus the appropriate physics model. Record normal telemetry, complete loss and recovery, delayed/duplicate/out-of-order traffic, process restart and slow/API outage behavior. In a separate supported simulator control path, exercise configured RC/GCS/offboard loss, battery, GPS/EKF and geofence responses that apply. Record requested response, observed mode/state, trajectory and completion from firmware logs. The bridge must remain receive-only throughout. A firmware-only telemetry smoke test cannot satisfy these dynamics gates.
2. **Isolated, propeller-removed bench acceptance.** Verify power, pinout and levels before connection. Confirm exact identities, streams, units and independent instrument comparisons; check sensor/battery IDs, reboot/disconnect recovery, stale detection, API credential revocation and slow/unavailable sinks. Prove no MAVLink transmit from the bridge with a capture. Confirm bridge removal/outage does not create or defeat autopilot control authority. Do not disable safety or signing to accommodate the adapter.
3. **Hardware-in-loop or equivalent justified aircraft integration acceptance.** Validate controller timing, sensor/actuator interfaces and the configured fault responses on the actual board/firmware. Preserve parameters/logs and record test-specific limitations. SITL alone does not verify hardware behavior.
4. **Supervised restricted flight acceptance.** Only after the prior gates and the pilot's independent preflight approval: staged hover/manual takeover, telemetry comparison, controlled link-loss/recovery and applicable failsafe checks under an approved safe test plan. Do not induce hazardous failure modes aloft merely to complete a checklist; use bench/HIL evidence and pilot-approved methods.

For every gate save the aircraft/configuration identifiers, operator, exact command/test case, expected result, measured result, logs/captures, deviations and reviewer sign-off. A failed or untested gate remains open. A passing result on one firmware, board or airframe does not approve the other stack or another aircraft.

## Related evidence and limitations

See [bridge setup and freshness boundaries](aircraft-integration.md), [reference multicopter—not owner selection](reference-multicopter-configuration.md), and the per-stack reports in `docs/validation/` when present. Synthetic wire tests and software regression totals must be labeled separately from actual simulator firmware, physics-backed failsafe, bench, HIL and flight evidence.
