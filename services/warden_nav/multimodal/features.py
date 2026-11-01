"""Per-window multimodal navigation-integrity features.

Five sensing modalities, each scored only against *other* sensors or against its
own recent past, so the features are coordinate-free and airframe-agnostic:

- ``gnss``      receiver health: satellites, fix, eph/epv, hdop, noise floor,
                jamming indicator, position/velocity self-consistency, gaps
- ``inertial``  GNSS velocity change vs IMU-integrated specific force (NED)
- ``baro``      GNSS altitude vs barometric altitude
- ``mag``       stability of the earth-frame magnetic heading/magnitude
- ``estimator`` EKF innovation test ratios, GPS check failures, EKF-vs-GNSS gap

plus a small always-present ``context`` block (speed, airframe family).

A modality is marked present only when its streams exist in the window; a
feature that cannot be computed is NaN and is imputed downstream. No absolute
coordinate leaves this module.
"""
from __future__ import annotations

import math
from typing import Mapping

import numpy as np

from .streams import Stream

WINDOW_S = 30.0
REFERENCE_S = 60.0
STRIDE_S = 5.0
FRESHNESS_LIMIT_S = 5.0
GRAVITY = 9.80665

MODALITIES = ("gnss", "inertial", "baro", "mag", "estimator")
FEATURES: dict[str, tuple[str, ...]] = {
    "gnss": ("sats_mean", "sats_drop", "sats_step_max", "fix_bad_frac", "eph_log_ratio", "eph_mean",
             "epv_log_ratio", "hdop_max", "noise_rel", "jam_rel", "posvel_mismatch_m_s",
             "pos_jump_resid_m", "gap_max_s", "rate_ratio"),
    "inertial": ("dv_resid_h_mean", "dv_resid_h_max", "dv_resid_v_mean", "dv_bias_drift_m_s", "dv_resid_rel"),
    "baro": ("gnss_baro_offset_max_m", "gnss_baro_offset_std_m", "gnss_baro_rate_diff_m_s"),
    "mag": ("mag_heading_dev_deg", "mag_norm_ratio"),
    "estimator": ("pos_tr_max", "pos_tr_mean", "vel_tr_max", "hgt_tr_max", "gps_fail_frac", "ekf_gnss_gap_m"),
}
CONTEXT = ("speed_log1p", "is_multicopter", "is_fixed_wing", "is_vtol")
FEATURE_NAMES = tuple(f"{m}.{f}" for m in MODALITIES for f in FEATURES[m]) + tuple(f"context.{c}" for c in CONTEXT)
FEATURE_COUNT = len(FEATURE_NAMES)
MODALITY_SLICES: dict[str, slice] = {}
_offset = 0
for _m in MODALITIES:
    MODALITY_SLICES[_m] = slice(_offset, _offset + len(FEATURES[_m]))
    _offset += len(FEATURES[_m])
CONTEXT_SLICE = slice(_offset, _offset + len(CONTEXT))
AIRFRAME_FAMILIES = ("multicopter", "fixed_wing", "vtol")


def _sel(stream: Stream, t0: float, t1: float) -> np.ndarray:
    t = stream["t"]
    return (t > t0) & (t <= t1)


def _nanmed(x: np.ndarray) -> float:
    x = x[np.isfinite(x)]
    return float(np.median(x)) if x.size else math.nan


def _enu(lat: np.ndarray, lon: np.ndarray, lat0: float, lon0: float) -> tuple[np.ndarray, np.ndarray]:
    north = (lat - lat0) * 111_320.0
    east = (lon - lon0) * 111_320.0 * math.cos(math.radians(lat0))
    return north, east


def _rot(q0, q1, q2, q3, x, y, z):
    """Rotate body vectors to NED with Hamilton quaternion (w, x, y, z)."""
    r00 = 1 - 2 * (q2 * q2 + q3 * q3); r01 = 2 * (q1 * q2 - q0 * q3); r02 = 2 * (q1 * q3 + q0 * q2)
    r10 = 2 * (q1 * q2 + q0 * q3); r11 = 1 - 2 * (q1 * q1 + q3 * q3); r12 = 2 * (q2 * q3 - q0 * q1)
    r20 = 2 * (q1 * q3 - q0 * q2); r21 = 2 * (q2 * q3 + q0 * q1); r22 = 1 - 2 * (q1 * q1 + q2 * q2)
    return (r00 * x + r01 * y + r02 * z, r10 * x + r11 * y + r12 * z, r20 * x + r21 * y + r22 * z)


def _interp(stream: Stream, key: str, grid: np.ndarray) -> np.ndarray:
    t, v = stream["t"], stream[key]
    ok = np.isfinite(v)
    if ok.sum() < 2:
        return np.full(grid.shape, np.nan)
    out = np.interp(grid, t[ok], v[ok])
    out[(grid < t[ok][0]) | (grid > t[ok][-1])] = np.nan
    return out


def _gnss_features(g: Stream, t0: float, t1: float, r0: float) -> dict[str, float]:
    f = {name: math.nan for name in FEATURES["gnss"]}
    w, ref = _sel(g, t0, t1), _sel(g, r0, t0)
    if w.sum() < 3:
        f["gap_max_s"] = WINDOW_S if w.sum() == 0 else f["gap_max_s"]
        f["rate_ratio"] = 0.0
        return f
    if ref.sum() < 5:  # no history yet: use first third of the window as reference
        ref = _sel(g, t0, t0 + WINDOW_S / 3)
    t = g["t"][w]
    if "sats" in g:
        s = g["sats"][w]
        f["sats_mean"] = float(np.nanmean(s))
        f["sats_drop"] = float(_nanmed(g["sats"][ref]) - np.nanmin(s))
        f["sats_step_max"] = float(np.nanmax(np.abs(np.diff(s)))) if s.size > 1 else 0.0
    f["fix_bad_frac"] = float(np.mean(g["fix"][w] < 3))
    for key, name in (("eph", "eph_log_ratio"), ("epv", "epv_log_ratio")):
        if key in g:
            base = max(_nanmed(g[key][ref]), 0.3)
            peak = np.nanmax(g[key][w]) if np.isfinite(g[key][w]).any() else math.nan
            f[name] = float(math.log(max(peak, 0.05) / base)) if math.isfinite(base) and math.isfinite(peak) else math.nan
    if "eph" in g:
        f["eph_mean"] = float(np.nanmean(np.clip(g["eph"][w], 0, 100)))
    if "hdop" in g:
        f["hdop_max"] = float(np.nanmax(np.clip(g["hdop"][w], 0, 50)))
    for key, name in (("noise", "noise_rel"), ("jam", "jam_rel")):
        if key in g:
            base = _nanmed(g[key][ref])
            cur = float(np.nanmean(g[key][w][-max(3, int(w.sum() / 3)):]))
            f[name] = (cur / base - 1.0) if math.isfinite(base) and base > 1 else math.nan
    good = w & (g["fix"] >= 2) & np.isfinite(g["lat"])
    if good.sum() >= 3:
        lat, lon, tt = g["lat"][good], g["lon"][good], g["t"][good]
        n, e = _enu(lat, lon, float(lat[0]), float(lon[0]))
        dt = np.diff(tt)
        dt[dt <= 0] = np.nan
        vn_pos, ve_pos = np.diff(n) / dt, np.diff(e) / dt
        if "vn" in g and "ve" in g:
            vn = 0.5 * (g["vn"][good][1:] + g["vn"][good][:-1])
            ve = 0.5 * (g["ve"][good][1:] + g["ve"][good][:-1])
            mismatch = np.hypot(vn_pos - vn, ve_pos - ve)
            f["posvel_mismatch_m_s"] = float(np.nanmean(np.clip(mismatch, 0, 200)))
            jump = np.hypot(np.diff(n) - vn * dt, np.diff(e) - ve * dt)
            f["pos_jump_resid_m"] = float(np.nanmax(np.clip(jump, 0, 5000)))
    gaps = np.diff(np.concatenate([[t0], t, [t1]]))
    f["gap_max_s"] = float(np.max(gaps))
    ref_rate = ref.sum() / max(1e-3, (g["t"][ref][-1] - g["t"][ref][0])) if ref.sum() > 2 else math.nan
    f["rate_ratio"] = float(min(2.0, (w.sum() / WINDOW_S) / ref_rate)) if math.isfinite(ref_rate) and ref_rate > 0 else math.nan
    return f


def _inertial_features(s: Mapping[str, Stream], t0: float, t1: float) -> dict[str, float] | None:
    g, imu, att = s.get("gnss"), s.get("imu"), s.get("att")
    if g is None or imu is None or att is None or "vn" not in g:
        return None
    if _sel(imu, t0, t1).sum() < 20 or _sel(g, t0, t1).sum() < 3:
        return None
    fine = np.arange(t0, t1, 0.04)  # 25 Hz
    q = [_interp(att, f"q{i}", fine) for i in range(4)]
    a = [_interp(imu, k, fine) for k in "xyz"]
    an, ae, ad = _rot(*q, *a)
    ad = ad + GRAVITY
    block = 100  # 4 s blocks
    nb = len(fine) // block
    if nb < 3:
        return None
    dv_imu = np.stack([np.nansum(arr[: nb * block].reshape(nb, block), axis=1) * 0.04 for arr in (an, ae, ad)], axis=1)
    edges = t0 + np.arange(nb + 1) * block * 0.04
    best = None
    for lag in (0.0, 0.1, 0.2, 0.3, 0.4, 0.6):  # receiver velocity latency differs by GNSS module
        v = np.stack([_interp(g, k, edges + lag) for k in ("vn", "ve", "vd")], axis=1)
        res = np.diff(v, axis=0) - dv_imu
        h = np.hypot(res[:, 0], res[:, 1])
        if np.isfinite(h).any() and (best is None or np.nanmean(h) < best[0]):
            best = (float(np.nanmean(h)), res, h)
    if best is None:
        return None
    _, res, h = best
    dyn = float(np.nanmean(np.hypot(dv_imu[:, 0], dv_imu[:, 1])))
    drift = np.nansum(res[:, :2], axis=0)
    return {
        "dv_resid_h_mean": float(np.nanmean(np.clip(h, 0, 100))),
        "dv_resid_h_max": float(np.nanmax(np.clip(h, 0, 100))),
        "dv_resid_v_mean": float(np.nanmean(np.clip(np.abs(res[:, 2]), 0, 100))),
        "dv_bias_drift_m_s": float(min(200.0, math.hypot(*drift))),
        "dv_resid_rel": float(min(20.0, np.nanmean(h) / (0.3 + dyn))),
    }


def _baro_features(s: Mapping[str, Stream], t0: float, t1: float, r0: float) -> dict[str, float] | None:
    g, b = s.get("gnss"), s.get("baro")
    if g is None or b is None or "alt" not in g or _sel(b, t0, t1).sum() < 5:
        return None
    grid = np.arange(r0, t1, 0.5)
    off = _interp(g, "alt", grid) - _interp(b, "alt", grid)
    good_fix = _interp(g, "fix", grid) >= 2.5
    off[~good_fix] = np.nan
    inwin = grid > t0
    base = _nanmed(off[~inwin]) if np.isfinite(off[~inwin]).sum() > 5 else _nanmed(off[inwin][: int(WINDOW_S / 1.5)])
    cur = off[inwin]
    if not np.isfinite(cur).any() or not math.isfinite(base):
        return {"gnss_baro_offset_max_m": math.nan, "gnss_baro_offset_std_m": math.nan, "gnss_baro_rate_diff_m_s": math.nan}
    tt = grid[inwin][np.isfinite(cur)]
    slope = float(np.polyfit(tt - tt[0], cur[np.isfinite(cur)], 1)[0]) if tt.size > 4 else math.nan
    return {
        "gnss_baro_offset_max_m": float(min(500.0, np.nanmax(np.abs(cur - base)))),
        "gnss_baro_offset_std_m": float(min(200.0, np.nanstd(cur))),
        "gnss_baro_rate_diff_m_s": float(np.clip(slope, -50, 50)) if math.isfinite(slope) else math.nan,
    }


def _mag_features(s: Mapping[str, Stream], t0: float, t1: float, r0: float) -> dict[str, float] | None:
    m, att = s.get("mag"), s.get("att")
    if m is None or att is None or _sel(m, t0, t1).sum() < 5:
        return None
    grid = np.arange(r0, t1, 0.5)
    q = [_interp(att, f"q{i}", grid) for i in range(4)]
    mx, my, mz = (_interp(m, k, grid) for k in "xyz")
    mn, me, md = _rot(*q, mx, my, mz)
    heading = np.degrees(np.arctan2(me, mn))
    norm = np.sqrt(mx * mx + my * my + mz * mz)
    inwin = grid > t0
    ref = ~inwin if np.isfinite(heading[~inwin]).sum() > 5 else inwin
    base_h = math.degrees(math.atan2(np.nanmedian(np.sin(np.radians(heading[ref]))), np.nanmedian(np.cos(np.radians(heading[ref])))))
    dev = np.abs((heading[inwin] - base_h + 180.0) % 360.0 - 180.0)
    base_n = _nanmed(norm[ref])
    return {
        "mag_heading_dev_deg": float(np.nanpercentile(dev, 90)) if np.isfinite(dev).any() else math.nan,
        "mag_norm_ratio": float(np.nanmean(norm[inwin]) / base_n) if math.isfinite(base_n) and base_n > 0 else math.nan,
    }


def _estimator_features(s: Mapping[str, Stream], t0: float, t1: float) -> dict[str, float] | None:
    e = s.get("est")
    if e is None or _sel(e, t0, t1).sum() < 3:
        return None
    w = _sel(e, t0, t1)
    out = {name: math.nan for name in FEATURES["estimator"]}
    for key, names in (("pos_tr", ("pos_tr_max", "pos_tr_mean")), ("vel_tr", ("vel_tr_max",)), ("hgt_tr", ("hgt_tr_max",))):
        if key in e:
            x = np.clip(e[key][w], 0, 50)
            out[names[0]] = float(np.nanmax(x))
            if len(names) > 1:
                out[names[1]] = float(np.nanmean(x))
    if "gps_fail" in e:
        out["gps_fail_frac"] = float(np.mean(np.nan_to_num(e["gps_fail"][w]) != 0))
    g, p = s.get("gnss"), s.get("gpos")
    if g is not None and p is not None and _sel(g, t0, t1).sum() >= 3:
        grid = np.arange(t0, t1, 1.0)
        glat, glon = _interp(g, "lat", grid), _interp(g, "lon", grid)
        plat, plon = _interp(p, "lat", grid), _interp(p, "lon", grid)
        ok = np.isfinite(glat) & np.isfinite(plat)
        if ok.any():
            n, e2 = _enu(glat[ok], glon[ok], float(plat[ok][0]), float(plon[ok][0]))
            pn, pe = _enu(plat[ok], plon[ok], float(plat[ok][0]), float(plon[ok][0]))
            out["ekf_gnss_gap_m"] = float(min(5000.0, np.max(np.hypot(n - pn, e2 - pe))))
    return out


def _speed(s: Mapping[str, Stream], t0: float, t1: float) -> float:
    g = s.get("gnss")
    if g is not None and "vn" in g and _sel(g, t0, t1).sum():
        w = _sel(g, t0, t1)
        return float(np.nanmean(np.hypot(g["vn"][w], g["ve"][w])))
    lp = s.get("lpos")
    if lp is not None and _sel(lp, t0, t1).sum():
        w = _sel(lp, t0, t1)
        return float(np.nanmean(np.hypot(lp["vx"][w], lp["vy"][w])))
    return math.nan


def window_features(streams: Mapping[str, Stream], t_end: float, airframe_family: str | None) -> tuple[np.ndarray, np.ndarray]:
    """Return ``(features[FEATURE_COUNT], modality_mask[len(MODALITIES)])`` for one window."""
    if airframe_family not in AIRFRAME_FAMILIES:
        raise ValueError("airframe family must be explicitly known")
    t0, r0 = t_end - WINDOW_S, t_end - WINDOW_S - REFERENCE_S
    blocks: dict[str, dict[str, float] | None] = {
        "gnss": _gnss_features(streams["gnss"], t0, t_end, r0) if "gnss" in streams else None,
        "inertial": _inertial_features(streams, t0, t_end),
        "baro": _baro_features(streams, t0, t_end, r0),
        "mag": _mag_features(streams, t0, t_end, r0),
        "estimator": _estimator_features(streams, t0, t_end),
    }
    vec = np.full(FEATURE_COUNT, np.nan, dtype=np.float64)
    mask = np.zeros(len(MODALITIES), dtype=np.float32)
    for index, name in enumerate(MODALITIES):
        block = blocks[name]
        if block is None:
            continue
        values = np.array([block.get(key, math.nan) for key in FEATURES[name]], dtype=np.float64)
        if np.isfinite(values).mean() >= 0.5:
            vec[MODALITY_SLICES[name]] = values
            mask[index] = 1.0
    speed = _speed(streams, t0, t_end)
    vec[CONTEXT_SLICE] = [math.log1p(speed) if math.isfinite(speed) else math.nan,
                          float(airframe_family == "multicopter"), float(airframe_family == "fixed_wing"),
                          float(airframe_family == "vtol")]
    return vec, mask


def _latest_age(stream: Stream | None, timestamp: float) -> float:
    if stream is None or "t" not in stream:
        return math.inf
    times = np.asarray(stream["t"], dtype=np.float64)
    valid = times[np.isfinite(times) & (times <= timestamp)]
    return max(0.0, timestamp - float(valid.max())) if valid.size else math.inf


def modality_freshness(streams: Mapping[str, Stream], t_end: float) -> dict[str, dict[str, object]]:
    """Expose per-modality source ages and fail closed on stale dependencies."""
    dependencies = {
        "gnss": ("gnss",),
        "inertial": ("gnss", "imu", "att"),
        "baro": ("gnss", "baro"),
        "mag": ("mag", "att"),
        "estimator": ("est",),
    }
    report: dict[str, dict[str, object]] = {}
    for modality, names in dependencies.items():
        ages = {name: _latest_age(streams.get(name), t_end) for name in names}
        if any(not math.isfinite(age) for age in ages.values()):
            status = "missing"
        elif any(age > FRESHNESS_LIMIT_S for age in ages.values()):
            status = "stale"
        else:
            status = "fresh"
        report[modality] = {
            "status": status,
            "sample_age_seconds": {name: round(age, 3) if math.isfinite(age) else None for name, age in ages.items()},
            "freshness_limit_seconds": FRESHNESS_LIMIT_S,
        }
    return report


def flight_state_freshness(streams: Mapping[str, Stream], t_end: float) -> dict[str, object]:
    """Report which explicit land/armed stream supports a window's flight-state gate."""
    for name, field in (("land", "landed"), ("status", "armed")):
        source = streams.get(name)
        if source is not None and field in source and len(source.get("t", [])):
            age = _latest_age(source, t_end)
            status = "fresh" if age <= FRESHNESS_LIMIT_S else "stale"
            return {"source": name, "field": field, "status": status,
                    "sample_age_seconds": round(age, 3) if math.isfinite(age) else None,
                    "freshness_limit_seconds": FRESHNESS_LIMIT_S}
    return {"source": None, "field": None, "status": "missing", "sample_age_seconds": None,
            "freshness_limit_seconds": FRESHNESS_LIMIT_S}


def in_air_fraction(streams: Mapping[str, Stream], t0: float, t1: float) -> float:
    land = streams.get("land")
    source, field, predicate = (land, "landed", lambda values: values < 0.5)
    if source is None or not len(source.get("t", [])):
        source = streams.get("status")
        field, predicate = "armed", lambda values: values > 0.5
    if source is None or field not in source or not len(source.get("t", [])):
        return 0.0
    grid = np.arange(t0, t1, 1.0)
    if not grid.size:
        return 0.0
    times = np.asarray(source["t"], dtype=np.float64)
    idx = np.searchsorted(times, grid, side="right") - 1
    if np.any(idx < 0):
        return 0.0
    ages = grid - times[idx]
    if np.any(~np.isfinite(ages)) or np.any(ages < 0) or np.any(ages > FRESHNESS_LIMIT_S):
        return 0.0
    values = np.asarray(source[field], dtype=np.float64)[idx]
    if not np.isfinite(values).all():
        return 0.0
    return float(np.mean(predicate(values)))


def flight_span(streams: Mapping[str, Stream]) -> tuple[float, float]:
    starts, ends = [], []
    for key in ("gnss", "gpos", "att"):
        if key in streams and len(streams[key]["t"]):
            starts.append(streams[key]["t"][0]); ends.append(streams[key]["t"][-1])
    return (max(starts), min(ends)) if starts else (0.0, 0.0)


def iter_window_ends(streams: Mapping[str, Stream], *, min_in_air: float = 0.8):
    start, end = flight_span(streams)
    t = start + WINDOW_S
    while t <= end + 1e-6:
        if in_air_fraction(streams, t - WINDOW_S, t) >= min_in_air:
            yield t
        t += STRIDE_S


__all__ = ["window_features", "iter_window_ends", "flight_span", "in_air_fraction", "modality_freshness",
           "flight_state_freshness", "FEATURE_NAMES", "FEATURE_COUNT", "MODALITIES", "MODALITY_SLICES",
           "CONTEXT_SLICE", "WINDOW_S", "STRIDE_S", "AIRFRAME_FAMILIES", "FRESHNESS_LIMIT_S"]
