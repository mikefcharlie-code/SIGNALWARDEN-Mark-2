"""Exercise local model wiring without ML packages, checkpoints, or network."""
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
import sys

import pytest
from scripts import local_ai_run as run
from scripts import local_ai_setup as setup


class Vector:
    def __init__(self, values=(0.6, 0.3, 0.1)): self.values = values
    def softmax(self, *args): return self
    def __getitem__(self, index): return self.values[index]
    def topk(self, count): return self.values[:count], list(range(count))


class Logits:
    shape = (1, 3)
    def softmax(self, *args): return self
    def __getitem__(self, index): return Vector()


class Tokens:
    shape = (1, 2)
    def to(self, device): return self


class Image:
    def convert(self, mode): return self
    def save(self, output, **kwargs): Path(output).write_bytes(b"synthetic-fixture")


@pytest.fixture
def runtime(monkeypatch, tmp_path):
    calls = []
    registry = setup.load_registry()
    model_path = tmp_path / "models"; (model_path / "vae").mkdir(parents=True)
    monkeypatch.setattr(run, "_verified", lambda group, registry=None: (model_path, setup.load_registry()["models"][group]))
    monkeypatch.setattr(run, "_synthetic_image", lambda i=0: Image())
    monkeypatch.setattr(run, "_torch", lambda device: (SimpleNamespace(inference_mode=nullcontext, float32="fp32"), "fp32" if device == "cpu" else "bf16"))
    monkeypatch.setattr(run, "_SERVE_LLM_KEY", None)
    monkeypatch.setattr(run, "_LLM_CACHE", {})

    def factory(name):
        class Component:
            @classmethod
            def from_pretrained(cls, path, **kwargs):
                calls.append((name, "load", path, kwargs)); return cls()
            def to(self, device): return self
            def eval(self): return self
            config = SimpleNamespace(id2label={0: "class-a", 1: "class-b", 2: "class-c"})
            vae = SimpleNamespace(enable_tiling=lambda: calls.append(("vae", "tiling")))
            def enable_model_cpu_offload(self): calls.append((name, "offload"))
            def apply_chat_template(self, messages, **kwargs):
                calls.append((name, "template", messages, kwargs)); return "formatted benign prompt"
            def decode(self, tokens, **kwargs): return "hello"
            def generate(self, **kwargs):
                calls.append((name, "generate", kwargs)); return [[99, 99, 7]]
            def __call__(self, *args, **kwargs):
                calls.append((name, "call", args, kwargs))
                if name == "AutoTokenizer": return {"input_ids": Tokens()}
                if name.endswith("Processor"): return {"pixel_values": Tokens(), "input_ids": Tokens()}
                return SimpleNamespace(images=[Image()], frames=[[Image(), Image()]], logits=Logits(), logits_per_video=Logits())
        return Component

    transformer_names = ("AutoTokenizer", "AutoModelForCausalLM", "AutoImageProcessor", "AutoModelForImageClassification", "XCLIPProcessor", "XCLIPModel")
    diffusers_names = ("DiffusionPipeline", "StableDiffusionPipeline", "StableDiffusionXLPipeline", "AutoencoderKLWan", "WanPipeline")
    monkeypatch.setitem(sys.modules, "transformers", SimpleNamespace(**{n: factory(n) for n in transformer_names}))
    monkeypatch.setitem(sys.modules, "diffusers", SimpleNamespace(**{n: factory(n) for n in diffusers_names}))
    return calls, tmp_path


@pytest.mark.parametrize("group,device", [
    ("llm", "cpu"), ("image-generation", "cpu"), ("video-generation", "cuda"),
    ("image-classification", "cpu"), ("video-classification", "cpu"),
])
def test_all_five_models_load_local_safe_weights_and_emit_only_advisory_outputs(runtime, group, device):
    calls, tmp = runtime
    result = run.smoke(group, device, str(tmp / "output"))
    assert result["advisory"] is True
    loads = [call for call in calls if call[1] == "load"]
    assert loads
    for name, _, path, kwargs in loads:
        assert not path.startswith(("http:", "https:"))
        assert kwargs["local_files_only"] is True
        assert kwargs["trust_remote_code"] is False
        if name not in {"AutoTokenizer", "AutoImageProcessor", "XCLIPProcessor"}:
            assert kwargs["use_safetensors"] is True
    assert not {"command", "target", "effector", "vehicleControl"} & result.keys()


def test_qwen_uses_non_thinking_chat_template_and_caches_loaded_weights(runtime):
    calls, _ = runtime
    assert run._llm("hello", "cpu", max_tokens=32) == "hello"
    assert run._llm("hello again", "cpu", max_tokens=16) == "hello"
    templates = [c for c in calls if c[1] == "template"]
    assert all(c[3]["enable_thinking"] is False for c in templates)
    assert len([c for c in calls if c[:2] == ("AutoModelForCausalLM", "load")]) == 1
    generations = [c[2] for c in calls if c[1] == "generate"]
    assert [g["max_new_tokens"] for g in generations] == [32, 16]
    assert all(g["max_time"] == 55 for g in generations)


def test_ssd_fp16_snapshot_variant_is_selected_even_with_cpu_conversion(runtime):
    calls, tmp = runtime
    run.smoke("image-generation", "cpu", str(tmp / "image.png"))
    load = next(c for c in calls if c[:2] == ("StableDiffusionXLPipeline", "load"))
    assert load[3]["variant"] == "fp16"
    assert load[3]["torch_dtype"] == "fp32"


def test_wan_offloads_to_cpu_and_requests_pil_frames_without_encoder_download(runtime):
    calls, tmp = runtime
    run.smoke("video-generation", "cuda", str(tmp / "video.gif"))
    assert ("WanPipeline", "offload") in calls
    inference = next(c for c in calls if c[:2] == ("WanPipeline", "call"))
    assert inference[3]["num_frames"] == 9
    assert inference[3]["output_type"] == "pil"
    vae = next(c for c in calls if c[:2] == ("AutoencoderKLWan", "load"))
    assert vae[3]["torch_dtype"] == "fp32"


def test_video_classifier_uses_eight_synthetic_frames_and_candidate_scores(runtime):
    calls, _ = runtime
    result = run.smoke("video-classification")
    inference = next(c for c in calls if c[:2] == ("XCLIPProcessor", "call"))
    assert len(inference[3]["videos"]) == 8
    assert len(inference[3]["text"]) == 3
    assert "not calibrated confidence" in result["score_semantics"]
    assert result["synthetic"] is True


def test_cpu_video_generation_fails_before_loading_any_model(runtime):
    calls, tmp = runtime
    with pytest.raises(RuntimeError, match="requires CUDA"):
        run.smoke("video-generation", "cpu", str(tmp / "video.gif"))
    assert not calls
