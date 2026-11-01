"""Warden-TH resampling and feature windows; missingness and trust are explicit."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import math
from collections.abc import Mapping, Sequence
from typing import Any

WINDOW_SECONDS = 120
SAMPLE_RATE_HZ = 2
WINDOW_STEPS = WINDOW_SECONDS * SAMPLE_RATE_HZ
STRIDE_SECONDS = 5
PRESENCE_THRESHOLD = 0.60
CHANNEL_NAMES = (
    "power.battery_voltage_v", "power.battery_percent", "power.temperature_c",
    "power.dv_dt", "power.voltage_sag_vs_vertical_speed", "power.percent_voltage_residual",
    "link.quality_percent", "link.heartbeat_age_seconds", "link.sequence_gap",
    "link.duplicate_late_ratio", "link.heartbeat_jitter_seconds",
    "navigation.gps_fix_type", "navigation.satellites_visible", "navigation.position_age_seconds",
    "navigation.position_jump_m", "navigation.velocity_position_residual_m_s",
    "navigation.altitude_rate_residual_m_s",
    "attitude.roll_rad", "attitude.pitch_rad", "attitude.yaw_rad", "attitude.age_seconds",
    "attitude.rate_magnitude_rad_s", "attitude.high_frequency_energy", "attitude.heading_yaw_residual_rad",
    "autopilot.armed", "autopilot.base_mode", "autopilot.custom_mode", "autopilot.system_status",
    "autopilot.mode_change", "autopilot.status_transition", "autopilot.heartbeat_age_seconds",
    "observation.battery_age_seconds", "observation.system_status_age_seconds",
    "position.vx_m_s", "position.vy_m_s", "position.vz_m_s", "position.relative_altitude_m",
    "sequence.gap_count", "sample.age_seconds",
)

# Only telemetry-schema scalar fields are read. Latitude/longitude are used inside
# the position-jump derivation but never returned as feature names or evidence.
_FIELD_AGE = {
    "power.battery_voltage_v": "observation.battery_age_seconds",
    "power.battery_percent": "observation.battery_age_seconds",
    "power.temperature_c": "observation.system_status_age_seconds",
    "link.quality_percent": "observation.system_status_age_seconds",
    "link.heartbeat_age_seconds": "autopilot.heartbeat_age_seconds",
    "navigation.gps_fix_type": "gps.age_seconds",
    "navigation.satellites_visible": "gps.age_seconds",
    "navigation.position_age_seconds": "position.age_seconds",
    "attitude.roll_rad": "attitude.age_seconds",
    "attitude.pitch_rad": "attitude.age_seconds",
    "attitude.yaw_rad": "attitude.age_seconds",
    "autopilot.heartbeat_age_seconds": "autopilot.heartbeat_age_seconds",
    "observation.battery_age_seconds": "observation.battery_age_seconds",
    "observation.system_status_age_seconds": "observation.system_status_age_seconds",
    "position.vx_m_s": "position.age_seconds",
    "position.vy_m_s": "position.age_seconds",
    "position.vz_m_s": "position.age_seconds",
    "position.relative_altitude_m": "position.age_seconds",
}


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        number = float(value)
    except (ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def _get(item: Mapping[str, Any], path: str) -> Any:
    value: Any = item
    for part in path.split("."):
        if not isinstance(value, Mapping):
            return None
        value = value.get(part)
    return value


def _parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.endswith("Z"):
        return None
    try:
        result = datetime.fromisoformat(value[:-1] + "+00:00")
    except (ValueError, OverflowError):
        return None
    return result.astimezone(timezone.utc) if result.tzinfo else None


def _haversine_m(left: Mapping[str, Any], right: Mapping[str, Any]) -> float | None:
    lat1 = _number(_get(left, "position.latitude_deg"))
    lon1 = _number(_get(left, "position.longitude_deg"))
    lat2 = _number(_get(right, "position.latitude_deg"))
    lon2 = _number(_get(right, "position.longitude_deg"))
    if None in (lat1, lon1, lat2, lon2):
        return None
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi, dlambda = phi2 - phi1, math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 6_371_000 * 2 * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1 - a)))


def _wrap_angle(value: float) -> float:
    return (value + math.pi) % (2 * math.pi) - math.pi


def _channel_values(current: Mapping[str, Any], previous: Mapping[str, Any] | None,
                    previous_previous: Mapping[str, Any] | None, dt: float) -> dict[str, float | None]:
    getn = lambda path: _number(_get(current, path))
    prior = (lambda path: _number(_get(previous, path))) if previous is not None else lambda _path: None
    pprior = (lambda path: _number(_get(previous_previous, path))) if previous_previous is not None else lambda _path: None
    voltage, voltage_prev = getn("health.battery_voltage_v"), prior("health.battery_voltage_v")
    percent, percent_prev = getn("health.battery_percent"), prior("health.battery_percent")
    temperature = getn("health.temperature_c")
    link = getn("health.link_quality_percent")
    vertical_speed = getn("position.vz_m_s")
    gps_fix, satellites = getn("gps.fix_type"), getn("gps.satellites_visible")
    heartbeat = getn("autopilot.heartbeat_age_seconds")
    heartbeat_prev = prior("autopilot.heartbeat_age_seconds")
    altitude, altitude_prev = getn("position.relative_altitude_m"), prior("position.relative_altitude_m")
    roll, pitch, yaw = getn("attitude.roll_rad"), getn("attitude.pitch_rad"), getn("attitude.yaw_rad")
    roll_prev, pitch_prev, yaw_prev = prior("attitude.roll_rad"), prior("attitude.pitch_rad"), prior("attitude.yaw_rad")
    roll_pp, pitch_pp = pprior("attitude.roll_rad"), pprior("attitude.pitch_rad")
    seq, seq_prev = _number(current.get("sequence")), _number(previous.get("sequence")) if previous else None
    sequence_gap = max(0.0, seq - seq_prev - 1.0) if seq is not None and seq_prev is not None else None
    dvdt = (voltage - voltage_prev) / dt if voltage is not None and voltage_prev is not None and dt > 0 else None
    sag_vs_vz = -dvdt * abs(vertical_speed) if dvdt is not None and vertical_speed is not None else None
    voltage_fraction = voltage / voltage_prev if voltage is not None and voltage_prev and voltage_prev > 0 else None
    percent_fraction = (percent / percent_prev) if percent is not None and percent_prev is not None and percent_prev > 0 else None
    percent_voltage_residual = (voltage_fraction - percent_fraction) if voltage_fraction is not None and percent_fraction is not None else None
    duplicate_late = 1.0 if seq is not None and seq_prev is not None and seq <= seq_prev else 0.0 if seq is not None else None
    jitter = abs(heartbeat - heartbeat_prev) if heartbeat is not None and heartbeat_prev is not None else None
    position_jump = _haversine_m(previous, current) if previous is not None else None
    ground_speed = math.hypot(getn("position.vx_m_s") or 0.0, getn("position.vy_m_s") or 0.0)
    measured_speed = position_jump / dt if position_jump is not None and dt > 0 else None
    velocity_residual = abs(measured_speed - ground_speed) if measured_speed is not None else None
    altitude_rate = (altitude - altitude_prev) / dt if altitude is not None and altitude_prev is not None and dt > 0 else None
    altitude_residual = abs(altitude_rate - vertical_speed) if altitude_rate is not None and vertical_speed is not None else None
    rates = [abs((a - b) / dt) for a, b in ((roll, roll_prev), (pitch, pitch_prev), (yaw, yaw_prev))
             if a is not None and b is not None and dt > 0]
    attitude_rate = math.sqrt(sum(value * value for value in rates)) if len(rates) == 3 else None
    hf_values = []
    for now, prev, prev2 in ((roll, roll_prev, roll_pp), (pitch, pitch_prev, pitch_pp)):
        if now is not None and prev is not None and prev2 is not None:
            hf_values.append((now - 2 * prev + prev2) ** 2)
    high_frequency_energy = sum(hf_values) / len(hf_values) if hf_values else None
    heading = getn("position.heading_deg")
    heading_yaw = abs(_wrap_angle(math.radians(heading) - yaw)) if heading is not None and yaw is not None else None
    mode_change = None
    status_transition = None
    if previous is not None:
        mode_change = float(any(_get(current, f"autopilot.{key}") != _get(previous, f"autopilot.{key}")
                                for key in ("base_mode", "custom_mode")))
        status_transition = float(_get(current, "autopilot.system_status") != _get(previous, "autopilot.system_status"))
    values: dict[str, float | None] = {
        "power.battery_voltage_v": voltage, "power.battery_percent": percent,
        "power.temperature_c": temperature, "power.dv_dt": dvdt,
        "power.voltage_sag_vs_vertical_speed": sag_vs_vz,
        "power.percent_voltage_residual": percent_voltage_residual,
        "link.quality_percent": link, "link.heartbeat_age_seconds": heartbeat,
        "link.sequence_gap": sequence_gap, "link.duplicate_late_ratio": duplicate_late,
        "link.heartbeat_jitter_seconds": jitter,
        "navigation.gps_fix_type": gps_fix, "navigation.satellites_visible": satellites,
        "navigation.position_age_seconds": getn("position.age_seconds"),
        "navigation.position_jump_m": position_jump,
        "navigation.velocity_position_residual_m_s": velocity_residual,
        "navigation.altitude_rate_residual_m_s": altitude_residual,
        "attitude.roll_rad": roll, "attitude.pitch_rad": pitch, "attitude.yaw_rad": yaw,
        "attitude.age_seconds": getn("attitude.age_seconds"),
        "attitude.rate_magnitude_rad_s": attitude_rate,
        "attitude.high_frequency_energy": high_frequency_energy,
        "attitude.heading_yaw_residual_rad": heading_yaw,
        "autopilot.armed": (1.0 if _get(current, "autopilot.armed") is True else 0.0
                            if _get(current, "autopilot.armed") is False else None),
        "autopilot.base_mode": getn("autopilot.base_mode"),
        "autopilot.custom_mode": getn("autopilot.custom_mode"),
        "autopilot.system_status": getn("autopilot.system_status"),
        "autopilot.mode_change": mode_change, "autopilot.status_transition": status_transition,
        "autopilot.heartbeat_age_seconds": heartbeat,
        "observation.battery_age_seconds": getn("observation.battery_age_seconds"),
        "observation.system_status_age_seconds": getn("observation.system_status_age_seconds"),
        "position.vx_m_s": getn("position.vx_m_s"), "position.vy_m_s": getn("position.vy_m_s"),
        "position.vz_m_s": vertical_speed, "position.relative_altitude_m": altitude,
        "sequence.gap_count": sequence_gap,
        "sample.age_seconds": 0.0,
    }
    return {name: values.get(name) for name in CHANNEL_NAMES}


def _age_for(channel: str, sample: Mapping[str, Any]) -> float | None:
    path = _FIELD_AGE.get(channel)
    if path:
        return _number(_get(sample, path))
    if channel.startswith("power."):
        paths = ("observation.battery_age_seconds",)
    elif channel.startswith("link."):
        paths = ("autopilot.heartbeat_age_seconds",)
    elif channel.startswith("navigation."):
        paths = ("gps.age_seconds", "position.age_seconds")
    elif channel.startswith("attitude."):
        paths = ("attitude.age_seconds",)
    elif channel.startswith("autopilot."):
        paths = ("observation.system_status_age_seconds", "autopilot.heartbeat_age_seconds")
    elif channel.startswith("position."):
        paths = ("position.age_seconds",)
    else:
        paths = ("observation.field_timeout_seconds",)
    ages = [_number(_get(sample, item)) for item in paths]
    present = [value for value in ages if value is not None]
    return max(present) if present else None


def _trust(item: Mapping[str, Any]) -> str:
    ingress = item.get("ingress_security")
    value = ingress.get("telemetry_trust") if isinstance(ingress, Mapping) else None
    return value if value in {"signature-verified", "transport-asserted", "untrusted"} else "unknown"


def build_window(samples: Sequence[Mapping[str, Any]] | None, *, end: datetime | None = None) -> dict[str, Any]:
    """Build a fixed 240-step, 2-Hz grid without carrying or silently filling values."""
    candidates = [dict(item) for item in (samples or []) if isinstance(item, Mapping)][-2400:]
    parsed = [(item, _parse_timestamp(item.get("timestamp"))) for item in candidates]
    valid = sorted(((item, stamp) for item, stamp in parsed if stamp is not None), key=lambda pair: (pair[1], pair[0].get("sequence", -1)))
    if end is None and valid:
        latest = valid[-1][1]
        half_tick = round(latest.timestamp() * SAMPLE_RATE_HZ) / SAMPLE_RATE_HZ
        end = datetime.fromtimestamp(half_tick, timezone.utc)
    if end is not None:
        if end.tzinfo is None:
            raise ValueError("window end must be timezone-aware")
        end = end.astimezone(timezone.utc)
        half_tick = round(end.timestamp() * SAMPLE_RATE_HZ) / SAMPLE_RATE_HZ
        end = datetime.fromtimestamp(half_tick, timezone.utc)
    else:
        end = datetime(1970, 1, 1, tzinfo=timezone.utc)
    start = end - timedelta(seconds=(WINDOW_STEPS - 1) / SAMPLE_RATE_HZ)
    stamps = [start + timedelta(seconds=index / SAMPLE_RATE_HZ) for index in range(WINDOW_STEPS)]
    chosen: list[Mapping[str, Any] | None] = [None] * WINDOW_STEPS
    selected_delta = [float("inf")] * WINDOW_STEPS
    for item, stamp in valid:
        index = round((stamp - start).total_seconds() * SAMPLE_RATE_HZ)
        if not 0 <= index < WINDOW_STEPS:
            continue
        delta = abs((stamp - stamps[index]).total_seconds())
        if delta <= 0.25 and delta < selected_delta[index]:
            chosen[index], selected_delta[index] = item, delta

    raw_rows: list[tuple[Mapping[str, Any] | None, datetime, float]] = []
    for item, stamp in zip(chosen, stamps):
        raw_rows.append((item, stamp, 0.5))
    rows: list[dict[str, Any]] = []
    prior_item: Mapping[str, Any] | None = None
    prior_prior: Mapping[str, Any] | None = None
    prior_stamp: datetime | None = None
    for item, stamp, _ in raw_rows:
        if item is None:
            rows.append({"timestamp": stamp.isoformat().replace("+00:00", "Z"),
                         "values": [None] * len(CHANNEL_NAMES), "presence_mask": [False] * len(CHANNEL_NAMES),
                         "age_seconds": [None] * len(CHANNEL_NAMES), "trust": "unknown", "sequence": None})
            continue
        dt = (stamp - prior_stamp).total_seconds() if prior_stamp is not None else 0.5
        dt = dt if dt > 0 else 0.5
        values_by_name = _channel_values(item, prior_item, prior_prior, dt)
        values = [values_by_name.get(name) for name in CHANNEL_NAMES]
        mask = [value is not None for value in values]
        ages = [_age_for(name, item) if value is not None else None for name, value in zip(CHANNEL_NAMES, values)]
        sequence = _number(item.get("sequence"))
        rows.append({"timestamp": stamp.isoformat().replace("+00:00", "Z"),
                     "values": values, "presence_mask": mask, "age_seconds": ages,
                     "trust": _trust(item), "sequence": int(sequence) if sequence is not None else None})
        prior_prior, prior_item, prior_stamp = prior_item, item, stamp

    cell_count = WINDOW_STEPS * len(CHANNEL_NAMES)
    observed_count = sum(sum(row["presence_mask"]) for row in rows)
    sequence_gaps = sum(max(0, right - left - 1) for left, right in zip(
        [row["sequence"] for row in rows if row["sequence"] is not None],
        [row["sequence"] for row in rows if row["sequence"] is not None][1:],
    ))
    source_count = sum(1 for item in chosen if item is not None)
    trust_labels = [row["trust"] for row in rows if row["sequence"] is not None]
    trust = "untrusted" if "untrusted" in trust_labels else (
        "trusted" if trust_labels and all(value == "signature-verified" for value in trust_labels) else "unknown"
    )
    return {
        "window_start": stamps[0].isoformat().replace("+00:00", "Z"),
        "window_end": stamps[-1].isoformat().replace("+00:00", "Z"),
        "sample_rate_hz": SAMPLE_RATE_HZ,
        "window_seconds": WINDOW_SECONDS,
        "window_steps": WINDOW_STEPS,
        "stride_seconds": STRIDE_SECONDS,
        "channel_names": list(CHANNEL_NAMES),
        "rows": rows,
        "airframe_class": (
            candidates[-1].get("_synthetic_metadata", {}).get("airframe_class")
            if candidates and isinstance(candidates[-1].get("_synthetic_metadata"), Mapping)
            else None
        ),
        "source_sample_count": source_count,
        "field_presence_ratio": observed_count / cell_count if cell_count else 0.0,
        "missing_steps": sum(row["sequence"] is None for row in rows),
        "sequence_gap_count": sequence_gaps,
        "telemetry_trust": trust,
        "trust_labels": trust_labels,
        "imputation": "none; missing cells remain null and have a false mask",
        "coordinates_emitted": False,
    }


def model_features(window: Mapping[str, Any]) -> list[float]:
    """Return finite summaries; mask rate and age are dedicated features per channel."""
    rows = window.get("rows")
    names = window.get("channel_names")
    if not isinstance(rows, list) or not isinstance(names, list):
        raise ValueError("invalid Warden-TH feature window")
    result: list[float] = []
    for index, _name in enumerate(names):
        values: list[float] = []
        ages: list[float] = []
        for row in rows:
            value = row["values"][index]
            if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value)):
                values.append(float(value))
            age = row["age_seconds"][index]
            if isinstance(age, (int, float)) and not isinstance(age, bool) and math.isfinite(float(age)):
                ages.append(float(age))
        mean = sum(values) / len(values) if values else 0.0
        variance = sum((value - mean) ** 2 for value in values) / len(values) if values else 0.0
        maximum = max((abs(value) for value in values), default=0.0)
        missing_rate = 1.0 - len(values) / max(1, len(rows))
        mean_age = sum(ages) / len(ages) if ages else 0.0
        result.extend((mean, math.sqrt(variance), maximum, missing_rate, mean_age))
    def slope(name: str) -> float | None:
        if name not in names:
            return None
        index = names.index(name)
        points = [(row_index / SAMPLE_RATE_HZ, float(row["values"][index]))
                  for row_index, row in enumerate(rows)
                  if isinstance(row["values"][index], (int, float))
                  and not isinstance(row["values"][index], bool)
                  and math.isfinite(float(row["values"][index]))]
        if len(points) < 4:
            return None
        xbar = sum(point[0] for point in points) / len(points)
        ybar = sum(point[1] for point in points) / len(points)
        denominator = sum((point[0] - xbar) ** 2 for point in points)
        return sum((x - xbar) * (y - ybar) for x, y in points) / denominator if denominator else None
    battery_slope = slope("power.battery_percent")
    voltage_slope = slope("power.battery_voltage_v")
    battery_values = [row["values"][CHANNEL_NAMES.index("power.battery_percent")] for row in rows
                      if isinstance(row["values"][CHANNEL_NAMES.index("power.battery_percent")], (int, float))]
    result.extend((battery_slope * 60.0 if battery_slope is not None else 0.0,
                   voltage_slope if voltage_slope is not None else 0.0,
                   float(battery_values[-1]) if battery_values else 0.0))
    return result


MODEL_FEATURE_COUNT = len(CHANNEL_NAMES) * 5 + 3


def compact_window(window: Mapping[str, Any]) -> dict[str, Any]:
    """Bounded inference payload; raw telemetry and coordinates are not included."""
    evidence_fields = {
        "power.battery_voltage_v", "power.battery_percent", "power.temperature_c",
        "link.quality_percent", "link.heartbeat_age_seconds", "navigation.gps_fix_type",
        "navigation.satellites_visible", "navigation.position_age_seconds", "attitude.roll_rad",
        "attitude.pitch_rad", "attitude.yaw_rad", "attitude.age_seconds", "autopilot.armed",
        "autopilot.base_mode", "autopilot.custom_mode", "autopilot.system_status",
        "position.vx_m_s", "position.vy_m_s", "position.vz_m_s", "position.relative_altitude_m",
        "sequence.gap_count",
    }
    return {
        "feature_names": [f"{name}.{stat}" for name in CHANNEL_NAMES
                          for stat in ("mean", "std", "max_abs", "missing_rate", "mean_age")]
                         + ["global.battery_percent_slope_per_min", "global.battery_voltage_slope_per_s",
                            "global.battery_percent_latest"],
        "model_input": model_features(window),
        "field_presence_ratio": float(window.get("field_presence_ratio", 0.0)),
        "airframe_class": window.get("airframe_class"),
        "telemetry_trust": window.get("telemetry_trust", "unknown"),
        "evidence_sequence_from": next((row["sequence"] for row in window["rows"] if row["sequence"] is not None), None),
        "evidence_sequence_to": next((row["sequence"] for row in reversed(window["rows"]) if row["sequence"] is not None), None),
        "evidence_channels": ",".join(name for name in CHANNEL_NAMES if name in evidence_fields),
        "synthetic": True,
    }
