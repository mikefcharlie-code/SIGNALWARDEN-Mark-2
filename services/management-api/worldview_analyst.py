"""Evidence-preserving candidate ordering for the local AI analyst route."""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
import urllib.error
from typing import Any

ROOT = __import__("pathlib").Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from services.lattice_readonly.assistance import (
    _EXTERNAL_URL,
    _NoRedirect,
    _provider_url,
    _read_response,
    _timeout,
)

MAX_BODY = 16 * 1024
MAX_QUESTION = 2000
MAX_CANDIDATES = 80
MAX_TEXT = 2000
MAX_CITATIONS = 100
MAX_ID = 128
MAX_CITATION_ID = 128
MAX_PROMPT = 4096
MAX_RESPONSE = 64000
MAX_MODEL_CANDIDATES = 12


def _disclosure(mode: str, question: str, candidates: list[dict[str, Any]], leaves: bool, model_subset: int | None = None) -> str:
    ids = [item["id"] for item in candidates]
    citations = [citation for item in candidates for citation in item["citationIds"]]
    scope = "question and candidate text, IDs, and citation IDs"
    destination = "leave this system" if leaves else "remain in this system"
    scope_note = (f" The model highlights only a bounded subset of {model_subset} candidate(s); "
                  "all original candidate IDs remain in the final result." if model_subset is not None and model_subset < len(candidates) else "")
    return (f"The {mode} analyst may only reorder the cited candidates; it cannot author facts, "
            f"suppress evidence, or execute tools. The {scope} will {destination}. "
            f"Candidate IDs: {json.dumps(ids, separators=(',', ':'))}; citation IDs included: "
            f"{json.dumps(citations, separators=(',', ':'))}.{scope_note}")


def validate_request(body: Any) -> dict[str, Any]:
    if not isinstance(body, dict) or set(body) != {"mode", "question", "candidates", "consent"}:
        raise ValueError("request must contain exactly mode, question, candidates, and consent")
    if not isinstance(body["mode"], str) or body["mode"] not in {"local", "external"} or not isinstance(body["question"], str):
        raise ValueError("mode and question have invalid types")
    if len(body["question"]) > MAX_QUESTION:
        raise ValueError("question exceeds 2000 characters")
    if not isinstance(body["candidates"], list) or len(body["candidates"]) > MAX_CANDIDATES:
        raise ValueError("candidates must contain at most 80 items")
    if not isinstance(body["consent"], bool):
        raise ValueError("consent must be boolean")
    seen: set[str] = set()
    candidates = []
    for candidate in body["candidates"]:
        if not isinstance(candidate, dict) or set(candidate) != {"id", "text", "citationIds"}:
            raise ValueError("each candidate must contain exactly id, text, and citationIds")
        ident, text, citations = candidate["id"], candidate["text"], candidate["citationIds"]
        if not isinstance(ident, str) or not ident or len(ident) > MAX_ID or ident in seen:
            raise ValueError("candidate IDs must be unique non-empty strings")
        if not isinstance(text, str) or len(text) > MAX_TEXT:
            raise ValueError("candidate text exceeds 2000 characters")
        if (not isinstance(citations, list) or len(citations) > MAX_CITATIONS
                or any(not isinstance(x, str) or len(x) > MAX_CITATION_ID for x in citations)):
            raise ValueError("citationIds must contain at most 100 strings")
        seen.add(ident)
        candidates.append({"id": ident, "text": text, "citationIds": list(citations)})
    return {"mode": body["mode"], "question": body["question"], "candidates": candidates, "consent": body["consent"]}


def _candidate_subset(question: str, candidates: list[dict[str, Any]]) -> list[tuple[str, dict[str, Any]]]:
    """Select a bounded prompt subset, using short opaque IDs for the model."""
    chosen: list[tuple[str, dict[str, Any]]] = []
    system = 'Return JSON only: {"selectedIds":[]} using only candidate IDs; no prose or facts.'
    for candidate in candidates:
        if len(chosen) >= MAX_MODEL_CANDIDATES:
            break
        short_id = f"c{len(chosen)}"
        trial = chosen + [(short_id, candidate)]
        prompt = json.dumps({"question": question, "candidates": [{"id": sid, "text": item["text"]} for sid, item in trial]}, ensure_ascii=True, separators=(",", ":"))
        messages = [{"role": "system", "content": system}, {"role": "user", "content": prompt}]
        body = json.dumps({"model": "m", "messages": messages, "temperature": 0, "max_tokens": 400}, separators=(",", ":")).encode()
        if sum(len(message["content"]) for message in messages) > MAX_PROMPT or len(body) > MAX_BODY:
            continue
        chosen = trial
    return chosen


def _provider(target: str, model: str, question: str, candidates: list[dict[str, Any]], timeout: float, key: str | None = None) -> list[str] | None:
    subset = _candidate_subset(question, candidates)
    if not subset:
        return None
    # All user material is data in a JSON-delimited prompt; model output is never returned.
    prompt = json.dumps({"question": question, "candidates": [{"id": sid, "text": item["text"]} for sid, item in subset]}, ensure_ascii=True, separators=(",", ":"))
    system = 'Return JSON only: {"selectedIds":[]} using only candidate IDs; no prose or facts.'
    messages = [{"role": "system", "content": system}, {"role": "user", "content": prompt}]
    payload = json.dumps({"model": model, "messages": messages, "temperature": 0, "max_tokens": 400}, separators=(",", ":")).encode()
    if sum(len(message["content"]) for message in messages) > MAX_PROMPT or len(payload) > MAX_BODY:
        return None
    req = urllib.request.Request(target, data=payload, headers={"Content-Type": "application/json", "Accept": "application/json", **({"Authorization": "Bearer " + key} if key else {})}, method="POST")
    deadline = time.monotonic() + timeout
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)
        with opener.open(req, timeout=max(0.05, deadline - time.monotonic())) as response:
            if response.status != 200:
                return None
            raw = _read_response(response, deadline)
        if raw is None or len(raw) > MAX_RESPONSE or time.monotonic() > deadline:
            return None
        doc = json.loads(raw)
        content = doc["choices"][0]["message"]["content"]
        result = json.loads(content) if isinstance(content, str) else content
        selected = result.get("selectedIds") if isinstance(result, dict) and set(result) == {"selectedIds"} else None
        allowed = {short_id: item["id"] for short_id, item in subset}
        if (not isinstance(selected, list) or any(not isinstance(x, str) for x in selected)
                or len(selected) != len(set(selected)) or any(x not in allowed for x in selected)):
            return None
        return [allowed[x] for x in selected]
    except (OSError, ValueError, TypeError, KeyError, IndexError, json.JSONDecodeError, urllib.error.URLError):
        return None


def _ordered(candidates: list[dict[str, Any]], selected: list[str] | None) -> list[str]:
    ids = [item["id"] for item in candidates]
    chosen = selected if isinstance(selected, list) else []
    chosen = [item for item in chosen if isinstance(item, str)]
    chosen_set = set(chosen)
    return chosen + [ident for ident in ids if ident not in chosen_set]


def _valid_selection(selected: Any, candidates: list[dict[str, Any]]) -> bool:
    allowed = {item["id"] for item in candidates}
    return (isinstance(selected, list) and all(isinstance(x, str) for x in selected)
            and len(selected) == len(set(selected)) and all(x in allowed for x in selected))


def status(environ: dict[str, str] | None = None) -> dict[str, Any]:
    env = os.environ if environ is None else environ
    model = env.get("UCAS_AI_LOCAL_MODEL", "").strip()
    endpoint = env.get("UCAS_LATTICE_AI_ENDPOINT") or env.get("UCAS_LATTICE_LOCAL_MODEL_URL")
    configured = bool(model and endpoint and _provider_url(endpoint) and env.get("UCAS_AI_LOCAL_RUNTIME", "").strip().lower() not in {"disabled", "off"})
    return {"configured": configured, "modelStatus": "configured; readiness not probed" if configured else "requires a running configured local server and UCAS_AI_LOCAL_MODEL; no auto-install or inference is performed"}


def analyze(request: dict[str, Any], environ: dict[str, str] | None = None) -> dict[str, Any]:
    env = os.environ if environ is None else environ
    mode, question, candidates, consent = request["mode"], request["question"], request["candidates"], request["consent"]
    selected = None
    engine, model_status, leaves = "deterministic", "deterministic candidate ordering; no provider call was made", False
    model_subset = len(_candidate_subset(question, candidates))
    if mode == "local":
        model = env.get("UCAS_AI_LOCAL_MODEL", "").strip()
        endpoint = env.get("UCAS_LATTICE_AI_ENDPOINT") or env.get("UCAS_LATTICE_LOCAL_MODEL_URL")
        target = _provider_url(endpoint) if endpoint else None
        if model and target and model_subset and env.get("UCAS_AI_LOCAL_RUNTIME", "").strip().lower() not in {"disabled", "off"}:
            selected = _provider(target, model, question, candidates, _timeout(env, local=True))
            if not _valid_selection(selected, candidates):
                selected = None
            if selected is not None:
                engine, model_status = "local-model", "configured local model responded"
            else:
                model_status = "local model unavailable or returned invalid IDs; deterministic ordering used"
        else:
            model_status = "requires a running configured local server and UCAS_AI_LOCAL_MODEL; no provider call was made"
    elif consent and env.get("UCAS_AI_EXTERNAL_CONSENT", "").strip().lower() == "true" and env.get("UCAS_AI_EXTERNAL_PROVIDER", "").strip().lower() == "openai" and env.get("UCAS_AI_EXTERNAL_MODEL", "").strip() and env.get("UCAS_AI_EXTERNAL_API_KEY", ""):
        if model_subset:
            selected = _provider(_EXTERNAL_URL, env["UCAS_AI_EXTERNAL_MODEL"].strip(), question, candidates, min(2.0, _timeout(env)), env["UCAS_AI_EXTERNAL_API_KEY"])
        if not _valid_selection(selected, candidates):
            selected = None
        leaves = True
        if selected is not None:
            engine, model_status = "external-model", "configured external model responded"
        else:
            model_status = "external model unavailable or returned invalid IDs; deterministic ordering used"
    else:
        model_status = "external requires explicit mode, consent, UCAS_AI_EXTERNAL_CONSENT=true, provider=openai, model, and key; no provider call was made"
    return {"engine": engine, "modelStatus": model_status, "selectedIds": _ordered(candidates, selected), "disclosure": _disclosure(mode, question, candidates, leaves, model_subset), "dataLeavesSystem": leaves}
