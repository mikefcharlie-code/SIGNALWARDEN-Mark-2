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
from services.lattice_readonly import OfflineLattice
from services.lattice_readonly.assistance import build_assistance
from services.lattice_readonly.report_adapter import build_report_overview, report_catalog
from services.lattice_readonly.reports import build_report, report_options
from telemetry_policy import compute_freshness, event_key as telemetry_event_key, ordering_key
import local_ai_jobs
import local_ai_inference
import worldview_analyst
import sar_imagery
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


def json_body(handler: BaseHTTPRequestHandler, *, max_bytes: int = 1_000_000) -> dict[str, Any]:
    def reject_constant(value: str) -> None:
        raise ValueError("non-finite JSON number")

    def finite_float(value: str) -> float:
        number = float(value)
        if not math.isfinite(number):
            raise ValueError("JSON number exceeds finite numeric range")
        return number

    try:
        if handler.headers.get("Transfer-Encoding"):
            raise ValueError("Transfer-Encoding is not supported")
        raw_length = handler.headers.get("Content-Length")
        if raw_length is None:
            raise ValueError("Content-Length is required")
        length = int(raw_length)
        if length <= 0 or length > max_bytes:
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


def local_ai_auth(handler: BaseHTTPRequestHandler, *, mutation: bool = False, max_body: int = local_ai_jobs.MAX_BODY) -> None:
    if not local_ai_jobs.enabled():
        raise ApiError(404, "not_found", "route was not found")
    if not local_ai_jobs.token_valid(handler.headers.get("Authorization")):
        raise ApiError(401, "local_ai_auth_required", "local AI installer authorization is required")
    if any(key in parse_qs(urlparse(handler.path).query) for key in ("token", "access_token")):
        raise ApiError(400, "query_token_forbidden", "Use bearer authorization, never query credentials.")
    if mutation:
        content_type = handler.headers.get("Content-Type", "")
        if content_type.split(";", 1)[0].strip().lower() != "application/json":
            raise ApiError(415, "json_required", "Content-Type must be application/json")
        if handler.headers.get("Transfer-Encoding"):
            raise ApiError(400, "invalid_transfer_encoding", "Transfer-Encoding is not supported")
        try:
            content_length = int(handler.headers.get("Content-Length", "0"))
            if content_length < 0:
                raise ValueError
            if content_length > max_body:
                raise ApiError(413, "request_too_large", "local AI job request body is too large")
        except ValueError as error:
            raise ApiError(400, "invalid_content_length", "Content-Length must be a non-negative integer") from error
        if not local_ai_jobs.mutation_origin_allowed(handler.headers.get("Origin")):
            raise ApiError(403, "origin_not_allowed", "request Origin is not allowed")


class LocalAIArtifact:
    def __init__(self, payload: bytes, mime: str):
        self.payload, self.mime = payload, mime


def inference_context(record_ids: list[str]) -> list[dict[str, Any]]:
    """Resolve only canonical read-only evidence, never client source text."""
    try:
        overview = OfflineLattice(mode=os.getenv("UCAS_LATTICE_MODE", "mock")).overview(now=utc_now())
    except ValueError as error:
        raise ApiError(503, "lattice_mode_unavailable", "Only mock and offline observation contexts are supported.") from error
    records = {row["id"]: row for row in overview["assessment"]["evidence"]}
    if any(ident not in records for ident in record_ids):
        raise ApiError(400, "unknown_context_record", "A selected evidence record is unavailable; refresh the observation view.")
    result = []
    for ident in record_ids:
        row = records[ident]
        if not row.get("observedAt") or row.get("value") is None:
            continue
        text = json.dumps({key: row.get(key) for key in ("entityId", "subjectId", "sourceId", "field", "value", "trust", "freshness", "synthetic")}, sort_keys=True, ensure_ascii=True)
        if len(text) > 600:
            continue  # Do not silently truncate a cited source.
        result.append({"record_id": ident, "timestamp": row["observedAt"], "text": text, "synthetic": row.get("synthetic") is True})
    return result


class ApiHandler(BaseHTTPRequestHandler):
    server_version = "UCAS-Management-API/0.1"

    def log_message(self, format: str, *args: Any) -> None:
        # Keep local development logs concise and avoid printing payloads.
        print(f"{self.command} {urlparse(self.path).path}")

    def send_json(self, status: int, body: Any) -> None:
        if isinstance(body, sar_imagery.BrowseImage):
            payload = body.payload
            self.send_response(status)
            self.send_header("Content-Type", body.mime)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(payload)
            return
        if isinstance(body, LocalAIArtifact):
            payload = body.payload
            if len(payload) > local_ai_inference.MAX_ARTIFACT:
                raise ApiError(413, "artifact_too_large", "Generated artifact exceeds the download limit.")
            self.send_response(status)
            self.send_header("Content-Type", body.mime)
            self.send_header("Content-Length", str(len(payload)))
            suffix = ".png" if body.mime == "image/png" else ".gif"
            self.send_header("Content-Disposition", f'attachment; filename="SYNTHETIC-demo{suffix}"')
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-UCAS-Synthetic", "true")
            self.end_headers()
            self.wfile.write(payload)
            return
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

    def inference_dispatch(self, suffix: list[str]) -> tuple[int, Any]:
        if not local_ai_inference.enabled():
            raise ApiError(404, "not_found", "local inference is disabled")
        local_ai_auth(self, mutation=self.command == "POST", max_body=local_ai_inference.MAX_BODY)
        try:
            if self.command == "GET" and suffix == ["status"]:
                return 200, local_ai_inference.status()
            if self.command == "POST" and not suffix:
                body = json_body(self, max_bytes=local_ai_inference.MAX_BODY)
                request, _, _ = local_ai_inference.validate_request(body)
                context = inference_context(request["recordIds"]) if request["group"] == "llm" else []
                return 202, local_ai_inference.create_job(body, context=context)
            if len(suffix) in (2, 3) and suffix[0] == "jobs":
                require_id(suffix[1], "job_id")
                if self.command == "GET" and len(suffix) == 2:
                    job = local_ai_inference.get_job(suffix[1])
                    if job is None:
                        raise ApiError(404, "job_not_found", "Inference job was not found or expired.")
                    return 200, job
                if self.command == "POST" and suffix[2:] == ["cancel"]:
                    if json_body(self) != {}:
                        raise ApiError(400, "invalid_cancel_request", "Cancel body must be an empty object.")
                    job = local_ai_inference.cancel_job(suffix[1])
                    if job is None:
                        raise ApiError(404, "job_not_found", "Inference job was not found or expired.")
                    return 200, job
                if self.command == "GET" and suffix[2:] == ["artifact"]:
                    artifact = local_ai_inference.artifact(suffix[1])
                    if artifact is None:
                        raise ApiError(404, "artifact_not_found", "Synthetic artifact is unavailable or expired.")
                    return 200, LocalAIArtifact(*artifact)
        except local_ai_inference.InferenceError as error:
            raise ApiError(error.status, error.code, error.message) from error
        raise ApiError(404, "not_found", "Inference route was not found.")

    def dispatch(self) -> tuple[int, Any]:
        parsed = urlparse(self.path)
        path = [part for part in parsed.path.split("/") if part]
        query = parse_qs(parsed.query)

        if self.command == "GET" and parsed.path == "/health":
            return 200, {"status": "ok", "service": "management-api", "storage": STORE.storage_name, "aircraft_control": False}
        if len(path) < 2 or path[:2] != ["api", "v1"]:
            raise ApiError(404, "not_found", "route was not found")

        if self.command == "GET" and path == ["api", "v1", "public-imagery", "sar", "browse"]:
            values = query.get("product", [])
            if len(values) != 1 or set(query) != {"product"}:
                raise ApiError(400, "invalid_sar_product", "product must be the only query parameter, supplied exactly once")
            try:
                return 200, sar_imagery.fetch_browse(values[0], self.headers)
            except sar_imagery.SarImageryError as error:
                raise ApiError(error.status, error.code, error.message) from error

        if path[:3] == ["api", "v1", "local-ai"]:
            if path[3:4] == ["inference"]:
                return self.inference_dispatch(path[4:])
            if self.command == "GET" and path == ["api", "v1", "local-ai", "analyst", "status"]:
                local_ai_auth(self)
                return 200, worldview_analyst.status()
            if self.command == "POST" and path == ["api", "v1", "local-ai", "analyst"]:
                local_ai_auth(self, mutation=True, max_body=worldview_analyst.MAX_BODY)
                try:
                    body = worldview_analyst.validate_request(json_body(self, max_bytes=worldview_analyst.MAX_BODY))
                except ValueError as error:
                    raise ApiError(400, "invalid_analyst_request", str(error)) from error
                return 200, worldview_analyst.analyze(body)
            if self.command == "GET" and path == ["api", "v1", "local-ai", "status"]:
                local_ai_auth(self)
                return 200, local_ai_jobs.status()
            if self.command == "GET" and len(path) == 5 and path[:4] == ["api", "v1", "local-ai", "jobs"]:
                local_ai_auth(self)
                job = local_ai_jobs.get_job(path[4])
                if job is None:
                    raise ApiError(404, "job_not_found", "local AI job was not found")
                return 200, job
            if self.command == "POST" and path == ["api", "v1", "local-ai", "jobs"]:
                local_ai_auth(self, mutation=True)
                body = json_body(self)
                if set(body) != {"group", "device", "action", "acceptLicense"}:
                    raise ApiError(400, "invalid_job_request", "job body must contain exactly group, device, action, and acceptLicense")
                if not all(isinstance(body[key], str) for key in ("group", "device", "action")) or not isinstance(body["acceptLicense"], bool):
                    raise ApiError(400, "invalid_job_request", "job fields have invalid types")
                try:
                    return 202, local_ai_jobs.create_job(body["group"], body["device"], body["action"], body["acceptLicense"])
                except RuntimeError as error:
                    raise ApiError(409, "job_active", str(error)) from error
                except ValueError as error:
                    raise ApiError(400, "invalid_job_request", str(error)) from error
            if self.command == "POST" and len(path) == 6 and path[:4] == ["api", "v1", "local-ai", "jobs"] and path[5] == "cancel":
                local_ai_auth(self, mutation=True)
                job = local_ai_jobs.cancel_job(path[4])
                if job is None:
                    raise ApiError(404, "job_not_found", "local AI job was not found")
                return 200, job
            raise ApiError(404, "not_found", "local AI route was not found")

        if len(path) >= 3 and path[2] == "lattice":
            # A separate observation namespace: never enters aircraft ingestion,
            # telemetry streams, training tasking, or any platform command path.
            if self.command != "GET":
                raise ApiError(405, "read_only_integration", "Lattice scaffold routes are GET-only")
            try:
                integration = OfflineLattice(mode=os.getenv("UCAS_LATTICE_MODE", "mock"))
            except ValueError as error:
                raise ApiError(503, "lattice_mode_unavailable", "Only mock and offline modes are supported; no Lattice connection exists") from error
            suffix = path[3:]
            if suffix == ["status"]:
                return 200, integration.status()
            if suffix == ["overview"]:
                # One clock value keeps generatedAt and every freshness result coherent.
                return 200, integration.overview(now=utc_now())
            if suffix == ["assistance"]:
                return 200, build_assistance(integration.overview(now=utc_now()))
            if suffix == ["capabilities"]:
                return 200, paginate(integration.capabilities(), query)
            if suffix == ["catalog"]:
                return 200, paginate(integration.catalog(), query)
            if suffix == ["platforms"]:
                return 200, paginate(integration.list_platforms(), query)
            if len(suffix) == 2 and suffix[0] == "platforms":
                require_id(suffix[1], "platform_id")
                try:
                    return 200, integration.get_platform(suffix[1])
                except KeyError as error:
                    raise ApiError(404, "platform_not_found", "platform_id was not found") from error
            raise ApiError(404, "not_found", "Lattice scaffold route was not found")
        if len(path) >= 4 and path[:3] == ["api", "v1", "reports"]:
            if parsed.query:
                raise ApiError(400, "invalid_query", "report routes do not accept query parameters; use JSON generation options")
            try:
                integration = OfflineLattice(mode=os.getenv("UCAS_LATTICE_MODE", "mock"))
            except ValueError as error:
                raise ApiError(503, "lattice_mode_unavailable", "Only mock and offline report sources are supported; no Lattice connection exists") from error
            if self.command == "GET" and path[3:] == ["options"]:
                catalog = report_catalog(STORE, integration)
                labels = {"platform-status": "Platform / fleet status", "sensor-isr": "Sensor collection / ISR summary", "incident-timeline": "Incident / event timeline", "data-quality": "Data quality / communications gaps", "operator-handoff": "Operator handoff"}
                return 200, {"types": [{"id": value, "label": labels[value]} for value in report_options()["types"]], **catalog}
            if self.command == "POST" and path[3:] == ["generate"]:
                content_type = self.headers.get("Content-Type", "")
                if content_type.split(";", 1)[0].strip().lower() != "application/json":
                    raise ApiError(415, "json_required", "Content-Type must be application/json")
                body = json_body(self)
                allowed = {"type", "start", "end", "platformIds", "sensorIds", "engine"}
                if set(body) - allowed:
                    raise ApiError(400, "invalid_report_options", "unsupported report option")
                overview = build_report_overview(STORE, integration, now=utc_now())
                try:
                    return 200, build_report(overview, body, environ=os.environ)
                except (TypeError, ValueError) as error:
                    raise ApiError(400, "invalid_report_options", str(error)) from error
            raise ApiError(404, "not_found", "report route was not found")

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
    # Reject an attempted live configuration before opening a listening socket.
    OfflineLattice(mode=os.getenv("UCAS_LATTICE_MODE", "mock"))
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
