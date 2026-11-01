"""Opt-in PostgreSQL integration coverage for the durable repository.

Run against a disposable database only:

    UCAS_DATABASE_URL=postgresql://... pytest -q -m integration

The tests intentionally skip when no DSN is configured so the fast reference
suite remains dependency-light and never guesses a database target.
"""
from __future__ import annotations

import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SERVICE = ROOT / "services" / "management-api"
sys.path.insert(0, str(SERVICE))

psycopg = pytest.importorskip("psycopg")
from persistence import PostgresStore, apply_migrations  # noqa: E402


pytestmark = pytest.mark.integration
DSN = __import__("os").environ.get("UCAS_DATABASE_URL")
if not DSN:
    pytest.skip("UCAS_DATABASE_URL is not configured; PostgreSQL integration is opt-in", allow_module_level=True)


@pytest.fixture
def database():
    apply_migrations(DSN)
    prefix = f"it-{uuid.uuid4().hex[:10]}"
    aircraft_id = f"{prefix}-aircraft"
    store = PostgresStore(DSN)
    store.add_aircraft({
        "schema_version": "1.0",
        "aircraft_id": aircraft_id,
        "display_name": "Integration synthetic aircraft",
        "lifecycle_status": "planned",
        "hardware_revision": "synthetic",
    })
    yield store, aircraft_id
    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        for table in (
            "evidence_events",
            "telemetry_latest",
            "telemetry_history",
            "telemetry_ingestion_outcomes",
            "maintenance_records",
            "source_registrations",
            "aircraft",
        ):
            cur.execute(f"DELETE FROM {table} WHERE aircraft_id = %s", (aircraft_id,))


def sample(aircraft_id: str, sequence: int, timestamp: datetime, source_id: str = "integration-simulator") -> dict:
    return {
        "schema_version": "1.0",
        "aircraft_id": aircraft_id,
        "timestamp": timestamp.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "received_at": timestamp.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "sequence": sequence,
        "source": "simulated",
        "health": {
            "battery_voltage_v": 12.2,
            "battery_percent": 88,
            "link_quality_percent": 96,
            "temperature_c": 25,
            "status": "nominal",
        },
        "source_id": source_id,
    }


def test_migrations_are_idempotent_and_database_is_durable(database):
    store, aircraft_id = database
    apply_migrations(DSN)
    assert store.get_aircraft(aircraft_id)["aircraft_id"] == aircraft_id
    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        cur.execute("SELECT version FROM schema_migrations ORDER BY version")
        assert [row[0] for row in cur.fetchall()] == ["001_initial"]


def test_ingestion_commits_history_latest_evidence_and_duplicate_outcome(database):
    store, aircraft_id = database
    now = datetime.now(timezone.utc).replace(microsecond=0)
    first = store.ingest(sample(aircraft_id, 1, now))
    duplicate = store.ingest(sample(aircraft_id, 1, now))

    assert first["status"] == "accepted"
    assert duplicate["status"] == "duplicate"
    assert duplicate["event_key"] == first["event_key"]
    assert len(store.history(aircraft_id)) == 1
    assert store.current_view(aircraft_id)["last_accepted_sequence"] == 1
    assert any(item["event_type"] == "telemetry_accepted" for item in store.evidence(aircraft_id))
    assert store.ingestion_status(aircraft_id)["counts"] == {"accepted": 1, "duplicate": 1}


def test_late_sample_is_retained_without_replacing_latest(database):
    store, aircraft_id = database
    now = datetime.now(timezone.utc).replace(microsecond=0)
    newer = store.ingest(sample(aircraft_id, 20, now))
    late = store.ingest(sample(aircraft_id, 19, now - timedelta(seconds=2)))

    assert newer["status"] == "accepted"
    assert late["status"] == "late"
    assert len(store.history(aircraft_id)) == 2
    assert store.current_view(aircraft_id)["last_accepted_sequence"] == 20


def test_ingestion_rolls_back_all_related_writes_on_failure(database):
    _, aircraft_id = database
    failing = PostgresStore(DSN, failure_hook=lambda stage: (_ for _ in ()).throw(RuntimeError(stage)))
    now = datetime.now(timezone.utc).replace(microsecond=0)

    with pytest.raises(RuntimeError, match="after_history"):
        failing.ingest(sample(aircraft_id, 30, now))

    assert failing.history(aircraft_id) == []
    assert failing.evidence(aircraft_id) == []
    assert failing.ingestion_status(aircraft_id)["counts"] == {}


def test_maintenance_and_restart_recovery_use_durable_rows(database):
    store, aircraft_id = database
    record_id = f"maint-{uuid.uuid4().hex[:10]}"
    created = store.add_maintenance({
        "schema_version": "1.0",
        "record_id": record_id,
        "aircraft_id": aircraft_id,
        "summary": "Synthetic durable inspection",
        "status": "open",
        "created_at": "2026-01-01T00:00:00Z",
    })
    updated = store.update_maintenance(record_id, {"status": "completed"})
    restarted = PostgresStore(DSN)

    assert created["record_id"] == record_id
    assert updated["status"] == "completed"
    assert restarted.maintenance(aircraft_id)[0]["record_id"] == record_id
    assert restarted.maintenance(aircraft_id)[0]["status"] == "completed"


def test_concurrent_ingestion_serializes_latest_projection(database):
    store, aircraft_id = database
    now = datetime.now(timezone.utc).replace(microsecond=0)

    def ingest(sequence: int):
        return PostgresStore(DSN).ingest(sample(aircraft_id, sequence, now + timedelta(seconds=sequence)))

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(ingest, (40, 41)))

    assert len(results) == 2
    assert {result["status"] for result in results} <= {"accepted", "late"}
    assert PostgresStore(DSN).current_view(aircraft_id)["last_accepted_sequence"] == 41
    assert len(PostgresStore(DSN).history(aircraft_id)) == 2
