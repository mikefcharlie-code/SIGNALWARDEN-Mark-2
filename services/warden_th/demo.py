"""Synthetic-only Warden-TH demo assembly. Never reads stores or operational logs."""
from __future__ import annotations

from collections.abc import Mapping
import json
from pathlib import Path
from typing import Any

from simulation.fault_injection import GENERATOR_VERSION, LABELS, SCENARIOS, generate_window
from .baseline import assess_window
from .events import build_advisory_events
from .window import build_window, compact_window

_ARTIFACT_MANIFEST = Path(__file__).resolve().parents[2] / "configs" / "warden-th-artifact.json"


def _prototype_evaluation() -> dict[str, Any]:
    try:
        document = json.loads(_ARTIFACT_MANIFEST.read_text(encoding="utf-8"))
        evaluation = document.get("synthetic_evaluation")
        return evaluation if isinstance(evaluation, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def build_demo(scenario: str = "nominal", seed: int = 0, trust: str = "signature-verified") -> dict[str, Any]:
    if scenario not in SCENARIOS:
        raise ValueError("unsupported synthetic Warden-TH scenario")
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 1_000_000:
        raise ValueError("seed must be an integer from 0 to 1000000")
    samples = generate_window(scenario, seed=seed, trust=trust)
    window = build_window(samples)
    metadata = samples[-1].get("_synthetic_metadata", {})
    airframe_class = metadata.get("airframe_class") if isinstance(metadata, Mapping) else None
    baseline = assess_window(window, airframe_class=airframe_class, samples=samples)
    series = []
    for sample in samples:
        health = sample.get("health", {})
        series.append({
            "timestamp": sample["timestamp"],
            "sequence": sample["sequence"],
            "battery_percent": health.get("battery_percent"),
            "battery_voltage_v": health.get("battery_voltage_v"),
            "link_quality_percent": health.get("link_quality_percent"),
        })
    onset = samples[120]["timestamp"] if LABELS[scenario] else None
    event_window = {
        "start": onset or window["window_start"],
        "end": window["window_end"],
        "start_index": 120 if LABELS[scenario] else 0,
        "end_index": 239,
        "fault_labels": list(LABELS[scenario]),
    }
    events = build_advisory_events(
        aircraft_id="sim-ucas-th-001", scenario=scenario, seed=seed,
        occurred_at=onset or window["window_end"], received_at=window["window_end"],
        baseline=baseline, trust=window["telemetry_trust"],
    )
    prototype_evaluation = _prototype_evaluation()
    inference_window = compact_window(window)
    inference_window.update({
        "scenario": scenario,
        "seed": seed,
        "window_start": window["window_start"],
        "window_end": window["window_end"],
        "baseline_findings": [
            {key: finding.get(key) for key in ("subsystem", "evidence_channels", "sequence_from", "sequence_to")}
            for finding in baseline["findings"]
        ],
    })
    return {
        "schema_version": "1.0",
        "model_id": "warden-th",
        "generator_version": GENERATOR_VERSION,
        "scenario": scenario,
        "seed": seed,
        "synthetic_only": True,
        "airframe_class": airframe_class,
        "fault_labels": list(LABELS[scenario]),
        "fault_onset_timestamp": onset,
        "sample_rate_hz": window["sample_rate_hz"],
        "window_seconds": window["window_seconds"],
        "window_steps": window["window_steps"],
        "stride_seconds": window["stride_seconds"],
        "window_start": window["window_start"],
        "window_end": window["window_end"],
        "field_presence_ratio": window["field_presence_ratio"],
        "missing_steps": window["missing_steps"],
        "telemetry_trust": window["telemetry_trust"],
        "baseline": baseline,
        "learned_inference": {"status": "not_requested", "available": False,
                              "reason": "Use the explicit, authenticated local inference job; no fallback is run."},
        "inference_window": inference_window,
        "event_window": event_window,
        "advisory_events": events,
        "series": series,
        "prototype_evaluation": prototype_evaluation,
        "window": {key: value for key, value in window.items() if key != "rows"},
        "limitations": [
            "Entirely seeded synthetic data; no private or public flight logs were used.",
            "Synthetic training/evaluation does not establish field performance or operational calibration.",
            "The latest held-out synthetic stream-replay passes its configured prototype gates; this does not establish operational calibration or field performance.",
            "Advisory events are response-only projections, not canonical observations or persisted evidence.",
            "No model result is automatically routed to any command, mission, arming, or effector path.",
        ],
    }
