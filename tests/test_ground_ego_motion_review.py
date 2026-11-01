import hashlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from scripts.ground_ego_motion_review import FEATURE_COLUMNS, HISTORY_STEPS, load_history_csv, review
from services.ground_ego_motion.model import FORECAST_STEPS, GroundEgoMotionModel


class FakeSessionOptions:
    def __init__(self):
        self.entries = {}

    def add_session_config_entry(self, key, value):
        self.entries[key] = value


class FakeSession:
    def __init__(self, *, provider_order=("CUDAExecutionProvider", "CPUExecutionProvider"), bad_shape=False):
        self.provider_order = list(provider_order)
        self.bad_shape = bad_shape
        self.fallback_disabled = False
        self.inputs = [SimpleNamespace(name="history", shape=["batch", 20, 9])]
        trajectory_shape = ["batch", 30, 3] if not bad_shape else ["batch", 29, 3]
        self.outputs = [SimpleNamespace(name="trajectory", shape=trajectory_shape),
                        SimpleNamespace(name="sigma", shape=["batch", 30, 2])]
        self.call = None

    def disable_fallback(self):
        self.fallback_disabled = True

    def get_providers(self):
        return self.provider_order

    def get_inputs(self):
        return self.inputs

    def get_outputs(self):
        return self.outputs

    def run(self, names, inputs):
        self.call = (names, inputs)
        return [np.zeros((1, 30, 3), dtype=np.float32), np.full((1, 30, 2), 0.25, dtype=np.float32)]


def _install_fake_ort(monkeypatch, *, providers=("CUDAExecutionProvider", "CPUExecutionProvider"),
                      session_providers=("CUDAExecutionProvider", "CPUExecutionProvider"), bad_shape=False):
    created = {}

    class FakeOrt:
        SessionOptions = FakeSessionOptions

        @staticmethod
        def get_available_providers():
            return list(providers)

        @staticmethod
        def InferenceSession(blob, *, sess_options, providers):
            assert blob == b"fixture-onnx"
            assert sess_options.entries == {"session.disable_cpu_ep_fallback": "1"}
            assert providers == ["CUDAExecutionProvider"]
            created["session"] = FakeSession(provider_order=session_providers, bad_shape=bad_shape)
            return created["session"]

    monkeypatch.setitem(sys.modules, "onnxruntime", FakeOrt)
    return created


def _artifact(tmp_path):
    root = tmp_path / "models"
    root.mkdir()
    payload = b"fixture-onnx"
    (root / "ground-nav-egomotion.onnx").write_bytes(payload)
    return root, hashlib.sha256(payload).hexdigest(), len(payload)


def _valid_csv(path: Path, *, step=0.1):
    headers = ["timestamp_s", *FEATURE_COLUMNS]
    lines = [",".join(headers)]
    for i in range(HISTORY_STEPS):
        t = i * step
        features = [0.2, 0.0, 0.01, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
        lines.append(",".join([str(t), *(str(x) for x in features)]))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def test_ground_model_requires_cuda_and_disables_cpu_fallback(monkeypatch, tmp_path):
    root, sha, size = _artifact(tmp_path)
    created = _install_fake_ort(monkeypatch)
    model = GroundEgoMotionModel(root, expected_sha256=sha, expected_size_bytes=size)
    result = model.predict(np.zeros((20, 9), dtype=np.float32))
    assert result["status"] == "prediction_unvalidated"
    assert result["execution_provider"] == "CUDAExecutionProvider"
    assert result["cpu_ep_fallback_disabled"] is True
    assert len(result["forecast"]) == FORECAST_STEPS
    assert result["forecast"][0]["future_time_s"] == 0.1
    assert result["forecast"][-1]["future_time_s"] == 3.0
    assert created["session"].fallback_disabled is True
    names, inputs = created["session"].call
    assert names == ["trajectory", "sigma"]
    assert inputs["history"].shape == (1, 20, 9)
    assert result["safety_boundary"]["uav_or_aircraft_profile"] is False


def test_ground_model_abstains_if_cuda_is_unavailable_or_provider_falls_back(monkeypatch, tmp_path):
    root, sha, size = _artifact(tmp_path)
    _install_fake_ort(monkeypatch, providers=("CPUExecutionProvider",))
    with pytest.raises(RuntimeError, match="CPU inference is forbidden"):
        GroundEgoMotionModel(root, expected_sha256=sha, expected_size_bytes=size)

    _install_fake_ort(monkeypatch, session_providers=("CPUExecutionProvider",))
    with pytest.raises(RuntimeError, match="CPU fallback is forbidden"):
        GroundEgoMotionModel(root, expected_sha256=sha, expected_size_bytes=size)


def test_ground_model_hash_and_output_contract_fail_closed(monkeypatch, tmp_path):
    root, sha, size = _artifact(tmp_path)
    _install_fake_ort(monkeypatch)
    with pytest.raises(ValueError, match="SHA-256"):
        GroundEgoMotionModel(root, expected_sha256="0" * 64, expected_size_bytes=size)
    with pytest.raises(ValueError, match="shapes"):
        _install_fake_ort(monkeypatch, bad_shape=True)
        GroundEgoMotionModel(root, expected_sha256=sha, expected_size_bytes=size)

    created = _install_fake_ort(monkeypatch)
    model = GroundEgoMotionModel(root, expected_sha256=sha, expected_size_bytes=size)
    assert model.predict(np.full((20, 9), np.nan, dtype=np.float32))["status"] == "model_unsure"
    created["session"].run = lambda *args, **kwargs: [np.zeros((1, 30, 3)), np.zeros((1, 30, 2))]
    assert model.predict(np.zeros((20, 9), dtype=np.float32))["reason"] == "invalid_model_output"


def test_ground_feature_csv_requires_exact_schema_rows_and_10hz(tmp_path):
    path = _valid_csv(tmp_path / "valid.csv")
    history, metadata = load_history_csv(path)
    assert len(history) == 20 and all(len(row) == 9 for row in history)
    assert metadata["sample_rate_hz"] == 10 and metadata["sample_spacing_validated"] is True

    irregular = _valid_csv(tmp_path / "irregular.csv", step=0.2)
    with pytest.raises(ValueError, match="10 Hz"):
        load_history_csv(irregular)
    wrong = tmp_path / "wrong.csv"
    wrong.write_text("timestamp_s,x,y\n0,1,2\n", encoding="utf-8")
    with pytest.raises(ValueError, match="header must be exactly"):
        load_history_csv(wrong)
    link = tmp_path / "link.csv"
    link.symlink_to(path)
    with pytest.raises(ValueError, match="not a symlink"):
        load_history_csv(link)


def test_ground_review_requires_both_attestations_and_rejects_non_ground_profile(tmp_path):
    path = _valid_csv(tmp_path / "valid.csv")
    with pytest.raises(ValueError, match="ground_vehicle profile only"):
        review(path, vehicle_profile="multicopter", input_attested=True, license_scope_attested=True)
    with pytest.raises(ValueError, match="attest-ground-input-provenance"):
        review(path, vehicle_profile="ground_vehicle", input_attested=False, license_scope_attested=True)
    with pytest.raises(ValueError, match="nvidia-av-adas-license"):
        review(path, vehicle_profile="ground_vehicle", input_attested=True, license_scope_attested=False)


def test_cpu_baseline_fallback_is_explicit_and_never_runs_the_model_on_cpu(monkeypatch, tmp_path):
    import scripts.ground_ego_motion_review as cli

    path = _valid_csv(tmp_path / "valid.csv")
    monkeypatch.setattr(cli, "_disable_network", lambda: None)
    monkeypatch.setattr(cli, "_load_model", lambda: (_ for _ in ()).throw(RuntimeError("CUDA unavailable")))
    with pytest.raises(RuntimeError, match="CUDA unavailable"):
        cli.review(path, vehicle_profile="ground_vehicle", input_attested=True,
                   license_scope_attested=True, allow_cpu_baseline_fallback=False)

    report = cli.review(path, vehicle_profile="ground_vehicle", input_attested=True,
                        license_scope_attested=True, allow_cpu_baseline_fallback=True)
    prediction = report["prediction"]
    assert report["execution_mode"] == "cpu_baseline_fallback"
    assert report["runtime"]["cpu_baseline_used"] is True
    assert report["candidate_model"]["weights_loaded"] is False
    assert report["candidate_model"]["inference_performed"] is False
    assert report["candidate_model"]["model_ran_on_cpu"] is False
    assert prediction["status"] == "baseline_fallback"
    assert prediction["learned_model_contributed_to_this_forecast"] is False
    assert prediction["model_ran_on_cpu"] is False
    assert prediction["forecast"][0]["sigma_x_m"] is None
    assert prediction["forecast"][0]["x_m"] > 0
    baseline_source = (Path(__file__).resolve().parents[1] / "services" / "ground_ego_motion" / "baseline.py").read_text()
    assert "onnxruntime" not in baseline_source.lower()
    assert "numpy" not in baseline_source.lower()


def test_model_abstention_fallback_records_gpu_attempt_without_using_model_output(monkeypatch, tmp_path):
    import scripts.ground_ego_motion_review as cli

    class AbstainingModel:
        def predict(self, _history):
            return {"status": "model_unsure", "reason": "invalid_model_output"}

    path = _valid_csv(tmp_path / "valid.csv")
    manifest = {"model_id": "test-model", "sha256": "a" * 64,
                "source": "test", "training_data": "test"}
    monkeypatch.setattr(cli, "_disable_network", lambda: None)
    monkeypatch.setattr(cli, "_load_model", lambda: (AbstainingModel(), manifest))
    report = cli.review(path, vehicle_profile="ground_vehicle", input_attested=True,
                        license_scope_attested=True, allow_cpu_baseline_fallback=True)
    assert report["execution_mode"] == "cpu_baseline_fallback"
    assert report["candidate_model"]["weights_loaded"] is True
    assert report["candidate_model"]["inference_performed"] is True
    assert report["candidate_model"]["model_ran_on_cpu"] is False
    assert report["runtime"]["model_provider"] == "CUDAExecutionProvider"
    assert report["runtime"]["cpu_baseline_used"] is True
    assert report["prediction"]["status"] == "baseline_fallback"
    assert report["prediction"]["learned_model_contributed_to_this_forecast"] is False
    assert report["prediction"]["fallback_reason"] == "gpu_model_abstained"


def test_ground_artifact_manifest_is_local_only_hash_pinned_and_not_bundled():
    root = Path(__file__).resolve().parents[1]
    manifest = json.loads((root / "configs" / "ground-ego-motion-artifact.json").read_text())
    from scripts import local_ai_setup as ai

    registry = ai.load_registry()
    item = registry["models"]["ground-ego-motion-nvidia"]
    assert item["distribution"] == "local-only"
    assert item["runtime"] == "onnxruntime-cuda-strict"
    assert item["source_url"].startswith("local://")
    assert len(item["files"]) == 1
    assert item["files"][0]["path"] == manifest["artifact_file"]
    assert item["files"][0]["size"] == manifest["size_bytes"]
    assert item["files"][0]["sha256"] == manifest["sha256"]
    assert manifest["automatic_download"] is False and manifest["weights_in_git"] is False
    assert not (root / manifest["artifact_file"]).exists()
    with pytest.raises(ValueError, match="local-only"):
        ai.download("ground-ego-motion-nvidia", accept_license=True, yes=True, registry=registry)
    with pytest.raises(ValueError, match="requires --device cuda"):
        ai.setup("ground-ego-motion-nvidia", device="cpu", yes=True, registry=registry)


def test_ground_review_cli_has_no_uav_or_live_control_adapters():
    root = Path(__file__).resolve().parents[1]
    source = (root / "scripts" / "ground_ego_motion_review.py").read_text().lower()
    assert "services.aircraft_gateway" not in source
    assert "services.management_api" not in source
    assert "mavlink" not in source
    assert "upload_mission" not in source
    assert 'choices=("ground_vehicle",)' in source
    assert "cudaexecutionprovider" in source
