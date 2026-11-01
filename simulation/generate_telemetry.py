"""Offline synthetic telemetry only; no network or hardware access."""
import argparse
from datetime import datetime, timedelta, timezone
import json
import re

ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
START = datetime(2026, 1, 1, tzinfo=timezone.utc)


def generate_samples(count=5, aircraft_id="sim-ucas-001"):
    if isinstance(count, bool) or not isinstance(count, int) or count < 1:
        raise ValueError("count must be a positive integer")
    if not isinstance(aircraft_id, str) or not ID_PATTERN.fullmatch(aircraft_id):
        raise ValueError("aircraft ID must match the v1 identifier contract")
    for sequence in range(count):
        stamp = (START + timedelta(seconds=sequence)).isoformat().replace("+00:00", "Z")
        yield {
            "schema_version": "1.0",
            "aircraft_id": aircraft_id,
            "timestamp": stamp,
            "received_at": stamp,
            "sequence": sequence,
            "source": "simulated",
            "health": {
                "battery_voltage_v": round(12.4 - (sequence % 10) * 0.02, 2),
                "battery_percent": 95 - (sequence % 10),
                "link_quality_percent": 100,
                "temperature_c": 24,
                "status": "nominal",
            },
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--count", type=int, default=5)
    parser.add_argument("--aircraft-id", default="sim-ucas-001")
    args = parser.parse_args()
    if args.count < 1:
        parser.error("--count must be a positive integer")
    if not ID_PATTERN.fullmatch(args.aircraft_id):
        parser.error("--aircraft-id must match the v1 identifier contract")
    for sample in generate_samples(args.count, args.aircraft_id):
        print(json.dumps(sample, sort_keys=True))


if __name__ == "__main__":
    main()
