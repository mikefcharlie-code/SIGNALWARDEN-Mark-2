import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_rbac_catalog_has_unique_permissions_and_valid_role_references():
    catalog = json.loads((ROOT / "packages/contracts/v1/rbac-catalog.json").read_text())
    permission_ids = {item["id"] for item in catalog["permissions"]}
    assert len(permission_ids) == len(catalog["permissions"])
    role_ids = set()
    for role in catalog["roles"]:
        assert role["id"] not in role_ids
        role_ids.add(role["id"])
        assert role["immutable"] is True
        assert set(role["permissions"]).issubset(permission_ids)
    assert "telemetry.stream.read" in permission_ids
    assert "aircraft.command.execute" not in permission_ids
    assert all(
        not any(permission.startswith(prefix) for prefix in catalog["forbidden_permission_prefixes"])
        for permission in permission_ids
    )


def test_viewer_and_operator_are_separate_from_access_administration():
    catalog = json.loads((ROOT / "packages/contracts/v1/rbac-catalog.json").read_text())
    roles = {role["id"]: set(role["permissions"]) for role in catalog["roles"]}
    assert "assignments.write" not in roles["telemetry-viewer"]
    assert "assignments.write" not in roles["drone-operator"]
    assert "telemetry.latest.read" in roles["telemetry-viewer"]
    assert "maintenance.write" in roles["drone-operator"]
    assert "assignments.write" in roles["access-administrator"]
