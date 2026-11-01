from datetime import datetime, timezone

from services.lattice_readonly import OfflineLattice, map_entity


NOW = datetime(2025, 1, 1, 0, 5, tzinfo=timezone.utc)


def test_overview_is_one_coherent_snapshot_with_exact_counts():
    overview = OfflineLattice("mock").overview(now=NOW)
    assert overview["generatedAt"] == "2025-01-01T00:05:00Z"
    assert overview["readOnly"] is True
    assert sum(overview["summary"]["freshness"].values()) == overview["summary"]["platformCount"]
    assert overview["summary"] == {
        "platformCount": 7,
        "sensorCount": 2,
        "locatedCount": 2,
        "freshness": {"current": 2, "stale": 0, "future": 0, "unknown": 5},
    }
    assert overview["diagnostics"]["source"] == "static-fixtures"
    assert overview["diagnostics"]["lastSourceUpdateTime"] == "2025-01-01T00:00:00Z"


def test_freshness_boundary_is_current_at_five_minutes_and_stale_after():
    exact = map_entity({"entityId": "x", "provenance": {"sourceUpdateTime": "2025-01-01T00:00:00Z"}}, now=NOW)
    after = map_entity({"entityId": "x", "provenance": {"sourceUpdateTime": "2024-12-31T23:59:59.999999Z"}}, now=NOW)
    assert exact["freshness"] == "current"
    assert after["freshness"] == "stale"


def test_offline_overview_has_zero_observations_and_honest_diagnostics():
    overview = OfflineLattice("offline").overview(now=NOW)
    assert overview["platforms"] == []
    assert overview["attention"] == []
    assert overview["summary"] == {
        "platformCount": 0,
        "sensorCount": 0,
        "locatedCount": 0,
        "freshness": {"current": 0, "stale": 0, "future": 0, "unknown": 0},
    }
    assert overview["diagnostics"] == {
        "transport": "none",
        "networkAccess": False,
        "deviceAccess": False,
        "meshAvailable": False,
        "source": "none",
        "lastSourceUpdateTime": None,
        "notes": ["No observations are configured; no source connection exists."],
    }


def test_capabilities_are_paginated_by_existing_api_helper_contract_and_defensive():
    capabilities = OfflineLattice().capabilities()
    assert len(capabilities) == 8
    assert {item["implementation"] for item in capabilities} == {"local-demo", "excluded"}
    capabilities[0]["title"] = "tampered"
    assert OfflineLattice().capabilities()[0]["title"] != "tampered"


def test_attention_is_deterministic_and_excludes_weapon_inventory():
    integration = OfflineLattice("mock")
    first = integration.overview(now=datetime(2026, 1, 1, tzinfo=timezone.utc))
    second = integration.overview(now=datetime(2026, 1, 1, tzinfo=timezone.utc))
    assert first == second
    assert first["attention"]
    assert len({item["id"] for item in first["attention"]}) == len(first["attention"])
    assert not any(item["entityId"] in {"synthetic-effector-001", "synthetic-weapon-001"} for item in first["attention"])
    assert {item["code"] for item in first["attention"]} == {"observation_stale", "observation_unknown", "reported_offline", "health_unknown"}
    first["platforms"][0]["aliases"]["name"] = "changed"
    first["attention"][0]["title"] = "changed"
    first["summary"]["freshness"]["stale"] = 999
    first["diagnostics"]["notes"].append("changed")
    assert integration.overview(now=datetime(2026, 1, 1, tzinfo=timezone.utc)) == second


def test_future_attention_and_honest_connectivity_flags():
    overview = OfflineLattice("mock").overview(now=datetime(2024, 1, 1, tzinfo=timezone.utc))
    assert overview["summary"]["freshness"]["future"] == 2
    assert sum(item["code"] == "observation_future" for item in overview["attention"]) == 2
    assert overview["connected"] is False
    assert overview["diagnostics"]["transport"] == "none"
    for flag in ("networkAccess", "deviceAccess", "meshAvailable"):
        assert overview["diagnostics"][flag] is False


def test_source_time_is_chronological_and_location_needs_coordinate_pair(monkeypatch):
    integration = OfflineLattice("mock")
    records = [
        map_entity({"entityId": "whole", "provenance": {"sourceUpdateTime": "2025-01-01T00:00:00Z"},
                    "location": {"position": {"altitudeHaeMeters": 12}}}, now=NOW),
        map_entity({"entityId": "fraction", "provenance": {"sourceUpdateTime": "2025-01-01T00:00:00.5Z"},
                    "location": {"position": {"latitudeDegrees": 0, "longitudeDegrees": 0}},
                    "sensors": {"sensors": [{"sensorId": "unknown-state", "operationalState": "not-known"}]}}, now=NOW),
        map_entity({"entityId": "partial", "location": {"position": {"latitudeDegrees": 1}}}, now=NOW),
    ]
    monkeypatch.setattr(integration, "list_platforms", lambda **_: records)
    overview = integration.overview(now=NOW)
    assert overview["diagnostics"]["lastSourceUpdateTime"] == "2025-01-01T00:00:00.500000Z"
    assert overview["summary"]["locatedCount"] == 1
    assert any(item["code"] == "sensor_state_unknown" for item in overview["attention"])
    assert records[0]["location"]["position"] == {"altitudeHaeMeters": 12.0}
