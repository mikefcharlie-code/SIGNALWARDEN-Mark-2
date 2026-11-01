"""Fail-closed authentication for real-aircraft telemetry publishers."""
from __future__ import annotations

import hmac
import json
import os
import re
from pathlib import Path
from typing import Any


class PublisherConfigError(Exception):
    """The configured publisher file is unavailable or invalid."""


class PublisherAuthError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def _validate_config(document: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(document, dict):
        raise PublisherConfigError("publisher configuration must be a JSON object")
    result: dict[str, dict[str, Any]] = {}
    for publisher_id, entry in document.items():
        if not isinstance(publisher_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", publisher_id):
            raise PublisherConfigError("publisher IDs must be non-empty strings")
        if not isinstance(entry, dict):
            raise PublisherConfigError("publisher entries must be objects")
        token = entry.get("token")
        aircraft_ids = entry.get("aircraft_ids")
        sources = entry.get("sources")
        if not isinstance(token, str) or len(token) < 32 or not token.isascii() or any(c.isspace() for c in token):
            raise PublisherConfigError("publisher token is invalid")
        if not isinstance(aircraft_ids, list) or not all(isinstance(item, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", item) for item in aircraft_ids):
            raise PublisherConfigError("aircraft_ids must be a string list")
        if not isinstance(sources, list) or not sources or not all(isinstance(item, str) and item in {"aircraft", "simulated"} for item in sources):
            raise PublisherConfigError("sources must contain aircraft or simulated")
        policies = entry.get("ingress_policies", ["unauthenticated"])
        if (not isinstance(policies, list) or not policies or not all(
                isinstance(item, str) and item in {"required-signed", "secure-transport", "unauthenticated"}
                for item in policies)):
            raise PublisherConfigError("ingress_policies must contain supported ingress policies")
        result[publisher_id] = {"token": token, "aircraft_ids": set(aircraft_ids), "sources": set(sources),
                                "ingress_policies": set(policies)}
    return result


def load_publishers(path: str | None = None) -> dict[str, dict[str, Any]] | None:
    """Load the current publisher file; None means synthetic-only mode."""
    configured_path = path if path is not None else os.environ.get("UCAS_TELEMETRY_PUBLISHERS_FILE", "")
    if not configured_path:
        return None
    try:
        with Path(configured_path).open("r", encoding="utf-8") as handle:
            document = json.load(handle)
    except (OSError, ValueError, UnicodeError, RecursionError) as exc:
        raise PublisherConfigError("publisher configuration is unavailable or invalid") from exc
    return _validate_config(document)


def authenticate(*, source_id: str, aircraft_id: str, source: str, authorization: str | None, publishers: dict[str, dict[str, Any]] | None) -> None:
    """Authenticate and authorize a telemetry publisher without exposing secrets."""
    if publishers is None:
        if source != "simulated":
            raise PublisherAuthError(401, "telemetry_auth_required", "real-aircraft telemetry authentication is required")
        return
    if not isinstance(authorization, str) or not authorization.startswith("Bearer "):
        raise PublisherAuthError(401, "telemetry_auth_required", "a bearer token is required")
    token = authorization[7:]
    publisher = publishers.get(source_id)
    if publisher is None or not token.isascii() or not hmac.compare_digest(token, publisher["token"]):
        raise PublisherAuthError(401, "telemetry_auth_failed", "telemetry publisher authentication failed")
    if aircraft_id not in publisher["aircraft_ids"] or source not in publisher["sources"]:
        raise PublisherAuthError(403, "telemetry_binding_mismatch", "publisher is not authorized for this aircraft or source")


def authorize_ingress(*, source_id: str, sample: dict, publishers: dict | None) -> None:
    """Call only AFTER authenticate(). No open simulator trust self-attestation.

    The API authenticates the authorized gateway's assertion, not aircraft
    signatures itself. Missing publisher policy grants only untrusted ingress.
    """
    security = sample.get("ingress_security") or {}
    policy = security.get("policy", "unauthenticated")
    if policy == "unauthenticated":
        return
    publisher = publishers.get(source_id) if publishers is not None else None
    if publisher is None or policy not in publisher.get("ingress_policies", {"unauthenticated"}):
        raise PublisherAuthError(403, "ingress_policy_not_authorized",
                                 "authenticated ingress assertions require an authorized gateway publisher policy")
