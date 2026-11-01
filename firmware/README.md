# Firmware workstream — planning only

PX4 and ArduPilot are supported **protocol families** for the read-only MAVLink adapter. The non-authoritative [reference multicopter configuration](../docs/reference-multicopter-configuration.md) provides separate PX4 v1.17.0 and ArduCopter 4.7.2 alternatives for a Holybro Pixhawk 6C quadrotor using TELEM2; it is a reference baseline, not the owner’s firmware selection or validation evidence. Protocol compatibility is not hardware or firmware validation.

Before any bench or flight gate, record board and vehicle/frame model, autopilot firmware source and exact version/commit, configuration/parameter revision, MAVLink transport and signing policy, interface ownership, build/recovery instructions, and controlled-test evidence. Keep secrets outside Git. The management system does not implement stabilization, failsafes, mission execution, arming, takeoff, offboard control, or autonomous planning.

Validation is staged: simulated SITL, propeller-removed isolated bench, HIL, then supervised flight. The gateway must not be treated as making an arbitrary aircraft flight-ready; commission through a supported GCS and retain autopilot safety controls.
