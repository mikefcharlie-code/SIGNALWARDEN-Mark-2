from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services" / "management-api"))
from telemetry_policy import compute_freshness


NOW = datetime(2025, 1, 1, tzinfo=timezone.utc)


def sample(**overrides):
    value = {
        "schema_version": "1.1",
        "timestamp": "2024-12-31T23:59:55Z",
        "received_at": "2024-12-31T23:59:59Z",
        "autopilot": {"heartbeat_age_seconds": 4.9},
        "health": {"battery_voltage_v": 12.0, "battery_percent": 80, "temperature_c": 20, "status": "nominal"},
        "position": {"age_seconds": 1.0},
    }
    value.update(overrides)
    return value


def test_effective_heartbeat_age_catches_delayed_snapshot_and_preserves_raw():
    value = sample(observation={"heartbeat_timeout_seconds": 9.8, "field_timeout_seconds": 10.0, "battery_age_seconds": 0.0, "system_status_age_seconds": 0.0})
    original = value.copy()
    result = compute_freshness(value, value["received_at"], now=NOW)
    assert result["snapshot_freshness"] == "fresh"
    assert result["connectivity"] == "stale"
    assert result["effective_ages"]["heartbeat"] == 9.9
    assert value == original


def test_fractional_deadline_is_inclusive_and_missing_observation_is_unknown():
    value = sample(observation={"heartbeat_timeout_seconds": 9.9, "field_timeout_seconds": 5.0})
    assert compute_freshness(value, value["received_at"], now=NOW)["connectivity"] == "live"
    value["observation"]["heartbeat_timeout_seconds"] = 0
    assert compute_freshness(value, value["received_at"], now=NOW)["connectivity"] == "unknown"
    value.pop("observation")
    assert compute_freshness(value, value["received_at"], now=NOW)["freshness"] == "unknown"


def test_future_clock_is_clamped_but_receipt_age_remains_conservative():
    value = sample(timestamp="2025-01-01T00:00:10Z", received_at="2024-12-31T23:59:59Z", observation={"heartbeat_timeout_seconds": 2.0, "field_timeout_seconds": 2.0})
    result = compute_freshness(value, value["received_at"], now=NOW)
    assert result["effective_ages"]["heartbeat"] == 1.0 + 4.9


def test_reported_battery_fault_without_numeric_measurements_still_has_age():
    value = sample(health={"battery_voltage_v": None, "battery_percent": None,
                           "link_quality_percent": None, "status": "warning"},
                   observation={"heartbeat_timeout_seconds": 30,
                                "field_timeout_seconds": 5,
                                "battery_age_seconds": 0.5,
                                "system_status_age_seconds": None})
    result = compute_freshness(value, value["received_at"], now=NOW)
    assert result["effective_ages"]["battery"] == 5.5
    assert result["field_freshness"]["battery"] == "stale"


def test_exact_rabbit_outage_case_and_fractional_boundary():
    value = sample(timestamp=(NOW - timedelta(seconds=20)).isoformat().replace("+00:00", "Z"),
                   observation={"heartbeat_timeout_seconds": 5,
                                "field_timeout_seconds": 5,
                                "battery_age_seconds": 1,
                                "system_status_age_seconds": 2})
    result = compute_freshness(value, value["received_at"], now=NOW)
    assert result["snapshot_freshness"] == "fresh"
    assert result["freshness"] == "stale"
    assert result["connectivity"] == "stale"
    assert result["effective_ages"]["heartbeat"] == 24.9
    assert result["field_freshness"]["position"] == "stale"
    value["timestamp"] = value["received_at"] = NOW.isoformat().replace("+00:00", "Z")
    assert compute_freshness(value, value["received_at"], now=NOW + timedelta(seconds=.1))["connectivity"] == "live"
    assert compute_freshness(value, value["received_at"], now=NOW + timedelta(seconds=.100001))["connectivity"] == "stale"


def test_legacy_snapshot_behavior_stays_compatible():
    value = sample(schema_version="1.0")
    result = compute_freshness(value, value["received_at"], now=NOW)
    assert result["freshness"] == "fresh"
    assert result["connectivity"] == "unknown"
    assert result["field_freshness"]["battery"] == "unknown"


def test_in_memory_view_delayed_delivery_outage_and_session_recovery():
    import importlib.util
    import copy
    from services.aircraft_gateway.mapper import TelemetryMapper
    from test_aircraft_mapper import heartbeat, message
    root = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location("freshness_memory_api", root / "services/management-api/app.py")
    app = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(app)
    store = app.InMemoryStore()
    mapper = TelemetryMapper("sim-ucas-001", "px4", 7)
    assert mapper.accept(heartbeat(), now=100)
    assert mapper.accept(message("SYS_STATUS", voltage_battery=12000), now=100)
    old_stamp = (datetime.now(timezone.utc) - timedelta(seconds=20)).isoformat().replace("+00:00", "Z")
    old = mapper.snapshot(now=104.9, timestamp=old_stamp)
    untouched = copy.deepcopy(old)
    store.ingest(old)
    view = store.current_view("sim-ucas-001")
    assert view["snapshot_freshness"] == "fresh"
    assert view["freshness"] == "stale"
    assert view["connectivity"] == "stale"
    assert view["effective_ages"]["heartbeat"] >= 24.9
    assert view["field_freshness"]["battery"] == "stale"
    assert old == untouched
    assert mapper.accept(heartbeat(), now=110)
    recovered = mapper.snapshot(now=110)
    store.ingest(recovered)
    current = store.current_view("sim-ucas-001")
    assert current["connectivity"] == "live"
    assert current["freshness"] == "fresh"
    assert current["sample"]["session_id"] != old["session_id"]
    assert current["sample"]["health"]["battery_voltage_v"] is None
