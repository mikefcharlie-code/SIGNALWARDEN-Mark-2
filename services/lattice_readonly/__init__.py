"""Offline-only, read-only projections of public Lattice-shaped entity data.

No SDK, network transport, credential handling, tasking, or device controls exist.
The catalog is local metadata, not an official product or Lattice taxonomy.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import math
import re
from typing import Any, Mapping

_STALE_AFTER_SECONDS = 300.0
_UNKNOWN = "unknown"
CONNECTION_STATUS_ONLINE = "CONNECTION_STATUS_ONLINE"
CONNECTION_STATUS_OFFLINE = "CONNECTION_STATUS_OFFLINE"
HEALTH_STATUS_HEALTHY = "HEALTH_STATUS_HEALTHY"
SENSOR_TYPE_CAMERA = "SENSOR_TYPE_CAMERA"
OPERATIONAL_STATE_OPERATIONAL = "OPERATIONAL_STATE_OPERATIONAL"

_CATALOG = [
    {"catalogId": "autonomous-air-like", "category": "autonomous-air-like", "label": "Autonomous air platform", "description": "Generic air-platform observation metadata."},
    {"catalogId": "autonomous-surface-like", "category": "autonomous-surface-like", "label": "Autonomous surface platform", "description": "Generic surface-platform observation metadata."},
    {"catalogId": "autonomous-undersea-like", "category": "autonomous-undersea-like", "label": "Autonomous undersea platform", "description": "Generic undersea-platform observation metadata."},
    {"catalogId": "autonomous-ground-like", "category": "autonomous-ground-like", "label": "Autonomous ground platform", "description": "Generic ground-platform observation metadata."},
    {"catalogId": "fixed-eo-ir-sensor-like", "category": "fixed-sensor-like", "sensorType": "EO/IR", "mobility": "fixed", "label": "Fixed EO/IR sensor"},
    {"catalogId": "mobile-eo-ir-sensor-like", "category": "mobile-sensor-like", "sensorType": "EO/IR", "mobility": "mobile", "label": "Mobile EO/IR sensor"},
    {"catalogId": "fixed-camera-sensor-like", "category": "fixed-sensor-like", "sensorType": "camera", "mobility": "fixed", "label": "Fixed camera sensor"},
    {"catalogId": "fixed-radar-sensor-like", "category": "fixed-sensor-like", "sensorType": "radar", "mobility": "fixed", "label": "Fixed radar sensor"},
    {"catalogId": "mobile-radar-sensor-like", "category": "mobile-sensor-like", "sensorType": "radar", "mobility": "mobile", "label": "Mobile radar sensor"},
    {"catalogId": "fixed-passive-rf-sensor-like", "category": "fixed-sensor-like", "sensorType": "passive RF", "mobility": "fixed", "label": "Fixed passive RF sensor"},
    {"catalogId": "mobile-passive-rf-sensor-like", "category": "mobile-sensor-like", "sensorType": "passive RF", "mobility": "mobile", "label": "Mobile passive RF sensor"},
    {"catalogId": "informational-effector-like", "category": "effector-like", "label": "Informational effector platform", "description": "Metadata only; no performance, readiness, firing, arming, or targeting data."},
    {"catalogId": "informational-weapon-like", "category": "weapon-like", "label": "Informational weapon platform", "description": "Metadata only; no performance, readiness, firing, arming, or targeting data."},
]
_CATALOG_IDS = frozenset(item["catalogId"] for item in _CATALOG)
_CAPABILITIES = [
    {"id": "common-operational-view", "title": "Common view", "theme": "shared-view", "implementation": "local-demo", "description": "One coherent, read-only view of synthetic platform observations.", "boundary": "Static observations only; no live Lattice or device connection."},
    {"id": "data-quality-attention", "title": "Data-quality attention", "theme": "decision-points", "implementation": "local-demo", "description": "Deterministic attention for freshness, health, connectivity, and sensor-state quality issues.", "boundary": "Non-tactical diagnostics only; no recommendations or tasking."},
    {"id": "multi-domain-catalog", "title": "Multi-domain catalog", "theme": "extensibility", "implementation": "local-demo", "description": "Catalog metadata spans air, surface, undersea, ground, sensor, and informational inventory records.", "boundary": "Catalog entries are metadata and do not imply readiness or capability."},
    {"id": "adapter-seam", "title": "Adapter seam", "theme": "extensibility", "implementation": "local-demo", "description": "A small projection boundary keeps source mapping separate from the read-only API.", "boundary": "No SDK, credentials, ingestion, or transport adapter is provided."},
    {"id": "source-diagnostics", "title": "Source diagnostics", "theme": "observability", "implementation": "local-demo", "description": "The API reports whether data is static synthetic fixtures or absent.", "boundary": "Diagnostics never claim connectivity, device access, or mesh availability."},
    {"id": "resilient-networking", "title": "Resilient networking", "theme": "networking", "implementation": "local-demo", "description": "Bounded API-client retry and timeout seam for read-only local calls.", "boundary": "No mesh, peer transport, distributed state, or device/network control is implemented."},
    {"id": "ai-decision-support", "title": "AI decision support", "theme": "decision-support", "implementation": "local-demo", "description": "Local deterministic or explicitly configured loopback-model assistance for aggregate data quality.", "boundary": "Advisory and human-reviewed only; no commands, operational advice, locations, weapons, effectors, or control."},
    {"id": "tasking-and-control", "title": "Tasking and control", "theme": "control", "implementation": "excluded", "description": "Command, tasking, targeting, weapon guidance, and control are out of scope.", "boundary": "Excluded from this read-only backend; writes remain denied."},
]

# Static synthetic positions near origin, not real operational locations. Only
# UAV is used as a documented platform label; other categories stay local.
_FIXTURES = [
    {
        "entityId": "synthetic-air-001",
        "aliases": {"name": "Synthetic aircraft"},
        "ontology": {"platformType": "UAV", "template": "TEMPLATE_ASSET"},
        "location": {"position": {"latitudeDegrees": 0.0, "longitudeDegrees": 0.0, "altitudeHaeMeters": 120.0}},
        "health": {"connectionStatus": CONNECTION_STATUS_ONLINE, "healthStatus": HEALTH_STATUS_HEALTHY},
        "sensors": {"sensors": [{"sensorId": "synthetic-air-camera", "sensorType": SENSOR_TYPE_CAMERA, "operationalState": OPERATIONAL_STATE_OPERATIONAL}]},
        "provenance": {"sourceUpdateTime": "2025-01-01T00:00:00Z"},
    },
    {
        "entityId": "synthetic-fixed-camera-001",
        "aliases": {"name": "Synthetic fixed camera"},
        "ontology": {"template": "TEMPLATE_ASSET"},
        "location": {"position": {"latitudeDegrees": 0.001, "longitudeDegrees": 0.001, "altitudeAglMeters": 2.0}},
        "health": {"connectionStatus": CONNECTION_STATUS_OFFLINE, "healthStatus": HEALTH_STATUS_HEALTHY},
        "sensors": {"sensors": [{"sensorId": "synthetic-fixed-camera", "sensorType": SENSOR_TYPE_CAMERA, "operationalState": OPERATIONAL_STATE_OPERATIONAL}]},
        "provenance": {"sourceUpdateTime": "2025-01-01T00:00:00Z"},
    },
    {"entityId": "synthetic-effector-001", "aliases": {"name": "Synthetic effector inventory record"}, "ontology": {"template": "TEMPLATE_ASSET"}},
    {"entityId": "synthetic-weapon-001", "aliases": {"name": "Synthetic weapon inventory record"}, "ontology": {"template": "TEMPLATE_ASSET"}},
    {"entityId": "synthetic-surface-001", "aliases": {"name": "Synthetic surface inventory record"}, "ontology": {"template": "TEMPLATE_ASSET"}},
    {"entityId": "synthetic-undersea-001", "aliases": {"name": "Synthetic undersea inventory record"}, "ontology": {"template": "TEMPLATE_ASSET"}},
    {"entityId": "synthetic-ground-001", "aliases": {"name": "Synthetic ground inventory record"}, "ontology": {"template": "TEMPLATE_ASSET"}},
]
_FIXTURE_CATALOG_IDS = {
    "synthetic-air-001": "autonomous-air-like",
    "synthetic-fixed-camera-001": "fixed-camera-sensor-like",
    "synthetic-effector-001": "informational-effector-like",
    "synthetic-weapon-001": "informational-weapon-like",
    "synthetic-surface-001": "autonomous-surface-like",
    "synthetic-undersea-001": "autonomous-undersea-like",
    "synthetic-ground-001": "autonomous-ground-like",
}
_RFC3339 = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$")


def _finite_number(value: Any, low: float, high: float) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        return float(value) if math.isfinite(value) and low <= value <= high else None
    except (OverflowError, ValueError):
        return None


def _timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not _RFC3339.fullmatch(value):
        return None
    # Python's parser normalizes invalid offset minutes; reject them first.
    if not value.endswith("Z") and (int(value[-5:-3]) > 23 or int(value[-2:]) > 59):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except (TypeError, ValueError, OverflowError):
        return None


def _now(value: datetime | None) -> datetime:
    result = value if value is not None else datetime.now(timezone.utc)
    if not isinstance(result, datetime) or result.tzinfo is None or result.utcoffset() is None:
        raise ValueError("now must be a timezone-aware datetime")
    try:
        return result.astimezone(timezone.utc)
    except (OverflowError, ValueError):
        raise ValueError("now is outside supported timezone range") from None


def _safe_string(value: Any) -> str | None:
    return value if isinstance(value, str) and value.strip() else None


def _known(value: Any, allowed: set[str]) -> str:
    return value if isinstance(value, str) and value in allowed else _UNKNOWN


def map_entity(raw: Mapping[str, Any], *, now: datetime | None = None, catalog_id: str | None = None) -> dict[str, Any]:
    """Project offline fixture data only; not an official SDK or ingestion API.

    A missing template is tolerated for partial fixtures; explicit non-assets are
    rejected. Unknown enums fail to 'unknown'. All results are labeled synthetic;
    this helper must not be repurposed as a live telemetry adapter.
    """
    if not isinstance(raw, Mapping):
        raise ValueError("raw entity must be a mapping")
    entity_id = _safe_string(raw.get("entityId"))
    if entity_id is None:
        raise ValueError("asset entity must have a non-empty entityId")
    if catalog_id is not None and (not isinstance(catalog_id, str) or catalog_id not in _CATALOG_IDS):
        raise ValueError("unknown catalog_id")
    current = _now(now)
    out: dict[str, Any] = {"entityId": entity_id, "synthetic": True}
    if catalog_id is not None:
        out["catalogId"] = catalog_id
    aliases = raw.get("aliases")
    if isinstance(aliases, Mapping) and _safe_string(aliases.get("name")) is not None:
        out["aliases"] = {"name": aliases["name"]}
    ontology = raw.get("ontology")
    if isinstance(ontology, Mapping):
        template = ontology.get("template")
        if template is not None and template != "TEMPLATE_ASSET":
            raise ValueError("only asset fixtures are supported")
        mapped = {key: ontology[key] for key in ("platformType", "template") if _safe_string(ontology.get(key)) is not None}
        if mapped:
            out["ontology"] = mapped
    location = raw.get("location")
    position = location.get("position") if isinstance(location, Mapping) else None
    if isinstance(position, Mapping):
        p = {}
        for key, low, high in (
            ("latitudeDegrees", -90, 90), ("longitudeDegrees", -180, 180),
            ("altitudeHaeMeters", -1_000_000, 1_000_000), ("altitudeAglMeters", -1_000_000, 1_000_000),
            ("altitudeAsfMeters", -1_000_000, 1_000_000), ("pressureDepthMeters", -1_000_000, 1_000_000),
        ):
            number = _finite_number(position.get(key), low, high)
            if number is not None:
                p[key] = number
        if p:
            out["location"] = {"position": p}
    health = raw.get("health") if isinstance(raw.get("health"), Mapping) else {}
    out["health"] = {
        "connectionStatus": _known(health.get("connectionStatus"), {CONNECTION_STATUS_ONLINE, CONNECTION_STATUS_OFFLINE}),
        "healthStatus": _known(health.get("healthStatus"), {HEALTH_STATUS_HEALTHY}),
    }
    source = raw.get("sensors")
    source_sensors = source.get("sensors") if isinstance(source, Mapping) else None
    sensors = []
    if isinstance(source_sensors, list):
        for item in source_sensors:
            if not isinstance(item, Mapping):
                continue
            sid = _safe_string(item.get("sensorId"))
            if sid is not None:
                sensors.append({"sensorId": sid,
                                "sensorType": _known(item.get("sensorType"), {SENSOR_TYPE_CAMERA}),
                                "operationalState": _known(item.get("operationalState"), {OPERATIONAL_STATE_OPERATIONAL})})
    out["sensors"] = {"sensors": sensors}
    provenance = raw.get("provenance")
    parsed = _timestamp(provenance.get("sourceUpdateTime")) if isinstance(provenance, Mapping) else None
    out["freshness"] = _UNKNOWN
    if parsed is not None:
        age = (current - parsed).total_seconds()
        out["freshness"] = "future" if age < 0 else ("current" if age <= _STALE_AFTER_SECONDS else "stale")
        out["provenance"] = {"sourceUpdateTime": parsed.isoformat().replace("+00:00", "Z")}
    return out


class OfflineLattice:
    """Local read-only catalog with optional static synthetic observations."""

    def __init__(self, mode: str = "offline") -> None:
        if not isinstance(mode, str) or mode not in {"mock", "offline"}:
            raise ValueError("mode must be 'mock' or 'offline'")
        self.mode = mode

    def status(self, *, now: datetime | None = None) -> dict[str, Any]:
        return {"mode": self.mode, "isLive": False, "read_only": True, "readOnly": True,
                "networkAccess": False, "deviceAccess": False, "connected": False,
                "synthetic": self.mode == "mock", "observationCount": len(self.list_platforms(now=now))}

    def catalog(self) -> list[dict[str, Any]]:
        return deepcopy(_CATALOG)

    def list_platforms(self, *, now: datetime | None = None) -> list[dict[str, Any]]:
        if self.mode == "offline":
            return []
        current = _now(now)
        return [map_entity(raw, now=current, catalog_id=_FIXTURE_CATALOG_IDS[raw["entityId"]]) for raw in _FIXTURES]

    def get_platform(self, entity_id: str, *, now: datetime | None = None) -> dict[str, Any]:
        if isinstance(entity_id, str):
            for item in self.list_platforms(now=now):
                if item["entityId"] == entity_id:
                    return item
        raise KeyError(entity_id)

    def capabilities(self) -> list[dict[str, Any]]:
        """Return the bounded local capability catalog, never executable controls."""
        return deepcopy(_CAPABILITIES)

    def overview(self, *, now: datetime | None = None) -> dict[str, Any]:
        """Build one coherent snapshot using one injected clock value."""
        from .evidence import build_assessment

        current = _now(now)
        generated_at = current.isoformat().replace("+00:00", "Z")
        platforms = self.list_platforms(now=current)
        freshness = {"current": 0, "stale": 0, "future": 0, "unknown": 0}
        attention: list[dict[str, Any]] = []
        for platform in platforms:
            state = platform.get("freshness", _UNKNOWN)
            freshness[state if state in freshness else _UNKNOWN] += 1
            entity_id = platform["entityId"]
            # Inventory-only records deliberately do not generate operational alerts.
            inventory_only = platform.get("catalogId") in {"informational-effector-like", "informational-weapon-like"}
            if not inventory_only:
                if state in {"stale", "future", "unknown"}:
                    code = f"observation_{state}"
                    title = {"stale": "Observation is stale", "future": "Observation is from the future", "unknown": "Observation freshness is unknown"}[state]
                    attention.append({"id": f"{entity_id}:{code}", "entityId": entity_id, "severity": "warning", "code": code, "title": title, "detail": f"{entity_id} has {state} observation freshness."})
                health = platform.get("health", {})
                if health.get("connectionStatus") == CONNECTION_STATUS_OFFLINE:
                    attention.append({"id": f"{entity_id}:reported_offline", "entityId": entity_id, "severity": "warning", "code": "reported_offline", "title": "Source reported offline", "detail": f"{entity_id} has historical offline metadata; this is not a current transport heartbeat."})
                if health.get("healthStatus") == _UNKNOWN:
                    attention.append({"id": f"{entity_id}:health_unknown", "entityId": entity_id, "severity": "info", "code": "health_unknown", "title": "Health status is unknown", "detail": f"{entity_id} has no recognized health status."})
                sensors = platform.get("sensors", {}).get("sensors", [])
                if any(sensor.get("operationalState") == _UNKNOWN for sensor in sensors):
                    attention.append({"id": f"{entity_id}:sensor_state_unknown", "entityId": entity_id, "severity": "info", "code": "sensor_state_unknown", "title": "Sensor state is unknown", "detail": f"{entity_id} has a sensor with an unrecognized operational state."})
        sensor_count = sum(len(item.get("sensors", {}).get("sensors", [])) for item in platforms)
        positions = [item.get("location", {}).get("position", {}) for item in platforms]
        located_count = sum(
            _finite_number(position.get("latitudeDegrees"), -90, 90) is not None
            and _finite_number(position.get("longitudeDegrees"), -180, 180) is not None
            for position in positions
        )
        source_times = [_timestamp(item.get("provenance", {}).get("sourceUpdateTime")) for item in platforms]
        latest_source = max((stamp for stamp in source_times if stamp is not None), default=None)
        source_time = latest_source.isoformat().replace("+00:00", "Z") if latest_source else None
        result = {
            "mode": self.mode, "synthetic": self.mode == "mock", "readOnly": True, "connected": False,
            "generatedAt": generated_at,
            "summary": {"platformCount": len(platforms), "sensorCount": sensor_count, "locatedCount": located_count, "freshness": freshness},
            "platforms": deepcopy(platforms), "attention": deepcopy(attention),
            "diagnostics": {"transport": "none", "networkAccess": False, "deviceAccess": False, "meshAvailable": False,
                            "source": "static-fixtures" if self.mode == "mock" else "none", "lastSourceUpdateTime": source_time,
                            "notes": ["Synthetic static fixtures; no live connection."] if self.mode == "mock" else ["No observations are configured; no source connection exists."]},
        }
        # The projection seam carries static, synthetic source reports separately
        # from platform/sensor counts.  Both reports are intentionally unknown
        # trust: they demonstrate citation/conflict handling, not live telemetry.
        if self.mode == "mock":
            result["observationEvidence"] = [
                {"entityId": "synthetic-air-001", "subjectId": "synthetic-air-001:sensor:synthetic-air-camera",
                 "sourceId": "synthetic-source-alpha", "field": "sensor.operationalState",
                 "value": "OPERATIONAL_STATE_OPERATIONAL", "observedAt": "2025-01-01T00:00:00Z",
                 "trust": "unknown", "synthetic": True},
                {"entityId": "synthetic-air-001", "subjectId": "synthetic-air-001:sensor:synthetic-air-camera",
                 "sourceId": "synthetic-source-beta", "field": "sensor.operationalState",
                 "value": "unknown", "observedAt": "2025-01-01T00:00:20Z",
                 "trust": "unknown", "synthetic": True},
            ]
        result["assessment"] = build_assessment(result)
        return result


from .evidence import build_assessment

__all__ = ["OfflineLattice", "map_entity", "build_assessment"]
