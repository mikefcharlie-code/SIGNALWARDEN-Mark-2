"""Minimal, dependency-free GTFS-realtime VehiclePosition decoder.

Decodes only the protobuf wire-format fields needed for a read-only vehicle
position layer (FeedHeader timestamp and FeedEntity.vehicle trip/route,
vehicle id/label, position and timestamp). Unknown fields are skipped by wire
type, so newer feeds remain decodable. ``VehicleDescriptor.license_plate`` is
deliberately never decoded or returned.

Why not ``gtfs-realtime-bindings``: it pulls in the full ``protobuf`` runtime
for a handful of fields; this ~150-line reader is bounded (entity, depth and
length limits) and fully covered by hand-built fixtures in the test suite.
Field numbers follow https://gtfs.org/realtime/proto/ (gtfs-realtime.proto).
"""
from __future__ import annotations

import struct
from typing import Any

MAX_ENTITIES = 20_000


class GtfsRtDecodeError(ValueError):
    pass


def _varint(buf: bytes, pos: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while True:
        if pos >= len(buf):
            raise GtfsRtDecodeError("truncated varint")
        byte = buf[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, pos
        shift += 7
        if shift > 63:
            raise GtfsRtDecodeError("varint too long")


def _fields(buf: bytes):
    """Yield (field_number, wire_type, value) for one message level."""
    pos = 0
    end = len(buf)
    while pos < end:
        key, pos = _varint(buf, pos)
        field, wire = key >> 3, key & 7
        if field == 0:
            raise GtfsRtDecodeError("invalid field number 0")
        if wire == 0:
            value, pos = _varint(buf, pos)
        elif wire == 1:
            if pos + 8 > end:
                raise GtfsRtDecodeError("truncated fixed64")
            value = buf[pos:pos + 8]
            pos += 8
        elif wire == 2:
            length, pos = _varint(buf, pos)
            if length > end - pos:
                raise GtfsRtDecodeError("truncated length-delimited field")
            value = buf[pos:pos + length]
            pos += length
        elif wire == 5:
            if pos + 4 > end:
                raise GtfsRtDecodeError("truncated fixed32")
            value = buf[pos:pos + 4]
            pos += 4
        else:
            raise GtfsRtDecodeError(f"unsupported wire type {wire}")
        yield field, wire, value


def _text(value: Any, limit: int = 120) -> str | None:
    if not isinstance(value, (bytes, bytearray)):
        return None
    try:
        text = bytes(value).decode("utf-8")
    except UnicodeDecodeError:
        return None
    text = "".join(ch for ch in text if ch.isprintable())[:limit]
    return text or None


def _float32(value: Any) -> float | None:
    if isinstance(value, (bytes, bytearray)) and len(value) == 4:
        number = struct.unpack("<f", bytes(value))[0]
        return number if number == number and abs(number) != float("inf") else None
    return None


def _trip(buf: bytes) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for field, wire, value in _fields(buf):
        if field == 1 and wire == 2:
            out["trip_id"] = _text(value)
        elif field == 5 and wire == 2:
            out["route_id"] = _text(value)
        elif field == 6 and wire == 0:
            out["direction_id"] = int(value) if value in (0, 1) else None
        elif field == 3 and wire == 2:
            out["start_date"] = _text(value, 16)
    return out


def _vehicle_descriptor(buf: bytes) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for field, wire, value in _fields(buf):
        if field == 1 and wire == 2:
            out["vehicle_id"] = _text(value, 64)
        elif field == 2 and wire == 2:
            out["vehicle_label"] = _text(value, 64)
        # field 3 (license_plate) is intentionally ignored.
    return out


def _position(buf: bytes) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for field, wire, value in _fields(buf):
        if wire != 5:
            continue
        if field == 1:
            out["lat"] = _float32(value)
        elif field == 2:
            out["lon"] = _float32(value)
        elif field == 3:
            out["bearing"] = _float32(value)
        elif field == 5:
            out["speed_mps"] = _float32(value)
    return out


def _vehicle_position(buf: bytes) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for field, wire, value in _fields(buf):
        if field == 1 and wire == 2:
            out.update(_trip(value))
        elif field == 8 and wire == 2:
            out.update(_vehicle_descriptor(value))
        elif field == 2 and wire == 2:
            out.update(_position(value))
        elif field == 5 and wire == 0:
            out["timestamp"] = int(value)
        elif field == 7 and wire == 2:
            out["stop_id"] = _text(value, 64)
        elif field == 4 and wire == 0:
            out["current_status"] = {0: "INCOMING_AT", 1: "STOPPED_AT", 2: "IN_TRANSIT_TO"}.get(int(value))
    return out


def decode_vehicle_positions(payload: bytes) -> dict[str, Any]:
    """Return {header_timestamp, version, vehicles: [...]} from a FeedMessage."""
    if not isinstance(payload, (bytes, bytearray)) or not payload:
        raise GtfsRtDecodeError("empty GTFS-realtime payload")
    header_ts: int | None = None
    version: str | None = None
    vehicles: list[dict[str, Any]] = []
    entities = 0
    saw_header = False
    for field, wire, value in _fields(bytes(payload)):
        if field == 1 and wire == 2:
            saw_header = True
            for hf, hw, hv in _fields(value):
                if hf == 1 and hw == 2:
                    version = _text(hv, 16)
                elif hf == 3 and hw == 0:
                    header_ts = int(hv)
        elif field == 2 and wire == 2:
            entities += 1
            if entities > MAX_ENTITIES:
                raise GtfsRtDecodeError("too many GTFS-realtime entities")
            entity_id = None
            deleted = False
            vehicle = None
            for ef, ew, ev in _fields(value):
                if ef == 1 and ew == 2:
                    entity_id = _text(ev, 64)
                elif ef == 2 and ew == 0:
                    deleted = bool(ev)
                elif ef == 4 and ew == 2:
                    vehicle = _vehicle_position(ev)
            if vehicle is not None and not deleted:
                vehicle["entity_id"] = entity_id
                vehicles.append(vehicle)
    if not saw_header:
        raise GtfsRtDecodeError("GTFS-realtime FeedHeader is missing")
    return {"header_timestamp": header_ts, "version": version, "vehicles": vehicles}


# --- tiny encoder used only by tests/fixtures (kept here so fixtures stay hand-written) ---

def _key(field: int, wire: int) -> bytes:
    return _enc_varint((field << 3) | wire)


def _enc_varint(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def encode_field(field: int, value: Any, kind: str) -> bytes:
    if kind == "varint":
        return _key(field, 0) + _enc_varint(int(value))
    if kind == "float":
        return _key(field, 5) + struct.pack("<f", float(value))
    data = value.encode() if isinstance(value, str) else bytes(value)
    return _key(field, 2) + _enc_varint(len(data)) + data
