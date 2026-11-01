"""Disabled-by-default, read-only AIS vessel relay for WorldView's `vessels` layer.

Three providers, each bounded in area, time and memory:

* ``aisstream``    AISStream.io WebSocket (keyed: ``UCAS_AISSTREAM_API_KEY``).
* ``kystverket``   Norwegian Coastal Administration open raw AIS TCP feed
                   (keyless, NLOD; explicit ``UCAS_KYSTVERKET_AIS_ENABLED=1``).
* ``barentswatch`` BarentsWatch AIS Live API latest-position snapshot
                   (keyed: ``UCAS_BARENTSWATCH_CLIENT_ID``/``_SECRET``).

The whole relay is off unless ``UCAS_PUBLIC_AIS_ENABLED=1``.  Stream providers
connect only while a browser is polling (idle disconnect), subscribe/filter to
one capped bounding box, and keep only the latest position per MMSI with a TTL.

AIS is self-reported by vessel transponders.  The relay forwards what was
broadcast (name, ship type, SOG/COG/heading, navigational status); it performs
no owner, crew, person or identity enrichment, and it never transmits AIS.
Credentials are read from the server environment only and are never echoed
in responses, errors or logs.
"""
from __future__ import annotations

import asyncio
import json
import math
import os
import re
import socket
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

import ais_nmea

# ---- bounds -----------------------------------------------------------------
MAX_LAT_SPAN = 4.0
MAX_LON_SPAN = 6.0
MAX_VESSELS = 2000          # latest-position records kept per provider
MAX_STATIC = 4000           # name/type records awaiting a position
MAX_RETURNED = 500          # vessels per response
POSITION_TTL_SECONDS = 30 * 60
STATIC_TTL_SECONDS = 6 * 60 * 60
STALE_AFTER_SECONDS = 10 * 60
IDLE_DISCONNECT_SECONDS = 120.0
SILENT_STREAM_SECONDS = 120.0
RESUBSCRIBE_MIN_SECONDS = 2.0   # AISStream allows at most one update per second
MAX_WS_FRAME = 256 * 1024
MAX_TCP_LINE_BUFFER = 8 * 1024
BACKOFF_MIN_SECONDS = 5.0
BACKOFF_MAX_SECONDS = 120.0
BARENTSWATCH_MIN_INTERVAL = 30.0
BARENTSWATCH_MAX_BYTES = 4 * 1024 * 1024
BARENTSWATCH_MAX_ITEMS = 5000
HTTP_DEADLINE_SECONDS = 20.0

AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream"
KYSTVERKET_HOST, KYSTVERKET_PORT = "153.44.253.27", 5631
BARENTSWATCH_TOKEN_URL = "https://id.barentswatch.no/connect/token"
BARENTSWATCH_LATEST_URL = "https://live.ais.barentswatch.no/v1/latest/combined"

SELF_REPORTED = ("AIS is self-reported by each vessel's transponder and may be wrong, delayed, spoofed "
                 "or missing; positions are not verified. No owner, crew or person lookup is performed.")

PROVIDERS: dict[str, dict[str, Any]] = {
    "aisstream": {
        "name": "AISStream.io",
        "source": "AISStream.io",
        "sourceUrl": AISSTREAM_URL,
        "attribution": "Vessel data: AISStream.io",
        "license": "AISStream.io terms of service; no redistribution right assumed",
        "termsUrl": "https://aisstream.io/",
        "coverage": "Crowdsourced terrestrial AIS receivers; coverage varies by area and is not global or complete.",
        "keyEnv": ["UCAS_AISSTREAM_API_KEY"],
        "transport": "WebSocket (server-side only)",
    },
    "kystverket": {
        "name": "Kystverket open AIS (raw NMEA)",
        "source": "Kystverket open AIS",
        "sourceUrl": f"tcp://{KYSTVERKET_HOST}:{KYSTVERKET_PORT}",
        "attribution": "Contains data under the Norwegian licence for Open Government data (NLOD) distributed by the Norwegian Coastal Administration (Kystverket)",
        "license": "NLOD 2.0",
        "licenseUrl": "https://data.norge.no/nlod/en/2.0",
        "termsUrl": "https://www.kystverket.no/en/sea-transport-and-ports/ais/access-to-ais-data",
        "coverage": "Norwegian economic zone and Svalbard/Jan Mayen protection zones only; excludes fishing vessels under 15 m and recreational craft under 45 m.",
        "keyEnv": [],
        "enableEnv": "UCAS_KYSTVERKET_AIS_ENABLED",
        "transport": "Raw TCP AIVDM stream (server-side only)",
    },
    "barentswatch": {
        "name": "BarentsWatch AIS Live (Kystverket)",
        "source": "BarentsWatch AIS (Kystverket)",
        "sourceUrl": BARENTSWATCH_LATEST_URL,
        "attribution": "AIS data from the Norwegian Coastal Administration (Kystverket) via BarentsWatch, NLOD",
        "license": "NLOD 2.0 plus BarentsWatch API terms",
        "licenseUrl": "https://data.norge.no/nlod/en/2.0",
        "termsUrl": "https://developer.barentswatch.no/docs/appreg",
        "coverage": "Norwegian waters (open AIS area); same vessel-category exclusions as Kystverket open AIS.",
        "keyEnv": ["UCAS_BARENTSWATCH_CLIENT_ID", "UCAS_BARENTSWATCH_CLIENT_SECRET"],
        "transport": "HTTPS latest-position snapshot (server-side only)",
    },
}


class AisRelayError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


class ProviderError(Exception):
    """A sanitized provider failure; its message is safe to show to the UI."""


def _env_flag(name: str) -> bool:
    return os.getenv(name, "0").strip().lower() in {"1", "true", "yes"}


def relay_enabled() -> bool:
    return _env_flag("UCAS_PUBLIC_AIS_ENABLED")


def _secret(name: str) -> str:
    return os.getenv(name, "").strip()


def provider_configured(provider: str) -> bool:
    meta = PROVIDERS[provider]
    if meta.get("enableEnv") and not _env_flag(meta["enableEnv"]):
        return False
    return all(_secret(name) for name in meta["keyEnv"])


def _iso(epoch: float | None) -> str | None:
    if epoch is None:
        return None
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat().replace("+00:00", "Z")


def _redact(text: str, *secrets: str) -> str:
    for value in secrets:
        if value:
            text = text.replace(value, "[redacted]")
    return text[:200]


# ---- bounding box -----------------------------------------------------------
@dataclass(frozen=True)
class BBox:
    south: float
    west: float
    north: float
    east: float

    def contains(self, lat: float, lon: float) -> bool:
        return self.south <= lat <= self.north and self.west <= lon <= self.east

    def as_dict(self) -> dict[str, float]:
        return {"south": self.south, "west": self.west, "north": self.north, "east": self.east}


def parse_bbox(query: dict[str, list[str]]) -> BBox:
    values = {}
    for key in ("south", "west", "north", "east"):
        raw = query.get(key, [])
        if len(raw) != 1:
            raise AisRelayError(400, "invalid_ais_bbox", "south, west, north and east must each be supplied once")
        try:
            value = float(raw[0])
        except ValueError as error:
            raise AisRelayError(400, "invalid_ais_bbox", "bounding box values must be numbers") from error
        if not math.isfinite(value):
            raise AisRelayError(400, "invalid_ais_bbox", "bounding box values must be finite")
        values[key] = round(value, 4)
    box = BBox(**values)
    if not (-90 <= box.south < box.north <= 90 and -180 <= box.west < box.east <= 180):
        raise AisRelayError(400, "invalid_ais_bbox", "bounding box must have south<north and west<east within valid coordinates (no antimeridian crossing)")
    if box.north - box.south > MAX_LAT_SPAN or box.east - box.west > MAX_LON_SPAN:
        raise AisRelayError(400, "ais_bbox_too_large", f"bounding box is capped at {MAX_LAT_SPAN:g}° latitude by {MAX_LON_SPAN:g}° longitude")
    return box


# ---- latest-position store --------------------------------------------------
class VesselStore:
    def __init__(self, clock: Callable[[], float] = time.time):
        self.clock = clock
        self.lock = threading.Lock()
        self.vessels: dict[int, dict[str, Any]] = {}
        self.static: dict[int, dict[str, Any]] = {}

    def _prune(self, now: float) -> None:
        for mmsi in [m for m, v in self.vessels.items() if now - v["receivedAt"] > POSITION_TTL_SECONDS]:
            del self.vessels[mmsi]
        for mmsi in [m for m, v in self.static.items() if now - v["receivedAt"] > STATIC_TTL_SECONDS]:
            del self.static[mmsi]

    def update(self, *, mmsi: int, ais_class: str | None = None, lat: float | None = None, lon: float | None = None,
               sog: float | None = None, cog: float | None = None, heading: int | None = None,
               nav_status: int | None = None, name: str | None = None, ship_type: int | None = None,
               provider_time: float | None = None) -> None:
        if not isinstance(mmsi, int) or not 0 < mmsi < 1_000_000_000:
            return
        now = self.clock()
        with self.lock:
            static = self.static.get(mmsi)
            if name is not None or ship_type is not None:
                if static is None:
                    if len(self.static) >= MAX_STATIC:
                        self._prune(now)
                        if len(self.static) >= MAX_STATIC:
                            del self.static[min(self.static, key=lambda m: self.static[m]["receivedAt"])]
                    static = self.static[mmsi] = {}
                if name is not None:
                    static["name"] = name[:40]
                if ship_type is not None:
                    static["shipType"] = ship_type
                static["receivedAt"] = now
            if lat is None or lon is None:
                record = self.vessels.get(mmsi)
                if record is not None and static:
                    record.update({k: v for k, v in static.items() if k != "receivedAt"})
                return
            if mmsi not in self.vessels and len(self.vessels) >= MAX_VESSELS:
                self._prune(now)
                if len(self.vessels) >= MAX_VESSELS:
                    del self.vessels[min(self.vessels, key=lambda m: self.vessels[m]["receivedAt"])]
            record = self.vessels.setdefault(mmsi, {"mmsi": mmsi})
            ptime = provider_time if provider_time is not None and provider_time <= now + 60 else now
            record.update({"lat": lat, "lon": lon, "sog": sog, "cog": cog, "heading": heading,
                           "navStatus": nav_status, "receivedAt": now, "providerTime": min(ptime, now)})
            if ais_class:
                record["aisClass"] = ais_class
            if static:
                record.update({k: v for k, v in static.items() if k != "receivedAt"})

    def replace(self, items: list[dict[str, Any]]) -> None:
        with self.lock:
            self.vessels.clear()
        for item in items[:MAX_VESSELS]:
            self.update(**item)

    def snapshot(self, bbox: BBox, limit: int = MAX_RETURNED) -> tuple[list[dict[str, Any]], int]:
        now = self.clock()
        with self.lock:
            self._prune(now)
            inside = [dict(v) for v in self.vessels.values() if bbox.contains(v["lat"], v["lon"])]
        inside.sort(key=lambda v: (-v["providerTime"], v["mmsi"]))
        out = []
        for v in inside[:limit]:
            age = max(0.0, now - v["providerTime"])
            out.append({
                "mmsi": v["mmsi"], "lat": v["lat"], "lon": v["lon"],
                "sogKn": v.get("sog"), "cogDeg": v.get("cog"), "headingDeg": v.get("heading"),
                "navStatus": v.get("navStatus"), "navStatusText": ais_nmea.nav_status_text(v.get("navStatus")),
                "name": v.get("name"), "shipType": v.get("shipType"),
                "shipTypeText": ais_nmea.ship_type_text(v.get("shipType")),
                "aisClass": v.get("aisClass"),
                "providerTimestamp": _iso(v["providerTime"]), "receivedAt": _iso(v["receivedAt"]),
                "ageSeconds": round(age), "stale": age > STALE_AFTER_SECONDS,
            })
        return out, len(inside)

    def clear(self) -> None:
        with self.lock:
            self.vessels.clear()
            self.static.clear()


# ---- stream workers ---------------------------------------------------------
class StreamWorker:
    provider = ""

    def __init__(self, clock: Callable[[], float] = time.monotonic, wall: Callable[[], float] = time.time):
        self.clock, self.wall = clock, wall
        self.store = VesselStore(wall)
        self.lock = threading.Lock()
        self.thread: threading.Thread | None = None
        self.stop_event = threading.Event()
        self.bbox: BBox | None = None
        self.last_poll = 0.0
        self.state = "idle"
        self.error: str | None = None
        self.last_message_at: float | None = None
        self.connected_at: float | None = None
        self.messages = 0
        self.backoff = BACKOFF_MIN_SECONDS
        self.retry_after = 0.0

    # Called from HTTP request threads.
    def touch(self, bbox: BBox) -> None:
        with self.lock:
            self.bbox, self.last_poll = bbox, self.clock()
            if self.thread is None or not self.thread.is_alive():
                self.stop_event.clear()
                self.state = "connecting"
                self.thread = threading.Thread(target=self._run, name=f"ais-{self.provider}", daemon=True)
                self.thread.start()

    def idle(self) -> bool:
        return self.stop_event.is_set() or self.clock() - self.last_poll > IDLE_DISCONNECT_SECONDS

    def shutdown(self, timeout: float = 5.0) -> None:
        self.stop_event.set()
        thread = self.thread
        if thread is not None:
            thread.join(timeout)

    def _run(self) -> None:
        while not self.idle():
            wait = self.retry_after - self.clock()
            if wait > 0:
                self.stop_event.wait(min(wait, 1.0))
                continue
            try:
                self.state, self.error = "connecting", None
                self.session()
                self.backoff = BACKOFF_MIN_SECONDS
            except ProviderError as error:
                self._fail(str(error))
            except Exception:  # noqa: BLE001 - never surface raw exception text (may echo request details)
                self._fail("provider connection failed")
        if self.state != "error":
            self.state = "idle"
        self.connected_at = None

    def _fail(self, message: str) -> None:
        self.state, self.error, self.connected_at = "error", message, None
        self.retry_after = self.clock() + self.backoff
        self.backoff = min(BACKOFF_MAX_SECONDS, self.backoff * 2)

    def _received(self) -> None:
        self.messages += 1
        self.last_message_at = self.wall()
        self.state = "live"

    def session(self) -> None:  # pragma: no cover - abstract
        raise NotImplementedError

    def health(self) -> dict[str, Any]:
        state = self.state
        if state == "live" and (self.last_message_at is None or self.wall() - self.last_message_at > SILENT_STREAM_SECONDS):
            state = "stale"
        elif state == "connecting" and self.connected_at is not None and self.wall() - self.connected_at > SILENT_STREAM_SECONDS:
            state = "stale"
        return {"state": state, "error": self.error, "lastMessageAt": _iso(self.last_message_at), "messages": self.messages}


_AISSTREAM_TIME = re.compile(r"^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?\s*([+-]\d{4}|Z)?")


def _parse_aisstream_time(meta: dict[str, Any]) -> float | None:
    """Parse AISStream MetaData.time_utc, e.g. '2022-12-29 18:22:32.318353 +0000 UTC'."""
    raw = meta.get("time_utc")
    if not isinstance(raw, str) or len(raw) > 64:
        return None
    match = _AISSTREAM_TIME.match(raw.strip())
    if not match:
        return None
    day, clock, frac, zone = match.groups()
    zone = "+0000" if zone in (None, "Z") else zone
    try:
        return datetime.strptime(f"{day} {clock}.{(frac or '0')[:6]:0<6} {zone}", "%Y-%m-%d %H:%M:%S.%f %z").timestamp()
    except ValueError:
        return None


def _num(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def parse_aisstream_message(raw: bytes | str) -> dict[str, Any] | None:
    """Map one AISStream JSON message to a store update; None for other types."""
    if isinstance(raw, bytes):
        if len(raw) > MAX_WS_FRAME:
            return None
        raw = raw.decode("utf-8", "replace")
    data = json.loads(raw)
    if not isinstance(data, dict):
        return None
    kind = data.get("MessageType")
    body = (data.get("Message") or {}).get(kind) if isinstance(data.get("Message"), dict) else None
    meta = data.get("MetaData") if isinstance(data.get("MetaData"), dict) else {}
    if not isinstance(body, dict):
        return None
    mmsi = body.get("UserID", meta.get("MMSI"))
    if not isinstance(mmsi, int) or isinstance(mmsi, bool):
        return None
    if body.get("Valid") is False:
        return None
    ptime = _parse_aisstream_time(meta)
    if kind in ("PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport"):
        lat, lon = _num(body.get("Latitude")), _num(body.get("Longitude"))
        if lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
            return None
        sog, cog, heading = _num(body.get("Sog")), _num(body.get("Cog")), body.get("TrueHeading")
        update = {
            "mmsi": mmsi, "lat": lat, "lon": lon, "provider_time": ptime,
            "ais_class": "A" if kind == "PositionReport" else "B",
            "sog": None if sog is None or sog >= 102.3 else sog,
            "cog": None if cog is None or cog >= 360 else cog,
            "heading": heading if isinstance(heading, int) and 0 <= heading <= 359 else None,
            "nav_status": body.get("NavigationalStatus") if kind == "PositionReport" and isinstance(body.get("NavigationalStatus"), int) else None,
        }
        name = meta.get("ShipName")
        if isinstance(name, str) and name.strip():
            update["name"] = name.strip()[:40]
        return update
    if kind == "ShipStaticData":
        name, stype = body.get("Name"), body.get("Type")
        return {"mmsi": mmsi, "name": name.strip()[:40] if isinstance(name, str) and name.strip() else None,
                "ship_type": stype if isinstance(stype, int) and 0 < stype < 100 else None}
    if kind == "StaticDataReport":
        report_a = body.get("ReportA") if isinstance(body.get("ReportA"), dict) else {}
        report_b = body.get("ReportB") if isinstance(body.get("ReportB"), dict) else {}
        name = report_a.get("Name") if report_a.get("Valid", True) else None
        stype = report_b.get("ShipType") if report_b.get("Valid", True) else None
        return {"mmsi": mmsi, "name": name.strip()[:40] if isinstance(name, str) and name.strip() else None,
                "ship_type": stype if isinstance(stype, int) and 0 < stype < 100 else None}
    return None


AISSTREAM_TYPES = ["PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport",
                   "ShipStaticData", "StaticDataReport"]


def aisstream_subscription(key: str, bbox: BBox) -> str:
    return json.dumps({
        "APIKey": key,
        "BoundingBoxes": [[[bbox.south, bbox.west], [bbox.north, bbox.east]]],
        "FilterMessageTypes": AISSTREAM_TYPES,
    })


def _default_ws_connect(url: str):
    from websockets.asyncio.client import connect
    return connect(url, open_timeout=10, close_timeout=3, max_size=MAX_WS_FRAME, compression="deflate",
                   ping_interval=20, ping_timeout=20, user_agent_header="SignalWarden-WorldView-AIS/1")


class AisStreamWorker(StreamWorker):
    provider = "aisstream"

    def __init__(self, connect: Callable[[str], Any] | None = None, **kwargs: Any):
        super().__init__(**kwargs)
        self.connect = connect or _default_ws_connect

    def session(self) -> None:
        asyncio.run(self._session())

    async def _session(self) -> None:
        key = _secret("UCAS_AISSTREAM_API_KEY")
        if not key:
            raise ProviderError("UCAS_AISSTREAM_API_KEY is not configured")
        try:
            async with self.connect(AISSTREAM_URL) as ws:
                sent = self.bbox
                await ws.send(aisstream_subscription(key, sent))
                last_sub = self.clock()
                self.connected_at = self.wall()
                last_frame = self.clock()
                while not self.idle():
                    if self.bbox != sent and self.clock() - last_sub >= RESUBSCRIBE_MIN_SECONDS:
                        sent = self.bbox
                        await ws.send(aisstream_subscription(key, sent))
                        last_sub = self.clock()
                    try:
                        raw = await asyncio.wait_for(ws.recv(), 1.0)
                    except asyncio.TimeoutError:
                        if not self.idle() and self.clock() - last_frame > SILENT_STREAM_SECONDS:
                            raise ProviderError("stream silent; reconnecting")
                        continue
                    last_frame = self.clock()
                    self._handle(raw, key)
        except ProviderError:
            raise
        except Exception as error:  # noqa: BLE001
            code = getattr(getattr(error, "rcvd", None), "code", None)
            raise ProviderError(f"AISStream connection closed{f' (code {code})' if code else ''}; an invalid key, connection limit or network error closes the stream") from None

    def _handle(self, raw: bytes | str, key: str) -> None:
        try:
            text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
            if len(text) > MAX_WS_FRAME:
                return
            data = json.loads(text)
        except ValueError:
            return
        if isinstance(data, dict) and isinstance(data.get("error"), str):
            raise ProviderError("AISStream rejected the subscription: " + _redact(data["error"], key))
        if isinstance(data, dict) and data.get("MessageType") == "SubscriptionConfirmation":
            return
        try:
            update = parse_aisstream_message(text)
        except ValueError:
            return
        if update is None:
            return
        self._received()
        if "lat" in update and not (self.bbox and self.bbox.contains(update["lat"], update["lon"])):
            return
        self.store.update(**update)


def _default_tcp_connect(address: tuple[str, int]) -> socket.socket:
    return socket.create_connection(address, timeout=10)


class KystverketWorker(StreamWorker):
    provider = "kystverket"

    def __init__(self, connect: Callable[[tuple[str, int]], Any] | None = None, **kwargs: Any):
        super().__init__(**kwargs)
        self.connect = connect or _default_tcp_connect
        self.assembler = ais_nmea.AivdmAssembler(clock=self.clock)

    def session(self) -> None:
        try:
            sock = self.connect((KYSTVERKET_HOST, KYSTVERKET_PORT))
        except OSError:
            raise ProviderError("Kystverket AIS TCP feed could not be reached") from None
        try:
            sock.settimeout(5.0)
            self.connected_at = self.wall()
            buffer = b""
            last_data = self.clock()
            while not self.idle():
                try:
                    chunk = sock.recv(4096)
                except socket.timeout:
                    if not self.idle() and self.clock() - last_data > SILENT_STREAM_SECONDS:
                        raise ProviderError("Kystverket AIS feed silent; reconnecting")
                    continue
                except OSError:
                    raise ProviderError("Kystverket AIS feed read failed") from None
                if not chunk:
                    raise ProviderError("Kystverket AIS feed closed the connection")
                last_data = self.clock()
                buffer += chunk
                *lines, buffer = buffer.split(b"\n")
                if len(buffer) > MAX_TCP_LINE_BUFFER:
                    buffer = b""  # Drop an overlong partial line instead of growing.
                for line in lines:
                    self.feed_line(line)
        finally:
            try:
                sock.close()
            except OSError:
                pass

    def feed_line(self, line: bytes) -> None:
        if not line.strip():
            return
        update = self.assembler.feed(line)
        if update is None:
            return
        self._received()
        if update.has_position and not (self.bbox and self.bbox.contains(update.lat, update.lon)):
            return
        self.store.update(mmsi=update.mmsi, ais_class=update.ais_class, lat=update.lat, lon=update.lon,
                          sog=update.sog, cog=update.cog, heading=update.heading, nav_status=update.nav_status,
                          name=update.name, ship_type=update.ship_type, provider_time=update.provider_time)


# ---- BarentsWatch snapshot poller ---------------------------------------------
class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


def _parse_iso(text: Any) -> float | None:
    if not isinstance(text, str):
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def parse_barentswatch_item(item: Any) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    mmsi, lat, lon = item.get("mmsi"), _num(item.get("latitude")), _num(item.get("longitude"))
    if not isinstance(mmsi, int) or isinstance(mmsi, bool) or lat is None or lon is None:
        return None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    heading, stype, nav, name = item.get("trueHeading"), item.get("shipType"), item.get("navigationalStatus"), item.get("name")
    sog, cog = _num(item.get("speedOverGround")), _num(item.get("courseOverGround"))
    return {
        "mmsi": mmsi, "lat": lat, "lon": lon, "provider_time": _parse_iso(item.get("msgtime")),
        "sog": None if sog is None or sog >= 102.3 else sog,
        "cog": None if cog is None or cog >= 360 else cog,
        "heading": heading if isinstance(heading, int) and 0 <= heading <= 359 else None,
        "nav_status": nav if isinstance(nav, int) and not isinstance(nav, bool) else None,
        "ship_type": stype if isinstance(stype, int) and 0 < stype < 100 else None,
        "name": name.strip()[:40] if isinstance(name, str) and name.strip() else None,
    }


class BarentsWatchPoller:
    provider = "barentswatch"

    def __init__(self, opener: Any = None, clock: Callable[[], float] = time.monotonic, wall: Callable[[], float] = time.time):
        self.opener = opener or build_opener(ProxyHandler({}), _NoRedirect())
        self.clock, self.wall = clock, wall
        self.store = VesselStore(wall)
        self.lock = threading.Lock()
        self.token: tuple[str, float] | None = None
        self.last_attempt = -math.inf
        self.last_bbox: BBox | None = None
        self.state, self.error = "idle", None
        self.last_message_at: float | None = None
        self.messages = 0

    def _read(self, request: Request, limit: int) -> bytes:
        deadline = self.clock() + HTTP_DEADLINE_SECONDS
        try:
            response = self.opener.open(request, timeout=HTTP_DEADLINE_SECONDS)
        except HTTPError as error:
            status = error.code
            error.close()
            raise ProviderError(f"BarentsWatch returned HTTP {status}") from None
        except (URLError, TimeoutError, OSError):
            raise ProviderError("BarentsWatch could not be reached") from None
        try:
            data = bytearray()
            while True:
                if self.clock() > deadline:
                    raise ProviderError("BarentsWatch request timed out")
                chunk = response.read(64 * 1024)
                if not chunk:
                    return bytes(data)
                data.extend(chunk)
                if len(data) > limit:
                    raise ProviderError("BarentsWatch response exceeds the size limit")
        except ProviderError:
            raise
        except (URLError, TimeoutError, OSError):
            raise ProviderError("BarentsWatch response could not be read") from None
        finally:
            response.close()

    def _access_token(self) -> str:
        if self.token and self.clock() < self.token[1]:
            return self.token[0]
        client_id, secret = _secret("UCAS_BARENTSWATCH_CLIENT_ID"), _secret("UCAS_BARENTSWATCH_CLIENT_SECRET")
        if not client_id or not secret:
            raise ProviderError("BarentsWatch client credentials are not configured")
        form = urlencode({"client_id": client_id, "client_secret": secret, "scope": "ais", "grant_type": "client_credentials"}).encode()
        request = Request(BARENTSWATCH_TOKEN_URL, data=form, method="POST",
                          headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"})
        try:
            body = json.loads(self._read(request, 64 * 1024))
        except ProviderError as error:
            raise ProviderError("BarentsWatch token request failed: " + _redact(str(error), client_id, secret)) from None
        except ValueError:
            raise ProviderError("BarentsWatch token response was not JSON") from None
        token, expires = body.get("access_token") if isinstance(body, dict) else None, body.get("expires_in", 3600) if isinstance(body, dict) else 0
        if not isinstance(token, str) or not token:
            raise ProviderError("BarentsWatch token response had no access token")
        lifetime = float(expires) if isinstance(expires, (int, float)) else 3600.0
        self.token = (token, self.clock() + max(30.0, lifetime - 60.0))
        return token

    def refresh(self, bbox: BBox) -> None:
        with self.lock:
            if self.last_bbox == bbox and self.clock() - self.last_attempt < BARENTSWATCH_MIN_INTERVAL:
                return
            self.last_attempt, self.last_bbox, self.state = self.clock(), bbox, "connecting"
            try:
                token = self._access_token()
                ring = [[bbox.west, bbox.south], [bbox.east, bbox.south], [bbox.east, bbox.north], [bbox.west, bbox.north], [bbox.west, bbox.south]]
                since = _iso(self.wall() - POSITION_TTL_SECONDS)
                payload = json.dumps({"geometry": {"type": "Polygon", "coordinates": [ring]}, "modelType": "Simple",
                                      "modelFormat": "Json", "since": since}).encode()
                request = Request(BARENTSWATCH_LATEST_URL, data=payload, method="POST",
                                  headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "Accept": "application/json"})
                try:
                    rows = json.loads(self._read(request, BARENTSWATCH_MAX_BYTES))
                except ValueError:
                    raise ProviderError("BarentsWatch response was not JSON") from None
                if not isinstance(rows, list):
                    raise ProviderError("BarentsWatch response had an unexpected shape")
                parsed = [u for u in (parse_barentswatch_item(r) for r in rows[:BARENTSWATCH_MAX_ITEMS]) if u]
                if rows and not parsed:
                    raise ProviderError("BarentsWatch response contained no valid AIS positions")
                updates = [u for u in parsed if bbox.contains(u["lat"], u["lon"])]
                self.store.replace(updates)
                self.messages = len(rows)
                self.last_message_at = self.wall()
                self.state, self.error = "live", None
            except ProviderError as error:
                if "401" in str(error):
                    self.token = None
                self.state, self.error = "error", str(error)

    def health(self) -> dict[str, Any]:
        state = self.state
        if state == "live" and self.last_message_at is not None and self.wall() - self.last_message_at > STALE_AFTER_SECONDS:
            state = "stale"
        return {"state": state, "error": self.error, "lastMessageAt": _iso(self.last_message_at), "messages": self.messages}

    def shutdown(self, timeout: float = 0) -> None:
        return None


# ---- relay facade -------------------------------------------------------------
class AisRelay:
    def __init__(self, workers: dict[str, Any] | None = None):
        self.workers = workers or {
            "aisstream": AisStreamWorker(),
            "kystverket": KystverketWorker(),
            "barentswatch": BarentsWatchPoller(),
        }

    def _provider_status(self, provider: str) -> dict[str, Any]:
        meta = PROVIDERS[provider]
        public = {k: v for k, v in meta.items() if k not in ("keyEnv", "enableEnv")}
        configured = provider_configured(provider)
        if configured:
            health = self.workers[provider].health()
            status = health["state"]
        else:
            health = {"state": "not_configured", "error": None, "lastMessageAt": None, "messages": 0}
            status = "not_configured"
        needs = meta["keyEnv"] or [meta.get("enableEnv")]
        return {
            "provider": provider, **public, "status": status, "configured": configured,
            "keyRequired": bool(meta["keyEnv"]), "configEnv": needs,
            "error": health["error"], "lastMessageAt": health["lastMessageAt"], "messagesSeen": health["messages"],
            "disclosure": SELF_REPORTED,
            "message": None if configured else f"Not configured: set {' and '.join(needs)} on the Management API server",
        }

    def status(self) -> dict[str, Any]:
        return {"relay": "enabled", "readOnly": True, "transmit": False,
                "limits": {"maxLatSpan": MAX_LAT_SPAN, "maxLonSpan": MAX_LON_SPAN, "maxReturned": MAX_RETURNED,
                           "staleAfterSeconds": STALE_AFTER_SECONDS, "positionTtlSeconds": POSITION_TTL_SECONDS,
                           "idleDisconnectSeconds": IDLE_DISCONNECT_SECONDS},
                "providers": [self._provider_status(p) for p in PROVIDERS]}

    def vessels(self, provider: str, bbox: BBox) -> dict[str, Any]:
        info = self._provider_status(provider)
        body: dict[str, Any] = {**info, "bbox": bbox.as_dict(), "retrievedAt": _iso(time.time()), "vessels": [], "vesselsInBox": 0, "truncated": False}
        if not info["configured"]:
            return body
        worker = self.workers[provider]
        if isinstance(worker, BarentsWatchPoller):
            worker.refresh(bbox)
        else:
            worker.touch(bbox)
        vessels, total = worker.store.snapshot(bbox)
        refreshed = self._provider_status(provider)
        body.update({k: refreshed[k] for k in ("status", "error", "lastMessageAt", "messagesSeen")})
        body.update({"vessels": vessels, "vesselsInBox": total, "truncated": total > len(vessels), "retrievedAt": _iso(time.time())})
        return body

    def shutdown(self) -> None:
        for worker in self.workers.values():
            worker.shutdown()


_relay: AisRelay | None = None
_relay_lock = threading.Lock()


def relay() -> AisRelay:
    global _relay
    with _relay_lock:
        if _relay is None:
            _relay = AisRelay()
        return _relay


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


def authorize_request(headers: Any) -> None:
    if not relay_enabled():
        raise AisRelayError(404, "public_ais_disabled", "public AIS relay is disabled; set UCAS_PUBLIC_AIS_ENABLED=1 on the Management API")
    if headers.get("X-SignalWarden-AIS") != "enabled":
        raise AisRelayError(403, "ais_header_required", "X-SignalWarden-AIS: enabled is required")
    if not _same_origin(headers):
        raise AisRelayError(403, "origin_not_allowed", "cross-site AIS relay requests are not allowed")


def handle(method: str, suffix: list[str], query: dict[str, list[str]], headers: Any, instance: AisRelay | None = None) -> dict[str, Any]:
    """Entry point for /api/v1/public-ais/<suffix>.  GET only; read-only."""
    authorize_request(headers)
    if method != "GET":
        raise AisRelayError(405, "read_only_integration", "public AIS relay routes are GET-only")
    target = instance or relay()
    if suffix == ["status"]:
        if query:
            raise AisRelayError(400, "invalid_ais_query", "status takes no query parameters")
        return target.status()
    if suffix == ["vessels"]:
        allowed = {"provider", "south", "west", "north", "east"}
        if set(query) - allowed:
            raise AisRelayError(400, "invalid_ais_query", "only provider, south, west, north and east are accepted")
        provider = query.get("provider", [])
        if len(provider) != 1 or provider[0] not in PROVIDERS:
            raise AisRelayError(400, "invalid_ais_provider", "provider must be one of " + ", ".join(PROVIDERS))
        return target.vessels(provider[0], parse_bbox(query))
    raise AisRelayError(404, "not_found", "public AIS route was not found")
