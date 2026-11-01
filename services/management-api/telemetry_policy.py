"""Shared identity/ordering rules for in-memory and PostgreSQL telemetry.

Session IDs isolate mapper reconnect/reboot histories. Legacy v1.0 documents
have an explicit legacy namespace. Identity is not authentication.
"""
from __future__ import annotations

import math
import os
from datetime import datetime, timezone
from typing import Any


def event_key(sample, source_id):
    return ":".join(str(part) for part in (
        source_id, sample["source"], sample["aircraft_id"],
        sample.get("session_id", "legacy"), sample["sequence"], sample["timestamp"],
    ))


def ordering_key(sample):
    timestamp = datetime.fromisoformat(sample["timestamp"].replace("Z", "+00:00")).astimezone(timezone.utc)
    identity = sample.get("event_key") or event_key(sample, sample.get("source_id", "local-simulator"))
    return timestamp, sample["sequence"], identity


def _as_float(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = float(value)
    return value if math.isfinite(value) and value >= 0 else None


def _deadline(value: Any) -> float | None:
    value = _as_float(value)
    return value if value is not None and value > 0 else None


def _elapsed(now: datetime, value: Any) -> float:
    try:
        stamp = datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(timezone.utc)
        return max(0.0, (now - stamp).total_seconds())
    except (TypeError, ValueError):
        return 0.0


def compute_freshness(sample: dict[str, Any], received_at: str | datetime | None, *, now: datetime | None = None, snapshot_timeout_seconds: float | None = None) -> dict[str, Any]:
    """Compute snapshot, connectivity, and effective measurement freshness.

    Effective ages add the larger of elapsed time since the aircraft timestamp
    and since gateway receipt. Future timestamps are clamped at zero, which
    limits (but cannot eliminate) uncertainty from unsynchronized clocks.
    This function never mutates the historical sample.
    """
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    elapsed = max(_elapsed(now, sample.get("timestamp")), _elapsed(now, received_at))
    snapshot_timeout = snapshot_timeout_seconds if snapshot_timeout_seconds is not None else os.getenv("UCAS_FRESH_AFTER_SECONDS", "30")
    if isinstance(snapshot_timeout, str):
        try:
            snapshot_timeout = float(snapshot_timeout)
        except ValueError:
            snapshot_timeout = None
    snapshot_timeout = _deadline(snapshot_timeout)
    snapshot_age = _elapsed(now, sample.get("timestamp"))
    snapshot_freshness = "fresh" if snapshot_timeout is not None and snapshot_age <= snapshot_timeout else "stale"

    observation = sample.get("observation") if isinstance(sample.get("observation"), dict) else None
    autopilot = sample.get("autopilot") or {}
    health = sample.get("health") or {}
    effective: dict[str, float | None] = {"heartbeat": None, "battery": None, "system_status": None, "position": None, "attitude": None, "gps": None}
    heartbeat = _as_float(autopilot.get("heartbeat_age_seconds"))
    if heartbeat is not None:
        effective["heartbeat"] = heartbeat + elapsed
    for field in ("position", "attitude", "gps"):
        age = _as_float((sample.get(field) or {}).get("age_seconds"))
        if age is not None:
            effective[field] = age + elapsed
    battery_age = _as_float(observation.get("battery_age_seconds")) if observation else None
    system_status_age = _as_float(observation.get("system_status_age_seconds")) if observation else None
    if battery_age is not None:
        effective["battery"] = battery_age + elapsed
    if system_status_age is not None and "status" in health:
        effective["system_status"] = system_status_age + elapsed

    heartbeat_timeout = _deadline(observation.get("heartbeat_timeout_seconds")) if observation else None
    field_timeout = _deadline(observation.get("field_timeout_seconds")) if observation else None
    if observation is None or heartbeat is None or heartbeat_timeout is None:
        connectivity = "unknown"
    else:
        connectivity = "live" if effective["heartbeat"] <= heartbeat_timeout else "stale"

    def field_state(name: str) -> str:
        if name == "battery":
            present = battery_age is not None or any(health.get(key) is not None for key in ("battery_voltage_v", "battery_percent", "temperature_c"))
        elif name == "system_status":
            present = "status" in health
        else:
            present = isinstance(sample.get(name), dict)
        if not present:
            return "missing"
        age = effective[name]
        return "unknown" if age is None or field_timeout is None else ("fresh" if age <= field_timeout else "stale")

    field_freshness = {name: field_state(name) for name in ("battery", "system_status", "position", "attitude", "gps")}
    if sample.get("schema_version") == "1.1":
        freshness = snapshot_freshness if connectivity == "live" else connectivity if connectivity == "unknown" else "stale"
    else:
        freshness = snapshot_freshness
    # Fresh/live data is not necessarily authentic. Legacy/missing metadata
    # and unauthenticated ingress never acquire a trusted label implicitly.
    security = sample.get("ingress_security") or {}
    policy, asserted = security.get("policy"), security.get("telemetry_trust")
    trust = "untrusted"
    if policy == "required-signed" and asserted == "signature-verified":
        trust = "signature-verified"
    elif policy == "secure-transport" and asserted == "transport-asserted":
        trust = "transport-asserted"
    return {"snapshot_freshness": snapshot_freshness, "freshness": freshness, "connectivity": connectivity, "effective_ages": effective, "field_freshness": field_freshness,
            "telemetry_trust": trust, "flight_ready": False}


compute_telemetry_freshness = compute_freshness
