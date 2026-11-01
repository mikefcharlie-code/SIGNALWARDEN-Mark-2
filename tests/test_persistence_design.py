import importlib.util
import inspect
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVICE = ROOT / "services" / "management-api"
sys.path.insert(0, str(SERVICE))
SPEC = importlib.util.spec_from_file_location("ucas_persistence", SERVICE / "persistence.py")
persistence = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(persistence)


class PersistenceDesignTests(unittest.TestCase):
    def test_migration_contains_expected_tables_and_integrity_controls(self):
        sql = (SERVICE / "migrations" / "001_initial.sql").read_text(encoding="utf-8")
        for table in (
            "schema_migrations", "aircraft", "source_registrations",
            "telemetry_ingestion_outcomes", "telemetry_history", "telemetry_latest",
            "maintenance_records", "evidence_events", "audit_events",
        ):
            self.assertIn(f"CREATE TABLE IF NOT EXISTS {table}", sql)
        for marker in (
            "event_key text NOT NULL UNIQUE",
            "PRIMARY KEY (aircraft_id, source)",
            "telemetry_history_aircraft_sampled_idx",
            "telemetry_ingestion_event_key_idx",
            "maintenance_aircraft_created_idx",
            "ON CONFLICT (version) DO NOTHING",
        ):
            self.assertIn(marker, sql)

    def test_postgres_store_exposes_repository_operations(self):
        expected = (
            "list_aircraft", "add_aircraft", "get_aircraft", "ingest", "current_view",
            "history", "ingestion_status", "evidence", "maintenance",
            "add_maintenance", "update_maintenance",
        )
        for method in expected:
            self.assertTrue(callable(getattr(persistence.PostgresStore, method, None)), method)

    def test_migration_runner_is_explicitly_database_configured(self):
        source = (SERVICE / "migrate.py").read_text(encoding="utf-8")
        self.assertIn("UCAS_DATABASE_URL", source)
        self.assertIn("apply_migrations", source)
        self.assertIn("requirements-prod.txt", (SERVICE / "README.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
