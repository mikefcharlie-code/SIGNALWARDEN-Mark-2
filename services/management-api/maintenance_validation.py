"""Shared maintenance patch validation for the management stores."""
from __future__ import annotations

import copy
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker


_ALLOWED_PATCH_FIELDS = {"summary", "status", "completed_at", "notes"}
_ROOT = Path(__file__).resolve().parents[2]
_SCHEMA = json.loads((_ROOT / "packages" / "contracts" / "v1" / "maintenance.schema.json").read_text())
_VALIDATOR = Draft202012Validator(_SCHEMA, format_checker=FormatChecker())


class MaintenancePatchError(ValueError):
    """A client-visible maintenance patch validation failure."""

    def __init__(self, message: str, details: Any = None):
        super().__init__(message)
        self.message = message
        self.details = details


def _iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def normalize_maintenance_patch(current: dict[str, Any], patch: Any) -> dict[str, Any]:
    """Return a validated merged record, without mutating ``current`` or ``patch``.

    Completion timestamps are generated when transitioning to ``completed`` and
    no timestamp is present, matching the in-memory store's behavior.
    """
    if not isinstance(patch, dict) or not patch:
        raise MaintenancePatchError("patch must be a non-empty JSON object")
    unknown = sorted(set(patch) - _ALLOWED_PATCH_FIELDS)
    if unknown:
        raise MaintenancePatchError("fields cannot be changed", {"fields": unknown})

    merged = copy.deepcopy(current)
    # SQL NULL represents an absent optional property in the JSON contract.
    # Only normalize stored fields: explicitly supplied nulls remain invalid.
    for field in ("completed_at", "notes"):
        if merged.get(field) is None:
            merged.pop(field, None)
    merged.update(copy.deepcopy(patch))
    if merged.get("status") == "completed" and "completed_at" not in merged:
        merged["completed_at"] = _iso_now()

    errors = sorted(_VALIDATOR.iter_errors(merged), key=lambda error: list(error.path))
    if errors:
        error = errors[0]
        location = ".".join(str(item) for item in error.path) or "body"
        raise MaintenancePatchError(f"{location}: {error.message}")
    return merged
