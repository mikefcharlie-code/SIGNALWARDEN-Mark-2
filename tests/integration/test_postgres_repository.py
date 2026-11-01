"""Real PostgreSQL repository tests.

Run with Docker available:
    pytest -m integration tests/integration/test_postgres_repository.py -v

The module skips cleanly when Docker or Testcontainers dependencies are not
available. CI should install requirements-dev.txt and provide Docker.
"""
from __future__ import annotations

import importlib.util
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

try:
    try:
        from testcontainers.community.postgres import PostgresContainer
    except ImportError:
        from testcontainers.postgres import PostgresContainer
except ImportError:  # pragma: no cover - environment-dependent import
    PostgresContainer = None

ROOT = Path(__file__).resolve().parents[2]
SERVICE = ROOT / "services" / "management-api"
sys.path.insert(0, str(SERVICE))
SPEC = importlib.util.spec_from_file_location("ucas_postgres_persistence", SERVICE / "persistence.py")
persistence = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(persistence)

pytestmark = pytest.mark.integration


def _normalize_dsn(url: str) -> str:
    """Convert Testcontainers' SQLAlchemy-style URL for psycopg 3."""
    return url.replace("postgresql+psycopg2://", "postgresql://", 1)


def _sample(sequence: int, timestamp: datetime) -> dict:
    stamp = timestamp.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return {
        "schema_version": "1.0",
        "aircraft_id": "pg-ucas-001",
        "timestamp": stamp,
        "received_at": stamp,
        "sequence": sequence,
        "source": "simulated",
        "health": {
            "battery_voltage_v": 12.2,
            "battery_percent": 88,
            "link_quality_percent": 96,
            "temperature_c": 25,
            "status": "nominal",
        },
    }


@pytest.fixture(scope="session")
def postgres_dsn():
    if PostgresContainer is None:
        pytest.skip("testcontainers is not installed; install requirements-dev.txt")
    try:
        container = PostgresContainer("postgres:16-alpine")
        container.start()
    except Exception as exc:  # Docker daemon/image/network availability varies by runner.
        pytest.skip(f"Docker/Testcontainers unavailable: {exc}")
    try:
        dsn = _normalize_dsn(container.get_connection_url())
        persistence.apply_migrations(dsn)
        # Prove the migration is idempotent before any repository test runs.
        persistence.apply_migrations(dsn)
        yield dsn
    finally:
        container.stop()


@pytest.fixture
def store(postgres_dsn):
    store = persistence.PostgresStore(postgres_dsn)
    with store.connection() as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE audit_events, evidence_events, maintenance_records, telemetry_latest, telemetry_history, telemetry_ingestion_outcomes, source_registrations, aircraft RESTART IDENTITY CASCADE")
        cur.execute("""
            INSERT INTO aircraft(schema_version, aircraft_id, display_name, lifecycle_status, hardware_revision)
            VALUES ('1.0', 'pg-ucas-001', 'Postgres Test Aircraft', 'planned', 'test-revision')
        """)
    return store


def test_migration_created_schema_and_is_idempotent(postgres_dsn):
    with persistence.PostgresStore(postgres_dsn).connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT version FROM schema_migrations ORDER BY version")
        assert [row["version"] for row in cur.fetchall()] == ["001_initial"]
        cur.execute("SELECT to_regclass('public.telemetry_history') AS history_table, to_regclass('public.telemetry_latest') AS latest_table")
        row = cur.fetchone()
        assert row["history_table"] == "telemetry_history"
        assert row["latest_table"] == "telemetry_latest"


def test_ingest_commits_history_latest_outcome_and_evidence(store):
    sample = _sample(1, datetime.now(timezone.utc))
    result = store.ingest(sample, "test-source")
    assert result["status"] == "accepted"
    assert store.history("pg-ucas-001")[0]["sequence"] == 1
    assert store.current_view("pg-ucas-001")["last_accepted_sequence"] == 1
    assert store.ingestion_status("pg-ucas-001")["counts"] == {"accepted": 1}
    evidence = store.evidence("pg-ucas-001")
    assert len(evidence) == 1
    assert evidence[0]["event_type"] == "telemetry_accepted"


def test_duplicate_replay_is_recorded_without_duplicate_history(store):
    sample = _sample(2, datetime.now(timezone.utc))
    first = store.ingest(sample, "test-source")
    second = store.ingest(sample, "test-source")
    assert first["status"] == "accepted"
    assert second["status"] == "duplicate"
    assert len(store.history("pg-ucas-001")) == 1
    assert store.ingestion_status("pg-ucas-001")["counts"] == {"accepted": 1, "duplicate": 1}


def test_late_sample_is_retained_but_does_not_replace_latest(store):
    now = datetime.now(timezone.utc)
    newer = store.ingest(_sample(20, now), "test-source")
    older = store.ingest(_sample(19, now - timedelta(seconds=2)), "test-source")
    assert newer["status"] == "accepted"
    assert older["status"] == "late"
    assert len(store.history("pg-ucas-001")) == 2
    assert store.current_view("pg-ucas-001")["last_accepted_sequence"] == 20


def test_ingest_transaction_rolls_back_on_post_history_failure(store):
    def fail_after_history(stage):
        if stage == "after_history":
            raise RuntimeError("simulated projection failure")

    failing_store = persistence.PostgresStore(store.dsn, failure_hook=fail_after_history)
    with pytest.raises(RuntimeError, match="simulated projection failure"):
        failing_store.ingest(_sample(30, datetime.now(timezone.utc)), "rollback-source")

    with failing_store.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) AS count FROM telemetry_history WHERE aircraft_id = 'pg-ucas-001'")
        assert cur.fetchone()["count"] == 0
        cur.execute("SELECT count(*) AS count FROM telemetry_latest WHERE aircraft_id = 'pg-ucas-001'")
        assert cur.fetchone()["count"] == 0
        cur.execute("SELECT count(*) AS count FROM evidence_events WHERE aircraft_id = 'pg-ucas-001'")
        assert cur.fetchone()["count"] == 0
        cur.execute("SELECT count(*) AS count FROM telemetry_ingestion_outcomes WHERE aircraft_id = 'pg-ucas-001'")
        assert cur.fetchone()["count"] == 0


def test_maintenance_persists_and_increments_version(store):
    record = {
        "schema_version": "1.0",
        "record_id": "pg-maint-001",
        "aircraft_id": "pg-ucas-001",
        "summary": "PostgreSQL integration inspection",
        "status": "open",
        "created_at": "2026-01-01T00:00:00Z",
    }
    assert store.add_maintenance(record)["record_id"] == "pg-maint-001"
    updated = store.update_maintenance("pg-maint-001", {"status": "in_progress", "notes": "Test note"})
    assert updated["status"] == "in_progress"
    assert store.maintenance("pg-ucas-001")[0]["notes"] == "Test note"
    with store.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT version FROM maintenance_records WHERE record_id = 'pg-maint-001'")
        assert cur.fetchone()["version"] == 2


def test_maintenance_patch_validates_merged_record_without_partial_mutation(store):
    record = {
        "schema_version": "1.0",
        "record_id": "pg-maint-validation-001",
        "aircraft_id": "pg-ucas-001",
        "summary": "PostgreSQL validation inspection",
        "status": "open",
        "created_at": "2026-01-01T00:00:00Z",
    }
    store.add_maintenance(record)
    before = store.maintenance(record["aircraft_id"])[0]

    for patch in ({}, {"status": "invalid"}, {"summary": ""}, {"completed_at": "not-a-timestamp"}):
        with pytest.raises(ValueError, match="invalid_patch"):
            store.update_maintenance(record["record_id"], patch)

    assert store.maintenance(record["aircraft_id"])[0] == before
    with store.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT version FROM maintenance_records WHERE record_id = %s", (record["record_id"],))
        assert cur.fetchone()["version"] == 1


def test_postgres_completion_patch_gets_timestamp(store):
    record = {
        "schema_version": "1.0",
        "record_id": "pg-maint-completion-001",
        "aircraft_id": "pg-ucas-001",
        "summary": "PostgreSQL completion inspection",
        "status": "open",
        "created_at": "2026-01-01T00:00:00Z",
    }
    store.add_maintenance(record)

    updated = store.update_maintenance(record["record_id"], {"status": "completed"})

    assert updated["status"] == "completed"
    assert updated["completed_at"].endswith("Z")
