"""Load PX4 flight logs into version-independent sensor streams.

Handles PX4 v1.9 through v1.16-era topic and field names from one bounded local
``.ulg`` file via ``pyulog``. Every stream is a dict of 1-D float64 numpy arrays
keyed by a fixed name, with ``t`` in seconds since boot. A missing stream stays
absent; raw coordinate fields remain in-process only for relative features.

Evaluation/training only: nothing here touches a live vehicle.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

MAX_ULOG_BYTES = 128 * 1024 * 1024

# topic -> list of candidate topic names (first found wins)
TOPIC_ALIASES = {
    "gnss": ["vehicle_gps_position", "sensor_gps"],
    "att": ["vehicle_attitude"],
    "imu": ["sensor_combined"],
    "baro": ["vehicle_air_data", "sensor_baro"],
    "mag": ["vehicle_magnetometer", "sensor_mag"],
    "est": ["estimator_status"],
    "gpos": ["vehicle_global_position"],
    "lpos": ["vehicle_local_position"],
    "land": ["vehicle_land_detected"],
    "status": ["vehicle_status"],
}
ALL_TOPICS = sorted({name for names in TOPIC_ALIASES.values() for name in names})

Stream = dict[str, np.ndarray]


def _first(data: dict[str, np.ndarray], *names: str) -> np.ndarray | None:
    for name in names:
        if name in data:
            return np.asarray(data[name], dtype=np.float64)
    return None


def _raw_from_ulg(path: Path) -> dict[str, dict[str, np.ndarray]]:
    from pyulog import ULog

    ulog = ULog(str(path), ALL_TOPICS, disable_str_exceptions=True)
    raw: dict[str, dict[str, np.ndarray]] = {}
    for dataset in ulog.data_list:
        if dataset.multi_id == 0 and dataset.name not in raw:
            raw[dataset.name] = {key: np.asarray(value) for key, value in dataset.data.items()}
    return raw


def load_raw(path: str | Path) -> dict[str, dict[str, np.ndarray]]:
    path = Path(path)
    if path.is_symlink() or path.suffix.lower() != ".ulg" or not path.is_file():
        raise ValueError("only one regular local .ulg file is accepted")
    if path.stat().st_size <= 0 or path.stat().st_size > MAX_ULOG_BYTES:
        raise ValueError(f"ULog must be between 1 byte and {MAX_ULOG_BYTES} bytes")
    return _raw_from_ulg(path)


def _pick(raw: dict[str, dict[str, np.ndarray]], key: str) -> dict[str, np.ndarray] | None:
    for name in TOPIC_ALIASES[key]:
        data = raw.get(name)
        if data is not None and "timestamp" in data and len(data["timestamp"]) > 1:
            return data
    return None


def _latlon(data: dict[str, np.ndarray], deg_names: tuple[str, str], int_names: tuple[str, str]) -> tuple[np.ndarray | None, np.ndarray | None]:
    lat = _first(data, deg_names[0])
    lon = _first(data, deg_names[1])
    if lat is not None and lon is not None:
        return lat, lon
    lat = _first(data, int_names[0])
    lon = _first(data, int_names[1])
    if lat is None or lon is None:
        return None, None
    if np.nanmax(np.abs(lat)) > 1000:  # int32 degE7
        return lat / 1e7, lon / 1e7
    return lat, lon


def normalize(raw: dict[str, dict[str, np.ndarray]]) -> dict[str, Stream]:
    """Map raw topics onto fixed stream names; drop what is missing."""
    out: dict[str, Stream] = {}
    if (d := _pick(raw, "gnss")) is not None:
        lat, lon = _latlon(d, ("latitude_deg", "longitude_deg"), ("lat", "lon"))
        alt = _first(d, "altitude_msl_m")
        if alt is None and (a := _first(d, "alt")) is not None:
            alt = a / 1e3 if np.nanmax(np.abs(a)) > 20000 else a
        s: Stream = {"t": d["timestamp"] / 1e6}
        for name, value in {"lat": lat, "lon": lon, "alt": alt,
                            "fix": _first(d, "fix_type"), "sats": _first(d, "satellites_used"),
                            "eph": _first(d, "eph"), "epv": _first(d, "epv"), "hdop": _first(d, "hdop"),
                            "noise": _first(d, "noise_per_ms"), "jam": _first(d, "jamming_indicator"),
                            "vn": _first(d, "vel_n_m_s"), "ve": _first(d, "vel_e_m_s"), "vd": _first(d, "vel_d_m_s")}.items():
            if value is not None:
                s[name] = value
        if "lat" in s and "lon" in s and "fix" in s:
            out["gnss"] = s
    if (d := _pick(raw, "att")) is not None and "q[0]" in d:
        out["att"] = {"t": d["timestamp"] / 1e6, **{f"q{i}": np.asarray(d[f"q[{i}]"], float) for i in range(4)}}
    if (d := _pick(raw, "imu")) is not None and "accelerometer_m_s2[0]" in d:
        out["imu"] = {"t": d["timestamp"] / 1e6, **{k: np.asarray(d[f"accelerometer_m_s2[{i}]"], float) for i, k in enumerate("xyz")}}
    if (d := _pick(raw, "baro")) is not None:
        alt = _first(d, "baro_alt_meter", "altitude")
        if alt is not None:
            out["baro"] = {"t": d["timestamp"] / 1e6, "alt": alt}
    if (d := _pick(raw, "mag")) is not None:
        if "magnetometer_ga[0]" in d:
            out["mag"] = {"t": d["timestamp"] / 1e6, **{k: np.asarray(d[f"magnetometer_ga[{i}]"], float) for i, k in enumerate("xyz")}}
        elif "x" in d:
            out["mag"] = {"t": d["timestamp"] / 1e6, **{k: np.asarray(d[k], float) for k in "xyz"}}
    if (d := _pick(raw, "est")) is not None:
        s = {"t": d["timestamp"] / 1e6}
        for name, src in (("pos_tr", "pos_test_ratio"), ("vel_tr", "vel_test_ratio"), ("hgt_tr", "hgt_test_ratio"),
                          ("gps_fail", "gps_check_fail_flags")):
            if src in d:
                s[name] = np.asarray(d[src], float)
        if len(s) > 1:
            out["est"] = s
    if (d := _pick(raw, "gpos")) is not None:
        lat, lon = _latlon(d, ("lat_deg", "lon_deg"), ("lat", "lon"))
        if lat is not None and lon is not None:
            out["gpos"] = {"t": d["timestamp"] / 1e6, "lat": lat, "lon": lon, "alt": _first(d, "alt")}
    if (d := _pick(raw, "lpos")) is not None and "vx" in d:
        out["lpos"] = {"t": d["timestamp"] / 1e6, "vx": d["vx"].astype(float), "vy": d["vy"].astype(float), "vz": d["vz"].astype(float)}
    if (d := _pick(raw, "land")) is not None and "landed" in d:
        out["land"] = {"t": d["timestamp"] / 1e6, "landed": d["landed"].astype(float)}
    if (d := _pick(raw, "status")) is not None and "arming_state" in d:
        out["status"] = {"t": d["timestamp"] / 1e6, "armed": (np.asarray(d["arming_state"]) == 2).astype(float)}
    for stream in out.values():  # sort and de-duplicate time
        order = np.argsort(stream["t"], kind="stable")
        for key in list(stream):
            if stream[key] is None:
                del stream[key]
            else:
                stream[key] = np.asarray(stream[key], float)[order]
    return out


def load_streams(path: str | Path) -> dict[str, Stream]:
    return normalize(load_raw(path))


def copy_streams(streams: dict[str, Stream]) -> dict[str, Stream]:
    return {name: {key: value.copy() for key, value in stream.items()} for name, stream in streams.items()}


__all__ = ["load_streams", "load_raw", "normalize", "copy_streams", "Stream", "MAX_ULOG_BYTES"]
