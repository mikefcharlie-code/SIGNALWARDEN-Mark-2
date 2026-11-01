import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SERVICE = ROOT / "services" / "management-api"
sys.path.insert(0, str(SERVICE))
SPEC = importlib.util.spec_from_file_location("ucas_maintenance_app", SERVICE / "app.py")
app = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = app
SPEC.loader.exec_module(app)


@pytest.fixture
def record():
    return {
        "schema_version": "1.0",
        "record_id": "maint-validation-001",
        "aircraft_id": "sim-ucas-001",
        "summary": "Inspection",
        "status": "open",
        "created_at": "2026-01-01T00:00:00Z",
    }


def test_in_memory_rejects_invalid_patch_without_mutating_record(record):
    store = app.InMemoryStore()
    store.add_maintenance(record)

    for patch in ({}, {"status": "invalid"}, {"summary": ""}, {"completed_at": "not-a-timestamp"}):
        with pytest.raises(app.ApiError) as exc_info:
            store.update_maintenance(record["record_id"], patch)
        assert exc_info.value.code == "invalid_patch"
        assert store.maintenance(record["aircraft_id"])[0] == record


def test_in_memory_completion_patch_gets_timestamp(record):
    store = app.InMemoryStore()
    store.add_maintenance(record)

    updated = store.update_maintenance(record["record_id"], {"status": "completed"})

    assert updated["status"] == "completed"
    assert updated["completed_at"].endswith("Z")
    assert store.maintenance(record["aircraft_id"])[0] == updated


def test_shared_normalizer_does_not_mutate_inputs(record):
    from maintenance_validation import normalize_maintenance_patch

    patch = {"notes": "new note"}
    updated = normalize_maintenance_patch(record, patch)

    assert record["status"] == "open"
    assert patch == {"notes": "new note"}
    assert updated["notes"] == "new note"


@pytest.mark.parametrize("patch", [
    {"notes": "reviewed"}, {"status": "in_progress"}, {"status": "completed"},
])
def test_database_null_optionals_are_absent_contract_properties(record, patch):
    from maintenance_validation import normalize_maintenance_patch

    stored = {**record, "completed_at": None, "notes": None}
    updated = normalize_maintenance_patch(stored, patch)
    assert updated["status"] == patch.get("status", "open")
    assert updated.get("notes") == patch.get("notes")
    if patch.get("status") == "completed":
        assert updated["completed_at"].endswith("Z")
    else:
        assert "completed_at" not in updated
    assert stored["completed_at"] is None


@pytest.mark.parametrize("patch", [
    {"notes": None}, {"completed_at": None}, {"completed_at": ""},
    {"status": "completed", "completed_at": None},
    {"status": "completed", "completed_at": ""},
])
def test_explicit_invalid_optional_values_are_not_normalized_away(record, patch):
    from maintenance_validation import MaintenancePatchError, normalize_maintenance_patch

    with pytest.raises(MaintenancePatchError):
        normalize_maintenance_patch(record, patch)
