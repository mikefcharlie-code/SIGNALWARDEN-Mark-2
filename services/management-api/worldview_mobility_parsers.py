"""Pure, network-free parsers for the WorldView mobility/context relay.

Each parser takes an already size-bounded, decoded provider response and
returns a list of normalized items. Items never contain credentials, stream
URLs, plates, rotating vehicle IDs, article bodies or images; only bounded
metadata needed for a civilian situational-awareness marker.
"""
from __future__ import annotations

import math
import re
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit

MAX_TEXT = 200


# Feeds use 0 or 86400 (and similar) as "never reported" sentinels; nothing realtime predates 2000-01-01.
MIN_PLAUSIBLE_TS = 946_684_800


def iso(ts: float | int | None) -> str | None:
    if ts is None or not isinstance(ts, (int, float)) or isinstance(ts, bool) or not math.isfinite(ts):
        return None
    if ts < MIN_PLAUSIBLE_TS:
        return None
    try:
        return datetime.fromtimestamp(float(ts), tz=timezone.utc).isoformat().replace("+00:00", "Z")
    except (OverflowError, OSError, ValueError):
        return None


def text(value: Any, limit: int = MAX_TEXT) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = "".join(ch for ch in value if ch.isprintable()).strip()
    return cleaned[:limit] or None


def number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        try:
            value = float(value)
        except ValueError:
            return None
    if isinstance(value, (int, float)) and math.isfinite(value):
        return float(value)
    return None


def valid_point(lat: Any, lon: Any) -> tuple[float, float] | None:
    la, lo = number(lat), number(lon)
    if la is None or lo is None or not (-90 <= la <= 90 and -180 <= lo <= 180):
        return None
    if la == 0 and lo == 0:
        return None  # "null island" is a common missing-position sentinel.
    return la, lo


def in_bbox(point: tuple[float, float], bbox: tuple[float, float, float, float]) -> bool:
    west, south, east, north = bbox
    return south <= point[0] <= north and west <= point[1] <= east


def safe_link(value: Any, *, hosts: tuple[str, ...] | None = None, allow_http: bool = False) -> str | None:
    """Return a link only if it is http(s), credential-free and (optionally) on allowed host suffixes."""
    if not isinstance(value, str) or len(value) > 2000:
        return None
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError:
        return None
    schemes = {"https", "http"} if allow_http else {"https"}
    if parts.scheme not in schemes or not parts.hostname or parts.username or parts.password:
        return None
    if port not in (None, 80, 443):
        return None
    host = parts.hostname.lower()
    if hosts is not None and not any(host == h or host.endswith("." + h) for h in hosts):
        return None
    return value


def _flag(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if value in (0, 1):
        return bool(value)
    return None


# ---------------------------------------------------------------- GBFS

def gbfs_feed_urls(discovery: Any, preferred_language: str = "en") -> dict[str, str]:
    """Map feed name -> URL for GBFS 1.x/2.x (language keyed) and 3.x (flat) discovery."""
    if not isinstance(discovery, dict) or not isinstance(discovery.get("data"), dict):
        raise ValueError("GBFS discovery document has no data object")
    data = discovery["data"]
    feeds = data.get("feeds")
    if not isinstance(feeds, list):
        languages = [k for k, v in data.items() if isinstance(v, dict) and isinstance(v.get("feeds"), list)]
        if not languages:
            raise ValueError("GBFS discovery document lists no feeds")
        lang = preferred_language if preferred_language in languages else sorted(languages)[0]
        feeds = data[lang]["feeds"]
    out: dict[str, str] = {}
    for feed in feeds[:40]:
        if isinstance(feed, dict) and isinstance(feed.get("name"), str) and isinstance(feed.get("url"), str):
            out[feed["name"][:60]] = feed["url"]
    return out


def gbfs_ttl(doc: Any) -> int:
    ttl = doc.get("ttl") if isinstance(doc, dict) else None
    if isinstance(ttl, int) and not isinstance(ttl, bool) and 0 <= ttl <= 86400:
        return ttl
    return 60


def gbfs_last_updated(doc: Any) -> float | None:
    """GBFS <3 uses POSIX seconds; GBFS 3 uses an RFC 3339 string."""
    value = doc.get("last_updated") if isinstance(doc, dict) else None
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
        return float(value)
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return None


def _gbfs_name(value: Any) -> str | None:
    if isinstance(value, list):  # GBFS 3 localized strings
        for entry in value:
            if isinstance(entry, dict) and text(entry.get("text")):
                return text(entry.get("text"), 120)
        return None
    return text(value, 120)


def gbfs_system(doc: Any) -> dict[str, Any]:
    data = doc.get("data") if isinstance(doc, dict) else None
    if not isinstance(data, dict):
        return {}
    return {
        "name": _gbfs_name(data.get("name")),
        "operator": _gbfs_name(data.get("operator")),
        "attributionOrganization": text(data.get("attribution_organization_name"), 120),
        "attributionUrl": safe_link(data.get("attribution_url")),
        "licenseUrl": safe_link(data.get("license_url")),
        "timezone": text(data.get("timezone"), 64),
    }


def gbfs_stations(info: Any, status: Any, bbox: tuple[float, float, float, float], limit: int) -> tuple[list[dict[str, Any]], bool]:
    info_rows = ((info or {}).get("data") or {}).get("stations") if isinstance(info, dict) else None
    status_rows = ((status or {}).get("data") or {}).get("stations") if isinstance(status, dict) else None
    if not isinstance(info_rows, list) or not isinstance(status_rows, list):
        raise ValueError("GBFS station feeds are missing a stations array")
    by_id = {str(row.get("station_id")): row for row in status_rows if isinstance(row, dict) and row.get("station_id") is not None}
    items: list[dict[str, Any]] = []
    truncated = False
    for row in info_rows:
        if not isinstance(row, dict) or row.get("station_id") is None:
            continue
        point = valid_point(row.get("lat"), row.get("lon"))
        if not point or not in_bbox(point, bbox):
            continue
        if len(items) >= limit:
            truncated = True
            break
        sid = text(str(row.get("station_id")), 80)
        st = by_id.get(str(row.get("station_id")), {})
        bikes = number(st.get("num_bikes_available"))
        if bikes is None:
            bikes = number(st.get("num_vehicles_available"))
        items.append({
            "id": sid,
            "kind": "station",
            "lat": point[0],
            "lon": point[1],
            "label": _gbfs_name(row.get("name")) or "Bikeshare station",
            "providerTimestamp": iso(number(st.get("last_reported"))) if not isinstance(st.get("last_reported"), str) else text(st.get("last_reported"), 40),
            "properties": {
                "capacity": number(row.get("capacity")),
                "bikesAvailable": bikes,
                "ebikesAvailable": number(st.get("num_ebikes_available")),
                "docksAvailable": number(st.get("num_docks_available")),
                "isRenting": _flag(st.get("is_renting")),
                "isReturning": _flag(st.get("is_returning")),
                "statusReported": bool(st),
            },
        })
    return items, truncated


def gbfs_vehicles(doc: Any, bbox: tuple[float, float, float, float], limit: int) -> tuple[list[dict[str, Any]], bool]:
    data = (doc or {}).get("data") if isinstance(doc, dict) else None
    rows = None
    if isinstance(data, dict):
        rows = data.get("bikes") if isinstance(data.get("bikes"), list) else data.get("vehicles")
    if not isinstance(rows, list):
        raise ValueError("GBFS vehicle feed has no bikes/vehicles array")
    items: list[dict[str, Any]] = []
    truncated = False
    for row in rows:
        if not isinstance(row, dict):
            continue
        point = valid_point(row.get("lat"), row.get("lon"))
        if not point or not in_bbox(point, bbox):
            continue  # docked vehicles have no lat/lon and are counted at stations
        if len(items) >= limit:
            truncated = True
            break
        reported = row.get("last_reported")
        items.append({
            # GBFS bike_id/vehicle_id values are rotating privacy identifiers; they are dropped.
            "id": f"v{len(items) + 1}",
            "kind": "vehicle",
            "lat": point[0],
            "lon": point[1],
            "label": "Available shared vehicle" if not _flag(row.get("is_disabled")) else "Shared vehicle (reported disabled)",
            "providerTimestamp": text(reported, 40) if isinstance(reported, str) else iso(number(reported)),
            "properties": {
                "vehicleType": text(row.get("vehicle_type"), 40) or text(row.get("vehicle_type_id"), 40),
                "isReserved": _flag(row.get("is_reserved")),
                "isDisabled": _flag(row.get("is_disabled")),
                "rangeMeters": number(row.get("current_range_meters")),
            },
        })
    return items, truncated


# ---------------------------------------------------------------- GTFS-realtime

def gtfs_vehicles(decoded: dict[str, Any], bbox: tuple[float, float, float, float], limit: int, now: float, stale_after: float) -> tuple[list[dict[str, Any]], bool]:
    items: list[dict[str, Any]] = []
    truncated = False
    header_ts = decoded.get("header_timestamp")
    seen: set[str] = set()
    for row in decoded.get("vehicles", []):
        point = valid_point(row.get("lat"), row.get("lon"))
        if not point or not in_bbox(point, bbox):
            continue
        if len(items) >= limit:
            truncated = True
            break
        ts = row.get("timestamp") or header_ts
        if not isinstance(ts, int) or ts <= 0 or ts > now + 60:
            ts = None
        age = None if ts is None else max(0.0, now - ts)
        ident = text(row.get("vehicle_id") or row.get("entity_id"), 64) or f"vehicle-{len(items) + 1}"
        if ident in seen:
            continue
        seen.add(ident)
        route = text(row.get("route_id"), 64)
        items.append({
            "id": ident,
            "kind": "transit-vehicle",
            "lat": point[0],
            "lon": point[1],
            "label": f"Route {route}" if route else "Transit vehicle (route not reported)",
            "providerTimestamp": iso(ts),
            "ageSeconds": None if age is None else round(age),
            "freshness": "unknown" if age is None else ("fresh" if age <= stale_after else "stale"),
            "properties": {
                "routeId": route,
                "tripId": text(row.get("trip_id"), 80),
                "directionId": row.get("direction_id") if row.get("direction_id") in (0, 1) else None,
                "vehicleLabel": text(row.get("vehicle_label"), 64),
                "stopId": text(row.get("stop_id"), 64),
                "currentStatus": text(row.get("current_status"), 20),
                "bearingDeg": number(row.get("bearing")),
                "speedMps": number(row.get("speed_mps")),
                "timestampBasis": "vehicle" if row.get("timestamp") else "feed header",
            },
        })
    return items, truncated


# ---------------------------------------------------------------- street imagery

MAPILLARY_THUMB_HOSTS = ("fbcdn.net", "mapillary.com")
KARTAVIEW_THUMB_HOSTS = ("kartaview.org", "openstreetcam.org")


def mapillary_images(doc: Any, limit: int) -> list[dict[str, Any]]:
    rows = doc.get("data") if isinstance(doc, dict) else None
    if not isinstance(rows, list):
        raise ValueError("Mapillary response has no data array")
    items = []
    for row in rows:
        if not isinstance(row, dict) or len(items) >= limit:
            continue
        geometry = row.get("geometry") or {}
        coords = geometry.get("coordinates") if isinstance(geometry, dict) else None
        if not isinstance(coords, list) or len(coords) < 2:
            continue
        point = valid_point(coords[1], coords[0])
        ident = text(str(row.get("id", "")), 40)
        if not point or not ident or not re.fullmatch(r"[0-9]{1,30}", ident):
            continue
        captured = number(row.get("captured_at"))
        creator = row.get("creator") if isinstance(row.get("creator"), dict) else {}
        items.append({
            "id": ident,
            "kind": "street-image",
            "lat": point[0],
            "lon": point[1],
            "label": "Mapillary street-level image",
            "providerTimestamp": iso(captured / 1000) if captured else None,
            "properties": {
                "thumbnailUrl": safe_link(row.get("thumb_256_url"), hosts=MAPILLARY_THUMB_HOSTS),
                "pageUrl": f"https://www.mapillary.com/app/?pKey={ident}",
                "author": text(creator.get("username"), 80) or "Mapillary contributor (username not provided)",
                "license": "CC BY-SA 4.0",
                "licenseUrl": "https://creativecommons.org/licenses/by-sa/4.0/",
                "compassDeg": number(row.get("compass_angle")),
                "timeSemantics": "captured_at: historical image capture time",
            },
        })
    return items


def panoramax_images(doc: Any, limit: int) -> list[dict[str, Any]]:
    rows = doc.get("features") if isinstance(doc, dict) else None
    if not isinstance(rows, list):
        raise ValueError("Panoramax response has no features array")
    items = []
    for row in rows:
        if not isinstance(row, dict) or len(items) >= limit:
            continue
        geometry = row.get("geometry") or {}
        coords = geometry.get("coordinates") if isinstance(geometry, dict) else None
        if not isinstance(coords, list) or len(coords) < 2:
            continue
        point = valid_point(coords[1], coords[0])
        ident = text(row.get("id"), 64)
        if not point or not ident or not re.fullmatch(r"[0-9a-fA-F-]{8,64}", ident):
            continue
        props = row.get("properties") if isinstance(row.get("properties"), dict) else {}
        assets = row.get("assets") if isinstance(row.get("assets"), dict) else {}
        thumb = assets.get("thumb") if isinstance(assets.get("thumb"), dict) else {}
        links = row.get("links") if isinstance(row.get("links"), list) else []
        self_link = next((l.get("href") for l in links if isinstance(l, dict) and l.get("rel") == "self"), None)
        license_link = next((l.get("href") for l in links if isinstance(l, dict) and l.get("rel") == "license"), None)
        via = next((l for l in links if isinstance(l, dict) and l.get("rel") == "via"), None)
        providers = row.get("providers") if isinstance(row.get("providers"), list) else []
        authors = [text(p.get("name"), 60) for p in providers if isinstance(p, dict) and "producer" in (p.get("roles") or [])]
        authors = [a for a in authors if a]
        when = text(props.get("datetime"), 40)
        items.append({
            "id": ident,
            "kind": "street-image",
            "lat": point[0],
            "lon": point[1],
            "label": "Panoramax street-level image",
            "providerTimestamp": when,
            "properties": {
                "thumbnailUrl": safe_link(thumb.get("href")),
                "pageUrl": safe_link(self_link),
                "author": ", ".join(authors[:3]) or "Panoramax contributor (not provided)",
                "license": text(props.get("license"), 60) or "Licence not provided by item",
                "licenseUrl": safe_link(license_link),
                "instance": text((via or {}).get("instance_name") or (via or {}).get("title"), 80),
                "instanceUrl": safe_link((via or {}).get("href")),
                "compassDeg": number(props.get("view:azimuth")),
                "timeSemantics": "datetime: historical image capture time",
            },
        })
    return items


def kartaview_images(doc: Any, limit: int) -> list[dict[str, Any]]:
    result = doc.get("result") if isinstance(doc, dict) else None
    rows = result.get("data") if isinstance(result, dict) else None
    if not isinstance(rows, list):
        raise ValueError("KartaView response has no result.data array")
    items = []
    for row in rows:
        if not isinstance(row, dict) or len(items) >= limit:
            continue
        point = valid_point(row.get("lat"), row.get("lng"))
        ident = text(str(row.get("id", "")), 20)
        if not point or not ident or not ident.isdigit():
            continue
        shot = text(row.get("shotDate"), 40)
        shot_iso = None
        if shot:
            try:
                shot_iso = datetime.strptime(shot[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
            except ValueError:
                shot_iso = None
        seq, idx = text(str(row.get("sequenceId", "")), 20), text(str(row.get("sequenceIndex", "")), 20)
        page = f"https://kartaview.org/details/{seq}/{idx}" if seq and idx and seq.isdigit() and idx.isdigit() else None
        user = row.get("user") if isinstance(row.get("user"), dict) else {}
        items.append({
            "id": ident,
            "kind": "street-image",
            "lat": point[0],
            "lon": point[1],
            "label": "KartaView street-level image",
            "providerTimestamp": shot_iso,
            "properties": {
                "thumbnailUrl": safe_link(row.get("imageThUrl"), hosts=KARTAVIEW_THUMB_HOSTS) or safe_link(row.get("fileurlTh"), hosts=KARTAVIEW_THUMB_HOSTS),
                "pageUrl": page,
                "author": text(user.get("username"), 80) or "KartaView contributor (not provided)",
                "license": "CC BY-SA 4.0",
                "licenseUrl": "https://creativecommons.org/licenses/by-sa/4.0/",
                "compassDeg": number(row.get("heading")),
                "timeSemantics": "shotDate: historical capture time; provider does not state a timezone (read as UTC)",
            },
        })
    return items


# ---------------------------------------------------------------- places / context

def nominatim_places(doc: Any, limit: int) -> list[dict[str, Any]]:
    if not isinstance(doc, list):
        raise ValueError("Nominatim response is not a result list")
    items = []
    for row in doc:
        if not isinstance(row, dict) or len(items) >= limit:
            continue
        point = valid_point(row.get("lat"), row.get("lon"))
        if not point:
            continue
        bbox = row.get("boundingbox")
        bounds = None
        if isinstance(bbox, list) and len(bbox) == 4:
            vals = [number(v) for v in bbox]
            if all(v is not None for v in vals):
                bounds = f"{vals[0]},{vals[1]},{vals[2]},{vals[3]}"  # south,north,west,east per Nominatim
        osm_type, osm_id = text(row.get("osm_type"), 10), number(row.get("osm_id"))
        items.append({
            "id": text(str(row.get("place_id", "")), 40) or f"place-{len(items) + 1}",
            "kind": "place",
            "lat": point[0],
            "lon": point[1],
            "label": text(row.get("display_name"), 200) or "Place",
            "providerTimestamp": None,
            "properties": {
                "category": text(row.get("category") or row.get("class"), 40),
                "type": text(row.get("type"), 40),
                "boundingBox": bounds,
                "osmUrl": f"https://www.openstreetmap.org/{osm_type}/{int(osm_id)}" if osm_type in {"node", "way", "relation"} and osm_id else None,
                "licence": text(row.get("licence"), 120),
            },
        })
    return items


def radio_stations(doc: Any, limit: int) -> list[dict[str, Any]]:
    if not isinstance(doc, list):
        raise ValueError("Radio Browser response is not a station list")
    items = []
    for row in doc:
        if not isinstance(row, dict) or len(items) >= limit:
            continue
        point = valid_point(row.get("geo_lat"), row.get("geo_long"))
        ident = text(row.get("stationuuid"), 40)
        if not point or not ident:
            continue
        tags = text(row.get("tags"), 160)
        items.append({
            "id": ident,
            "kind": "radio-station",
            "lat": point[0],
            "lon": point[1],
            "label": text(row.get("name"), 120) or "Radio station",
            "providerTimestamp": text(row.get("lastchangetime_iso8601"), 40),
            "properties": {
                # Stream URLs (url/url_resolved) and favicons are deliberately not returned.
                "homepage": safe_link(row.get("homepage"), allow_http=True),
                "country": text(row.get("country"), 80),
                "state": text(row.get("state"), 80),
                "language": text(row.get("language"), 80),
                "tags": tags,
                "lastCheckOk": _flag(row.get("lastcheckok")),
                "positionBasis": "station-submitted geo_lat/geo_long (directory metadata, not transmitter survey)",
            },
        })
    return items


def gdelt_articles(doc: Any, limit: int, point: tuple[float, float] | None) -> list[dict[str, Any]]:
    if not isinstance(doc, dict):
        raise ValueError("GDELT response is not a JSON object")
    rows = doc.get("articles", [])  # GDELT returns {} when nothing matched
    if not isinstance(rows, list):
        raise ValueError("GDELT articles field is not a list")
    items = []
    for row in rows:
        if not isinstance(row, dict) or len(items) >= limit:
            continue
        url = safe_link(row.get("url"), allow_http=True)
        if not url:
            continue
        seen = text(row.get("seendate"), 20)
        when = None
        if seen:
            try:
                when = datetime.strptime(seen, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
            except ValueError:
                when = None
        item = {
            "id": f"a{len(items) + 1}",
            "kind": "news-link",
            "label": text(row.get("title"), 200) or "Untitled article",
            "providerTimestamp": when,
            "properties": {
                # Links and metadata only: no article text, no social image.
                "articleUrl": url,
                "domain": text(row.get("domain"), 100),
                "language": text(row.get("language"), 40),
                "sourceCountry": text(row.get("sourcecountry"), 60),
                "positionBasis": "placed at the searched place; GDELT article lists are not geocoded" if point else None,
                "timeSemantics": "seendate: when GDELT first saw the URL",
            },
        }
        if point:
            item["lat"], item["lon"] = point
        items.append(item)
    return items


def overpass_infrastructure(doc: Any, limit: int) -> tuple[list[dict[str, Any]], bool, str | None]:
    if not isinstance(doc, dict) or not isinstance(doc.get("elements"), list):
        raise ValueError("Overpass response has no elements array")
    remark = text(doc.get("remark"), 200)
    if remark and ("error" in remark.lower() or "timed out" in remark.lower()):
        raise ValueError("Overpass reported a query error or timeout")
    base = None
    osm3s = doc.get("osm3s")
    if isinstance(osm3s, dict):
        base = text(osm3s.get("timestamp_osm_base"), 40)
    items = []
    truncated = False
    for row in doc["elements"]:
        if not isinstance(row, dict):
            continue
        tags = row.get("tags") if isinstance(row.get("tags"), dict) else {}
        etype = row.get("type")
        ident = number(row.get("id"))
        if etype not in {"node", "way", "relation"} or ident is None:
            continue
        if etype == "node":
            point = valid_point(row.get("lat"), row.get("lon"))
        else:
            center = row.get("center") if isinstance(row.get("center"), dict) else {}
            point = valid_point(center.get("lat"), center.get("lon"))
        if not point:
            continue
        if tags.get("telecom") == "data_center":
            kind = "datacenter"
        elif tags.get("waterway") == "dam":
            kind = "dam"
        else:
            continue
        if len(items) >= limit:
            truncated = True
            break
        name = text(tags.get("name"), 120)
        items.append({
            "id": f"{etype}-{int(ident)}",
            "kind": kind,
            "lat": point[0],
            "lon": point[1],
            "label": name or ("Data center (unnamed in OSM)" if kind == "datacenter" else "Dam (unnamed in OSM)"),
            "providerTimestamp": base,
            "properties": {
                "osmType": etype,
                "osmUrl": f"https://www.openstreetmap.org/{etype}/{int(ident)}",
                "operator": text(tags.get("operator"), 120),
                "positionBasis": "OSM node position" if etype == "node" else "Overpass-computed centre of OSM geometry",
                "timeSemantics": "timestamp_osm_base: OSM database state served by Overpass",
            },
        })
    return items, truncated, base
