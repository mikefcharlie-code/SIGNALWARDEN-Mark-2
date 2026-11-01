"""Read-only, human-reviewed data-quality assistance for the offline overview.

The default is deterministic local rules. Model use is opt-in, bounded, and can
only select fixed statements from safe aggregate evidence; model text is never
returned to callers and this module never emits commands or operational advice.
"""
from __future__ import annotations

import json
import math
import os
import socket
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse

from .evidence import build_assessment

MAX_REQUEST_BYTES = 16_384
MAX_RESPONSE_BYTES = 64_000
DEFAULT_TIMEOUT = 2.0
LOCAL_DEFAULT_TIMEOUT = 45.0
LOCAL_MAX_TIMEOUT = 60.0
_ALLOWED_CODES = {"observation_stale", "observation_future", "observation_unknown", "reported_offline", "health_unknown"}
_INVENTORY_CATALOGS = {"informational-effector-like", "informational-weapon-like"}
_LOCAL_MODEL_PATH = "/v1/chat/completions"
_EXTERNAL_URL = "https://api.openai.com/v1/chat/completions"

_STATEMENTS = {
    "freshness.stale": ("Stale observations need data-quality review", "The overview contains {count} stale observation records; review source freshness before relying on aggregate quality counts."),
    "freshness.future": ("Future-dated observations need validation", "The overview contains {count} future-dated observation records; validate source clocks and timestamps."),
    "freshness.unknown": ("Some observation freshness is unknown", "The overview contains {count} records without recognized freshness; improve timestamp provenance."),
    "attention.reported_offline": ("Historical offline metadata is present", "The overview reports {count} historical offline metadata signal(s); this is a data-quality signal, not a current transport heartbeat."),
    "attention.health_unknown": ("Some health status is unknown", "The overview contains {count} unrecognized or missing health status signal(s); improve source health metadata."),
    "summary.empty": ("No observations are available", "The overview contains no eligible observations, so quality assistance is limited to source completeness."),
}


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _eligible_platforms(overview: dict[str, Any]) -> list[dict[str, Any]]:
    raw = overview.get("platforms")
    if not isinstance(raw, list):
        return []
    return [item for item in raw if isinstance(item, dict) and isinstance(item.get("catalogId"), str) and item["catalogId"] not in _INVENTORY_CATALOGS]


def _safe_count(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def _evidence(overview: dict[str, Any], assessment: dict[str, Any] | None = None) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, int]]:
    """Build only aggregate evidence from non-inventory platform records.

    No IDs, names, coordinates, health/readiness values, or inventory records
    cross the provider boundary.
    """
    platforms = _eligible_platforms(overview)
    eligible_ids = {item["entityId"] for item in platforms if isinstance(item.get("entityId"), str)}
    freshness = {key: 0 for key in ("current", "stale", "future", "unknown")}
    sensor_count = 0
    for platform in platforms:
        state = platform.get("freshness")
        if isinstance(state, str) and state in freshness:
            freshness[state] += 1
        sensors = platform.get("sensors")
        rows = sensors.get("sensors") if isinstance(sensors, dict) else None
        if isinstance(rows, list):
            sensor_count += sum(1 for row in rows if isinstance(row, dict))
    attention_counts = {code: 0 for code in _ALLOWED_CODES}
    attention = overview.get("attention")
    if isinstance(attention, list):
        for item in attention:
            if (isinstance(item, dict) and isinstance(item.get("code"), str)
                    and isinstance(item.get("entityId"), str) and item["entityId"] in eligible_ids
                    and item["code"] in attention_counts):
                attention_counts[item["code"]] += 1
    evidence: dict[str, Any] = {
        "platformCount": len(platforms),
        "sensorCount": sensor_count,
        "freshness": freshness,
        "attention": attention_counts,
    }
    # Only aggregate finding kinds cross a provider boundary; citations, IDs,
    # values, and source text remain local to the assessment.
    finding_counts: dict[str, int] = {}
    finding_evidence: dict[str, list[str]] = {}
    if isinstance(assessment, dict) and isinstance(assessment.get("findings"), list):
        for item in assessment["findings"]:
            if isinstance(item, dict) and isinstance(item.get("kind"), str):
                kind = item["kind"]
                finding_counts[kind] = finding_counts.get(kind, 0) + 1
                finding_evidence.setdefault(kind, []).extend(citation for citation in item.get("evidenceIds", []) if isinstance(citation, str))
        if finding_counts:
            evidence["findingCounts"] = dict(sorted(finding_counts.items()))
    candidates: list[dict[str, Any]] = []
    evidence_counts: dict[str, int] = {}
    for key in ("stale", "future", "unknown"):
        count = freshness[key]
        if count:
            ident = f"freshness.{key}"
            title, template = _STATEMENTS[ident]
            candidates.append({"id": ident, "title": title, "detail": template.format(count=count), "count": count})
            evidence_counts[ident] = count
    for code in ("reported_offline", "health_unknown"):
        count = attention_counts[code]
        if count:
            ident = f"attention.{code}"
            title, template = _STATEMENTS[ident]
            candidates.append({"id": ident, "title": title, "detail": template.format(count=count), "count": count})
            evidence_counts[ident] = count
    if not platforms:
        ident = "summary.empty"
        title, detail = _STATEMENTS[ident]
        candidates.append({"id": ident, "title": title, "detail": detail.format(count=0), "count": 0})
        evidence_counts[ident] = 0
    if finding_counts:
        labels = {
            "conflict": ("finding.conflict", "Conflicting observation reports need review", "The assessment found {count} conflicting observation report(s); retain provenance and review source timing."),
            "untrusted": ("finding.untrusted", "Observation provenance needs review", "The assessment found {count} observation record(s) without trusted provenance."),
            "missing": ("finding.missing", "Expected observation evidence is missing", "The assessment found {count} missing or null observation field(s); completeness is unknown."),
            "stale": ("finding.stale", "Stale observation findings need review", "The assessment found {count} stale observation finding(s)."),
            "future": ("finding.future", "Future-dated observation findings need review", "The assessment found {count} future-dated observation finding(s)."),
        }
        for kind, count in sorted(finding_counts.items()):
            if kind not in labels:
                continue
            ident, title, template = labels[kind]
            candidates.append({"id": ident, "title": title, "detail": template.format(count=count), "count": count,
                              "evidenceIds": sorted(set(finding_evidence.get(kind, [])))})
    if isinstance(assessment, dict):
        records = assessment.get("evidence", [])
        for candidate in candidates:
            if "evidenceIds" in candidate:
                continue
            ident = candidate["id"]
            linked = []
            for row in records:
                field, value = row.get("field"), row.get("value")
                if ident.startswith("freshness.") and field == "freshness" and value == ident.split(".")[1]:
                    linked.append(row["id"])
                elif ident == "attention.reported_offline" and field == "health" and isinstance(value, dict) and value.get("connectionStatus") == "CONNECTION_STATUS_OFFLINE":
                    linked.append(row["id"])
                elif ident == "attention.health_unknown" and field == "health" and isinstance(value, dict) and value.get("healthStatus") == "unknown":
                    linked.append(row["id"])
                elif ident == "summary.empty" and field == "observation":
                    linked.append(row["id"])
            candidate["evidenceIds"] = sorted(set(linked))
    return evidence, candidates, evidence_counts


def _public_insight(item: dict[str, Any]) -> dict[str, Any]:
    citations = item.get("evidenceIds") if isinstance(item.get("evidenceIds"), list) else [item["id"]]
    return {"id": item["id"], "title": item["title"], "detail": item["detail"], "evidence": citations}


def _rules(overview: dict[str, Any]) -> list[dict[str, Any]]:
    return [_public_insight(item) for item in _evidence(overview)[1]]


def _loopback(url: str) -> bool:
    """Accept literal loopback hosts only; never resolve attacker-controlled DNS."""
    if not isinstance(url, str):
        return False
    try:
        parsed = urlparse(url)
        port = parsed.port
        host = parsed.hostname
    except (TypeError, ValueError):
        return False
    if parsed.scheme != "http" or host not in {"127.0.0.1", "::1"} or parsed.username or parsed.password or port is None or parsed.query or parsed.fragment:
        return False
    if parsed.path not in ("", "/", _LOCAL_MODEL_PATH):
        return False
    return True


def _provider_url(root: str) -> str | None:
    if not _loopback(root):
        return None
    parsed = urlparse(root)
    if parsed.path in ("", "/"):
        return root.rstrip("/") + _LOCAL_MODEL_PATH
    return root


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _timeout(environ: dict[str, str], local: bool = False) -> float:
    """Return the selected provider's finite, bounded request timeout."""
    default = LOCAL_DEFAULT_TIMEOUT if local else DEFAULT_TIMEOUT
    maximum = LOCAL_MAX_TIMEOUT if local else DEFAULT_TIMEOUT
    try:
        value = float(environ.get("UCAS_LATTICE_AI_TIMEOUT", str(default)))
    except (TypeError, ValueError):
        value = default
    if not math.isfinite(value):
        value = default
    return min(maximum, max(0.05, value))


def _read_response(response: Any, deadline: float) -> bytes | None:
    """Read at most MAX_RESPONSE_BYTES while checking the wall-clock deadline.

    ``read1`` avoids waiting for a full buffered response when urllib exposes it;
    simple test doubles and unusual response objects retain the one-shot ``read``
    compatibility path.  A socket read can still consume its currently configured
    interval, but every available chunk is checked against the overall deadline.
    """
    reader = getattr(response, "read1", None)
    if callable(reader):
        chunks: list[bytes] = []
        total = 0
        while total <= MAX_RESPONSE_BYTES:
            if time.monotonic() > deadline:
                return None
            chunk = reader(min(8192, MAX_RESPONSE_BYTES + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > MAX_RESPONSE_BYTES or time.monotonic() > deadline:
                return None
        return b"".join(chunks)
    raw = response.read(MAX_RESPONSE_BYTES + 1)
    if time.monotonic() > deadline:
        return None
    return raw


def _model_insights(url: str, overview: dict[str, Any], candidates: list[dict[str, Any]], *, model: str, timeout: float, api_key: str | None = None, assessment: dict[str, Any] | None = None) -> list[dict[str, Any]] | None:
    """Call one explicitly selected provider and reduce its response to allowlisted IDs."""
    if not isinstance(model, str) or not model.strip() or not isinstance(candidates, list):
        return None
    evidence, _, _ = _evidence(overview, assessment=assessment)
    allowed = {item.get("id"): item for item in candidates if isinstance(item, dict) and isinstance(item.get("id"), str)}
    prompt = {"task": "Select zero or more data-quality statements. Return JSON object {insights:[{id,evidence}]} only.", "evidence": evidence, "allowedStatements": [{"id": key, "title": item["title"]} for key, item in allowed.items()]}
    body = json.dumps({"model": model, "messages": [{"role": "system", "content": "You are a non-tactical data-quality assistant. Never add text; choose only allowed statement IDs."}, {"role": "user", "content": json.dumps(prompt, separators=(",", ":"))}], "temperature": 0, "max_tokens": 400}, separators=(",", ":")).encode()
    if len(body) > MAX_REQUEST_BYTES:
        return None
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if api_key is not None:
        headers["Authorization"] = "Bearer " + api_key
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    deadline = time.monotonic() + timeout
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)
        remaining = max(0.05, deadline - time.monotonic())
        with opener.open(request, timeout=remaining) as response:
            if response.status != 200:
                return None
            raw = _read_response(response, deadline)
            if raw is None:
                return None
            if len(raw) > MAX_RESPONSE_BYTES:
                return None
        if time.monotonic() > deadline:
            return None
        document = json.loads(raw)
        choices = document.get("choices") if isinstance(document, dict) else None
        first = choices[0] if isinstance(choices, list) and choices and isinstance(choices[0], dict) else None
        message = first.get("message") if isinstance(first, dict) else None
        content = message.get("content") if isinstance(message, dict) else None
        if isinstance(content, list):
            content = "".join(part.get("text", "") for part in content if isinstance(part, dict) and isinstance(part.get("text"), str))
        selected = json.loads(content) if isinstance(content, str) else None
        rows = selected.get("insights") if isinstance(selected, dict) else None
    except (OSError, ValueError, TypeError, KeyError, IndexError, json.JSONDecodeError, urllib.error.URLError):
        return None
    if not isinstance(rows, list) or len(rows) > len(allowed):
        return None
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            return None
        ident = row.get("id")
        if not isinstance(ident, str) or ident in seen or ident not in allowed:
            return None
        evidence_ids = row.get("evidence")
        if not isinstance(evidence_ids, list) or any(item != ident or not isinstance(item, str) for item in evidence_ids):
            return None
        seen.add(ident)
        result.append(_public_insight(allowed[ident]))
    return result


def build_assistance(overview: dict[str, Any], *, environ: dict[str, str] | None = None) -> dict[str, Any]:
    """Return the stable advisory contract; local rules never make network calls."""
    if not isinstance(overview, dict):
        overview = {}
    env = os.environ if environ is None else environ
    # Never trust a caller-supplied assessment: it may describe a different
    # overview or contain forged citations.  Rebuild against this exact input.
    assessment = build_assessment(overview)
    generated = assessment.get("generatedAt") if isinstance(assessment.get("generatedAt"), str) else (overview.get("generatedAt") if isinstance(overview.get("generatedAt"), str) else _iso_now())
    evidence, candidates, evidence_counts = _evidence(overview, assessment=assessment)
    insights = [_public_insight(item) for item in candidates]
    mode = env.get("UCAS_AI_MODE", "local").strip().lower()
    if mode not in {"local", "external"}:
        mode = "local"
        invalid_mode = True
    else:
        invalid_mode = False
    engine, status, provider = "rules", "unconfigured", "rules"
    leaves = False
    disclosure = "Local deterministic rules; not a model. No network calls are made."
    if invalid_mode:
        status, disclosure = "unavailable", "Invalid AI mode; no provider call was made. Local rules remain advisory."
    elif mode == "local":
        runtime = env.get("UCAS_AI_LOCAL_RUNTIME", "rules").strip().lower()
        model = env.get("UCAS_AI_LOCAL_MODEL", "").strip()
        endpoint = env.get("UCAS_LATTICE_AI_ENDPOINT") or env.get("UCAS_LATTICE_LOCAL_MODEL_URL")
        if runtime in {"disabled", "off"}:
            status, disclosure = "disabled", "Local AI runtime is disabled; deterministic assistance remains advisory."
        elif runtime in {"openai-compatible", "local-model"}:
            provider = "openai-compatible-local"
            target = _provider_url(endpoint) if endpoint else None
            if not model:
                status, disclosure = "unavailable", "Local model is unconfigured; set UCAS_AI_LOCAL_MODEL. No provider call was made."
            elif target is None:
                status, disclosure = "unavailable", "Local model endpoint must be an HTTP loopback root; no provider call was made."
            else:
                selected = _model_insights(target, overview, candidates, model=model, timeout=_timeout(env, local=True), assessment=assessment)
                if selected is not None:
                    # A model may highlight/order known findings, but can never
                    # suppress deterministic issues or author new citations.
                    selected_ids = {item["id"] for item in selected}
                    insights = selected + [item for item in insights if item["id"] not in selected_ids]
                    engine, status = "local-model", "available"
                    disclosure = "Local loopback model; data stays on this system."
                else:
                    status, disclosure = "unavailable", "Configured local model was unavailable or returned invalid data; deterministic rules remain advisory."
        elif runtime in {"rules", ""}:
            status, disclosure = "unconfigured", "Local deterministic rules; not a model. No network calls are made."
        else:
            status, disclosure = "unavailable", "Unsupported local runtime; no provider call was made."
    else:
        provider = env.get("UCAS_AI_EXTERNAL_PROVIDER", "").strip().lower()
        consent = env.get("UCAS_AI_EXTERNAL_CONSENT", "").strip().lower() == "true"
        model = env.get("UCAS_AI_EXTERNAL_MODEL", "").strip()
        api_key = env.get("UCAS_AI_EXTERNAL_API_KEY", "")
        eligible = provider == "openai" and consent and bool(model) and bool(api_key)
        if eligible:
            leaves = True
            disclosure = "External OpenAI is explicitly selected; aggregate evidence will leave this system for this attempt. Returned model text is discarded and only fixed statements are shown."
            selected = _model_insights(_EXTERNAL_URL, overview, candidates, model=model, timeout=_timeout(env), api_key=api_key, assessment=assessment)
            if selected is not None:
                selected_ids = {item["id"] for item in selected}
                insights = selected + [item for item in insights if item["id"] not in selected_ids]
                engine, status = "external-model", "available"
            else:
                status = "unavailable"
        else:
            status, disclosure = "unavailable", "External AI requires explicit provider, consent, model, and credential configuration; no call was made."
    limitations = ["Rules are deterministic and not a model." if engine == "rules" else "Model output is constrained to known data-quality statements.", "Advisory and human-reviewed only; never a command, effector instruction, or operational recommendation.", "Only safe aggregate freshness and attention counts are used; no identifiers, locations, inventory, readiness, or health values are sent."]
    return {"mode": mode, "provider": provider, "modelStatus": status, "engine": engine, "generatedAt": generated,
            "snapshotId": assessment.get("snapshotId"), "summary": assessment.get("summary", "Non-tactical data-quality assistance derived only from aggregate offline overview evidence."),
            "assessment": assessment, "insights": insights, "evidenceCounts": evidence_counts, "limitations": limitations,
            "disclosure": disclosure, "dataLeavesSystem": leaves, "readOnly": True, "synthetic": bool(overview.get("synthetic", False))}


__all__ = ["build_assistance"]
