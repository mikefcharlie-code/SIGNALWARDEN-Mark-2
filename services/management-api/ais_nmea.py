"""Small, bounded AIVDM/AIVDO decoder for civilian vessel situational awareness.

Only the fields WorldView displays are decoded, from AIS message types
1/2/3 (Class A position), 5 (Class A static), 18 (Class B position) and
24 (Class B static, parts A/B).  Call sign, IMO number, destination, ETA and
any other identity/voyage fields are deliberately not extracted.

AIS is self-reported by vessel transponders: decoded values are what the
vessel broadcast, not verified facts.  This module performs no I/O.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable

MAX_SENTENCE = 512  # NMEA 0183 is 82 chars; tag blocks add a little.
MAX_FRAGMENTS = 9
MAX_PENDING_GROUPS = 128
FRAGMENT_TTL_SECONDS = 10.0

NAV_STATUS = {
    0: "Under way using engine", 1: "At anchor", 2: "Not under command",
    3: "Restricted manoeuvrability", 4: "Constrained by draught", 5: "Moored",
    6: "Aground", 7: "Engaged in fishing", 8: "Under way sailing",
    11: "Power-driven vessel towing astern", 12: "Power-driven vessel pushing ahead or towing alongside",
    14: "AIS-SART / MOB / EPIRB active", 15: "Not defined",
}


def nav_status_text(code: Any) -> str | None:
    if not isinstance(code, int) or isinstance(code, bool):
        return None
    return NAV_STATUS.get(code, "Reserved")


def ship_type_text(code: Any) -> str | None:
    """Broad ITU-R M.1371 ship-type category for a broadcast type code."""
    if not isinstance(code, int) or isinstance(code, bool) or code <= 0 or code > 99:
        return None
    special = {30: "Fishing", 31: "Towing", 32: "Towing (large)", 33: "Dredging/underwater ops",
               34: "Diving ops", 35: "Military ops", 36: "Sailing", 37: "Pleasure craft",
               50: "Pilot vessel", 51: "Search and rescue", 52: "Tug", 53: "Port tender",
               54: "Anti-pollution", 55: "Law enforcement", 58: "Medical transport"}
    if code in special:
        return special[code]
    decade = {2: "Wing in ground", 4: "High-speed craft", 6: "Passenger", 7: "Cargo",
              8: "Tanker", 9: "Other"}
    return decade.get(code // 10, "Other/reserved")


def nmea_checksum(body: str) -> str:
    value = 0
    for char in body:
        value ^= ord(char)
    return f"{value:02X}"


@dataclass
class AisUpdate:
    mmsi: int
    msg_type: int
    ais_class: str  # "A" or "B"
    lat: float | None = None
    lon: float | None = None
    sog: float | None = None
    cog: float | None = None
    heading: int | None = None
    nav_status: int | None = None
    name: str | None = None
    ship_type: int | None = None
    provider_time: float | None = None  # epoch seconds from the tag block, when present

    @property
    def has_position(self) -> bool:
        return self.lat is not None and self.lon is not None


class _Bits:
    def __init__(self, payload: str, fill: int):
        bits = []
        for char in payload:
            value = ord(char) - 48
            if value > 40:
                value -= 8
            if value < 0 or value > 63:
                raise ValueError("invalid payload character")
            bits.append(format(value, "06b"))
        text = "".join(bits)
        self.bits = text[: len(text) - fill] if fill else text

    def __len__(self) -> int:
        return len(self.bits)

    def uint(self, start: int, width: int) -> int:
        chunk = self.bits[start:start + width]
        if len(chunk) != width:
            raise ValueError("payload too short")
        return int(chunk, 2)

    def sint(self, start: int, width: int) -> int:
        value = self.uint(start, width)
        return value - (1 << width) if value & (1 << (width - 1)) else value

    def text(self, start: int, width: int) -> str:
        width = min(width, max(0, len(self.bits) - start) // 6 * 6)
        out = []
        for offset in range(start, start + width, 6):
            value = self.uint(offset, 6)
            out.append(chr(value + 64) if value < 32 else chr(value))
        return "".join(out).split("@", 1)[0].strip()


def _position(bits: _Bits, lon_at: int, lat_at: int, sog_at: int, cog_at: int, hdg_at: int) -> dict[str, Any]:
    lon = bits.sint(lon_at, 28) / 600000.0
    lat = bits.sint(lat_at, 27) / 600000.0
    valid = -180.0 <= lon <= 180.0 and -90.0 <= lat <= 90.0 and not (lon == 181 or lat == 91)
    sog_raw, cog_raw, heading = bits.uint(sog_at, 10), bits.uint(cog_at, 12), bits.uint(hdg_at, 9)
    return {
        "lat": round(lat, 6) if valid else None,
        "lon": round(lon, 6) if valid else None,
        "sog": None if sog_raw == 1023 else sog_raw / 10.0,
        "cog": None if cog_raw >= 3600 else cog_raw / 10.0,
        "heading": None if heading > 359 else heading,
    }


def decode_payload(payload: str, fill: int = 0) -> AisUpdate | None:
    """Decode one complete armoured payload; unsupported types return None."""
    if not payload or len(payload) > MAX_FRAGMENTS * 82 or not 0 <= fill <= 5:
        raise ValueError("invalid payload")
    bits = _Bits(payload, fill)
    if len(bits) < 38:
        raise ValueError("payload too short")
    msg_type = bits.uint(0, 6)
    mmsi = bits.uint(8, 30)
    if msg_type in (1, 2, 3):
        if len(bits) < 149:
            raise ValueError("position report too short")
        return AisUpdate(mmsi=mmsi, msg_type=msg_type, ais_class="A", nav_status=bits.uint(38, 4),
                         **_position(bits, 61, 89, 50, 116, 128))
    if msg_type == 18:
        if len(bits) < 149:
            raise ValueError("class B position report too short")
        return AisUpdate(mmsi=mmsi, msg_type=18, ais_class="B", **_position(bits, 57, 85, 46, 112, 124))
    if msg_type == 5:
        if len(bits) < 240:
            raise ValueError("static report too short")
        return AisUpdate(mmsi=mmsi, msg_type=5, ais_class="A", name=bits.text(112, 120) or None,
                         ship_type=bits.uint(232, 8) or None)
    if msg_type == 24:
        part = bits.uint(38, 2)
        if part == 0:
            return AisUpdate(mmsi=mmsi, msg_type=24, ais_class="B", name=bits.text(40, 120) or None)
        if part == 1 and len(bits) >= 48:
            return AisUpdate(mmsi=mmsi, msg_type=24, ais_class="B", ship_type=bits.uint(40, 8) or None)
        return None
    return None


def _tag_time(tag: str) -> float | None:
    for item in tag.split(","):
        key, _, value = item.partition(":")
        if key == "c" and value.isdigit() and len(value) <= 13:
            seconds = int(value)
            return seconds / 1000.0 if seconds > 10**11 else float(seconds)
    return None


@dataclass
class AivdmAssembler:
    """Reassembles multi-sentence AIVDM messages with bounded memory."""

    clock: Callable[[], float] = time.monotonic
    pending: dict[tuple[str, str, int], dict[str, Any]] = field(default_factory=dict)
    rejected: int = 0

    def _expire(self, now: float) -> None:
        for key in [k for k, v in self.pending.items() if now - v["at"] > FRAGMENT_TTL_SECONDS]:
            del self.pending[key]

    def feed(self, line: str | bytes) -> AisUpdate | None:
        try:
            return self._feed(line)
        except (ValueError, UnicodeDecodeError):
            self.rejected += 1
            return None

    def _feed(self, line: str | bytes) -> AisUpdate | None:
        if isinstance(line, bytes):
            if len(line) > MAX_SENTENCE:
                raise ValueError("sentence too long")
            line = line.decode("ascii")
        line = line.strip()
        if not line or len(line) > MAX_SENTENCE:
            raise ValueError("empty or long sentence")
        provider_time = None
        if line.startswith("\\"):
            end = line.find("\\", 1)
            if end < 0:
                raise ValueError("unterminated tag block")
            tag = line[1:end]
            tag_body, star, tag_sum = tag.rpartition("*")
            if star and nmea_checksum(tag_body) != tag_sum.upper():
                raise ValueError("tag block checksum")
            provider_time = _tag_time(tag_body if star else tag)
            line = line[end + 1:]
        if not line.startswith("!") or "*" not in line:
            raise ValueError("not an encapsulated sentence")
        body, _, checksum = line[1:].rpartition("*")
        if nmea_checksum(body) != checksum[:2].upper():
            raise ValueError("checksum mismatch")
        fields = body.split(",")
        if len(fields) != 7 or len(fields[0]) != 5 or fields[0][2:] not in ("VDM", "VDO"):
            raise ValueError("not AIVDM/AIVDO")
        count, index = int(fields[1]), int(fields[2])
        seq, channel, payload, fill = fields[3], fields[4], fields[5], int(fields[6] or 0)
        if not 1 <= count <= MAX_FRAGMENTS or not 1 <= index <= count:
            raise ValueError("bad fragment numbering")
        if count == 1:
            update = decode_payload(payload, fill)
        else:
            now = self.clock()
            self._expire(now)
            key = (fields[0][:2] + seq, channel, count)
            group = self.pending.get(key)
            if index == 1 or group is None:
                if index != 1:
                    raise ValueError("orphan fragment")
                if len(self.pending) >= MAX_PENDING_GROUPS:
                    oldest = min(self.pending, key=lambda k: self.pending[k]["at"])
                    del self.pending[oldest]
                group = self.pending[key] = {"at": now, "parts": {}, "time": provider_time}
            group["parts"][index] = payload
            if index != count:
                return None
            del self.pending[key]
            if len(group["parts"]) != count:
                raise ValueError("missing fragment")
            payload = "".join(group["parts"][i] for i in range(1, count + 1))
            provider_time = provider_time or group["time"]
            update = decode_payload(payload, fill)
        if update is not None:
            update.provider_time = provider_time
        return update
