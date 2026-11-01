"""Canonical, allow-listed adapter for the deterministic report engine.

This module deliberately emits only report-safe observations. It does not expose
coordinates, control data, weapon/effector data, or free-form maintenance text.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

_ALLOWED = {
    "aircraft.status",
    "telemetry.battery_percent",
    "telemetry.link_quality_percent",
    "maintenance.status",
    "ingestion.status",
    "event",
}


def _time(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    return None


def _append(rows: list[dict[str, Any]], *, entity: str, subject: str | None = None,
           source: str | None, field: str, value: Any, observed: Any,
           synthetic: bool, trust: Any = "unknown", source_record_id: Any = None) -> None:
    if field not in _ALLOWED or not isinstance(entity, str) or not entity:
        return
    row: dict[str, Any] = {
        "entityId": entity,
        "subjectId": subject if isinstance(subject, str) and subject else entity,
        "sourceId": source if isinstance(source, str) and source else "unknown",
        "field": field,
        "value": value,
        "observedAt": _time(observed),
        "trust": "unknown" if synthetic else (trust if trust in {"trusted", "untrusted", "unknown", True} else "unknown"),
        "synthetic": bool(synthetic),
    }
    if isinstance(source_record_id, str) and source_record_id:
        row["sourceRecordId"] = source_record_id
    rows.append(row)


def build_report_overview(store: Any, lattice: Any, *, now: Any = None) -> dict[str, Any]:
    """Combine canonical repository observations with the offline overview.

    Store interfaces are intentionally duck-typed so both InMemoryStore and the
    PostgreSQL repository are supported. All repository calls are read-only.
    """
    overview = lattice.overview(now=now)
    overview = dict(overview) if isinstance(overview, Mapping) else {}
    rows: list[dict[str, Any]] = []
    aircraft = store.list_aircraft()
    known_aircraft = {item.get("aircraft_id") for item in aircraft if isinstance(item, Mapping)}
    for item in aircraft:
        if not isinstance(item, Mapping):
            continue
        entity = item.get("aircraft_id")
        if not isinstance(entity, str):
            continue
        synthetic = str(item.get("hardware_revision", "")).lower() in {"simulation-only", "synthetic"}
        _append(rows, entity=entity, field="aircraft.status", value=item.get("lifecycle_status", "unknown"),
                observed=None, source="aircraft-repository", synthetic=synthetic,
                source_record_id=entity)
        try:
            history = store.history(entity)
        except (AttributeError, KeyError, ValueError):
            history = []
        for sample in history or []:
            if not isinstance(sample, Mapping):
                continue
            source = sample.get("source_id") or sample.get("source") or "unknown"
            stamp = sample.get("timestamp") or sample.get("sampled_at")
            record_id = sample.get("event_key") or sample.get("sourceRecordId")
            synthetic_sample = synthetic or source in {"local-simulator", "synthetic"} or sample.get("source") == "simulated"
            health = sample.get("health") if isinstance(sample.get("health"), Mapping) else sample
            for key, field in (("battery_percent", "telemetry.battery_percent"), ("link_quality_percent", "telemetry.link_quality_percent")):
                if isinstance(health, Mapping) and key in health:
                    _append(rows, entity=entity, subject=entity, source=source, field=field,
                            value=health.get(key), observed=stamp, synthetic=synthetic_sample,
                            source_record_id=record_id)
            _append(rows, entity=entity, subject=entity, source=source, field="ingestion.status",
                    value=sample.get("ingestion_status", "accepted"), observed=sample.get("received_at") or stamp,
                    synthetic=synthetic_sample, source_record_id=record_id)
            _append(rows, entity=entity, subject=entity, source=source, field="event",
                    value=sample.get("ingestion_status", "accepted"), observed=sample.get("received_at") or stamp,
                    synthetic=synthetic_sample, source_record_id=record_id)
        try:
            maintenance = store.maintenance(entity)
        except (AttributeError, KeyError, ValueError):
            maintenance = []
        for record in maintenance or []:
            if not isinstance(record, Mapping):
                continue
            _append(rows, entity=entity, subject=entity, source="maintenance-repository", field="maintenance.status",
                    value=record.get("status", "unknown"), observed=record.get("completed_at") or record.get("created_at"),
                    synthetic=synthetic, source_record_id=record.get("record_id"))
        try:
            status = store.ingestion_status(entity)
        except (AttributeError, KeyError, ValueError):
            status = None
        if isinstance(status, Mapping):
            _append(rows, entity=entity, subject=entity, source="ingestion-repository", field="ingestion.status",
                    value=status.get("counts", {}), observed=status.get("last_received_at"), synthetic=synthetic)
        try:
            evidence = store.evidence(entity)
        except (AttributeError, KeyError, ValueError):
            evidence = []
        for event in evidence or []:
            if not isinstance(event, Mapping):
                continue
            _append(rows, entity=entity, subject=entity, source=event.get("source_id"), field="event",
                    value=event.get("event_type", "event"), observed=event.get("occurred_at"),
                    synthetic=synthetic, source_record_id=event.get("integrity_reference") or event.get("event_id"))

    # OfflineLattice observations are canonical read-only metadata, while the
    # adapter intentionally copies no location or arbitrary nested fields.
    for platform in overview.get("platforms", []):
        if not isinstance(platform, Mapping):
            continue
        entity = platform.get("entityId")
        if platform.get("catalogId") in {"informational-effector-like", "informational-weapon-like"}:
            continue
        if not isinstance(entity, str) or entity in known_aircraft:
            continue
        prov = platform.get("provenance") if isinstance(platform.get("provenance"), Mapping) else {}
        source = prov.get("sourceId") or prov.get("source") or "offline-lattice"
        stamp = prov.get("sourceUpdateTime")
        category = str(platform.get("category", ""))
        if "air" in category:
            _append(rows, entity=entity, source=source, field="aircraft.status",
                    value=platform.get("operationalState", "unknown"), observed=stamp,
                    synthetic=True, source_record_id=prov.get("sourceRecordId"))
    overview["documentSources"] = rows
    return overview


def report_catalog(store: Any, lattice: Any) -> dict[str, list[dict[str, str]]]:
    platforms: dict[str, str] = {}
    sensors: dict[str, str] = {}
    for item in store.list_aircraft():
        if isinstance(item, Mapping) and isinstance(item.get("aircraft_id"), str):
            platforms[item["aircraft_id"]] = str(item.get("display_name") or item["aircraft_id"])
    for item in lattice.list_platforms():
        if not isinstance(item, Mapping) or not isinstance(item.get("entityId"), str):
            continue
        if item.get("catalogId") in {"informational-effector-like", "informational-weapon-like"}:
            continue
        platforms.setdefault(item["entityId"], str(item.get("label") or item["entityId"]))
        sensors_data = item.get("sensors") if isinstance(item.get("sensors"), Mapping) else {}
        for sensor in sensors_data.get("sensors", []):
            if isinstance(sensor, Mapping) and isinstance(sensor.get("sensorId"), str):
                sensors.setdefault(sensor["sensorId"], str(sensor.get("sensorType") or sensor["sensorId"]))
    return {"platforms": [{"id": k, "label": platforms[k]} for k in sorted(platforms)],
            "sensors": [{"id": k, "label": sensors[k]} for k in sorted(sensors)]}
