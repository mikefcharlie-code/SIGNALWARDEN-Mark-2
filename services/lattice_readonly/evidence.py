"""Deterministic, read-only data-quality evidence for lattice snapshots."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import math
import re
from typing import Any, Mapping

_INVENTORY = {"informational-effector-like", "informational-weapon-like"}
_ALLOWED_FIELDS = {
    "health", "health.status", "health.connectionStatus", "health.healthStatus",
    "sensors", "sensor.operationalState", "sensor.type", "freshness", "platform", "observation",
    "source", "time",
}
_RFC3339 = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$")
_TRUE = {"true", "1", "yes", "y"}
_FALSE = {"false", "0", "no", "n"}
_UNKNOWN_SOURCE = "unknown"
_ABSENCE_SOURCE = "absence"
_SAFE_METADATA_KEYS = {
    "connectionstatus", "healthstatus", "status", "operationalstate", "sensortype",
    "sensors", "health", "freshness", "type", "state", "availability", "condition",
}


def _canonical(value: Any) -> str:
    try:
        return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)
    except (TypeError, ValueError, OverflowError):
        return "null"


def _hash(prefix: str, value: Any) -> str:
    return prefix + "-" + hashlib.sha256(_canonical(value).encode()).hexdigest()[:20]


def _parse(value: Any) -> datetime | None:
    if not isinstance(value, str) or not _RFC3339.fullmatch(value):
        return None
    if not value.endswith("Z") and (int(value[-5:-3]) > 23 or int(value[-2:]) > 59):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            return None
        return parsed.astimezone(timezone.utc)
    except (TypeError, ValueError, OverflowError):
        return None


def _iso(value: datetime | None) -> str | None:
    return value.isoformat().replace("+00:00", "Z") if value else None


def _is_synthetic(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return isinstance(value, str) and value.strip().lower() in _TRUE


def _trust(value: Any) -> str:
    if value is True or (isinstance(value, str) and value.strip().lower() == "trusted"):
        return "trusted"
    if isinstance(value, str) and value.strip().lower() in {"untrusted", "unknown"}:
        return value.strip().lower()
    return "unknown"


def _freshness(observed: datetime | None, generated: datetime | None, synthetic: bool = False) -> str:
    if observed is None or generated is None:
        return "unknown"
    age = (generated - observed).total_seconds()
    if age < 0:
        return "future"
    if synthetic:
        return "stale"  # static fixtures are never represented as current
    return "stale" if age > 300 else "current"


def _safe_value(value: Any, depth: int = 0) -> Any:
    """Return bounded JSON only; never preserve arbitrary nested payloads."""
    if depth > 3:
        return None
    if value is None or isinstance(value, (str, bool, int)):
        return value if not isinstance(value, str) or len(value) <= 256 else value[:256]
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, list):
        return [_safe_value(item, depth + 1) for item in value[:20]]
    if isinstance(value, Mapping):
        result = {}
        for key, item in list(value.items())[:20]:
            if not isinstance(key, str) or len(key) > 64:
                continue
            lower = key.lower()
            if lower not in _SAFE_METADATA_KEYS:
                continue
            result[key] = _safe_value(item, depth + 1)
        return result
    return None


def _valid_id(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip()) and len(value) <= 256


def _add(rows: list[dict[str, Any]], *, entity: str, subject: str, source: str, field: str, value: Any,
        observed: Any, trust: Any, synthetic: Any, generated: datetime | None) -> None:
    if not (_valid_id(entity) and _valid_id(subject) and _valid_id(source)):
        return
    if not isinstance(field, str) or field not in _ALLOWED_FIELDS:
        return
    stamp = _parse(observed)
    syn = _is_synthetic(synthetic)
    item = {"entityId": entity, "subjectId": subject, "sourceId": source, "field": field,
            "value": _safe_value(value), "observedAt": _iso(stamp), "trust": "unknown" if syn or source in {_UNKNOWN_SOURCE, _ABSENCE_SOURCE} else _trust(trust),
            "freshness": _freshness(stamp, generated, syn), "synthetic": syn}
    item["id"] = _hash("ev", item)
    rows.append(item)


def _eligible(overview: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    result = {}
    raw = overview.get("platforms")
    if not isinstance(raw, list):
        return result
    for platform in raw:
        if not isinstance(platform, Mapping):
            continue
        catalog = platform.get("catalogId")
        entity = platform.get("entityId")
        if isinstance(catalog, str) and catalog not in _INVENTORY and _valid_id(entity):
            result[entity] = platform
    return result


def _input_rows(overview: Mapping[str, Any], generated: datetime | None) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    eligible = _eligible(overview)
    for entity, platform in eligible.items():
        provenance = platform.get("provenance") if isinstance(platform.get("provenance"), Mapping) else {}
        source = provenance.get("sourceId")
        observed = provenance.get("sourceUpdateTime")
        trust = provenance.get("trust", "unknown")
        synthetic = _is_synthetic(overview.get("synthetic", False)) or _is_synthetic(platform.get("synthetic", False))
        effective_source = source if _valid_id(source) else _UNKNOWN_SOURCE
        custom = platform.get("observationEvidence", platform.get("evidence"))
        if isinstance(custom, list):
            for raw in custom:
                if isinstance(raw, Mapping):
                    _add(rows, entity=entity, subject=raw.get("subjectId", entity), source=raw.get("sourceId", effective_source),
                         field=raw.get("field", ""), value=raw.get("value"), observed=raw.get("observedAt", observed),
                         trust=raw.get("trust", trust), synthetic=synthetic or _is_synthetic(raw.get("synthetic", False)), generated=generated)
        for field in ("health", "sensors", "freshness"):
            _add(rows, entity=entity, subject=entity, source=effective_source, field=field, value=platform.get(field),
                 observed=observed, trust=trust, synthetic=synthetic, generated=generated)
        # These markers are only for absent/invalid provenance, not a second
        # citation on every otherwise valid platform row.
        if not _valid_id(source):
            _add(rows, entity=entity, subject=entity, source=_ABSENCE_SOURCE, field="source", value=None,
                 observed=None, trust="unknown", synthetic=synthetic, generated=generated)
        if _parse(observed) is None:
            _add(rows, entity=entity, subject=entity, source=_ABSENCE_SOURCE, field="time", value=None,
                 observed=None, trust="unknown", synthetic=synthetic, generated=generated)
    raw = overview.get("observationEvidence")
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, Mapping):
                continue
            entity = item.get("entityId")
            if not _valid_id(entity) or entity not in eligible:
                continue
            _add(rows, entity=entity, subject=item.get("subjectId", entity), source=item.get("sourceId", _UNKNOWN_SOURCE) or _UNKNOWN_SOURCE, field=item.get("field", ""),
                 value=item.get("value"), observed=item.get("observedAt"), trust=item.get("trust"),
                 synthetic=_is_synthetic(overview.get("synthetic", False)) or _is_synthetic(eligible[entity].get("synthetic", False)) or _is_synthetic(item.get("synthetic", False)), generated=generated)
    if not eligible:
        _add(rows, entity="snapshot", subject="snapshot", source="absence", field="observation", value=None,
             observed=None, trust="unknown", synthetic=overview.get("synthetic", False), generated=generated)
    unique = {item["id"]: item for item in rows}
    return [unique[key] for key in sorted(unique)]


def _latest_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Discard superseded records before any finding is emitted.

    The comparison uses parsed UTC timestamps, not RFC3339 spelling.  Equal
    latest timestamps are retained so the provenance conflict remains citable.
    Unknown-source records are never treated as an independent source.
    """
    groups: dict[tuple[str, str, str, str], list[dict[str, Any]]] = {}
    for row in rows:
        key = (row["entityId"], row["subjectId"], row["sourceId"], row["field"])
        groups.setdefault(key, []).append(row)
    kept: list[dict[str, Any]] = []
    for key, group in groups.items():
        timed = [(row, _parse(row["observedAt"])) for row in group if _parse(row["observedAt"]) is not None]
        if timed:
            latest = max(stamp for _, stamp in timed)
            kept.extend(row for row, stamp in timed if stamp == latest)
        else:
            # There is no temporal winner; retain one deterministic unknown
            # observation rather than manufacturing a conflict from duplicates.
            kept.append(min(group, key=lambda row: (row["id"])))
    return sorted(kept, key=lambda row: row["id"])


def build_assessment(overview: Mapping[str, Any] | None) -> dict[str, Any]:
    overview = overview if isinstance(overview, Mapping) else {}
    generated = _parse(overview.get("generatedAt"))
    # A wall clock would make identical malformed snapshots change identity.
    # Keep the public timestamp schema valid, but leave freshness unknown by
    # passing None into row generation when no strict timestamp was supplied.
    generated_text = _iso(generated) or "1970-01-01T00:00:00Z"
    rows = _latest_rows(_input_rows(overview, generated))
    evidence_ids = {row["id"] for row in rows}
    findings: list[dict[str, Any]] = []

    def finding(kind: str, title: str, detail: str, evidence: list[str]) -> None:
        ids = sorted({item for item in evidence if item in evidence_ids})
        if not ids:
            return
        payload = {"kind": kind, "title": title, "detail": detail, "evidenceIds": ids}
        findings.append({"id": _hash("finding", payload), **payload})

    if generated is None:
        finding("limitation", "Assessment clock is missing or invalid",
                "The assessment generatedAt value is missing or invalid; freshness cannot be established and the epoch sentinel is used for deterministic output.",
                [row["id"] for row in rows])

    by_field: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for row in rows:
        by_field.setdefault((row["subjectId"], row["field"]), []).append(row)
        if row["freshness"] in {"stale", "future"}:
            finding(row["freshness"], f"Observation is {row['freshness']}", f"Observation field {row['field']} has {row['freshness']} timestamp evidence; validate source clocks before relying on it.", [row["id"]])
        if row["trust"] != "trusted":
            finding("untrusted", "Observation provenance is not trusted", f"Observation field {row['field']} has {row['trust']} provenance; treat it as untrusted evidence.", [row["id"]])
        if row["value"] is None:
            finding("missing", "Expected observation evidence is missing", f"Expected {row['field']} evidence is absent for {row['entityId']}; completeness is unknown.", [row["id"]])
        elif row["value"] in ("unknown", "") or row["value"] == {} or row["value"] == {"sensors": []}:
            finding("missing", "Observation content is unknown or empty", f"Field {row['field']} does not establish a known observation value; inspect the cited source record.", [row["id"]])
        elif row["observedAt"] is None and row["field"] != "time":
            finding("missing", "Observation timestamp is missing or invalid", f"Observation field {row['field']} has a nonnull value but no valid RFC3339 observation timestamp; timestamp-based freshness is unknown.", [row["id"]])

    for (subject, field), group in sorted(by_field.items()):
        real = [r for r in group if r["sourceId"] not in {_ABSENCE_SOURCE, _UNKNOWN_SOURCE} and _valid_id(r["sourceId"])]
        by_source: dict[str, list[dict[str, Any]]] = {}
        for row in real:
            by_source.setdefault(row["sourceId"], []).append(row)
        # Same-source variants at the same timestamp are a provenance issue, never a winner.
        for source, variants in by_source.items():
            for left in variants:
                for right in variants:
                    left_time, right_time = _parse(left["observedAt"]), _parse(right["observedAt"])
                    if left["id"] >= right["id"] or left_time != right_time or left_time is None:
                        continue
                    if _canonical(left["value"]) != _canonical(right["value"]):
                        finding("conflict", "Same source reports disagreeing variants", f"Source {source} reports conflicting {field} values at the same observation time; retain provenance for review.", [left["id"], right["id"]])
        latest: list[dict[str, Any]] = []
        for source, variants in by_source.items():
            timed = [r for r in variants if r["observedAt"]]
            if timed:
                latest_stamp = max(r["observedAt"] for r in timed)
                latest.extend(r for r in timed if r["observedAt"] == latest_stamp)
        for i, left in enumerate(latest):
            for right in latest[i + 1:]:
                if left["sourceId"] == right["sourceId"] or left["observedAt"] is None or right["observedAt"] is None:
                    continue
                lt, rt = _parse(left["observedAt"]), _parse(right["observedAt"])
                if lt is None or rt is None or abs((lt - rt).total_seconds()) > 30:
                    continue
                if _canonical(left["value"]) != _canonical(right["value"]):
                    finding("conflict", "Independent sources disagree", f"Independent sources report conflicting values for subject {subject} field {field} at comparable observation times; retain both citations for review.", [left["id"], right["id"]])
    findings.sort(key=lambda item: item["id"])
    summary = "Deterministic read-only data-quality assessment: " + (f"{len(findings)} issue(s) require review." if findings else "no deterministic data-quality issues were found.")
    limitations = ["Evidence reports provenance and timestamp quality, not physical-world confidence.", "Weapon and effector inventory plus location and tactical fields are excluded.", "Trust is fail-closed: unknown or synthetic evidence is not treated as trusted."]
    snapshot_basis = {"evidence": rows, "findings": findings}
    return {"generatedAt": generated_text, "snapshotId": _hash("snapshot", snapshot_basis), "summary": summary, "findings": findings, "evidence": rows, "limitations": limitations}


__all__ = ["build_assessment"]
