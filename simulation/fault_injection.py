"""Seeded, synthetic-only Warden-TH telemetry fault generator.

No files, network sources, private logs, hardware, or flight runtime are read.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
import math
import random
from typing import Any, Iterator

GENERATOR_VERSION = "warden-th-synthetic-v1"
WINDOW_SECONDS = 120
SAMPLE_RATE_HZ = 2
WINDOW_STEPS = WINDOW_SECONDS * SAMPLE_RATE_HZ
FAULT_ONSET_INDEX = 120
SCENARIOS = (
    "nominal",
    "battery_sag",
    "thermal_ramp",
    "link_degradation",
    "gps_jump",
    "attitude_oscillation",
    "stuck_sensor",
    "unexpected_mode_change",
    "low_presence",
)
LABELS: dict[str, tuple[str, ...]] = {
    "nominal": (),
    "battery_sag": ("power",),
    "thermal_ramp": ("power",),
    "link_degradation": ("link",),
    "gps_jump": ("navigation",),
    "attitude_oscillation": ("attitude",),
    "stuck_sensor": ("power",),
    "unexpected_mode_change": ("autopilot",),
    "low_presence": (),
}
KNOWN_AIRFRAME_CLASSES = ("multicopter-light", "multicopter-heavy", "fixed-wing-lab")
START = datetime(2026, 1, 1, tzinfo=timezone.utc)


def generate_window(
    scenario: str = "nominal",
    *,
    seed: int = 0,
    start: datetime = START,
    aircraft_id: str = "sim-ucas-th-001",
    trust: str = "signature-verified",
    airframe_class: str = "multicopter-light",
    sample_count: int = WINDOW_STEPS,
    fault_onset_index: int = FAULT_ONSET_INDEX,
) -> list[dict[str, Any]]:
    """Generate a reproducible 2-Hz sequence; the standard demo is exactly 240 samples."""
    if scenario not in SCENARIOS:
        raise ValueError(f"scenario must be one of {', '.join(SCENARIOS)}")
    if isinstance(seed, bool) or not isinstance(seed, int):
        raise ValueError("seed must be an integer")
    if isinstance(sample_count, bool) or not isinstance(sample_count, int) or not WINDOW_STEPS <= sample_count <= 2400:
        raise ValueError("sample_count must be an integer from 240 to 2400")
    if isinstance(fault_onset_index, bool) or not isinstance(fault_onset_index, int) or not 0 <= fault_onset_index < sample_count:
        raise ValueError("fault_onset_index must point inside the generated sequence")
    if start.tzinfo is None:
        raise ValueError("start must be timezone-aware")
    if trust not in {"signature-verified", "untrusted"}:
        raise ValueError("trust must be signature-verified or untrusted")
    if airframe_class not in KNOWN_AIRFRAME_CLASSES:
        raise ValueError("airframe_class must be a known synthetic test class")
    if not aircraft_id or len(aircraft_id) > 64 or not aircraft_id[0].isalnum() or any(
        not (char.isalnum() or char in "_-") for char in aircraft_id
    ):
        raise ValueError("aircraft_id must use the telemetry identifier alphabet")

    rng = random.Random(seed)
    discharge_rate = rng.uniform(0.010, 0.030)
    start = start.astimezone(timezone.utc)
    samples: list[dict[str, Any]] = []
    stuck_voltage: float | None = None
    sequence = 0
    previous_mode = 0
    for index in range(sample_count):
        elapsed = index / SAMPLE_RATE_HZ
        timestamp = (start + timedelta(seconds=elapsed)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        noisy = lambda scale: rng.uniform(-scale, scale)
        voltage = 16.8 - 0.003 * elapsed + noisy(0.001)
        battery_percent = 90.0 - discharge_rate * elapsed + noisy(0.04)
        temperature = 25.0 + 0.01 * elapsed + noisy(0.05)
        link_quality = 98.0 + noisy(0.4)
        heartbeat_age = max(0.0, 0.08 + noisy(0.025))
        latitude = 0.0 + (0.00000008 * elapsed)
        longitude = 0.0 + (0.00000008 * elapsed)
        altitude = 100.0 + 0.2 * math.sin(elapsed / 8.0)
        relative_altitude = 20.0 + 0.2 * math.sin(elapsed / 8.0)
        vx, vy, vz = 0.18, 0.18, 0.02
        roll = 0.015 * math.sin(elapsed / 3.0) + noisy(0.003)
        pitch = 0.012 * math.cos(elapsed / 3.5) + noisy(0.003)
        yaw = (0.05 + 0.002 * elapsed) % (2 * math.pi)
        fix_type, satellites, custom_mode, system_status = 3, 12, 0, 4
        if LABELS[scenario] and index >= fault_onset_index:
            since_onset = elapsed - fault_onset_index / SAMPLE_RATE_HZ
            if scenario == "battery_sag":
                voltage -= 0.018 * since_onset
                # Percent deliberately lags the injected voltage sag.
            elif scenario == "thermal_ramp":
                temperature += 0.035 * since_onset
            elif scenario == "link_degradation":
                link_quality = max(8.0, 98.0 - 0.72 * since_onset + noisy(1.0))
                heartbeat_age = min(12.0, 0.08 + 0.035 * since_onset + abs(noisy(0.4)))
            elif scenario == "gps_jump":
                latitude += 0.00024
                fix_type, satellites = 2, 5
            elif scenario == "attitude_oscillation":
                roll += 0.28 * math.sin(2 * math.pi * 0.7 * elapsed)
                pitch += 0.22 * math.sin(2 * math.pi * 0.65 * elapsed + 0.3)
            elif scenario == "stuck_sensor":
                if stuck_voltage is None:
                    stuck_voltage = voltage
                voltage = stuck_voltage
            elif scenario == "unexpected_mode_change":
                custom_mode, system_status = 5, 5

        if scenario == "link_degradation" and index >= fault_onset_index and (index - fault_onset_index) % 24 == 0:
            sequence += 2  # deliberate sequence gaps, not lost sample rows
        current_sequence = sequence
        sequence += 1
        mode_change = custom_mode != previous_mode
        previous_mode = custom_mode
        security_trust = "untrusted" if trust == "untrusted" else "signature-verified"
        security_policy = "unauthenticated" if trust == "untrusted" else "required-signed"
        sample: dict[str, Any] = {
            "schema_version": "1.1",
            "aircraft_id": aircraft_id,
            "timestamp": timestamp,
            "received_at": timestamp,
            "sequence": current_sequence,
            "source": "simulated",
            "health": {
                "battery_voltage_v": round(voltage, 5),
                "battery_percent": round(min(100.0, max(0.0, battery_percent)), 5),
                "link_quality_percent": round(min(100.0, max(0.0, link_quality)), 5),
                "temperature_c": round(temperature, 5),
                "status": "nominal",
            },
            "autopilot": {
                "family": "px4", "system_id": 1, "component_id": 1, "vehicle_type": 2,
                "armed": False, "base_mode": 0, "custom_mode": custom_mode,
                "system_status": system_status, "heartbeat_age_seconds": round(heartbeat_age, 5),
            },
            "position": {
                "latitude_deg": latitude, "longitude_deg": longitude,
                "altitude_msl_m": altitude, "relative_altitude_m": relative_altitude,
                "vx_m_s": vx, "vy_m_s": vy, "vz_m_s": vz,
                "heading_deg": (math.degrees(yaw) % 360), "age_seconds": 0.1,
            },
            "attitude": {
                "roll_rad": roll, "pitch_rad": pitch, "yaw_rad": yaw, "age_seconds": 0.1,
            },
            "gps": {"fix_type": fix_type, "satellites_visible": satellites, "age_seconds": 0.1},
            "session_id": f"{seed & 0xffffffff:08x}" * 4,
            "observation": {
                "heartbeat_timeout_seconds": 2.0, "field_timeout_seconds": 2.0,
                "battery_age_seconds": 0.1, "system_status_age_seconds": 0.1,
            },
            "ingress_security": {
                "policy": security_policy, "telemetry_trust": security_trust,
                "flight_ready": False, "counters": {},
            },
            # Training metadata is simulator-only, not a telemetry contract field.
            "_synthetic_metadata": {
                "generator_version": GENERATOR_VERSION,
                "scenario": scenario,
                "fault_labels": list(LABELS[scenario]),
                "fault_onset_timestamp": (
                    (start + timedelta(seconds=fault_onset_index / SAMPLE_RATE_HZ)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
                    if LABELS[scenario] else None
                ),
                "airframe_class": airframe_class,
                "battery_discharge_pct_per_second": discharge_rate,
            },
        }
        if scenario == "low_presence":
            sample["health"]["battery_voltage_v"] = None
            sample["health"]["battery_percent"] = None
            sample["health"]["link_quality_percent"] = None
            sample["health"].pop("temperature_c")
            for key in ("position", "attitude", "gps"):
                sample.pop(key)
        samples.append(sample)
    return samples


def iter_dataset(seeds: list[int], scenarios: tuple[str, ...] = SCENARIOS) -> Iterator[tuple[list[dict[str, Any]], dict[str, Any]]]:
    """Yield reproducible samples and labels for training/evaluation."""
    for seed in seeds:
        for scenario in scenarios:
            samples = generate_window(scenario, seed=seed)
            yield samples, {
                "seed": seed,
                "scenario": scenario,
                "labels": list(LABELS[scenario]),
                "fault_onset_index": FAULT_ONSET_INDEX if LABELS[scenario] else None,
                "generator_version": GENERATOR_VERSION,
                "airframe_class": "multicopter-light",
                "trust": "untrusted" if scenario == "untrusted" else "signature-verified",
            }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", choices=SCENARIOS, default="nominal")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--trust", choices=("signature-verified", "untrusted"), default="signature-verified")
    args = parser.parse_args()
    for sample in generate_window(args.scenario, seed=args.seed, trust=args.trust):
        sample.pop("_synthetic_metadata", None)
        print(json.dumps(sample, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
