"""Read-only access to the checked-in Warden model readiness manifest."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

_ROOT = Path(__file__).resolve().parents[1]
_MANIFEST = _ROOT / "configs" / "warden-model-status.json"


def model_status() -> dict[str, Any]:
    document = json.loads(_MANIFEST.read_text(encoding="utf-8"))
    if (document.get("schemaVersion") != 1 or document.get("advisoryOnly") is not True
            or document.get("weightsAvailable") is not False
            or document.get("automaticDownloads") is not False
            or not isinstance(document.get("models"), list) or len(document["models"]) != 8):
        raise ValueError("Warden model status manifest failed its local safety checks")
    return document


__all__ = ["model_status"]
