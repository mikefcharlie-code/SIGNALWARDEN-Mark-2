"""Deterministic, read-only reports over an OfflineLattice overview snapshot."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
import re
from typing import Any, Mapping

from .assistance import build_assistance
from .evidence import _input_rows, build_assessment

REPORT_TYPES = ("platform-status", "sensor-isr", "incident-timeline", "data-quality", "operator-handoff")
ENGINES = ("template", "local")
_ALLOWED_OPTIONS = {"type", "start", "end", "platformIds", "sensorIds", "engine"}
_ALLOWED_DOCUMENT_FIELDS = {"aircraft.status", "telemetry.battery_percent", "telemetry.link_quality_percent", "maintenance.status", "ingestion.status", "event", "sensor.type", "sensor.operationalState"}
_RFC3339 = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$")
_FORBIDDEN = {"weapon", "effector", "command", "control", "target", "tactical", "coordinate", "latitude", "longitude", "location", "inventory"}


def _parse(value: Any) -> datetime | None:
    if not isinstance(value, str) or not _RFC3339.fullmatch(value):
        return None
    if value[-1] != "Z":
        # datetime accepts some values that are not a valid RFC3339 offset.
        off = value[-6:]
        if len(off) != 6 or off[3] != ":" or not (0 <= int(off[1:3]) <= 23 and 0 <= int(off[4:6]) <= 59):
            return None
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return result.astimezone(timezone.utc) if result.tzinfo and result.utcoffset() is not None else None
    except (TypeError, ValueError, OverflowError):
        return None


def _iso(value: datetime | None) -> str | None:
    return value.isoformat().replace("+00:00", "Z") if value else None


def _safe(value: Any, depth: int = 0) -> Any:
    if depth > 3:
        return None
    if value is None or isinstance(value, (str, bool, int)):
        return value if not isinstance(value, str) else value[:256]
    if isinstance(value, float):
        return value if value == value and abs(value) != float("inf") else None
    if isinstance(value, list):
        return [_safe(x, depth + 1) for x in value[:20]]
    if isinstance(value, Mapping):
        return {key[:64]: _safe(item, depth + 1) for key, item in list(value.items())[:20]
                if isinstance(key, str) and not any(term in key.lower() for term in _FORBIDDEN)}
    return None


def _hash(prefix: str, value: Any) -> str:
    blob = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, default=str)
    return prefix + "-" + hashlib.sha256(blob.encode()).hexdigest()[:20]


def _valid_id(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip()) and len(value) <= 256


def _trust(value: Any, synthetic: bool, source: str) -> str:
    if synthetic or source in {"unknown", "absence"}:
        return "unknown"
    if value is True or (isinstance(value, str) and value.lower() == "trusted"):
        return "trusted"
    if isinstance(value, str) and value.lower() in {"untrusted", "unknown"}:
        return value.lower()
    return "unknown"


def _freshness(stamp: datetime | None, generated: datetime | None, synthetic: bool) -> str:
    if not stamp or not generated:
        return "unknown"
    age = (generated - stamp).total_seconds()
    if age < 0:
        return "future"
    return "stale" if synthetic or age > 300 else "current"


def _options(options: Any) -> dict[str, Any]:
    if options is None:
        options = {}
    if not isinstance(options, Mapping):
        raise ValueError("options must be an object")
    unknown = set(options) - _ALLOWED_OPTIONS
    if unknown:
        raise ValueError("unknown report option")
    typ = options.get("type", "platform-status")
    engine = options.get("engine", "template")
    if typ not in REPORT_TYPES:
        raise ValueError("unknown report type")
    if engine not in ENGINES:
        raise ValueError("engine must be 'template' or 'local'")
    parsed: dict[str, datetime | None] = {}
    for key in ("start", "end"):
        if key in options and _parse(options[key]) is None:
            raise ValueError(f"{key} must be strict RFC3339")
        parsed[key] = _parse(options.get(key))
    if parsed["start"] and parsed["end"] and parsed["start"] > parsed["end"]:
        raise ValueError("start must be before or equal to end")
    ids: dict[str, list[str]] = {}
    for key in ("platformIds", "sensorIds"):
        value = options.get(key, [])
        if not isinstance(value, list) or any(not _valid_id(item) for item in value):
            raise ValueError(f"{key} must be a list of IDs")
        ids[key] = list(dict.fromkeys(value))
    return {"type": typ, "engine": engine, **parsed, **ids}


def report_options() -> dict[str, Any]:
    return {"types": list(REPORT_TYPES), "engines": list(ENGINES), "filters": ["start", "end", "platformIds", "sensorIds"]}


def _row(entity: str, subject: str, source: str, field: str, value: Any, observed: Any, *, trust: Any, synthetic: bool, source_record_id: Any = None, generated: datetime | None = None) -> dict[str, Any]:
    stamp = _parse(observed)
    row = {"entityId": entity, "subjectId": subject, "sourceId": source, "field": field, "value": _safe(value), "observedAt": _iso(stamp), "trust": _trust(trust, synthetic, source), "freshness": _freshness(stamp, generated, synthetic), "confidence": "unknown", "synthetic": bool(synthetic)}
    if _valid_id(source_record_id):
        row["sourceRecordId"] = source_record_id
    # Adapter IDs are retained only as provenance; report IDs are namespace-owned.
    row["id"] = _hash("ev", row)
    return row


def _rows(overview: Mapping[str, Any], generated: datetime | None) -> list[dict[str, Any]]:
    # _input_rows is deliberately historical; build_assessment is latest-only and is
    # used only below for findings/citations, never as the report's evidence source.
    rows = [dict(row, confidence="unknown") for row in _input_rows(overview, generated) if isinstance(row, Mapping)]
    sensor_aliases: dict[tuple[str, str], str] = {}
    platforms = overview.get("platforms")
    if isinstance(platforms, list):
        for platform in platforms:
            if not isinstance(platform, Mapping) or not _valid_id(platform.get("entityId")):
                continue
            if platform.get("catalogId") in {"informational-weapon-like", "informational-effector-like"}:
                continue
            entity = platform["entityId"]
            prov = platform.get("provenance") if isinstance(platform.get("provenance"), Mapping) else {}
            source = prov.get("sourceId") if _valid_id(prov.get("sourceId")) else "unknown"
            observed = prov.get("sourceUpdateTime")
            synthetic = bool(platform.get("synthetic", False)) or bool(overview.get("synthetic", False))
            sensors = platform.get("sensors") if isinstance(platform.get("sensors"), Mapping) else {}
            for sensor in sensors.get("sensors", []) if isinstance(sensors.get("sensors"), list) else []:
                if not isinstance(sensor, Mapping) or not _valid_id(sensor.get("sensorId")):
                    continue
                sid = sensor["sensorId"]
                sensor_aliases[(entity, sid)] = sid
                sensor_aliases[(entity, f"{entity}:sensor:{sid}")] = sid
                for field, key in (("sensor.type", "sensorType"), ("sensor.operationalState", "operationalState")):
                    if key in sensor:
                        rows.append(_row(entity, sid, source, field, sensor.get(key), observed, trust=prov.get("trust"), synthetic=synthetic, source_record_id=sensor.get("sourceRecordId"), generated=generated))
    docs = overview.get("documentSources")
    if isinstance(docs, list):
        for raw in docs:
            if not isinstance(raw, Mapping) or raw.get("field") not in _ALLOWED_DOCUMENT_FIELDS:
                continue
            entity, subject, source = raw.get("entityId"), raw.get("subjectId", raw.get("entityId")), raw.get("sourceId", "unknown")
            if not (_valid_id(entity) and _valid_id(subject) and _valid_id(source)):
                continue
            # documentSource synthetic status is authoritative for that document.
            rows.append(_row(entity, subject, source, raw["field"], raw.get("value"), raw.get("observedAt"), trust=raw.get("trust"), synthetic=bool(raw.get("synthetic", False)), source_record_id=raw.get("sourceRecordId"), generated=generated))
    for row in rows:
        sensor_id = sensor_aliases.get((row["entityId"], row["subjectId"]))
        if sensor_id:
            row["sensorId"] = sensor_id
    unique = {row["id"]: row for row in rows if _valid_id(row.get("id"))}
    return [unique[key] for key in sorted(unique)]


def _filter(rows: list[dict[str, Any]], opts: dict[str, Any]) -> tuple[list[dict[str, Any]], int]:
    kept, excluded = [], 0
    for row in rows:
        stamp = _parse(row.get("observedAt"))
        if opts["platformIds"] and row.get("entityId") not in opts["platformIds"]:
            excluded += 1; continue
        if opts["sensorIds"] and row.get("subjectId") not in opts["sensorIds"] and row.get("sensorId") not in opts["sensorIds"]:
            excluded += 1; continue
        if opts["start"] and (stamp is None or stamp < opts["start"]):
            excluded += 1; continue
        if opts["end"] and (stamp is None or stamp > opts["end"]):
            excluded += 1; continue
        kept.append(row)
    return kept, excluded


def _md_escape(value: Any) -> str:
    return str(value if value is not None else "unknown").replace("\\", "\\\\").replace("`", "\\`").replace("[", "\\[").replace("]", "\\]").replace("<", "&lt;").replace(">", "&gt;")


def _anchor(eid: str) -> str:
    return "ev-" + re.sub(r"[^a-z0-9_-]+", "-", eid.lower()).strip("-")


def _markdown(result: dict[str, Any]) -> str:
    lines = [f"# {_md_escape(result['title'])}", "", _md_escape(result["summary"]), "", f"- Generated at: `{_md_escape(result['generatedAt'])}`; engine: `{_md_escape(result['engine'])}`; synthetic: `{str(bool(result['synthetic'])).lower()}`", f"- Scope: platforms `{_md_escape(result['scope'].get('platformIds'))}`; sensors `{_md_escape(result['scope'].get('sensorIds'))}`; start `{_md_escape(result['scope'].get('start'))}`; end `{_md_escape(result['scope'].get('end'))}`", "", "> Advisory read-only report. Human review is required; this generated document does not verify evidence.", ""]
    for section in result["sections"]:
        lines += [f"## {_md_escape(section['title'])}"]
        for claim in section.get("claims", []):
            cites = ", ".join(f"[{_md_escape(eid)}](#{_anchor(eid)})" for eid in claim.get("evidenceIds", []))
            lines.append(f"- {_md_escape(claim.get('text', ''))}" + (f" ({cites})" if cites else ""))
        lines.append("")
    lines += ["## Coverage and limitations", f"- Included evidence: {result['coverage']['included']}; excluded by filters: {result['coverage']['excluded']}."]
    for gap in result.get("coverageGaps", []): lines.append(f"- Coverage gap: {_md_escape(gap)}")
    for limitation in result.get("limitations", []): lines.append(f"- Limitation: {_md_escape(limitation)}")
    lines += ["", "## Evidence appendix"]
    seen_sources: set[str] = set()
    for row in result["evidence"]:
        eid = row["id"]
        source_anchor = _hash("source", row.get("sourceId", "unknown"))
        if source_anchor not in seen_sources:
            lines.append(f'<a id="{source_anchor}"></a>')
            seen_sources.add(source_anchor)
        lines += [f"<a id=\"{_anchor(eid)}\"></a>", f"### {_md_escape(eid)}", f"- Source: [{_md_escape(row.get('sourceId'))}](#{source_anchor}); sourceRecordId: `{_md_escape(row.get('sourceRecordId'))}`; observedAt: `{_md_escape(row.get('observedAt'))}`", f"- Entity/subject: `{_md_escape(row.get('entityId'))}` / `{_md_escape(row.get('subjectId'))}`; field: `{_md_escape(row.get('field'))}`; value: `{_md_escape(row.get('value'))}`", f"- Trust: `{_md_escape(row.get('trust'))}`; freshness: `{_md_escape(row.get('freshness'))}`; confidence: `{_md_escape(row.get('confidence'))}`; synthetic: `{str(bool(row.get('synthetic'))).lower()}`", ""]
    return "\n".join(lines) + "\n"


def build_report(overview: Mapping[str, Any] | None, options: Mapping[str, Any] | None = None, *, environ: Mapping[str, str] | None = None) -> dict[str, Any]:
    overview = overview if isinstance(overview, Mapping) else {}
    opts = _options(options)
    generated = _parse(overview.get("generatedAt"))
    all_rows = _rows(overview, generated)
    rows, excluded = _filter(all_rows, opts)
    rows.sort(key=lambda x: (_parse(x.get("observedAt")) or datetime.min.replace(tzinfo=timezone.utc), x.get("id", "")))
    typ = opts["type"]
    if typ == "sensor-isr":
        rows = [r for r in rows if r.get("subjectId") != r.get("entityId")]
    elif typ == "incident-timeline":
        rows = [r for r in rows if r.get("field") in {"event", "health", "aircraft.status", "maintenance.status", "ingestion.status", "sensor.operationalState"}]
    assessment = build_assessment(overview)
    assessment_ids = {r.get("id") for r in assessment.get("evidence", []) if isinstance(r, Mapping)}
    finding_refs = [ref for finding in assessment.get("findings", []) if isinstance(finding, Mapping) for ref in finding.get("evidenceIds", []) if ref in {r["id"] for r in rows}]
    titles = {"platform-status": "Platform status", "sensor-isr": "Sensor ISR evidence", "incident-timeline": "Incident timeline", "data-quality": "Data quality", "operator-handoff": "Operator handoff"}
    gaps: list[str] = []
    if not rows: gaps.append("No evidence matched the requested scope and filters.")
    gaps.append("Only retained source records are covered; complete historical collection payloads and outage history cannot be established.")
    if any(r.get("freshness") == "stale" for r in rows): gaps.append("Stale observation timestamps limit current-state coverage.")
    if any(r.get("freshness") == "future" for r in rows): gaps.append("Future-dated observations require clock validation.")
    if any(r.get("freshness") == "unknown" for r in rows): gaps.append("Some observation times are missing or invalid; temporal coverage is unknown.")
    if (opts["start"] or opts["end"]) and any(_parse(r.get("observedAt")) is None for r in all_rows): gaps.append("Undated records were excluded by the requested time range; historical time coverage is incomplete.")
    if any(r.get("synthetic") for r in rows): gaps.append("Synthetic fixture evidence is included and explicitly labeled; it is not live telemetry.")
    if any(r.get("trust") != "trusted" for r in rows): gaps.append("Some evidence has unknown or untrusted provenance.")
    if any(r.get("field") == "sensors" for r in all_rows): gaps.append("Sensor coverage is metadata-only where no historical sensor collection payload is present.")
    claims = [{"text": f"{r.get('entityId')} / {r.get('subjectId')} / {r.get('field')}: {r.get('value')!r}; source={r.get('sourceId')}; observedAt={r.get('observedAt')}; trust={r.get('trust')}; synthetic={bool(r.get('synthetic'))}.", "evidenceIds": [r["id"]]} for r in rows]
    sections = [{"title": titles[typ], "claims": claims}]
    finding_claims = []
    retained_ids = {r["id"] for r in rows}
    for finding in assessment.get("findings", []):
        refs = finding.get("evidenceIds", []) if isinstance(finding, Mapping) else []
        if refs and all(ref in retained_ids for ref in refs):
            finding_claims.append({"text": f"{finding.get('title')}: {finding.get('detail')}", "evidenceIds": list(refs)})
    if finding_claims:
        sections.append({"title": "Assessment findings", "claims": finding_claims})
    report_engine, model_status = ("local-fallback", "unavailable") if opts["engine"] == "local" else ("template", "not-requested")
    if opts["engine"] == "local":
        env = dict(environ or os.environ)
        env["UCAS_AI_MODE"] = "local"
        assistance = build_assistance(dict(overview), environ=env)
        if isinstance(assistance, Mapping) and assistance.get("engine") == "local-model" and assistance.get("modelStatus") == "available":
            report_engine, model_status = "local-model", "available"
        highlights = assistance.get("insights", []) if isinstance(assistance, Mapping) else []
        local_claims = [{"text": item.get("title", "Local deterministic highlight") + ": " + item.get("detail", ""), "evidenceIds": list(item.get("evidence", []))} for item in highlights if isinstance(item, Mapping) and item.get("evidence") and all(eid in retained_ids for eid in item.get("evidence", []))]
        sections.append({"title": "Local deterministic highlights", "claims": local_claims})
    report_id = _hash("report", {"type": typ, "options": {k: (_iso(v) if isinstance(v, datetime) else v) for k, v in opts.items()}, "evidence": rows})
    is_synthetic = any(bool(r.get("synthetic")) for r in rows) or (not rows and bool(overview.get("synthetic", False)))
    result = {"id": report_id, "snapshotId": report_id, "type": typ, "generatedAt": _iso(generated) or "1970-01-01T00:00:00Z", "synthetic": is_synthetic, "engine": report_engine, "modelStatus": model_status, "title": titles[typ] + (" (synthetic demo)" if is_synthetic else ""), "summary": f"Deterministic read-only {titles[typ].lower()} containing {len(rows)} evidence record(s).", "scope": {"platformIds": opts["platformIds"], "sensorIds": opts["sensorIds"], "start": _iso(opts["start"]), "end": _iso(opts["end"])}, "sections": sections, "evidence": rows, "coverage": {"included": len(rows), "excluded": excluded, "historical": True, "assessmentEvidence": len(assessment_ids), "findingReferences": sorted(set(finding_refs))}, "coverageGaps": gaps, "limitations": ["Evidence citations describe source records and do not establish physical-world truth.", "Historical offline metadata is not a current transport heartbeat and does not establish an outage.", "Synthetic demo evidence is illustrative only and must not be treated as live telemetry.", "No control, tactical, location, weapon, effector, or inventory fields are reported."], "advisory": True, "humanReviewRequired": True}
    result["markdown"] = _markdown(result)
    return result


__all__ = ["build_report", "report_options", "REPORT_TYPES"]
