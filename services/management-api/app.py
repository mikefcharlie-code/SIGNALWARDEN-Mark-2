"""Dependency-light reference Management API for the UCAS project.

This is a local reference API with optional PostgreSQL persistence and scoped
telemetry publishers. Aircraft links are receive-only external adapters. This
is not a production authorization system and has no command/control routes.
"""
from __future__ import annotations

import base64
import copy
import json
import math
import os
import re
import sys
import threading
import uuid
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from jsonschema import Draft202012Validator, FormatChecker
from maintenance_validation import MaintenancePatchError, normalize_maintenance_patch
from persistence import build_store
from publisher_auth import PublisherAuthError, PublisherConfigError, authenticate, authorize_ingress, load_publishers

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from services.telemetry_stream import TelemetryHub, TokenVerifier, build_tls_context, build_stream_event
from services.telemetry_stream.server import start_background_server
from telemetry_policy import compute_freshness, event_key as telemetry_event_key, ordering_key

CONTRACT_DIR = ROOT / "packages" / "contracts" / "v1"
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
ISO_RE = re.compile(r"Z$")
MAX_LIMIT = 100


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_now() -> str:
    return utc_now().isoformat().replace("+00:00", "Z")


def parse_time(value: str) -> datetime:
    if not isinstance(value, str) or not ISO_RE.search(value):
        raise ValueError("timestamp must be an RFC 3339 UTC value ending in Z")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("timestamp must be a valid RFC 3339 UTC value") from exc


def validate_sample_time(sample: dict[str, Any]) -> None:
    """Reject clock-poisoning samples while allowing all historical samples."""
    sampled_at = parse_time(sample["timestamp"])
    if sampled_at > datetime.now(timezone.utc) + timedelta(seconds=5):
        raise ApiError(400, "timestamp_in_future", "timestamp must not be more than 5 seconds in the future")


def load_validator(name: str) -> Draft202012Validator:
    schema = json.loads((CONTRACT_DIR / f"{name}.schema.json").read_text())
    return Draft202012Validator(schema, format_checker=FormatChecker())


VALIDATORS = {name: load_validator(name) for name in ("aircraft", "telemetry", "maintenance")}


def validate_contract(name: str, document: dict[str, Any]) -> None:
    errors = sorted(VALIDATORS[name].iter_errors(document), key=lambda error: list(error.path))
    if errors:
        error = errors[0]
        location = ".".join(str(item) for item in error.path) or "body"
        raise ApiError(400, "contract_validation_failed", f"{location}: {error.message}")


def deep_copy(value: Any) -> Any:
    return copy.deepcopy(value)


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details: Any = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details


class InMemoryStore:
    """Reference store; replace with durable storage behind the same interfaces."""

    storage_name = "in-memory"

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.aircraft: dict[str, dict[str, Any]] = {}
        self.telemetry: list[dict[str, Any]] = []
        self._ingestion: list[dict[str, Any]] = []
        self._maintenance: dict[str, dict[str, Any]] = {}
        self._evidence: list[dict[str, Any]] = []
        self._seed()

    def _seed(self) -> None:
        aircraft = {
            "schema_version": "1.0",
            "aircraft_id": "sim-ucas-001",
            "display_name": "Synthetic UCAS 001",
            "lifecycle_status": "planned",
            "hardware_revision": "simulation-only",
        }
        self.aircraft[aircraft["aircraft_id"]] = aircraft

    def add_aircraft(self, aircraft: dict[str, Any]) -> dict[str, Any]:
        validate_contract("aircraft", aircraft)
        with self.lock:
            if aircraft["aircraft_id"] in self.aircraft:
                raise ApiError(409, "aircraft_exists", "aircraft_id already exists")
            self.aircraft[aircraft["aircraft_id"]] = deep_copy(aircraft)
            return deep_copy(aircraft)

    def get_aircraft(self, aircraft_id: str) -> dict[str, Any]:
        with self.lock:
            item = self.aircraft.get(aircraft_id)
            if item is None:
                raise ApiError(404, "aircraft_not_found", "aircraft_id was not found")
            return deep_copy(item)

    def list_aircraft(self) -> list[dict[str, Any]]:
        with self.lock:
            return deep_copy(sorted(self.aircraft.values(), key=lambda item: item["aircraft_id"]))

    def ingest(self, sample: dict[str, Any], source_id: str = "local-simulator") -> dict[str, Any]:
        validate_contract("telemetry", sample)
        validate_sample_time(sample)
        aircraft_id = sample["aircraft_id"]
        self.get_aircraft(aircraft_id)
        received_at = iso_now()
        event_key = telemetry_event_key(sample, source_id)
        with self.lock:
            duplicate = any(item["event_key"] == event_key for item in self.telemetry)
            latest = self.latest(aircraft_id, source=sample["source"])
            late = False
            if latest is not None:
                candidate = {**sample, "source_id": source_id, "event_key": event_key}
                late = ordering_key(candidate) < ordering_key(latest)
            outcome = "duplicate" if duplicate else ("late" if late else "accepted")
            result = {
                "event_key": event_key,
                "aircraft_id": aircraft_id,
                "source_id": source_id,
                "source": sample["source"],
                "sequence": sample["sequence"],
                "sampled_at": sample["timestamp"],
                "received_at": received_at,
                "status": outcome,
            }
            self._ingestion.append(deep_copy(result))
            if duplicate:
                return result
            normalized = deep_copy(sample)
            normalized["received_at"] = received_at
            normalized["source_id"] = source_id
            normalized["event_key"] = event_key
            normalized["ingestion_status"] = outcome
            self.telemetry.append(normalized)
            self._evidence.append({
                "event_id": f"evidence-{uuid.uuid4().hex[:12]}",
                "aircraft_id": aircraft_id,
                "event_type": "telemetry_accepted" if outcome == "accepted" else "telemetry_late",
                "occurred_at": sample["timestamp"],
                "received_at": received_at,
                "source_id": source_id,
                "sequence": sample["sequence"],
                "integrity_reference": event_key,
            })
            return result

    def latest(self, aircraft_id: str, source: str | None = None) -> dict[str, Any] | None:
        candidates = [item for item in self.telemetry if item["aircraft_id"] == aircraft_id]
        if source:
            candidates = [item for item in candidates if item["source"] == source]
        if not candidates:
            return None
        return max(candidates, key=ordering_key)

    def current_view(self, aircraft_id: str, source: str | None = None) -> dict[str, Any]:
        latest = self.latest(aircraft_id, source)
        if latest is None:
            return {"aircraft_id": aircraft_id, "sample": None, "freshness": "missing", "age_seconds": None,
                    "telemetry_trust": "untrusted", "flight_ready": False}
        now = datetime.now(timezone.utc)
        freshness = compute_freshness(latest, latest.get("received_at"), now=now)
        age = max(0, (now - parse_time(latest["timestamp"])).total_seconds())
        return {
            "aircraft_id": aircraft_id,
            "sample": deep_copy(latest),
            "sampled_at": latest["timestamp"],
            "received_at": latest["received_at"],
            "source": latest["source"],
            "source_id": latest.get("source_id"),
            **freshness,
            "age_seconds": age,
            "last_accepted_sequence": latest["sequence"],
            "last_ingestion_status": latest.get("ingestion_status", "accepted"),
        }

    def history(self, aircraft_id: str, source: str | None = None) -> list[dict[str, Any]]:
        items = [item for item in self.telemetry if item["aircraft_id"] == aircraft_id]
        if source:
            items = [item for item in items if item["source"] == source]
        return sorted(items, key=ordering_key)

    def ingestion_status(self, aircraft_id: str) -> dict[str, Any]:
        outcomes = [item for item in self._ingestion if item["aircraft_id"] == aircraft_id]
        counts: dict[str, int] = {}
        for item in outcomes:
            counts[item["status"]] = counts.get(item["status"], 0) + 1
        return {"aircraft_id": aircraft_id, "counts": counts, "last_received_at": outcomes[-1]["received_at"] if outcomes else None}

    def evidence(self, aircraft_id: str) -> list[dict[str, Any]]:
        return sorted(
            [deep_copy(item) for item in self._evidence if item["aircraft_id"] == aircraft_id],
            key=lambda item: item["received_at"], reverse=True,
        )

    def maintenance(self, aircraft_id: str) -> list[dict[str, Any]]:
        return sorted(
            [deep_copy(item) for item in self._maintenance.values() if item["aircraft_id"] == aircraft_id],
            key=lambda item: item["created_at"], reverse=True,
        )

    def add_maintenance(self, record: dict[str, Any]) -> dict[str, Any]:
        validate_contract("maintenance", record)
        self.get_aircraft(record["aircraft_id"])
        with self.lock:
            if record["record_id"] in self._maintenance:
                raise ApiError(409, "maintenance_exists", "record_id already exists")
            self._maintenance[record["record_id"]] = deep_copy(record)
            return deep_copy(record)

    def update_maintenance(self, record_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            current = self._maintenance.get(record_id)
            if current is None:
                raise ApiError(404, "maintenance_not_found", "record_id was not found")
            try:
                updated = normalize_maintenance_patch(current, patch)
            except MaintenancePatchError as error:
                raise ApiError(400, "invalid_patch", error.message, error.details) from error
            self._maintenance[record_id] = updated
            return deep_copy(updated)


STORE = build_store() or InMemoryStore()
STREAM_HUB = TelemetryHub()


def encode_cursor(offset: int) -> str:
    return base64.urlsafe_b64encode(str(offset).encode()).decode().rstrip("=")


def decode_cursor(cursor: str | None) -> int:
    if not cursor:
        return 0
    try:
        value = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
        offset = int(value)
        if offset < 0:
            raise ValueError
        return offset
    except (ValueError, UnicodeDecodeError, base64.binascii.Error) as exc:
        raise ApiError(400, "invalid_cursor", "cursor is invalid") from exc


def paginate(items: list[Any], query: dict[str, list[str]]) -> dict[str, Any]:
    try:
        limit = int(query.get("limit", ["50"])[0])
    except ValueError as exc:
        raise ApiError(400, "invalid_limit", "limit must be an integer") from exc
    if limit < 1 or limit > MAX_LIMIT:
        raise ApiError(400, "invalid_limit", f"limit must be between 1 and {MAX_LIMIT}")
    offset = decode_cursor(query.get("cursor", [None])[0])
    page = items[offset:offset + limit]
    next_cursor = encode_cursor(offset + limit) if offset + limit < len(items) else None
    return {"items": deep_copy(page), "count": len(page), "next_cursor": next_cursor}


def require_id(value: str, label: str = "id") -> None:
    if not ID_RE.fullmatch(value):
        raise ApiError(400, "invalid_identifier", f"{label} has an invalid format")


def json_body(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    def reject_constant(value: str) -> None:
        raise ValueError("non-finite JSON number")

    def finite_float(value: str) -> float:
        number = float(value)
        if not math.isfinite(number):
            raise ValueError("JSON number exceeds finite numeric range")
        return number

    try:
        length = int(handler.headers.get("Content-Length", "0"))
        if length <= 0 or length > 1_000_000:
            raise ValueError
        document = json.loads(
            handler.rfile.read(length),
            parse_constant=reject_constant,
            parse_float=finite_float,
        )
        if not isinstance(document, dict):
            raise ValueError
        return document
    except (ValueError, RecursionError) as exc:
        raise ApiError(400, "invalid_json", "request body must be a JSON object") from exc


class ApiHandler(BaseHTTPRequestHandler):
    server_version = "UCAS-Management-API/0.1"

    def log_message(self, format: str, *args: Any) -> None:
        # Keep local development logs concise and avoid printing payloads.
        print(f"{self.command} {urlparse(self.path).path}")

    def send_json(self, status: int, body: Any) -> None:
        payload = json.dumps(body, separators=(",", ":"), default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def error(self, error: ApiError) -> None:
        body = {"error": {"code": error.code, "message": error.message}}
        if error.details is not None:
            body["error"]["details"] = error.details
        self.send_json(error.status, body)

    def dispatch(self) -> tuple[int, Any]:
        parsed = urlparse(self.path)
        path = [part for part in parsed.path.split("/") if part]
        query = parse_qs(parsed.query)

        if self.command == "GET" and parsed.path == "/health":
            return 200, {"status": "ok", "service": "management-api", "storage": STORE.storage_name, "aircraft_control": False}
        if len(path) < 2 or path[:2] != ["api", "v1"]:
            raise ApiError(404, "not_found", "route was not found")

        if self.command == "GET" and path == ["api", "v1", "aircraft"]:
            items = STORE.list_aircraft()
            return 200, paginate(items, query)

        if self.command == "POST" and path == ["api", "v1", "aircraft"]:
            body = json_body(self)
            validate_contract("aircraft", body)
            return 201, STORE.add_aircraft(body)

        if self.command == "POST" and path == ["api", "v1", "telemetry", "ingest"]:
            source_id = self.headers.get("X-Source-ID", "local-simulator")
            require_id(source_id, "source_id")
            body = json_body(self)
            validate_contract("telemetry", body)
            validate_sample_time(body)
            if "token" in query or "access_token" in query:
                raise ApiError(401, "telemetry_auth_required", "telemetry tokens must be sent as bearer authorization")
            try:
                publishers = load_publishers()
            except PublisherConfigError as error:
                raise ApiError(503, "publisher_config_unavailable", "telemetry publisher configuration is unavailable") from error
            try:
                authenticate(
                    source_id=source_id,
                    aircraft_id=body["aircraft_id"],
                    source=body["source"],
                    authorization=self.headers.get("Authorization"),
                    publishers=publishers,
                )
                authorize_ingress(source_id=source_id, sample=body, publishers=publishers)
            except PublisherAuthError as error:
                raise ApiError(error.status, error.code, error.message) from error
            result = STORE.ingest(body, source_id)
            canonical = deep_copy(body)
            canonical.update({
                "received_at": result["received_at"],
                "source_id": result["source_id"],
                "event_key": result["event_key"],
                "ingestion_status": result["status"],
            })
            STREAM_HUB.publish(build_stream_event(result, canonical))
            return (200 if result["status"] == "duplicate" else 202), result

        if len(path) >= 3 and path[2] == "aircraft":
            if len(path) < 4:
                raise ApiError(404, "not_found", "aircraft route was not found")
            aircraft_id = path[3]
            require_id(aircraft_id, "aircraft_id")
            STORE.get_aircraft(aircraft_id)
            if self.command == "GET" and len(path) == 4:
                return 200, STORE.get_aircraft(aircraft_id)
            if self.command == "GET" and path[4:] == ["telemetry", "latest"]:
                return 200, STORE.current_view(aircraft_id, query.get("source", [None])[0])
            if self.command == "GET" and path[4:] == ["telemetry"]:
                items = STORE.history(aircraft_id, query.get("source", [None])[0])
                for key in ("from", "to"):
                    if key in query:
                        bound = parse_time(query[key][0])
                        if key == "from":
                            items = [item for item in items if parse_time(item["timestamp"]) >= bound]
                        else:
                            items = [item for item in items if parse_time(item["timestamp"]) <= bound]
                return 200, paginate(items, query)
            if self.command == "GET" and path[4:] == ["telemetry", "ingestion-status"]:
                return 200, STORE.ingestion_status(aircraft_id)
            if self.command == "GET" and path[4:] == ["maintenance"]:
                return 200, paginate(STORE.maintenance(aircraft_id), query)
            if self.command == "GET" and path[4:] == ["evidence"]:
                return 200, paginate(STORE.evidence(aircraft_id), query)

        if self.command == "POST" and len(path) == 5 and path[2] == "aircraft" and path[4] == "maintenance":
            body = json_body(self)
            body["aircraft_id"] = path[3]
            validate_contract("maintenance", body)
            return 201, STORE.add_maintenance(body)

        if self.command == "PATCH" and len(path) == 4 and path[2] == "maintenance":
            require_id(path[3], "record_id")
            return 200, STORE.update_maintenance(path[3], json_body(self))

        raise ApiError(404, "not_found", "route was not found")

    def do_GET(self) -> None:
        try:
            status, body = self.dispatch()
            self.send_json(status, body)
        except ApiError as error:
            self.error(error)
        except KeyError as error:
            code = str(error.args[0]) if error.args else "repository_not_found"
            self.error(ApiError(404, code, code.replace("_", " ")))
        except ValueError as error:
            code = str(error).split(":", 1)[0]
            status = 409 if code.endswith("_exists") else 400
            self.error(ApiError(status, code, code.replace("_", " ")))
        except Exception as error:  # pragma: no cover - defensive server boundary
            print(f"Unhandled API error: {error}")
            self.error(ApiError(500, "internal_error", "internal server error"))

    def do_POST(self) -> None:
        self.do_GET()

    def do_PATCH(self) -> None:
        try:
            status, body = self.dispatch()
            self.send_json(status, body)
        except ApiError as error:
            self.error(error)
        except KeyError as error:
            code = str(error.args[0]) if error.args else "repository_not_found"
            self.error(ApiError(404, code, code.replace("_", " ")))
        except ValueError as error:
            code = str(error).split(":", 1)[0]
            status = 409 if code.endswith("_exists") else 400
            self.error(ApiError(status, code, code.replace("_", " ")))
        except Exception as error:  # pragma: no cover - defensive server boundary
            print(f"Unhandled API error: {error}")
            self.error(ApiError(500, "internal_error", "internal server error"))


def create_server(host: str = "127.0.0.1", port: int = 8000) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), ApiHandler)


def main() -> None:
    host = os.getenv("UCAS_API_HOST", "127.0.0.1")
    port = int(os.getenv("UCAS_API_PORT", "8000"))
    server = create_server(host, port)
    stream_handle = None
    if os.getenv("UCAS_STREAM_ENABLED", "0").lower() in {"1", "true", "yes"}:
        stream_host = os.getenv("UCAS_STREAM_HOST", "127.0.0.1")
        stream_port = int(os.getenv("UCAS_STREAM_PORT", "8765"))
        verifier = TokenVerifier.from_env()
        allow_insecure = os.getenv("UCAS_STREAM_ALLOW_INSECURE", "0").lower() in {"1", "true", "yes"}
        tls_context = None
        if not allow_insecure:
            tls_context = build_tls_context(
                os.environ.get("UCAS_STREAM_TLS_CERTFILE", ""),
                os.environ.get("UCAS_STREAM_TLS_KEYFILE", ""),
                os.environ.get("UCAS_STREAM_TLS_CAFILE") or None,
                os.getenv("UCAS_STREAM_TLS_REQUIRE_CLIENT_CERT", "0").lower() in {"1", "true", "yes"},
            )
        stream_handle = start_background_server(STREAM_HUB, stream_host, stream_port, verifier=verifier, ssl_context=tls_context)
        scheme = "ws" if tls_context is None else "wss"
        print(f"Telemetry WebSocket stream listening on {scheme}://{stream_host}:{stream_port}/ws")
    print(f"UCAS Management API listening on http://{host}:{port}")
    print(f"Storage={STORE.storage_name}; synthetic/read-only scope; no aircraft commands.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Management API")
    finally:
        server.server_close()
        if stream_handle is not None:
            stream_handle.stop()


if __name__ == "__main__":
    main()
