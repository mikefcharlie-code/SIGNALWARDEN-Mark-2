from datetime import datetime, timezone
import socket

import pytest

from services.lattice_readonly import (
    CONNECTION_STATUS_OFFLINE,
    CONNECTION_STATUS_ONLINE,
    HEALTH_STATUS_HEALTHY,
    OPERATIONAL_STATE_OPERATIONAL,
    SENSOR_TYPE_CAMERA,
    OfflineLattice,
    _finite_number,
    _timestamp,
    map_entity,
)

NOW = datetime(2025, 1, 1, 0, 1, tzinfo=timezone.utc)


def test_offline_contract_and_catalog_list():
    service = OfflineLattice("offline")
    assert service.list_platforms() == []
    assert isinstance(service.catalog(), list)
    assert len(service.catalog()) >= 12
    assert service.status() == {
        "mode": "offline", "isLive": False, "read_only": True, "readOnly": True,
        "networkAccess": False, "deviceAccess": False, "connected": False,
        "synthetic": False, "observationCount": 0,
    }


def test_mock_has_representative_synthetic_observations_and_explicit_catalog_ids():
    service = OfflineLattice("mock")
    platforms = service.list_platforms(now=NOW)
    assert len(platforms) == 7
    assert {p["catalogId"] for p in platforms} == {
        "autonomous-air-like", "fixed-camera-sensor-like", "autonomous-surface-like",
        "autonomous-undersea-like", "autonomous-ground-like",
        "informational-effector-like", "informational-weapon-like",
    }
    assert all(p["synthetic"] is True for p in platforms)
    assert all(p["freshness"] == "current" for p in platforms[:2])
    assert all(p["freshness"] == "unknown" for p in platforms[2:])
    assert platforms[0]["location"]["position"]["latitudeDegrees"] in (0.0, 0.001)
    assert service.status(now=NOW)["connected"] is False
    assert service.get_platform("synthetic-air-001", now=NOW)["entityId"] == "synthetic-air-001"
    with pytest.raises(KeyError):
        service.get_platform("missing", now=NOW)


@pytest.mark.parametrize("field,value", [
    ("connectionStatus", CONNECTION_STATUS_ONLINE),
    ("connectionStatus", CONNECTION_STATUS_OFFLINE),
    ("healthStatus", HEALTH_STATUS_HEALTHY),
])
def test_public_enum_values_are_preserved(field, value):
    raw = {"entityId": "x", "health": {field: value}}
    assert map_entity(raw, now=NOW)["health"][field] == value


@pytest.mark.parametrize("field,value", [
    ("connectionStatus", "connected"),
    ("connectionStatus", "degraded"),
    ("healthStatus", "nominal"),
    ("healthStatus", "warning"),
    ("healthStatus", "HEALTH_STATUS_DEGRADED"),
])
def test_unknown_health_values_are_field_specific_and_fail_closed(field, value):
    result = map_entity({"entityId": "x", "health": {field: value}}, now=NOW)
    expected = "unknown"
    assert result["health"][field] == expected


@pytest.mark.parametrize("value,expected", [
    (SENSOR_TYPE_CAMERA, SENSOR_TYPE_CAMERA),
    ("camera", "unknown"),
    ("EO/IR", "unknown"),
])
def test_sensor_enum_known_vs_unknown(value, expected):
    raw = {"entityId": "x", "sensors": {"sensors": [{"sensorId": "s", "sensorType": value, "operationalState": OPERATIONAL_STATE_OPERATIONAL}]}}
    assert map_entity(raw, now=NOW)["sensors"]["sensors"][0]["sensorType"] == expected
    assert map_entity({"entityId": "x", "sensors": {"sensors": [{"sensorId": "s", "sensorType": "x", "operationalState": value}]}}, now=NOW)["sensors"]["sensors"][0]["operationalState"] == (value if value == OPERATIONAL_STATE_OPERATIONAL else "unknown")


def test_mapping_requires_explicit_known_catalog_id_and_does_not_infer():
    result = map_entity({"entityId": "x", "aliases": {"name": "autonomous-air-like"}}, now=NOW)
    assert "catalogId" not in result
    with pytest.raises(ValueError, match="unknown catalog_id"):
        map_entity({"entityId": "x"}, now=NOW, catalog_id="guessed-from-name")


@pytest.mark.parametrize("stamp,expected", [
    ("2025-01-01T00:00:00Z", "current"),
    ("2025-01-01T00:02:00Z", "future"),
    ("2024-12-31T23:54:00Z", "stale"),
    ("not-a-time", "unknown"),
    ("2025-01-01T00:00:00", "unknown"),
    ("9999-99-99T00:00:00Z", "unknown"),
])
def test_freshness_and_rfc3339_timestamp_guard(stamp, expected):
    result = map_entity({"entityId": "x", "provenance": {"sourceUpdateTime": stamp}}, now=NOW)
    assert result["freshness"] == expected


@pytest.mark.parametrize("value", [10**10000, float("inf"), float("nan"), True, "10"], ids=["huge-int", "infinity", "nan", "bool", "string"])
def test_finite_number_never_raises_and_rejects_bad_values(value):
    assert _finite_number(value, -100, 100) is None


@pytest.mark.parametrize("raw", [None, [], "asset", {}, {"entityId": ""}])
def test_invalid_top_level_or_non_asset_shape_rejected(raw):
    with pytest.raises(ValueError):
        map_entity(raw, now=NOW)


def test_safe_projection_drops_control_fields_and_keeps_no_weapon_operations():
    raw = {"entityId": "x", "taskCatalog": {"launch": True}, "weapon": {"ready": True}, "command": "fire", "unknown": "secret"}
    result = map_entity(raw, now=NOW)
    assert not {"taskCatalog", "weapon", "command", "unknown"} & result.keys()


def test_defensive_copies_and_catalog_mutation_isolated():
    service = OfflineLattice("mock")
    catalog = service.catalog()
    catalog[0]["category"] = "tampered"
    assert service.catalog()[0]["category"] != "tampered"
    observations = service.list_platforms(now=NOW)
    observations[0]["aliases"]["name"] = "tampered"
    assert service.list_platforms(now=NOW)[0]["aliases"]["name"] != "tampered"


def test_no_socket_connection_attempts(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("network connection attempted")
    monkeypatch.setattr(socket, "create_connection", forbidden)
    service = OfflineLattice("mock")
    service.status(now=NOW)
    service.catalog()
    service.list_platforms(now=NOW)


def test_naive_now_and_unsupported_mode_rejected():
    with pytest.raises(ValueError):
        OfflineLattice("live")
    with pytest.raises(ValueError):
        OfflineLattice("mock").list_platforms(now=datetime(2025, 1, 1))


@pytest.mark.parametrize("value", [[], {}, None, True, 123])
def test_malformed_enum_types_do_not_raise_or_become_healthy(value):
    result = map_entity({"entityId": "x", "health": {"connectionStatus": value, "healthStatus": value},
                         "sensors": {"sensors": [{"sensorId": "s", "sensorType": value, "operationalState": value}]}}, now=NOW)
    assert result["health"] == {"connectionStatus": "unknown", "healthStatus": "unknown"}
    assert result["sensors"]["sensors"][0] == {"sensorId": "s", "sensorType": "unknown", "operationalState": "unknown"}


def test_altitude_references_preserved_without_msl_guessing():
    position = {"latitudeDegrees": 90, "longitudeDegrees": -180,
                "altitudeHaeMeters": 10, "altitudeAglMeters": 20,
                "altitudeAsfMeters": 30, "pressureDepthMeters": 40,
                "altitudeMslMeters": 999, "command": "ignored"}
    result = map_entity({"entityId": "x", "location": {"position": position}}, now=NOW)
    assert result["location"]["position"] == {k: float(v) for k, v in position.items() if k not in {"altitudeMslMeters", "command"}}
    invalid = map_entity({"entityId": "x", "location": {"position": {"latitudeDegrees": 91, "longitudeDegrees": -181, "altitudeHaeMeters": float("nan")}}}, now=NOW)
    assert "location" not in invalid


@pytest.mark.parametrize("stamp,expected", [
    ("2024-12-31T23:56:00Z", "current"),
    ("2024-12-31T23:55:59.999999Z", "stale"),
    ("2025-01-01T00:01:00.000001Z", "future"),
    ("2025-01-01T01:00:00+01:00", "current"),
    ("2025-01-01T00:00:00+00:99", "unknown"),
    ("0001-01-01T00:00:00+23:00", "unknown"),
    (None, "unknown"),
])
def test_freshness_boundaries_offsets_and_missing_timestamp(stamp, expected):
    assert map_entity({"entityId": "x", "provenance": {"sourceUpdateTime": stamp}}, now=NOW)["freshness"] == expected


@pytest.mark.parametrize("field", ["ontology", "location", "health", "sensors", "provenance", "aliases"])
@pytest.mark.parametrize("value", [None, [], "malformed", 42])
def test_malformed_components_do_not_escape_projection(field, value):
    result = map_entity({"entityId": "x", field: value}, now=NOW)
    assert result["synthetic"] is True
    assert result["freshness"] == "unknown"


def test_explicit_non_asset_template_rejected():
    with pytest.raises(ValueError, match="only asset"):
        map_entity({"entityId": "x", "ontology": {"template": "TEMPLATE_TRACK"}}, now=NOW)


def test_weapon_and_effector_records_are_unknown_informational_metadata():
    service = OfflineLattice("mock")
    for entity_id in ("synthetic-weapon-001", "synthetic-effector-001"):
        item = service.get_platform(entity_id, now=NOW)
        assert item["freshness"] == "unknown"
        assert item["health"] == {"connectionStatus": "unknown", "healthStatus": "unknown"}
        assert item["sensors"] == {"sensors": []}
        assert not {"ready", "armed", "target", "taskCatalog", "weapon", "command"} & item.keys()
    stale = service.get_platform("synthetic-air-001", now=datetime(2026, 1, 1, tzinfo=timezone.utc))
    assert stale["freshness"] == "stale"
    assert stale["provenance"]["sourceUpdateTime"] == "2025-01-01T00:00:00Z"
    assert service.status()["connected"] is False


def test_catalog_covers_all_sensor_and_platform_categories():
    catalog = OfflineLattice().catalog()
    ids = {item["catalogId"] for item in catalog}
    assert len(ids) == len(catalog)
    for sensor in ("eo-ir", "radar", "passive-rf"):
        for mobility in ("fixed", "mobile"):
            assert f"{mobility}-{sensor}-sensor-like" in ids


def test_source_is_live_never_claims_transport_connectivity():
    result = map_entity({"entityId": "x", "isLive": True, "token": "must-drop", "taskCatalog": {}}, now=NOW)
    assert "isLive" not in result
    assert "token" not in result
    assert OfflineLattice("mock").status()["isLive"] is False
