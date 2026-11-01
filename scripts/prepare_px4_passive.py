#!/usr/bin/env python3
"""Prepare exact PX4 v1.17.0 POSIX startup for a passive loopback observer.

Preserves release simulation defaults without old-release parameter overrides.
Only replaces default MAVLink routing with one dedicated loopback endpoint and
adds read-only parameter output. Does not select/commission a flight airframe.
"""
import argparse
import subprocess
from pathlib import Path

EXPECTED = "d6f12ad1c4f70ad3230afd7d86e971421e02fef4"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--px4", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    commit = subprocess.check_output(["git", "-C", str(args.px4), "rev-parse", "HEAD"], text=True).strip()
    if commit != EXPECTED:
        parser.error(f"expected v1.17.0 commit {EXPECTED}, found {commit}")
    source = subprocess.check_output(["git", "-C", str(args.px4), "show",
                                      "HEAD:ROMFS/px4fmu_common/init.d-posix/rcS"], text=True)
    target = ". px4-rc.mavlink"
    if source.splitlines().count(target) != 1:
        parser.error("unexpected upstream MAVLink startup layout")
    source = source.replace(target, "# Default MAVLink routing replaced by passive loopback observer below.")
    source += """
# Validation-only loopback observer. No forwarding, arming or control commands.
mavlink start -x -u 14582 -o 14550 -t 127.0.0.1 -r 4000000 -m onboard
mavlink stream -r 1 -s HEARTBEAT -u 14582
mavlink stream -r 1 -s SYS_STATUS -u 14582
mavlink stream -r 1 -s ATTITUDE -u 14582
mavlink stream -r 1 -s GLOBAL_POSITION_INT -u 14582
mavlink stream -r 1 -s GPS_RAW_INT -u 14582
mavlink stream -r 1 -s BATTERY_STATUS -u 14582
# Read-only exact configured parameter listing, retained in firmware.log.
param show -a
"""
    args.output.write_text(source)
    print(args.output)


if __name__ == "__main__":
    main()
