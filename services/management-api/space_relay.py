"""Opt-in, read-only relay for space situational-awareness sources.

Disabled unless ``UCAS_SPACE_RELAY_ENABLED=1``. It relays exactly two fixed
upstream reads and nothing else:

* SatNOGS Network past radio observations for one NORAD ID
  (``network.satnogs.org`` sends no CORS headers, so browsers cannot read it).
* The Space Devs Launch Library 2 upcoming launches. When
  ``UCAS_LAUNCH_LIBRARY_API_KEY`` is set the key is sent upstream as
  ``Authorization: Token ...``; it is never returned, logged or echoed.

Requests require ``X-SignalWarden-Space: enabled`` and a same-origin browser
context. Upstream reads are bounded (size, deadline, concurrency), cached and
throttled. Responses are reduced to an allowlisted field set (no observer
usernames, no station coordinates).
"""
from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

MAX_BYTES = 1024 * 1024
DEADLINE_SECONDS = 15.0
SATNOGS_CACHE_SECONDS = 600
SATNOGS_MIN_INTERVAL_SECONDS = 10
LAUNCH_CACHE_SECONDS = 900
LAUNCH_MIN_INTERVAL_KEYLESS_SECONDS = 300
LAUNCH_MIN_INTERVAL_KEYED_SECONDS = 60
SATNOGS_ORIGIN = "https://network.satnogs.org"
LAUNCH_ORIGIN = "https://ll.thespacedevs.com"
_ALLOWED_HOSTS = frozenset({"network.satnogs.org", "ll.thespacedevs.com"})
USER_AGENT = "SignalWarden-WorldView/0.1 (read-only space relay)"


class SpaceRelayError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        return None


_slots = threading.BoundedSemaphore(2)
_lock = threading.Lock()
_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_attempts: dict[str, float] = {}


def enabled() -> bool:
    return os.getenv("UCAS_SPACE_RELAY_ENABLED", "0").lower() in {"1", "true", "yes"}


def _launch_key() -> str:
    key = os.getenv("UCAS_LAUNCH_LIBRARY_API_KEY", "").strip()
    # Keys are opaque tokens; reject anything that could inject header content.
    if key and (len(key) > 200 or any(c in key for c in "\r\n\t ")):
        return ""
    return key


def reset_state() -> None:
    with _lock:
        _cache.clear()
        _attempts.clear()


def _same_origin(headers: Any) -> bool:
    origin = headers.get("Origin")
    if origin:
        try:
            parsed = urlsplit(origin)
        except ValueError:
            return False
        if parsed.scheme not in {"http", "https"} or parsed.path or parsed.query or parsed.fragment:
            return False
        if parsed.netloc.lower() != (headers.get("Host") or "").lower():
            return False
    return (headers.get("Sec-Fetch-Site") or "").lower() != "cross-site"


def authorize(headers: Any) -> None:
    if not enabled():
        raise SpaceRelayError(404, "space_relay_disabled", "space relay is disabled")
    if headers.get("X-SignalWarden-Space") != "enabled":
        raise SpaceRelayError(403, "space_header_required", "X-SignalWarden-Space: enabled is required")
    if not _same_origin(headers):
        raise SpaceRelayError(403, "origin_not_allowed", "cross-site space relay requests are not allowed")


def _now_iso(now: float) -> str:
    return datetime.fromtimestamp(now, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _default_open(request: Request, timeout: float):
    # Use the process proxy configuration (deployments may require an egress proxy).
    return build_opener(_NoRedirect()).open(request, timeout=timeout)


Opener = Callable[[Request, float], Any]
_open: Opener = _default_open


def _get_json(url: str, headers: dict[str, str]) -> Any:
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname not in _ALLOWED_HOSTS or parsed.port not in (None, 443):
        raise SpaceRelayError(500, "space_upstream_not_allowed", "upstream host is not allowlisted")
    deadline = time.monotonic() + DEADLINE_SECONDS
    request = Request(url, headers={"Accept": "application/json", "User-Agent": USER_AGENT, **headers}, method="GET")
    try:
        response = _open(request, DEADLINE_SECONDS)
    except HTTPError as exc:
        code = exc.code
        exc.close()
        if code == 429:
            raise SpaceRelayError(429, "space_upstream_rate_limited", "upstream provider rate limit reached") from None
        if code in {401, 403}:
            raise SpaceRelayError(502, "space_upstream_unauthorized", "upstream provider rejected the request") from None
        raise SpaceRelayError(502, "space_upstream_error", f"upstream provider returned HTTP {code}") from None
    except (URLError, TimeoutError, OSError):
        raise SpaceRelayError(502, "space_upstream_unreachable", "upstream provider could not be reached") from None
    try:
        length = response.headers.get("Content-Length")
        if length is not None and length.isdigit() and int(length) > MAX_BYTES:
            raise SpaceRelayError(502, "space_upstream_too_large", "upstream response exceeds the size limit")
        data = bytearray()
        while True:
            if time.monotonic() > deadline:
                raise SpaceRelayError(504, "space_upstream_timeout", "upstream provider timed out")
            chunk = response.read(min(64 * 1024, MAX_BYTES + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > MAX_BYTES:
                raise SpaceRelayError(502, "space_upstream_too_large", "upstream response exceeds the size limit")
    except SpaceRelayError:
        raise
    except (URLError, TimeoutError, OSError):
        raise SpaceRelayError(502, "space_upstream_unreachable", "upstream provider could not be read") from None
    finally:
        response.close()
    try:
        return json.loads(bytes(data).decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise SpaceRelayError(502, "space_upstream_invalid", "upstream provider returned invalid JSON") from None


def _cached(key: str, max_age: float, min_interval: float, fetch: Callable[[], dict[str, Any]]) -> dict[str, Any]:
    now = time.time()
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < max_age:
            return {**hit[1], "cached": True}
        family = key.split(":", 1)[0]
        if now - _attempts.get(family, 0.0) < min_interval:
            if hit:
                return {**hit[1], "cached": True, "stale": True}
            raise SpaceRelayError(429, "space_relay_throttled", "space relay refresh throttled; retry shortly")
        _attempts[family] = now
    if not _slots.acquire(blocking=False):
        raise SpaceRelayError(503, "space_relay_busy", "space relay concurrency limit reached")
    try:
        body = fetch()
    except SpaceRelayError:
        with _lock:
            hit = _cache.get(key)
        if hit:
            return {**hit[1], "cached": True, "stale": True}
        raise
    finally:
        _slots.release()
    body["retrievedAt"] = _now_iso(now)
    with _lock:
        _cache[key] = (now, body)
    return {**body, "cached": False}


def _norad(values: list[str]) -> int:
    if len(values) != 1 or not values[0].isdigit() or len(values[0]) > 9:
        raise SpaceRelayError(400, "invalid_norad_id", "norad must be one positive integer NORAD catalog number")
    value = int(values[0])
    if value < 1:
        raise SpaceRelayError(400, "invalid_norad_id", "norad must be one positive integer NORAD catalog number")
    return value


def _str(value: Any, limit: int) -> str:
    return value[:limit] if isinstance(value, str) else ""


def _num(value: Any) -> float | int | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def satnogs_observations(norad: int) -> dict[str, Any]:
    def fetch() -> dict[str, Any]:
        end = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        # The live API filters on norad_cat_id (satellite__norad_cat_id is ignored as of 2026-10).
        url = f"{SATNOGS_ORIGIN}/api/observations/?" + urlencode({"norad_cat_id": norad, "end": end, "format": "json"})
        payload = _get_json(url, {})
        if not isinstance(payload, list):
            raise SpaceRelayError(502, "space_upstream_invalid", "SatNOGS returned an unexpected shape")
        rows = []
        for item in payload[:25]:
            if not isinstance(item, dict) or item.get("norad_cat_id") != norad:
                continue
            status = item.get("status")
            if status not in {"good", "bad", "failed", "unknown"}:
                continue  # skip "future" (scheduled, not observed)
            if not isinstance(item.get("id"), int):
                continue
            rows.append({
                "id": item["id"],
                "start": _str(item.get("start"), 40),
                "end": _str(item.get("end"), 40),
                "status": status,
                "stationId": _num(item.get("ground_station")),
                "stationName": _str(item.get("station_name"), 80),
                "transmitter": _str(item.get("transmitter_description"), 120),
                "mode": _str(item.get("transmitter_mode"), 40),
                "frequencyHz": _num(item.get("observation_frequency")) or _num(item.get("transmitter_downlink_low")),
            })
        return {
            "provider": "SatNOGS Network",
            "kind": "radio-observations",
            "sourceUrl": f"{SATNOGS_ORIGIN}/api/observations/?norad_cat_id={norad}",
            "attribution": "SatNOGS Network by Libre Space Foundation and volunteer ground stations",
            "license": "CC BY-SA 4.0",
            "note": "Radio observations by ground stations; not optical sightings.",
            "noradId": norad,
            "observations": rows,
        }

    return _cached(f"satnogs:{norad}", SATNOGS_CACHE_SECONDS, SATNOGS_MIN_INTERVAL_SECONDS, fetch)


def upcoming_launches() -> dict[str, Any]:
    key = _launch_key()

    def fetch() -> dict[str, Any]:
        headers = {"Authorization": f"Token {key}"} if key else {}
        payload = _get_json(f"{LAUNCH_ORIGIN}/2.2.0/launch/upcoming/?limit=10&mode=list&format=json", headers)
        results = payload.get("results") if isinstance(payload, dict) else None
        if not isinstance(results, list):
            raise SpaceRelayError(502, "space_upstream_invalid", "Launch Library returned an unexpected shape")
        rows = []
        for item in results[:10]:
            if not isinstance(item, dict):
                continue
            status = item.get("status") if isinstance(item.get("status"), dict) else {}
            rows.append({
                "id": _str(item.get("id"), 64),
                "name": _str(item.get("name"), 160),
                "net": _str(item.get("net"), 40),
                "window_start": _str(item.get("window_start"), 40),
                "window_end": _str(item.get("window_end"), 40),
                "last_updated": _str(item.get("last_updated"), 40),
                "status": {"abbrev": _str(status.get("abbrev"), 40), "description": _str(status.get("description"), 200)},
                "lsp_name": _str(item.get("lsp_name"), 120),
                "mission": _str(item.get("mission"), 160),
                "pad": _str(item.get("pad"), 160),
                "location": _str(item.get("location"), 160),
            })
        return {
            "provider": "Launch Library 2",
            "kind": "launch-schedule",
            "sourceUrl": f"{LAUNCH_ORIGIN}/2.2.0/launch/upcoming/",
            "attribution": "The Space Devs Launch Library 2",
            "results": rows,
        }

    body = _cached(
        "launches:upcoming",
        LAUNCH_CACHE_SECONDS,
        LAUNCH_MIN_INTERVAL_KEYED_SECONDS if key else LAUNCH_MIN_INTERVAL_KEYLESS_SECONDS,
        fetch,
    )
    return {**body, "keyConfigured": bool(key)}


def status() -> dict[str, Any]:
    return {
        "enabled": enabled(),
        "satnogs": "available" if enabled() else "disabled",
        "launchLibrary": {
            "relay": "available" if enabled() else "disabled",
            "apiKey": "configured" if _launch_key() else "not_configured",
        },
    }


def dispatch(command: str, suffix: list[str], query: dict[str, list[str]], headers: Any) -> dict[str, Any]:
    authorize(headers)
    if command != "GET":
        raise SpaceRelayError(405, "method_not_allowed", "space relay is read-only")
    if suffix == ["status"] and not query:
        return status()
    if suffix == ["satnogs", "observations"]:
        if set(query) != {"norad"}:
            raise SpaceRelayError(400, "invalid_norad_id", "norad must be the only query parameter")
        return satnogs_observations(_norad(query["norad"]))
    if suffix == ["launches", "upcoming"] and not query:
        return upcoming_launches()
    raise SpaceRelayError(404, "not_found", "space relay route was not found")
