"""Independent CPU kinematic baseline; this is not the learned ONNX model."""
from __future__ import annotations

import math
from typing import Any, Sequence

HISTORY_STEPS = 20
FORECAST_STEPS = 30
FEATURE_COUNT = 9
STEP_SECONDS = 0.1


def constant_turn_rate_acceleration_baseline(history: Sequence[Sequence[float]], *, fallback_reason: str,
                                             expected_model_sha256: str | None = None) -> dict[str, Any]:
    """Produce a plainly labeled CPU kinematic forecast with no model imports."""
    try:
        values = [[float(value) for value in row] for row in history]
    except (TypeError, ValueError, OverflowError) as error:
        raise ValueError("baseline input must be a numeric history matrix") from error
    if (len(values) != HISTORY_STEPS or any(len(row) != FEATURE_COUNT for row in values)
            or any(not math.isfinite(value) for row in values for value in row)):
        raise ValueError("baseline input must be a finite 20x9 history matrix")
    if not fallback_reason or len(fallback_reason) > 100:
        raise ValueError("baseline fallback reason is invalid")

    # Use only the recent forward speed, longitudinal acceleration, and yaw
    # rate; integrate a conventional constant-turn-rate/acceleration prior.
    speed0 = values[-1][0]
    yaw_rate = sum(row[2] for row in values[-3:]) / 3.0
    longitudinal_acceleration = sum(row[3] for row in values[-3:]) / 3.0
    x_m = y_m = 0.0
    forecast = []
    for step in range(1, FORECAST_STEPS + 1):
        t = step * STEP_SECONDS
        midpoint_t = t - STEP_SECONDS / 2
        speed = max(0.0, speed0 + longitudinal_acceleration * t)
        distance = speed * STEP_SECONDS
        midpoint_yaw = yaw_rate * midpoint_t
        x_m += distance * math.cos(midpoint_yaw)
        y_m += distance * math.sin(midpoint_yaw)
        yaw_delta = yaw_rate * t
        if not all(math.isfinite(value) for value in (x_m, y_m, yaw_delta)):
            raise ValueError("baseline produced non-finite output")
        forecast.append({
            "future_time_s": round(t, 1),
            "x_m": round(x_m, 4),
            "y_m": round(y_m, 4),
            "yaw_delta_rad": round(yaw_delta, 6),
            "sigma_x_m": None,
            "sigma_y_m": None,
        })
    return {
        "baseline_id": "constant-turn-rate-acceleration-cpu-v1",
        "status": "baseline_fallback",
        "fallback_reason": fallback_reason,
        "learned_model_contributed_to_this_forecast": False,
        "model_ran_on_cpu": False,
        "advisory_only": True,
        "execution_provider": "CPU (standard-library kinematic baseline only)",
        "candidate_model_sha256": expected_model_sha256,
        "output_frame": "vehicle frame at the end of the supplied history; x/y are relative displacements, not global coordinates or a corrected current pose",
        "uncertainty_interpretation": "not available for this baseline; sigma values are null",
        "input_domain_status": "not checked; this baseline has no learned-model OOD detector",
        "forecast": forecast,
        "safety_boundary": {
            "uav_or_aircraft_profile": False,
            "live_navigation_or_position_correction": False,
            "live_planning_or_control": False,
            "mission_or_effector_action": False,
        },
    }


__all__ = ["constant_turn_rate_acceleration_baseline"]
