"""Persistence boundary for the Management API.

The API's domain methods can use either InMemoryStore or PostgresStore. The
Postgres implementation is opt-in and requires psycopg 3 plus an applied
migration. It intentionally contains no aircraft command/control behavior.
"""
from __future__ import annotations

import copy
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol

from telemetry_policy import compute_freshness, event_key as telemetry_event_key
from maintenance_validation import MaintenancePatchError, normalize_maintenance_patch

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover - optional dependency for local memory mode
    psycopg = None
    dict_row = None

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / "services" / "management-api" / "migrations"


def deep_copy(value: Any) -> Any:
    return copy.deepcopy(value)


def iso_utc(value: datetime | str | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_utc(value: datetime | str) -> datetime:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc)
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def json_value(value: Any) -> Any:
    return json.loads(json.dumps(value))


class StoreProtocol(Protocol):
    def list_aircraft(self) -> list[dict[str, Any]]: ...
    def add_aircraft(self, aircraft: dict[str, Any]) -> dict[str, Any]: ...
    def get_aircraft(self, aircraft_id: str) -> dict[str, Any]: ...
    def ingest(self, sample: dict[str, Any], source_id: str = "local-simulator") -> dict[str, Any]: ...
    def current_view(self, aircraft_id: str, source: str | None = None) -> dict[str, Any]: ...
    def history(self, aircraft_id: str, source: str | None = None) -> list[dict[str, Any]]: ...
    def ingestion_status(self, aircraft_id: str) -> dict[str, Any]: ...
    def evidence(self, aircraft_id: str) -> list[dict[str, Any]]: ...
    def maintenance(self, aircraft_id: str) -> list[dict[str, Any]]: ...
    def add_maintenance(self, record: dict[str, Any]) -> dict[str, Any]: ...
    def update_maintenance(self, record_id: str, patch: dict[str, Any]) -> dict[str, Any]: ...


class PostgresStore:
    """PostgreSQL repository matching the local store's domain operations.

    One connection is acquired per operation. Ingestion uses a single
    transaction: outcome, history, latest projection, and evidence either all
    commit or none do. Pooling and request-scoped auth are intentionally left
    to the service integration layer.
    """

    storage_name = "postgresql"

    def __init__(self, dsn: str | None = None, connect_timeout: int = 5, failure_hook=None):
        if psycopg is None:
            raise RuntimeError("PostgresStore requires psycopg[binary]; install requirements-prod.txt")
        self.dsn = dsn or os.environ.get("UCAS_DATABASE_URL")
        if not self.dsn:
            raise RuntimeError("UCAS_DATABASE_URL is required for PostgreSQL storage")
        self.connect_timeout = connect_timeout
        # Test-only seam: a callback can raise after history insertion to
        # prove the transaction rolls back all related writes.
        self.failure_hook = failure_hook

    def connection(self):
        return psycopg.connect(self.dsn, row_factory=dict_row, connect_timeout=self.connect_timeout)

    @staticmethod
    def _aircraft_row(row: dict[str, Any]) -> dict[str, Any]:
        result = {key: row[key] for key in ("schema_version", "aircraft_id", "display_name", "lifecycle_status", "hardware_revision")}
        return result

    @staticmethod
    def _telemetry_row(row: dict[str, Any]) -> dict[str, Any]:
        payload = deep_copy(row["payload"])
        payload["received_at"] = iso_utc(row["received_at"])
        payload["source_id"] = row["source_id"]
        payload["event_key"] = row.get("event_key", payload.get("event_key"))
        payload["ingestion_status"] = row.get("ingestion_status", payload.get("ingestion_status", "accepted"))
        payload["timestamp"] = iso_utc(row["sampled_at"])
        return payload

    def list_aircraft(self) -> list[dict[str, Any]]:
        with self.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT schema_version, aircraft_id, display_name, lifecycle_status, hardware_revision FROM aircraft ORDER BY aircraft_id")
            return [self._aircraft_row(row) for row in cur.fetchall()]

    def add_aircraft(self, aircraft: dict[str, Any]) -> dict[str, Any]:
        with self.connection() as conn, conn.cursor() as cur:
            try:
                cur.execute("""
                    INSERT INTO aircraft(schema_version, aircraft_id, display_name, lifecycle_status, hardware_revision)
                    VALUES (%s, %s, %s, %s, %s)
                    RETURNING schema_version, aircraft_id, display_name, lifecycle_status, hardware_revision
                """, (aircraft.get("schema_version", "1.0"), aircraft["aircraft_id"], aircraft["display_name"], aircraft["lifecycle_status"], aircraft.get("hardware_revision")))
            except psycopg.errors.UniqueViolation as exc:
                raise ValueError("aircraft_exists") from exc
            return self._aircraft_row(cur.fetchone())

    def get_aircraft(self, aircraft_id: str) -> dict[str, Any]:
        with self.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT schema_version, aircraft_id, display_name, lifecycle_status, hardware_revision FROM aircraft WHERE aircraft_id = %s", (aircraft_id,))
            row = cur.fetchone()
            if row is None:
                raise KeyError("aircraft_not_found")
            return self._aircraft_row(row)

    def ingest(self, sample: dict[str, Any], source_id: str = "local-simulator") -> dict[str, Any]:
        event_key = telemetry_event_key(sample, source_id)
        with self.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT 1 FROM aircraft WHERE aircraft_id = %s FOR UPDATE", (sample["aircraft_id"],))
            if cur.fetchone() is None:
                raise KeyError("aircraft_not_found")
            sampled_at = sample["timestamp"]
            received_at = datetime.now(timezone.utc)
            cur.execute("""
                SELECT sampled_at, sequence, event_key FROM telemetry_latest
                WHERE aircraft_id = %s AND source = %s
            """, (sample["aircraft_id"], sample["source"]))
            latest = cur.fetchone()
            late = latest is not None and (parse_utc(sampled_at), sample["sequence"], event_key) < (parse_utc(latest["sampled_at"]), latest["sequence"], latest["event_key"])
            cur.execute("SELECT 1 FROM telemetry_history WHERE event_key = %s", (event_key,))
            duplicate = cur.fetchone() is not None
            status = "duplicate" if duplicate else ("late" if late else "accepted")
            cur.execute("""
                INSERT INTO telemetry_ingestion_outcomes
                    (attempt_id, event_key, aircraft_id, source_id, source, sequence, sampled_at, received_at, status)
                VALUES (%s, %s, %s, %s, %s, %s, %s::timestamptz, %s, %s)
            """, (uuid.uuid4(), event_key, sample["aircraft_id"], source_id, sample["source"], sample["sequence"], sampled_at, received_at, status))
            if duplicate:
                return {"event_key": event_key, "aircraft_id": sample["aircraft_id"], "source_id": source_id, "source": sample["source"], "sequence": sample["sequence"], "sampled_at": sampled_at, "received_at": iso_utc(received_at), "status": status}
            payload = json_value(sample)
            payload["received_at"] = iso_utc(received_at)
            cur.execute("""
                INSERT INTO telemetry_history(event_key, aircraft_id, source_id, source, sequence, sampled_at, received_at, ingestion_status, payload)
                VALUES (%s, %s, %s, %s, %s, %s::timestamptz, %s, %s, %s::jsonb)
                RETURNING telemetry_id
            """, (event_key, sample["aircraft_id"], source_id, sample["source"], sample["sequence"], sampled_at, received_at, status, json.dumps(payload)))
            telemetry_id = cur.fetchone()["telemetry_id"]
            if self.failure_hook is not None:
                self.failure_hook("after_history")
            if not late:
                cur.execute("""
                    INSERT INTO telemetry_latest(aircraft_id, source, telemetry_id, event_key, source_id, sequence, sampled_at, received_at, ingestion_status, payload)
                    VALUES (%s, %s, %s, %s, %s, %s, %s::timestamptz, %s, %s, %s::jsonb)
                    ON CONFLICT (aircraft_id, source) DO UPDATE SET
                        telemetry_id = EXCLUDED.telemetry_id, event_key = EXCLUDED.event_key, source_id = EXCLUDED.source_id,
                        sequence = EXCLUDED.sequence, sampled_at = EXCLUDED.sampled_at,
                        received_at = EXCLUDED.received_at, ingestion_status = EXCLUDED.ingestion_status,
                        payload = EXCLUDED.payload, updated_at = now()
                    WHERE (telemetry_latest.sampled_at, telemetry_latest.sequence, telemetry_latest.event_key COLLATE "C")
                        < (EXCLUDED.sampled_at, EXCLUDED.sequence, EXCLUDED.event_key COLLATE "C")
                """, (sample["aircraft_id"], sample["source"], telemetry_id, event_key, source_id, sample["sequence"], sampled_at, received_at, status, json.dumps(payload)))
            event_id = f"evidence-{uuid.uuid4().hex[:12]}"
            cur.execute("""
                INSERT INTO evidence_events(event_id, aircraft_id, event_type, occurred_at, received_at, source_id, sequence, integrity_reference)
                VALUES (%s, %s, %s, %s::timestamptz, %s, %s, %s, %s)
            """, (event_id, sample["aircraft_id"], "telemetry_accepted" if status == "accepted" else "telemetry_late", sampled_at, received_at, source_id, sample["sequence"], event_key))
            return {"event_key": event_key, "aircraft_id": sample["aircraft_id"], "source_id": source_id, "source": sample["source"], "sequence": sample["sequence"], "sampled_at": sampled_at, "received_at": iso_utc(received_at), "status": status}

    def _telemetry_query(self, aircraft_id: str, source: str | None = None, latest: bool = False) -> list[dict[str, Any]]:
        table = "telemetry_latest" if latest else "telemetry_history"
        source_clause = " AND source = %s" if source else ""
        params: list[Any] = [aircraft_id] + ([source] if source else [])
        columns = "*"
        query = f"SELECT {columns} FROM {table} WHERE aircraft_id = %s{source_clause} ORDER BY sampled_at DESC, sequence DESC, event_key COLLATE \"C\" DESC"
        with self.connection() as conn, conn.cursor() as cur:
            cur.execute(query, params)
            return [self._telemetry_row(row) for row in cur.fetchall()]

    def history(self, aircraft_id: str, source: str | None = None) -> list[dict[str, Any]]:
        return list(reversed(self._telemetry_query(aircraft_id, source, latest=False)))

    def current_view(self, aircraft_id: str, source: str | None = None) -> dict[str, Any]:
        rows = self._telemetry_query(aircraft_id, source, latest=True)
        if not rows:
            return {"aircraft_id": aircraft_id, "sample": None, "freshness": "missing", "age_seconds": None,
                    "telemetry_trust": "untrusted", "flight_ready": False}
        sample = rows[0]
        now = datetime.now(timezone.utc)
        sampled_at = datetime.fromisoformat(sample["timestamp"].replace("Z", "+00:00"))
        age = max(0.0, (now - sampled_at).total_seconds())
        freshness = compute_freshness(sample, sample.get("received_at"), now=now)
        return {"aircraft_id": aircraft_id, "sample": deep_copy(sample), "sampled_at": sample["timestamp"], "received_at": sample["received_at"], "source": sample["source"], "source_id": sample.get("source_id"), **freshness, "age_seconds": age, "last_accepted_sequence": sample["sequence"], "last_ingestion_status": sample.get("ingestion_status", "accepted")}

    def ingestion_status(self, aircraft_id: str) -> dict[str, Any]:
        with self.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT status, count(*) AS count, max(received_at) AS last_received_at FROM telemetry_ingestion_outcomes WHERE aircraft_id = %s GROUP BY status", (aircraft_id,))
            rows = cur.fetchall()
            counts = {row["status"]: row["count"] for row in rows}
            last = max((row["last_received_at"] for row in rows if row["last_received_at"]), default=None)
            return {"aircraft_id": aircraft_id, "counts": counts, "last_received_at": iso_utc(last)}

    def evidence(self, aircraft_id: str) -> list[dict[str, Any]]:
        with self.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT event_id, aircraft_id, event_type, occurred_at, received_at, source_id, sequence, integrity_reference FROM evidence_events WHERE aircraft_id = %s ORDER BY received_at DESC", (aircraft_id,))
            return [{**row, "occurred_at": iso_utc(row["occurred_at"]), "received_at": iso_utc(row["received_at"])} for row in cur.fetchall()]

    def maintenance(self, aircraft_id: str) -> list[dict[str, Any]]:
        with self.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT schema_version, record_id, aircraft_id, summary, status, created_at, completed_at, notes FROM maintenance_records WHERE aircraft_id = %s ORDER BY created_at DESC", (aircraft_id,))
            return [{**row, "created_at": iso_utc(row["created_at"]), "completed_at": iso_utc(row["completed_at"])} for row in cur.fetchall()]

    def add_maintenance(self, record: dict[str, Any]) -> dict[str, Any]:
        with self.connection() as conn, conn.cursor() as cur:
            try:
                cur.execute("""
                    INSERT INTO maintenance_records(schema_version, record_id, aircraft_id, summary, status, created_at, completed_at, notes)
                    VALUES (%s, %s, %s, %s, %s, %s::timestamptz, %s::timestamptz, %s)
                    RETURNING schema_version, record_id, aircraft_id, summary, status, created_at, completed_at, notes
                """, (record.get("schema_version", "1.0"), record["record_id"], record["aircraft_id"], record["summary"], record["status"], record["created_at"], record.get("completed_at"), record.get("notes")))
            except psycopg.errors.UniqueViolation as exc:
                raise ValueError("maintenance_exists") from exc
            row = cur.fetchone()
            return {**row, "created_at": iso_utc(row["created_at"]), "completed_at": iso_utc(row["completed_at"])}

    def update_maintenance(self, record_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        with self.connection() as conn, conn.cursor() as cur:
            cur.execute("""
                SELECT schema_version, record_id, aircraft_id, summary, status,
                       created_at, completed_at, notes
                FROM maintenance_records
                WHERE record_id = %s
                FOR UPDATE
            """, (record_id,))
            row = cur.fetchone()
            if row is None:
                raise KeyError("maintenance_not_found")
            current = {**row, "created_at": iso_utc(row["created_at"]), "completed_at": iso_utc(row["completed_at"])}
            try:
                updated = normalize_maintenance_patch(current, patch)
            except MaintenancePatchError as error:
                details = f":{error.details}" if error.details is not None else ""
                raise ValueError(f"invalid_patch:{error.message}{details}") from error
            cur.execute("""
                UPDATE maintenance_records
                SET summary = %s, status = %s, completed_at = %s::timestamptz,
                    notes = %s, version = version + 1
                WHERE record_id = %s
                RETURNING schema_version, record_id, aircraft_id, summary, status, created_at, completed_at, notes
            """, (updated["summary"], updated["status"], updated.get("completed_at"), updated.get("notes"), record_id))
            row = cur.fetchone()
            return {**row, "created_at": iso_utc(row["created_at"]), "completed_at": iso_utc(row["completed_at"])}


def apply_migrations(dsn: str | None = None) -> None:
    """Apply numbered SQL files in lexical order using one transaction each."""
    if psycopg is None:
        raise RuntimeError("apply_migrations requires psycopg[binary]")
    database_url = dsn or os.environ.get("UCAS_DATABASE_URL")
    if not database_url:
        raise RuntimeError("UCAS_DATABASE_URL is required")
    migration_files = sorted(MIGRATIONS.glob("*.sql"))
    with psycopg.connect(database_url) as conn:
        for migration in migration_files:
            with conn.cursor() as cur:
                cur.execute(migration.read_text())


def build_store():
    """Select storage explicitly; memory remains the safe local default."""
    if os.environ.get("UCAS_STORAGE", "memory").lower() == "postgres":
        return PostgresStore()
    return None
