import json
from pathlib import Path

import numpy as np
import pytest

from scripts.warden_nav_mm_review import build_report
from services.warden_nav.multimodal.features import (
    FEATURE_COUNT,
    FEATURE_NAMES,
    MODALITIES,
    flight_state_freshness,
    in_air_fraction,
    iter_window_ends,
    modality_freshness,
    window_features,
)
from services.warden_nav.multimodal.model import CLASSES, MODEL_ID, interpret_logits
from services.warden_nav.multimodal.streams import MAX_ULOG_BYTES, load_raw


def _flight(seconds=240.0):
    rng = np.random.default_rng(0)
    t_g = np.arange(0, seconds, 0.2)
    t_f = np.arange(0, seconds, 0.02)
    gnss = {
        "t": t_g,
        "lat": 45.0 + rng.normal(0, 2e-7, t_g.size),
        "lon": -75.0 + rng.normal(0, 2e-7, t_g.size),
        "alt": 100 + rng.normal(0, 0.2, t_g.size),
        "fix": np.full(t_g.size, 3.0),
        "sats": np.full(t_g.size, 14.0),
        "eph": np.full(t_g.size, 0.8),
        "epv": np.full(t_g.size, 1.2),
        "hdop": np.full(t_g.size, 0.7),
        "noise": np.full(t_g.size, 90.0),
        "jam": np.full(t_g.size, 30.0),
        "vn": rng.normal(0, 0.05, t_g.size),
        "ve": rng.normal(0, 0.05, t_g.size),
        "vd": rng.normal(0, 0.05, t_g.size),
    }
    att = {"t": t_f, "q0": np.ones_like(t_f), "q1": np.zeros_like(t_f),
           "q2": np.zeros_like(t_f), "q3": np.zeros_like(t_f)}
    imu = {"t": t_f, "x": rng.normal(0, 0.05, t_f.size),
           "y": rng.normal(0, 0.05, t_f.size), "z": -9.80665 + rng.normal(0, 0.05, t_f.size)}
    return {
        "gnss": gnss,
        "att": att,
        "imu": imu,
        "baro": {"t": t_g, "alt": 50 + rng.normal(0, 0.2, t_g.size)},
        "mag": {"t": t_g, "x": np.full(t_g.size, 0.2), "y": np.zeros_like(t_g), "z": np.full(t_g.size, 0.4)},
        "est": {"t": t_g, "pos_tr": np.full(t_g.size, 0.02), "vel_tr": np.full(t_g.size, 0.2),
                "hgt_tr": np.full(t_g.size, 0.02), "gps_fail": np.zeros(t_g.size)},
        "land": {"t": t_g, "landed": np.zeros(t_g.size)},
    }


def _calibration(ood_limit=3.0):
    support = {name: list(CLASSES) for name in MODALITIES}
    support["estimator"] = ["nominal", "spoofing_like_pattern"]
    return {
        "model_id": MODEL_ID,
        "classes": list(CLASSES),
        "feature_names": list(FEATURE_NAMES),
        "modalities": list(MODALITIES),
        "class_gates": {name: 0.1 for name in CLASSES[1:]},
        "ood_limit": ood_limit,
        "normalization": {"mean": [0.0] * FEATURE_COUNT, "scale": [1.0] * FEATURE_COUNT},
        "expert_class_support": support,
    }


def test_windows_require_fresh_explicit_flight_state_and_known_airframe():
    streams = _flight()
    ends = list(iter_window_ends(streams))
    assert ends and ends[0] == 30.0
    vector, mask = window_features(streams, ends[-1], "multicopter")
    assert vector.shape == (FEATURE_COUNT,) and mask.shape == (len(MODALITIES),)
    assert mask.tolist() == [1.0] * len(MODALITIES)
    assert flight_state_freshness(streams, ends[-1])["status"] == "fresh"
    assert in_air_fraction(streams, ends[-1] - 30, ends[-1]) == 1.0
    with pytest.raises(ValueError, match="explicitly known"):
        window_features(streams, ends[-1], None)


def test_missing_or_stale_flight_state_does_not_mean_in_air():
    streams = _flight()
    del streams["land"]
    assert in_air_fraction(streams, 100.0, 130.0) == 0.0
    assert flight_state_freshness(streams, 130.0)["status"] == "missing"
    streams["status"] = {"t": np.arange(0.0, 100.0, 1.0), "armed": np.ones(100)}
    assert in_air_fraction(streams, 120.0, 150.0) == 0.0


def test_stale_modalities_are_visible_and_can_be_masked():
    streams = _flight()
    streams["gnss"]["t"] = streams["gnss"]["t"][streams["gnss"]["t"] <= 190.0]
    fresh = modality_freshness(streams, 200.0)
    assert fresh["gnss"]["status"] == "stale"
    assert fresh["inertial"]["status"] == "stale"
    assert fresh["baro"]["status"] == "stale"
    assert fresh["mag"]["status"] == "fresh"
    assert fresh["estimator"]["status"] == "fresh"


def test_ood_gate_precedes_class_label_and_invalid_masks_abstain():
    calibration = _calibration(ood_limit=3.0)
    x = np.zeros(FEATURE_COUNT, dtype=np.float32)
    mask = np.ones(len(MODALITIES), dtype=np.float32)
    logits = np.array([0.0, 10.0, 0.0, 0.0], dtype=np.float32)
    result = interpret_logits(x, mask, logits, calibration)
    assert result["status"] == "pattern"
    assert result["pattern"] == "jamming_like_pattern"
    assert "class_probabilities" not in result
    x[0] = 20.0
    ood_result = interpret_logits(x, mask, logits, calibration)
    assert ood_result["status"] == "model_unsure"
    assert ood_result["reason"] == "out_of_distribution"
    bad_mask = mask.copy()
    bad_mask[0] = 0.5
    assert interpret_logits(np.zeros(FEATURE_COUNT), bad_mask, logits, calibration)["status"] == "model_unsure"


def test_expert_class_support_is_enforced_and_report_contains_no_coordinates():
    calibration = _calibration()
    only_estimator = np.zeros(len(MODALITIES), dtype=np.float32)
    only_estimator[-1] = 1.0
    logits = np.array([0.0, 0.0, 0.0, 10.0], dtype=np.float32)
    result = interpret_logits(np.zeros(FEATURE_COUNT), only_estimator, logits, calibration)
    assert result["status"] == "model_unsure"
    assert result["reason"] == "unsupported_class_for_present_experts"

    report = build_report([result], airframe_family="multicopter", model_sha256="a" * 64,
                          calibration_sha256="b" * 64, input_attested=True, model_loaded=True,
                          ood_limit=1248.278564453125)
    payload = json.dumps(report).lower()
    for coordinate_key in ("\"latitude\"", "\"longitude\"", "\"lat\"", "\"lon\""):
        assert coordinate_key not in payload
    assert report["safety_boundary"]["raw_coordinates_emitted"] is False
    assert report["input_trust"] == "operator-attested; not independently verified"
    assert report["baseline_fusion"] == "not_run"


def test_review_cli_source_has_no_aircraft_or_control_adapter_imports():
    root = Path(__file__).resolve().parents[1]
    source = (root / "scripts" / "warden_nav_mm_review.py").read_text().lower()
    assert "services.aircraft_gateway" not in source
    assert "services.management_api" not in source
    assert "mavlink" not in source
    assert "command_long" not in source
    assert "setpoint" not in source
    assert "upload_mission" not in source


def test_log_parser_accepts_only_bounded_regular_ulg_files(tmp_path):
    csv_path = tmp_path / "flight.csv"
    csv_path.write_text("data\n", encoding="utf-8")
    with pytest.raises(ValueError, match="regular local .ulg"):
        load_raw(csv_path)

    too_large = tmp_path / "too-large.ulg"
    with too_large.open("wb") as handle:
        handle.truncate(MAX_ULOG_BYTES + 1)
    with pytest.raises(ValueError, match="ULog must be between"):
        load_raw(too_large)

    with pytest.raises(ValueError, match="regular local .ulg"):
        load_raw(tmp_path)
