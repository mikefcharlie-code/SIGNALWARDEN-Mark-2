"""Opt-in, read-only WorldView relay for transit, street imagery and place/context feeds.

Disabled by default. Enable with ``UCAS_WORLDVIEW_MOBILITY_ENABLED=1``; every
request must also carry ``X-SignalWarden-Mobility: enabled`` and be
same-origin. The relay performs bounded HTTPS GETs to an explicit host
allowlist (no redirects, size/time limits, per-provider throttles, small
in-memory TTL caches) and returns normalized metadata only.

Keys live only in server environment variables and are sent upstream in a
header or query parameter. Returned ``sourceUrl`` values, error messages and
logs never contain a key. With a required key missing the provider reports
``status: "not_configured"`` and returns no items (never fabricated data).

No path here can reach flight control, MAVLink, commands or targeting. No
face/plate analysis, identity enrichment, article content, stream relay or
image download happens on the server.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from datetime import datetime, timezone
from email.message import Message
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

import gtfs_realtime_lite
import worldview_mobility_parsers as parse
from sar_imagery import _same_origin

ENABLE_ENV = "UCAS_WORLDVIEW_MOBILITY_ENABLED"
HEADER = "X-SignalWarden-Mobility"
ROUTE_PREFIX = ["api", "v1", "worldview-mobility"]
VERSION = "0.1"
DEFAULT_TIMEOUT = 15.0
SMALL_BYTES = 1 * 1024 * 1024
LARGE_BYTES = 4 * 1024 * 1024
KEY_ENV_RE = re.compile(r"^UCAS_[A-Z0-9_]{1,60}_(?:KEY|TOKEN)$")
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
HOST_RE = re.compile(r"^[a-z0-9.-]{1,253}$")
_SECRETISH = re.compile(r"(?i)(api[_-]?key|access[_-]?token|token|key|secret|password)=([^&\s]+)")


class MobilityError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req: Request, fp: Any, code: int, msg: str, headers: Message, newurl: str) -> None:
        return None


def _flag(name: str, default: str = "0") -> bool:
    return os.getenv(name, default).strip().lower() in {"1", "true", "yes"}


def enabled() -> bool:
    return _flag(ENABLE_ENV)


def _now() -> float:
    return time.time()


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def contact() -> str | None:
    value = os.getenv("UCAS_WORLDVIEW_CONTACT", "").strip()
    if not value or len(value) > 200 or any(ch in value for ch in "\r\n()"):
        return None
    return value


def user_agent() -> str:
    who = contact()
    return f"SignalWarden-WorldView/{VERSION} (+{who})" if who else f"SignalWarden-WorldView/{VERSION} (contact not configured)"


def redact(text: str) -> str:
    """Strip anything that looks like a credential from text that may be shown or logged."""
    return _SECRETISH.sub(lambda m: f"{m.group(1)}=REDACTED", text)


# ------------------------------------------------------------------ transport

_slots = threading.BoundedSemaphore(4)


def _check_url(url: str, allowed_hosts: frozenset[str]) -> None:
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError as exc:
        raise MobilityError(502, "upstream_url_rejected", "provider URL is invalid") from exc
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or parts.username or parts.password or parts.fragment or port not in (None, 443):
        raise MobilityError(502, "upstream_url_rejected", "provider URL must be plain HTTPS")
    if host not in allowed_hosts:
        raise MobilityError(502, "upstream_host_not_allowed", f"provider host {host or '?'} is not on the allowlist")


def http_get(url: str, *, allowed_hosts: frozenset[str], headers: dict[str, str] | None = None,
             max_bytes: int = SMALL_BYTES, timeout: float = DEFAULT_TIMEOUT) -> tuple[bytes, str]:
    """Bounded HTTPS GET. Returns (body, content_type). Never follows redirects."""
    _check_url(url, allowed_hosts)
    opener = build_opener(ProxyHandler({}), _NoRedirect())
    request_headers = {"User-Agent": user_agent(), "Accept": "application/json"}
    request_headers.update(headers or {})
    deadline = time.monotonic() + timeout
    try:
        response = opener.open(Request(url, headers=request_headers, method="GET"), timeout=timeout)
    except HTTPError as exc:
        code = exc.code
        exc.close()
        if code in (301, 302, 303, 307, 308):
            raise MobilityError(502, "upstream_redirect_rejected", "provider redirect was rejected") from None
        if code == 429:
            raise MobilityError(429, "upstream_rate_limited", "provider rate limit reached; try again later") from None
        if code in (401, 403):
            raise MobilityError(502, "upstream_auth_failed", "provider rejected the request (credentials or access)") from None
        raise MobilityError(502, "upstream_http_error", f"provider returned HTTP {code}") from None
    except (URLError, TimeoutError, OSError) as exc:
        raise MobilityError(502, "upstream_unreachable", "provider could not be reached") from exc
    try:
        length = response.headers.get("Content-Length")
        if length is not None and length.isdigit() and int(length) > max_bytes:
            raise MobilityError(413, "upstream_too_large", "provider response exceeds the relay size limit")
        data = bytearray()
        while True:
            if time.monotonic() > deadline:
                raise MobilityError(504, "upstream_timeout", "provider timed out")
            read = getattr(response, "read1", response.read)
            chunk = read(min(64 * 1024, max_bytes + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > max_bytes:
                raise MobilityError(413, "upstream_too_large", "provider response exceeds the relay size limit")
        return bytes(data), response.headers.get_content_type().lower()
    except (URLError, TimeoutError, OSError) as exc:
        raise MobilityError(502, "upstream_unreachable", "provider response could not be read") from exc
    finally:
        response.close()


# Tests replace this with a fake; CI never reaches the network.
transport: Callable[..., tuple[bytes, str]] = http_get


def _fetch(url: str, *, allowed_hosts: frozenset[str], headers: dict[str, str] | None = None,
           max_bytes: int = SMALL_BYTES) -> tuple[bytes, str]:
    _check_url(url, allowed_hosts)  # enforced here too, whatever transport is installed
    if not _slots.acquire(blocking=False):
        raise MobilityError(503, "relay_busy", "relay concurrency limit reached; try again shortly")
    try:
        return transport(url, allowed_hosts=allowed_hosts, headers=headers, max_bytes=max_bytes)
    finally:
        _slots.release()


def _fetch_json(url: str, **kwargs: Any) -> Any:
    body, _ = _fetch(url, **kwargs)
    try:
        return json.loads(body.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise MobilityError(502, "upstream_invalid_json", "provider did not return valid JSON") from None


# ------------------------------------------------------------------ throttle + cache

_lock = threading.RLock()
_last_attempt: dict[str, float] = {}
_cache: dict[str, tuple[float, dict[str, Any]]]= {}
_doc_cache: dict[str, tuple[float, Any]] = {}
_MAX_CACHE = 256


def reset_state() -> None:
    """Clear throttles/caches (used by tests and on configuration change)."""
    with _lock:
        _last_attempt.clear()
        _cache.clear()
        _doc_cache.clear()


def _remember(store: dict[str, Any], key: str, value: Any) -> None:
    with _lock:
        if len(store) >= _MAX_CACHE:
            oldest = min(store, key=lambda k: store[k][0])
            store.pop(oldest, None)
        store[key] = (_now(), value)


def _throttle_wait(gate: str, min_interval: float, max_wait: float = 0.0) -> bool:
    """Reserve a request slot for ``gate``. Sleeps up to ``max_wait``; returns False if still too soon."""
    with _lock:
        now = _now()
        last = _last_attempt.get(gate, 0.0)
        wait = last + min_interval - now
        if wait > max_wait:
            return False
        _last_attempt[gate] = max(now, last + min_interval)
    if wait > 0:
        time.sleep(wait)
    return True


# ------------------------------------------------------------------ envelopes

def envelope(provider: dict[str, Any], *, status: str, items: list[dict[str, Any]] | None = None,
             retrieved_at: float | None = None, provider_ts: str | None = None, source_url: str | None = None,
             ttl: int | None = None, error: str | None = None, notice: str | None = None,
             truncated: bool = False, freshness: str | None = None, **extra: Any) -> dict[str, Any]:
    now = _now()
    retrieved = retrieved_at if retrieved_at is not None else now
    age = None
    if provider_ts:
        try:
            age = max(0, round(now - datetime.fromisoformat(provider_ts.replace("Z", "+00:00")).timestamp()))
        except ValueError:
            age = None
    safe_items: list[dict[str, Any]] = []
    for original in items or []:
        item = dict(original)
        item_freshness = item.get("freshness", freshness or "unknown")
        item_live = status == "ok" and (freshness or "fresh") == "fresh" and item_freshness == "fresh"
        item["live"] = item_live
        properties = item.get("properties")
        if isinstance(properties, dict):
            item["properties"] = {**properties, "live": item_live}
        safe_items.append(item)
    body = {
        "providerId": provider["id"],
        "provider": provider["name"],
        "status": status,
        "freshness": freshness or {"ok": "fresh", "stale": "stale", "throttled": "stale"}.get(status, status),
        "retrievedAt": _iso(retrieved),
        "providerTimestamp": provider_ts,
        "ageSeconds": age,
        "sourceUrl": redact(source_url) if source_url else None,
        "attribution": provider.get("attribution"),
        "license": provider.get("license"),
        "licenseUrl": provider.get("licenseUrl"),
        "termsUrl": provider.get("termsUrl"),
        "ttlSeconds": ttl,
        "truncated": truncated,
        "items": safe_items,
        # A successful HTTP response is not evidence of a current source record.
        # Stale and unknown freshness must never be advertised as live.
        "live": status == "ok" and (freshness or "fresh") == "fresh",
        "synthetic": False,
    }
    if error:
        body["error"] = redact(error)
    if notice:
        body["notice"] = notice
    body.update(extra)
    return body


def _cached_or_failed(provider: dict[str, Any], key: str, error: MobilityError) -> dict[str, Any]:
    with _lock:
        hit = _cache.get(key)
    if hit:
        old = dict(hit[1])
        old.update(status="stale", freshness="stale", live=False, error=redact(f"{error.message}; showing last successful snapshot"))
        old["items"] = [dict(item, freshness="stale", live=False,
                              properties={**item.get("properties", {}), "live": False})
                         for item in old.get("items", []) if isinstance(item, dict)]
        return old
    return envelope(provider, status="failed", error=error.message, errorCode=error.code)


def _throttled(provider: dict[str, Any], key: str, interval: float) -> dict[str, Any]:
    with _lock:
        hit = _cache.get(key)
    message = f"refresh throttled (minimum {interval:g}s between {provider['name']} requests)"
    if hit:
        old = dict(hit[1])
        old.update(status="throttled", freshness="stale", live=False, error=message, cached=True)
        old["items"] = [dict(item, freshness="stale", live=False,
                              properties={**item.get("properties", {}), "live": False})
                         for item in old.get("items", []) if isinstance(item, dict)]
        return old
    return envelope(provider, status="throttled", error=message, live=False)


# ------------------------------------------------------------------ provider catalogue

def _provider(pid: str, name: str, attribution: str, license_: str, license_url: str | None, terms_url: str) -> dict[str, Any]:
    return {"id": pid, "name": name, "attribution": attribution, "license": license_, "licenseUrl": license_url, "termsUrl": terms_url}


NOMINATIM_DEFAULT = "https://nominatim.openstreetmap.org"
PANORAMAX_DEFAULT = "https://api.panoramax.xyz/api"
RADIO_BROWSER_DEFAULT = "https://de1.api.radio-browser.info"
OVERPASS_DEFAULT = "https://overpass-api.de/api/interpreter"
GDELT_URL = "https://api.gdeltproject.org/api/v2/doc/doc"
MAPILLARY_URL = "https://graph.mapillary.com/images"
KARTAVIEW_URL = "https://api.kartaview.org/2.0/photo/"

PROVIDERS = {
    "nominatim": _provider("osm-nominatim", "OpenStreetMap Nominatim", "© OpenStreetMap contributors", "ODbL 1.0",
                           "https://opendatacommons.org/licenses/odbl/1.0/", "https://operations.osmfoundation.org/policies/nominatim/"),
    "mapillary": _provider("mapillary", "Mapillary Graph API", "© Mapillary contributors, CC BY-SA 4.0", "CC BY-SA 4.0",
                           "https://creativecommons.org/licenses/by-sa/4.0/", "https://www.mapillary.com/terms"),
    "panoramax": _provider("panoramax", "Panoramax federated API", "Panoramax contributors; per-item licence and author", "Per item (see each image)",
                           None, "https://panoramax.fr/mentions-legales"),
    "kartaview": _provider("kartaview", "KartaView API", "© KartaView contributors, CC BY-SA 4.0", "CC BY-SA 4.0",
                           "https://creativecommons.org/licenses/by-sa/4.0/", "https://kartaview.org/terms"),
    "radio": _provider("radio-browser", "Radio Browser", "Radio Browser community directory (radio-browser.info); station names/links belong to stations",
                       "Public-domain directory data per radio-browser.info; station content remains the station's", None, "https://www.radio-browser.info/"),
    "news": _provider("gdelt-doc", "GDELT DOC 2.0 API", "The GDELT Project (gdeltproject.org); headlines © their publishers", "GDELT open access with citation; publisher copyright applies to articles",
                      None, "https://www.gdeltproject.org/about.html#termsofuse"),
    "infrastructure": _provider("osm-overpass", "OpenStreetMap via Overpass API", "© OpenStreetMap contributors", "ODbL 1.0 (share-alike for derived databases)",
                                "https://opendatacommons.org/licenses/odbl/1.0/", "https://www.openstreetmap.org/copyright"),
    "gbfs": _provider("gbfs", "GBFS bikeshare/micromobility", "Per operator (see feed)", "Per operator terms", None, "https://gbfs.org/"),
    "gtfs-rt": _provider("gtfs-rt", "GTFS-realtime vehicle positions", "Per agency (see feed)", "Per agency terms", None, "https://gtfs.org/realtime/"),
}

DEFAULT_GBFS_FEEDS = [
    {
        "id": "citibike-nyc", "name": "Citi Bike (New York City)",
        "url": "https://gbfs.citibikenyc.com/gbfs/gbfs.json",
        "attribution": "Citi Bike System Data — Lyft Bikes and Scooters, LLC",
        "termsUrl": "https://citibikenyc.com/data-sharing-policy",
        "allowedHosts": ["gbfs.citibikenyc.com", "gbfs.lyft.com"],
    },
    {
        "id": "lime-washington-dc", "name": "Lime (Washington, DC)",
        "url": "https://data.lime.bike/api/partners/v2/gbfs/washington_dc/gbfs.json",
        "attribution": "Lime", "termsUrl": "https://www.li.me/gbfs-terms",
        "allowedHosts": ["data.lime.bike"],
    },
]

DEFAULT_GTFS_FEEDS = [
    {
        "id": "mbta", "name": "MBTA (Boston) vehicle positions",
        "url": "https://cdn.mbta.com/realtime/VehiclePositions.pb",
        "attribution": "Massachusetts Bay Transportation Authority (MBTA)",
        "termsUrl": "https://www.mbta.com/developers", "timezone": "America/New_York",
    },
    {
        "id": "mta-bus-nyc", "name": "MTA Bus Time (New York City) vehicle positions",
        "url": "https://gtfsrt.prod.obanyc.com/vehiclePositions",
        "attribution": "Metropolitan Transportation Authority (MTA) Bus Time",
        "termsUrl": "https://new.mta.info/developers", "timezone": "America/New_York",
        "keyEnv": "UCAS_GTFSRT_MTA_BUS_KEY", "keyParam": "key", "keyRequired": False,
    },
    {
        "id": "sf-bay-511-muni", "name": "511 SF Bay — SFMTA Muni vehicle positions",
        "url": "https://api.511.org/transit/vehiclepositions?agency=SF",
        "attribution": "511 SF Bay / Metropolitan Transportation Commission; SFMTA",
        "termsUrl": "https://511.org/open-data/terms", "timezone": "America/Los_Angeles",
        "keyEnv": "UCAS_GTFSRT_511_API_KEY", "keyParam": "api_key", "keyRequired": True,
    },
]


def _load_feed_list(env: str, defaults: list[dict[str, Any]], kind: str) -> list[dict[str, Any]]:
    raw = os.getenv(env, "").strip()
    rows: Any = defaults
    if raw:
        try:
            rows = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise MobilityError(500, f"{kind}_config_invalid", f"{env} is not valid JSON") from exc
    if not isinstance(rows, list) or len(rows) > 25:
        raise MobilityError(500, f"{kind}_config_invalid", f"{env} must be a JSON list of at most 25 feeds")
    feeds = []
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not ID_RE.fullmatch(row["id"]):
            raise MobilityError(500, f"{kind}_config_invalid", f"{env}: each feed needs a lowercase id")
        url = row.get("url")
        try:
            parts = urlsplit(url) if isinstance(url, str) else None
        except ValueError:
            parts = None
        if not parts or parts.scheme != "https" or not parts.hostname or parts.username or parts.password:
            raise MobilityError(500, f"{kind}_config_invalid", f"{env}: feed {row['id']} needs an https url")
        hosts = {parts.hostname.lower()}
        for host in row.get("allowedHosts", []) or []:
            if not isinstance(host, str) or not HOST_RE.fullmatch(host.lower()):
                raise MobilityError(500, f"{kind}_config_invalid", f"{env}: feed {row['id']} has an invalid allowed host")
            hosts.add(host.lower())
        key_env = row.get("keyEnv")
        if key_env is not None and (not isinstance(key_env, str) or not KEY_ENV_RE.fullmatch(key_env)):
            raise MobilityError(500, f"{kind}_config_invalid", f"{env}: feed {row['id']} keyEnv must look like UCAS_*_KEY or UCAS_*_TOKEN")
        key_param, key_header = row.get("keyParam"), row.get("keyHeader")
        if key_env and not (isinstance(key_param, str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]{0,30}", key_param)) and not (
                isinstance(key_header, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9-]{0,40}", key_header)):
            raise MobilityError(500, f"{kind}_config_invalid", f"{env}: feed {row['id']} needs keyParam or keyHeader with keyEnv")
        feeds.append({
            "id": row["id"],
            "name": parse.text(row.get("name"), 120) or row["id"],
            "url": url,
            "attribution": parse.text(row.get("attribution"), 200) or "Operator attribution not configured",
            "termsUrl": parse.safe_link(row.get("termsUrl")),
            "timezone": parse.text(row.get("timezone"), 64),
            "allowedHosts": frozenset(hosts),
            "keyEnv": key_env,
            "keyParam": key_param if key_env else None,
            "keyHeader": key_header if key_env else None,
            "keyRequired": bool(row.get("keyRequired", bool(key_env))),
        })
    if len({f["id"] for f in feeds}) != len(feeds):
        raise MobilityError(500, f"{kind}_config_invalid", f"{env}: feed ids must be unique")
    return feeds


def gbfs_feeds() -> list[dict[str, Any]]:
    return _load_feed_list("UCAS_GBFS_FEEDS_JSON", DEFAULT_GBFS_FEEDS, "gbfs")


def gtfs_feeds() -> list[dict[str, Any]]:
    return _load_feed_list("UCAS_GTFSRT_FEEDS_JSON", DEFAULT_GTFS_FEEDS, "gtfs_rt")


def _endpoint(env: str, default: str) -> str:
    value = os.getenv(env, "").strip() or default
    try:
        parts = urlsplit(value)
    except ValueError:
        raise MobilityError(500, "endpoint_config_invalid", f"{env} is not a valid URL") from None
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
        raise MobilityError(500, "endpoint_config_invalid", f"{env} must be a plain https URL")
    return value.rstrip("/")


def _host_of(url: str) -> frozenset[str]:
    return frozenset({(urlsplit(url).hostname or "").lower()})


def _key_for(feed: dict[str, Any]) -> str | None:
    if not feed.get("keyEnv"):
        return None
    value = os.getenv(feed["keyEnv"], "").strip()
    return value or None


def status() -> dict[str, Any]:
    """Configuration overview for the UI. Never returns key values."""
    try:
        gbfs = [{"id": f["id"], "name": f["name"], "attribution": f["attribution"], "termsUrl": f["termsUrl"], "status": "configured"} for f in gbfs_feeds()]
        gbfs_error = None
    except MobilityError as error:
        gbfs, gbfs_error = [], error.message
    try:
        gtfs = []
        for f in gtfs_feeds():
            missing = f["keyRequired"] and not _key_for(f)
            gtfs.append({"id": f["id"], "name": f["name"], "attribution": f["attribution"], "termsUrl": f["termsUrl"],
                         "keyEnv": f["keyEnv"], "keyRequired": f["keyRequired"], "keyConfigured": bool(_key_for(f)),
                         "status": "not_configured" if missing else "configured"})
        gtfs_error = None
    except MobilityError as error:
        gtfs, gtfs_error = [], error.message
    nominatim_public = _safe_endpoint("UCAS_NOMINATIM_URL", NOMINATIM_DEFAULT) == NOMINATIM_DEFAULT
    return {
        "enabled": enabled(),
        "readOnly": True,
        "gbfs": {"feeds": gbfs, "error": gbfs_error},
        "gtfsRealtime": {"feeds": gtfs, "error": gtfs_error},
        "streetImagery": {
            "mapillary": {"status": "configured" if os.getenv("UCAS_MAPILLARY_ACCESS_TOKEN", "").strip() else "not_configured", "keyEnv": "UCAS_MAPILLARY_ACCESS_TOKEN"},
            "panoramax": {"status": "configured", "keyEnv": None},
            "kartaview": {"status": "configured", "keyEnv": None},
        },
        "geocoder": {"status": "not_configured" if nominatim_public and not contact() else "configured",
                     "endpoint": "public OSMF Nominatim" if nominatim_public else "self-hosted/custom Nominatim",
                     "requires": "UCAS_WORLDVIEW_CONTACT for the public OSMF endpoint"},
        "radio": {"status": "configured"},
        "news": {"status": "configured"},
        "infrastructure": {"status": "configured"},
        "contactConfigured": contact() is not None,
    }


def _safe_endpoint(env: str, default: str) -> str | None:
    try:
        return _endpoint(env, default)
    except MobilityError:
        return None


# ------------------------------------------------------------------ request parsing

def _one(query: dict[str, list[str]], name: str, *, required: bool = True) -> str | None:
    values = query.get(name, [])
    if len(values) > 1:
        raise MobilityError(400, "invalid_query", f"{name} must be supplied at most once")
    if not values:
        if required:
            raise MobilityError(400, "invalid_query", f"{name} is required")
        return None
    return values[0]


def _float(query: dict[str, list[str]], name: str, lo: float, hi: float, *, default: float | None = None) -> float:
    raw = _one(query, name, required=default is None)
    if raw is None:
        return float(default)  # type: ignore[arg-type]
    try:
        value = float(raw)
    except ValueError:
        raise MobilityError(400, "invalid_query", f"{name} must be a number") from None
    if not (lo <= value <= hi) or value != value:
        raise MobilityError(400, "invalid_query", f"{name} must be between {lo:g} and {hi:g}")
    return value


def _bbox(query: dict[str, list[str]], max_span: float) -> tuple[float, float, float, float]:
    west, south = _float(query, "west", -180, 180), _float(query, "south", -90, 90)
    east, north = _float(query, "east", -180, 180), _float(query, "north", -90, 90)
    if west >= east or south >= north:
        raise MobilityError(400, "invalid_bbox", "bbox must have west<east and south<north (split date-line views)")
    if east - west > max_span or north - south > max_span:
        raise MobilityError(400, "bbox_too_large", f"bbox sides must be at most {max_span:g} degrees; zoom in")
    return west, south, east, north


def _allowed_keys(query: dict[str, list[str]], keys: set[str]) -> None:
    extra = set(query) - keys
    if extra:
        raise MobilityError(400, "invalid_query", f"unexpected query parameter(s): {', '.join(sorted(extra))[:80]}")


def _feed(feeds: list[dict[str, Any]], feed_id: str | None) -> dict[str, Any]:
    for feed in feeds:
        if feed["id"] == feed_id:
            return feed
    raise MobilityError(404, "unknown_feed", "feed is not configured on this server")


# ------------------------------------------------------------------ GBFS

def _gbfs_doc(feed: dict[str, Any], url: str) -> Any:
    """Fetch a GBFS document, honouring its own ttl (min 10 s, max 1 h) via the doc cache."""
    key = f"gbfs-doc:{feed['id']}:{url}"
    with _lock:
        hit = _doc_cache.get(key)
    if hit:
        at, doc = hit
        ttl = min(3600, max(10, parse.gbfs_ttl(doc)))
        if _now() - at < ttl:
            return doc
    doc = _fetch_json(url, allowed_hosts=feed["allowedHosts"], max_bytes=LARGE_BYTES)
    _remember(_doc_cache, key, doc)
    return doc


def gbfs(query: dict[str, list[str]]) -> dict[str, Any]:
    _allowed_keys(query, {"feed", "west", "south", "east", "north"})
    feed = _feed(gbfs_feeds(), _one(query, "feed"))
    bbox = _bbox(query, 1.0)
    provider = dict(PROVIDERS["gbfs"], id=f"gbfs:{feed['id']}", name=feed["name"], attribution=feed["attribution"], termsUrl=feed["termsUrl"])
    key = f"gbfs:{feed['id']}:{','.join(f'{v:.4f}' for v in bbox)}"
    # No request-level throttle: every upstream document is cached for its own ttl
    # (at least 10 s), so panning the view re-filters cached documents instead of
    # being refused or re-fetching.
    try:
        discovery = _gbfs_doc(feed, feed["url"])
        urls = parse.gbfs_feed_urls(discovery)
        system = parse.gbfs_system(_gbfs_doc(feed, urls["system_information"])) if "system_information" in urls else {}
        items: list[dict[str, Any]] = []
        truncated = False
        primary = None
        if "station_information" in urls and "station_status" in urls:
            info = _gbfs_doc(feed, urls["station_information"])
            status_doc = _gbfs_doc(feed, urls["station_status"])
            stations, cut = parse.gbfs_stations(info, status_doc, bbox, 300)
            items += stations
            truncated |= cut
            primary = status_doc
        vehicle_name = "vehicle_status" if "vehicle_status" in urls else "free_bike_status" if "free_bike_status" in urls else None
        if vehicle_name:
            vehicles_doc = _gbfs_doc(feed, urls[vehicle_name])
            vehicles, cut = parse.gbfs_vehicles(vehicles_doc, bbox, 300)
            items += vehicles
            truncated |= cut
            primary = primary or vehicles_doc
        if primary is None:
            raise MobilityError(502, "gbfs_feeds_missing", "GBFS system lists neither station nor vehicle status feeds")
    except MobilityError as error:
        return _cached_or_failed(provider, key, error)
    except (ValueError, KeyError) as error:
        return _cached_or_failed(provider, key, MobilityError(502, "gbfs_schema", f"GBFS schema error: {error}"))
    updated = parse.gbfs_last_updated(primary)
    ttl = parse.gbfs_ttl(primary)
    now = _now()
    stale = updated is None or now - updated > max(300, 3 * ttl)
    attribution = feed["attribution"]
    if system.get("attributionOrganization"):
        attribution = f"{system['attributionOrganization']} (operator-declared); {attribution}"
    provider.update(attribution=attribution, licenseUrl=system.get("licenseUrl"))
    for item in items:
        item["freshness"] = "stale" if stale else "fresh"
    body = envelope(provider, status="stale" if stale else "ok", items=items, provider_ts=parse.iso(updated),
                    source_url=feed["url"], ttl=ttl, truncated=truncated, freshness="stale" if stale else "fresh",
                    system={k: v for k, v in system.items() if v}, notice=None if not stale else "operator feed last_updated is old; positions may not reflect current availability")
    _remember(_cache, key, body)
    return body


# ------------------------------------------------------------------ GTFS-realtime

GTFS_STALE_SECONDS = 120
GTFS_MIN_INTERVAL = 15.0


def gtfs_rt(query: dict[str, list[str]]) -> dict[str, Any]:
    _allowed_keys(query, {"feed", "west", "south", "east", "north"})
    feed = _feed(gtfs_feeds(), _one(query, "feed"))
    bbox = _bbox(query, 2.0)
    provider = dict(PROVIDERS["gtfs-rt"], id=f"gtfs-rt:{feed['id']}", name=feed["name"], attribution=feed["attribution"], termsUrl=feed["termsUrl"])
    secret = _key_for(feed)
    if feed["keyRequired"] and not secret:
        return envelope(provider, status="not_configured", source_url=feed["url"],
                        error=f"API key not configured; set {feed['keyEnv']} on the server")
    key = f"gtfs:{feed['id']}:{','.join(f'{v:.4f}' for v in bbox)}"
    doc_key = f"gtfs-doc:{feed['id']}"
    with _lock:
        hit = _doc_cache.get(doc_key)
    if hit and _now() - hit[0] < GTFS_MIN_INTERVAL:
        decoded = hit[1]  # whole feed decoded once per interval; each view only re-filters it
    else:
        if not _throttle_wait(f"gtfs:{feed['id']}", GTFS_MIN_INTERVAL):
            return _throttled(provider, key, GTFS_MIN_INTERVAL)
        url, headers = feed["url"], {"Accept": "application/x-protobuf, application/octet-stream"}
        if secret and feed["keyParam"]:
            url = f"{url}{'&' if '?' in url else '?'}{urlencode({feed['keyParam']: secret})}"
        elif secret and feed["keyHeader"]:
            headers[feed["keyHeader"]] = secret
        try:
            payload, _ctype = _fetch(url, allowed_hosts=feed["allowedHosts"], headers=headers, max_bytes=LARGE_BYTES)
            decoded = gtfs_realtime_lite.decode_vehicle_positions(payload)
        except MobilityError as error:
            return _cached_or_failed(provider, key, error)
        except gtfs_realtime_lite.GtfsRtDecodeError:
            return _cached_or_failed(provider, key, MobilityError(502, "gtfs_rt_decode", "feed is not a decodable GTFS-realtime FeedMessage"))
        _remember(_doc_cache, doc_key, decoded)
    now = _now()
    items, truncated = parse.gtfs_vehicles(decoded, bbox, 300, now, GTFS_STALE_SECONDS)
    header = decoded.get("header_timestamp")
    header_iso = parse.iso(header) if isinstance(header, int) and 0 < header <= now + 60 else None
    stale = header_iso is None or now - header > GTFS_STALE_SECONDS
    body = envelope(provider, status="stale" if stale else "ok", items=items, provider_ts=header_iso,
                    source_url=feed["url"], ttl=int(GTFS_MIN_INTERVAL), truncated=truncated, freshness="stale" if stale else "fresh",
                    agencyTimezone=feed["timezone"], gtfsRealtimeVersion=decoded.get("version"),
                    notice=f"Vehicle positions older than {GTFS_STALE_SECONDS}s are marked stale. Positions are agency-reported, not surveyed.")
    _remember(_cache, key, body)
    return body


# ------------------------------------------------------------------ street imagery

def _radius_bbox(lat: float, lon: float, radius_m: float) -> tuple[float, float, float, float]:
    import math
    dlat = radius_m / 111_320.0
    dlon = radius_m / max(1.0, 111_320.0 * math.cos(math.radians(lat)))
    return max(-180, lon - dlon), max(-90, lat - dlat), min(180, lon + dlon), min(90, lat + dlat)


def street_imagery(query: dict[str, list[str]]) -> dict[str, Any]:
    _allowed_keys(query, {"provider", "lat", "lon", "radius"})
    name = _one(query, "provider")
    if name not in {"mapillary", "panoramax", "kartaview"}:
        raise MobilityError(400, "invalid_query", "provider must be mapillary, panoramax or kartaview")
    lat, lon = _float(query, "lat", -90, 90), _float(query, "lon", -180, 180)
    radius = _float(query, "radius", 10, 500, default=150)
    provider = PROVIDERS[name]
    key = f"street:{name}:{lat:.5f},{lon:.5f},{radius:.0f}"
    notice = "On-demand search near one selected point; thumbnails load in your browser only when you ask. Providers blur faces/plates on their side; SignalWarden performs no face or plate analysis."
    if name == "mapillary":
        token = os.getenv("UCAS_MAPILLARY_ACCESS_TOKEN", "").strip()
        if not token:
            return envelope(provider, status="not_configured", error="Mapillary access token not configured; set UCAS_MAPILLARY_ACCESS_TOKEN on the server")
    if not _throttle_wait(f"street:{name}", 2.0):
        return _throttled(provider, key, 2.0)
    try:
        if name == "mapillary":
            west, south, east, north = _radius_bbox(lat, lon, min(radius, 250))  # Graph API bbox must stay small
            url = f"{MAPILLARY_URL}?{urlencode({'fields': 'id,captured_at,compass_angle,geometry,thumb_256_url,creator', 'bbox': f'{west:.6f},{south:.6f},{east:.6f},{north:.6f}', 'limit': 20})}"
            doc = _fetch_json(url, allowed_hosts=_host_of(MAPILLARY_URL), headers={"Authorization": f"OAuth {token}"})
            items = parse.mapillary_images(doc, 20)
        elif name == "panoramax":
            base = _endpoint("UCAS_PANORAMAX_URL", PANORAMAX_DEFAULT)
            url = f"{base}/search?{urlencode({'place_position': f'{lon:.6f},{lat:.6f}', 'place_distance': f'0-{int(radius)}', 'limit': 20})}"
            doc = _fetch_json(url, allowed_hosts=_host_of(base), headers={"Accept": "application/geo+json, application/json"})
            items = parse.panoramax_images(doc, 20)
        else:
            url = f"{KARTAVIEW_URL}?{urlencode({'lat': f'{lat:.6f}', 'lng': f'{lon:.6f}', 'radius': int(radius), 'itemsPerPage': 20})}"
            doc = _fetch_json(url, allowed_hosts=_host_of(KARTAVIEW_URL))
            items = parse.kartaview_images(doc, 20)
    except MobilityError as error:
        return _cached_or_failed(provider, key, error)
    except ValueError as error:
        return _cached_or_failed(provider, key, MobilityError(502, "street_schema", str(error)))
    for item in items:
        item["freshness"] = "fresh"
    body = envelope(provider, status="ok", items=items, source_url=url, notice=notice,
                    timeSemantics="Item providerTimestamp is the historical capture time; status reflects this retrieval only")
    _remember(_cache, key, body)
    return body


# ------------------------------------------------------------------ geocoder

def geocode(query: dict[str, list[str]]) -> dict[str, Any]:
    _allowed_keys(query, {"q"})
    q = (_one(query, "q") or "").strip()
    if not (2 <= len(q) <= 200) or any(not ch.isprintable() for ch in q):
        raise MobilityError(400, "invalid_query", "q must be 2-200 printable characters")
    provider = PROVIDERS["nominatim"]
    base = _endpoint("UCAS_NOMINATIM_URL", NOMINATIM_DEFAULT)
    if base == NOMINATIM_DEFAULT and not contact():
        return envelope(provider, status="not_configured",
                        error="Public OSMF Nominatim requires an identifying contact; set UCAS_WORLDVIEW_CONTACT (URL or e-mail) or point UCAS_NOMINATIM_URL at a self-hosted instance")
    key = f"geo:{base}:{q.lower()}"
    with _lock:
        hit = _cache.get(key)
    if hit and _now() - hit[0] < 24 * 3600:  # OSMF policy asks clients to cache results
        return dict(hit[1], cached=True)
    # Strict 1 request/second across the whole relay process (waits up to 1 s).
    if not _throttle_wait(f"nominatim:{base}", 1.0, max_wait=1.0):
        return _throttled(provider, key, 1.0)
    url = f"{base}/search?{urlencode({'q': q, 'format': 'jsonv2', 'limit': 5})}"
    try:
        doc = _fetch_json(url, allowed_hosts=_host_of(base))
        items = parse.nominatim_places(doc, 5)
    except MobilityError as error:
        return _cached_or_failed(provider, key, error)
    except ValueError as error:
        return _cached_or_failed(provider, key, MobilityError(502, "geocoder_schema", str(error)))
    for item in items:
        item["freshness"] = "fresh"
    body = envelope(provider, status="ok", items=items, source_url=url,
                    notice="Geocoder results are OSM place candidates, not verified locations.")
    _remember(_cache, key, body)
    return body


# ------------------------------------------------------------------ radio

def radio(query: dict[str, list[str]]) -> dict[str, Any]:
    _allowed_keys(query, {"lat", "lon", "radius_km"})
    lat, lon = _float(query, "lat", -90, 90), _float(query, "lon", -180, 180)
    radius = _float(query, "radius_km", 1, 100, default=25)
    provider = PROVIDERS["radio"]
    base = _endpoint("UCAS_RADIO_BROWSER_URL", RADIO_BROWSER_DEFAULT)
    key = f"radio:{lat:.3f},{lon:.3f},{radius:.0f}"
    if not _throttle_wait("radio", 2.0):
        return _throttled(provider, key, 2.0)
    url = f"{base}/json/stations/search?{urlencode({'geo_lat': f'{lat:.5f}', 'geo_long': f'{lon:.5f}', 'geo_distance': int(radius * 1000), 'has_geo_info': 'true', 'hidebroken': 'true', 'limit': 50, 'order': 'clickcount', 'reverse': 'true'})}"
    try:
        doc = _fetch_json(url, allowed_hosts=_host_of(base))
        items = parse.radio_stations(doc, 50)
    except MobilityError as error:
        return _cached_or_failed(provider, key, error)
    except ValueError as error:
        return _cached_or_failed(provider, key, MobilityError(502, "radio_schema", str(error)))
    for item in items:
        item["freshness"] = "fresh"
    body = envelope(provider, status="ok", items=items, source_url=url,
                    notice="Directory metadata and homepage links only. Streams are never relayed, played or recorded by SignalWarden.")
    _remember(_cache, key, body)
    return body


# ------------------------------------------------------------------ news

_NEWS_RE = re.compile(r"^[\w\s\"'.,:-]{3,120}$", re.UNICODE)


def news(query: dict[str, list[str]]) -> dict[str, Any]:
    _allowed_keys(query, {"q", "lat", "lon"})
    q = (_one(query, "q") or "").strip()
    if not _NEWS_RE.fullmatch(q):
        raise MobilityError(400, "invalid_query", "q must be 3-120 letters, digits, spaces or simple punctuation")
    point = None
    if "lat" in query or "lon" in query:
        point = (_float(query, "lat", -90, 90), _float(query, "lon", -180, 180))
    provider = PROVIDERS["news"]
    key = f"news:{q.lower()}:{point}"
    with _lock:
        hit = _cache.get(key)
    if hit and _now() - hit[0] < 300:
        return dict(hit[1], cached=True)
    if not _throttle_wait("gdelt", 6.0):  # GDELT asks for at most one request every 5 s
        return _throttled(provider, key, 6.0)
    url = f"{GDELT_URL}?{urlencode({'query': q, 'mode': 'artlist', 'format': 'json', 'maxrecords': 25, 'sort': 'datedesc', 'timespan': '3d'})}"
    try:
        body_bytes, ctype = _fetch(url, allowed_hosts=_host_of(GDELT_URL))
        try:
            doc = json.loads(body_bytes.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            # GDELT answers query problems/rate limits with a plain-text sentence.
            raise MobilityError(502, "gdelt_rejected", "GDELT rejected the query or rate-limited it (plain-text reply)") from None
        items = parse.gdelt_articles(doc, 25, point)
    except MobilityError as error:
        return _cached_or_failed(provider, key, error)
    except ValueError as error:
        return _cached_or_failed(provider, key, MobilityError(502, "gdelt_schema", str(error)))
    for item in items:
        item["freshness"] = "fresh"
    newest = max((i["providerTimestamp"] for i in items if i.get("providerTimestamp")), default=None)
    body = envelope(provider, status="ok", items=items, source_url=url, provider_ts=newest,
                    notice="Links, titles, source and time only; article text is never fetched or stored. Markers sit at the searched place, not where events happened.")
    _remember(_cache, key, body)
    return body


# ------------------------------------------------------------------ datacenters + dams (Overpass)

def infrastructure(query: dict[str, list[str]]) -> dict[str, Any]:
    _allowed_keys(query, {"west", "south", "east", "north"})
    west, south, east, north = _bbox(query, 1.0)
    provider = PROVIDERS["infrastructure"]
    base = _endpoint("UCAS_OVERPASS_URL", OVERPASS_DEFAULT)
    key = f"osm-infra:{west:.3f},{south:.3f},{east:.3f},{north:.3f}"
    with _lock:
        hit = _cache.get(key)
    if hit and _now() - hit[0] < 600:
        return dict(hit[1], cached=True)
    if not _throttle_wait("overpass", 10.0):
        return _throttled(provider, key, 10.0)
    box = f"{south:.5f},{west:.5f},{north:.5f},{east:.5f}"
    ql = (f'[out:json][timeout:25][maxsize:16000000];'
          f'(nwr["telecom"="data_center"]({box});nwr["waterway"="dam"]({box}););out center tags 400;')
    url = f"{base}?{urlencode({'data': ql})}"
    try:
        doc = _fetch_json(url, allowed_hosts=_host_of(base), max_bytes=LARGE_BYTES)
        items, truncated, base_ts = parse.overpass_infrastructure(doc, 400)
    except MobilityError as error:
        return _cached_or_failed(provider, key, error)
    except ValueError as error:
        return _cached_or_failed(provider, key, MobilityError(502, "overpass_schema", str(error)))
    for item in items:
        item["freshness"] = "fresh"
    body = envelope(provider, status="ok", items=items, source_url=url, provider_ts=base_ts, truncated=truncated,
                    notice="Live OSM query for the current view (telecom=data_center, waterway=dam). OSM coverage is crowdsourced and incomplete. "
                           "ODbL 1.0: keep the attribution; any database derived from these results that you share must be offered under ODbL (share-alike). Nothing is bundled or stored.")
    _remember(_cache, key, body)
    return body


# ------------------------------------------------------------------ routing

ROUTES: dict[str, Callable[[dict[str, list[str]]], dict[str, Any]]] = {
    "gbfs": gbfs,
    "gtfs-rt": gtfs_rt,
    "street-imagery": street_imagery,
    "geocode": geocode,
    "radio": radio,
    "news": news,
    "infrastructure": infrastructure,
}


def authorize(headers: Any) -> None:
    if not enabled():
        raise MobilityError(404, "worldview_mobility_disabled", "WorldView mobility/context relay is disabled")
    if headers.get(HEADER) != "enabled":
        raise MobilityError(403, "mobility_header_required", f"{HEADER}: enabled is required")
    if not _same_origin(headers):
        raise MobilityError(403, "origin_not_allowed", "cross-site relay requests are not allowed")


def handle(command: str, path: list[str], query: dict[str, list[str]], headers: Any) -> tuple[int, Any]:
    """Entry point used by app.py for GET /api/v1/worldview-mobility/<route>."""
    authorize(headers)
    if command != "GET" or len(path) != 4:
        raise MobilityError(404, "not_found", "mobility route was not found")
    if path[3] == "status":
        _allowed_keys(query, set())
        return 200, status()
    route = ROUTES.get(path[3])
    if route is None:
        raise MobilityError(404, "not_found", "mobility route was not found")
    return 200, route(query)
