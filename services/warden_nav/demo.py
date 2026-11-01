"""Seeded synthetic-only Warden-NAV demo; raw rows never leave this function."""
from __future__ import annotations

from typing import Any

from .baseline import MODEL_ID, assess_window
from .events import build_advisory_events
from .window import SAMPLE_RATE_HZ, WINDOW_SECONDS, WINDOW_STEPS
from simulation.nav_scenarios import SCENARIO_LABELS, generate_window


def build_demo(scenario: str = "nominal", seed: int = 0, trust: str = "signature-verified",
               airframe_class: str | None = "multicopter-light") -> dict[str, Any]:
    """Generate, assess, and immediately discard raw synthetic coordinate rows."""
    samples = generate_window(scenario, seed=seed, trust=trust, airframe_class=airframe_class)
    assessment = assess_window(samples, airframe_class=airframe_class)
    assessment["synthetic_only"] = True
    telemetry_trust = assessment["telemetry_trust"]
    traces = assessment["residuals"]["traces"] if assessment.get("residuals") else []
    occurred_at = samples[-1]["timestamp"]
    events = build_advisory_events(
        assessment=assessment,
        aircraft_id="sim-ucas-nav-001",
        occurred_at=occurred_at,
        trust=telemetry_trust,
        scenario=scenario,
        seed=seed,
    )
    window = assessment["window"]
    return {
        "schema_version": "1.0",
        "model_id": MODEL_ID,
        "scenario": scenario,
        "scenario_label_synthetic_only": SCENARIO_LABELS[scenario],
        "seed": seed,
        "synthetic_only": True,
        "read_only": True,
        "advisory_only": True,
        "telemetry_trust": telemetry_trust,
        "airframe_class": airframe_class,
        "window_seconds": WINDOW_SECONDS,
        "sample_rate_hz": SAMPLE_RATE_HZ,
        "window_steps": WINDOW_STEPS,
        "window_start": window.get("window_start"),
        "window_end": window.get("window_end"),
        "field_presence_ratio": assessment["feature_presence_ratio"],
        "navigation_presence_ratio": window.get("navigation_presence_ratio"),
        "window_coverage_ratio": assessment["window_coverage_ratio"],
        "assessment": assessment,
        "residual_traces": traces,
        "learned_inference": {"status": "not_requested", "model_id": "warden-nav-synthetic-linear-v1",
                              "detail": "Run only through the explicit, verified local ONNX inference action."},
        "advisory_events": events,
        "limitations": assessment["limitations"],
    }


__all__ = ["build_demo"]
