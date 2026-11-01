#!/usr/bin/env python3
"""Explicitly process a user-provided local ground-vehicle LiDAR scan folder."""
from __future__ import annotations

import argparse
import socket
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.ground_vehicle_odometry import GroundOdometryError, run_sequence

_ORIGINAL_SOCKET = socket.socket


def _disable_network() -> None:
    """Fail closed for Python socket/DNS access in this one-shot CLI process."""
    class OfflineSocket(_ORIGINAL_SOCKET):
        def connect(self, *_args: Any, **_kwargs: Any) -> Any:
            raise RuntimeError("network access is disabled for local ground-vehicle odometry")

        def connect_ex(self, *_args: Any, **_kwargs: Any) -> Any:
            raise RuntimeError("network access is disabled for local ground-vehicle odometry")

        def sendto(self, *_args: Any, **_kwargs: Any) -> Any:
            raise RuntimeError("network access is disabled for local ground-vehicle odometry")

        def sendmsg(self, *_args: Any, **_kwargs: Any) -> Any:
            raise RuntimeError("network access is disabled for local ground-vehicle odometry")

    def denied(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("network access is disabled for local ground-vehicle odometry")

    socket.socket = OfflineSocket  # type: ignore[assignment]
    socket.create_connection = denied  # type: ignore[assignment]
    for name in ("getaddrinfo", "gethostbyname", "gethostbyname_ex", "getnameinfo"):
        if hasattr(socket, name):
            setattr(socket, name, denied)

    def audit(event: str, _args: Any) -> None:
        if event in {"socket.connect", "socket.sendto", "socket.sendmsg", "socket.getaddrinfo", "socket.gethostbyname"}:
            raise RuntimeError("network access is disabled for local ground-vehicle odometry")

    sys.addaudithook(audit)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Estimate relative ground-vehicle LiDAR motion from explicitly selected local KITTI-style .bin scans. "
            "This is offline analysis only; it is not connected to UAV navigation or control."
        )
    )
    parser.add_argument("--input", required=True, type=Path, help="local sequence folder, or its velodyne/ scan folder")
    parser.add_argument("--output", required=True, type=Path, help="explicit local JSON report path")
    parser.add_argument("--overwrite", action="store_true", help="replace an existing report at the explicitly selected output path")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    _disable_network()
    try:
        report = run_sequence(args.input, args.output, overwrite=args.overwrite)
    except (GroundOdometryError, OSError, RuntimeError) as error:
        print(f"ground-vehicle odometry unavailable: {error}", file=sys.stderr)
        return 2
    print(
        f"Wrote {report['status']} report for {report['input']['scan_count']} local scans to "
        f"{args.output.expanduser().resolve()}"
    )
    print("Relative estimate only; not ground truth, UAV navigation data, aircraft control, or mission input.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
