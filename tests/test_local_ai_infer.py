import importlib
import json
from pathlib import Path

import pytest

infer_mod = importlib.import_module("scripts.local_ai_infer")
REAL_PREFLIGHT = infer_mod._resource_preflight


class FakeAdapter:
    def llm(self, prompt, device):
        return json.dumps({"answer": "A benign finding.", "claims": [{"quote": "green light", "record_id": "r1", "timestamp": "2025-01-01T00:00:00Z"}]})

    def image_generation(self, prompt, device):
        from PIL import Image
        return Image.new("RGB", (32, 24), "white")

    def video_generation(self, prompt, device):
        from PIL import Image
        return [Image.new("RGB", (16, 16), "white") for _ in range(9)]

    def image_classification(self, image, device):
        assert image.size == (32, 24)
        return [{"label": "nature", "score": 0.8}]

    def video_classification(self, frames, labels, device):
        assert len(frames) == 8
        return [{"label": labels[0], "score": 0.7}]


@pytest.fixture(autouse=True)
def no_model_load(monkeypatch):
    monkeypatch.setattr(infer_mod, "_resource_preflight", lambda *args: None)


def test_llm_is_grounded_and_cites_exact_source(tmp_path):
    result = infer_mod.infer({"group": "llm", "device": "cpu", "prompt": "summarize", "context": [{"record_id": "r1", "timestamp": "2025-01-01T00:00:00Z", "text": "green light"}]}, FakeAdapter())
    assert result["advisory"] is True and result["synthetic"] is False
    assert result["abstained"] is False and result["citations"] == [{"record_id": "r1", "timestamp": "2025-01-01T00:00:00Z"}]


def test_llm_empty_or_invalid_output_abstains(monkeypatch):
    class Bad(FakeAdapter):
        def llm(self, prompt, device):
            return json.dumps({"answer": "unsupported", "claims": [{"quote": "not present", "record_id": "r1", "timestamp": "t"}]})
    empty = infer_mod.infer({"group": "llm", "device": "cpu", "context": []}, Bad())
    bad = infer_mod.infer({"group": "llm", "device": "cpu", "context": [{"record_id": "r1", "timestamp": "t", "text": "source"}]}, Bad())
    assert empty["abstained"] and bad["abstained"] and bad["answer"] == ""


def test_generation_is_bounded_stamped_and_returns_relative_artifact(tmp_path):
    result = infer_mod.infer({"group": "image-generation", "device": "cpu", "prompt": "shape", "output_dir": str(tmp_path)}, FakeAdapter())
    assert result["synthetic"] and result["artifact"] == Path(result["artifact"]).name
    from PIL import Image
    with Image.open(tmp_path / result["artifact"]) as image:
        assert image.size == (32, 24)
        assert image.getpixel((0, 0)) == (0, 0, 0)


def test_classifiers_validate_real_media_and_use_bounded_frames(tmp_path):
    from PIL import Image
    image_path = tmp_path / "input.png"
    Image.new("RGB", (32, 24), "blue").save(image_path)
    image_result = infer_mod.infer({"group": "image-classification", "device": "cpu", "input": str(image_path)}, FakeAdapter())
    assert image_result["synthetic"] is False and image_result["topk"][0]["label"] == "nature"
    gif_path = tmp_path / "input.gif"
    Image.new("RGB", (20, 20), "blue").save(gif_path, save_all=True, append_images=[Image.new("RGB", (20, 20), "red")], duration=100)
    video_result = infer_mod.infer({"group": "video-classification", "device": "cpu", "input": str(gif_path)}, FakeAdapter())
    assert len(video_result["clips"][0]["topk"]) == 1
    assert video_result["clips"][0]["topk"][0]["label"] in infer_mod.BENIGN_LABELS


def test_limits_and_absolute_paths_are_fail_closed(tmp_path):
    from PIL import Image
    huge = tmp_path / "huge.png"
    Image.new("RGB", (4097, 1), "black").save(huge)
    with pytest.raises(ValueError, match="exceeds"):
        infer_mod.infer({"group": "image-classification", "device": "cpu", "input": str(huge)}, FakeAdapter())
    with pytest.raises(ValueError, match="absolute"):
        infer_mod.infer({"group": "image-generation", "device": "cpu", "output_dir": "relative"}, FakeAdapter())


def test_network_guard_denies_socket_creation_subprocess():
    import subprocess, sys
    code = """import socket, sys
from scripts.local_ai_infer import _deny_network
_deny_network()
import ssl
for fn in (lambda: socket.create_connection(('example.invalid',443)), lambda: socket.getaddrinfo('example.invalid',443), lambda: socket.socket().connect_ex(('example.invalid',443)), lambda: socket.socket(socket.AF_INET,socket.SOCK_DGRAM).sendto(b'x',('127.0.0.1',9))):
    try: fn()
    except RuntimeError as e:
        assert 'network access' in str(e)
    else: raise AssertionError('network call was not denied')
"""
    result = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("claims", [[], [{"quote": "fabricated", "record_id": "r1", "timestamp": "t"}], [{"quote": "source", "record_id": "wrong", "timestamp": "t"}], [{"quote": "source", "record_id": "r1", "timestamp": "wrong"}]])
def test_unsupported_llm_claims_never_publish_free_answer(claims):
    adapter = {"llm": lambda *_: {"answer": "an unsupported conclusion", "claims": claims}}
    result = infer_mod.infer({"group": "llm", "device": "cpu", "context": [{"record_id": "r1", "timestamp": "t", "text": "source"}]}, adapter)
    assert result["abstained"] and result["answer"] == ""
    assert result["model_ran"] is True


def test_qwen_answer_is_extractive_and_source_fixture_label_is_preserved():
    result = infer_mod.infer({"group": "llm", "device": "cpu", "context": [{"record_id": "r1", "timestamp": "2025-01-01T00:00:00Z", "text": "green light", "synthetic": True}]}, FakeAdapter())
    assert result["answer"] == "green light"
    assert result["source_synthetic"] is True
    assert "benign finding" not in result["answer"]


def test_llm_runtime_failure_is_not_disguised_as_supported_abstention():
    def failed(*_):
        raise RuntimeError("runtime unavailable")
    with pytest.raises(RuntimeError, match="runtime unavailable"):
        infer_mod.infer({"group": "llm", "context": [{"record_id": "r", "timestamp": "t", "text": "source"}]}, {"llm": failed})


@pytest.mark.parametrize("kind", ["image", "video"])
def test_production_generation_helper_uses_local_runner_and_removes_unmarked_intermediate(monkeypatch, tmp_path, kind):
    import sys
    from PIL import Image
    runner = importlib.import_module("scripts.local_ai_run")
    calls = []
    def generate(prompt, output, device):
        calls.append((prompt, device))
        im = Image.new("RGB", (256, 256), "red")
        if kind == "image":
            im.save(output, format="PNG")
        else:
            im.save(output, format="GIF", save_all=True, append_images=[Image.new("RGB", (256, 256), "blue")], duration=100)
    monkeypatch.setitem(sys.modules, "local_ai_run", runner)
    monkeypatch.setattr(runner, "_image_generation", generate)
    monkeypatch.setattr(runner, "_video_generation", generate)
    output = infer_mod._real_generation(kind, {"prompt": "benign demo", "device": "cpu", "output_dir": str(tmp_path)})
    assert calls == [("benign demo", "cpu")]
    assert (isinstance(output, list) and len(output) == 2) if kind == "video" else output.size == (256, 256)
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("kind", ["image", "video"])
def test_production_classifier_loaders_are_offline_and_scores_are_returned(monkeypatch, tmp_path, kind):
    import contextlib
    import sys
    from types import SimpleNamespace
    runner = importlib.import_module("scripts.local_ai_run")
    calls = []
    class Tensor:
        def to(self, device): return self
    class Vector(list):
        def softmax(self, axis): return self
        def topk(self, count): return self[:count], list(range(count))
    class Logits:
        shape = (1, 3)
        def softmax(self, axis): return [Vector([.7, .2, .1])]
    class Processor:
        @classmethod
        def from_pretrained(cls, directory, **kwargs):
            calls.append(("processor", directory, kwargs)); return cls()
        def __call__(self, **kwargs):
            if kind == "video": assert kwargs["text"] == list(infer_mod.BENIGN_LABELS)
            return {"pixel_values": Tensor()}
    class Model:
        config = SimpleNamespace(id2label={0: "class-a", 1: "class-b", 2: "class-c"})
        @classmethod
        def from_pretrained(cls, directory, **kwargs):
            calls.append(("model", directory, kwargs)); return cls()
        def to(self, device): return self
        def eval(self): return self
        def __call__(self, **kwargs):
            return SimpleNamespace(logits=Logits(), logits_per_video=[Vector([.4, .3, .2, .1])])
    monkeypatch.setitem(sys.modules, "local_ai_run", runner)
    monkeypatch.setitem(sys.modules, "transformers", SimpleNamespace(AutoImageProcessor=Processor, AutoModelForImageClassification=Model, XCLIPProcessor=Processor, XCLIPModel=Model))
    monkeypatch.setattr(runner, "_verified", lambda group: (tmp_path, {}))
    monkeypatch.setattr(runner, "_torch", lambda device: (SimpleNamespace(inference_mode=contextlib.nullcontext), None))
    result = infer_mod._real_classification(kind, ["frame"] * 8, {"device": "cpu"})
    assert result and all(0 <= row["score"] <= 1 for row in result)
    for loader, directory, kwargs in calls:
        assert directory == str(tmp_path) and kwargs["local_files_only"] is True and kwargs["trust_remote_code"] is False
        if loader == "model": assert kwargs["use_safetensors"] is True


def test_llm_exact_token_budget_prevents_silent_source_truncation(monkeypatch):
    import sys
    from types import SimpleNamespace
    runner = importlib.import_module("scripts.local_ai_run")
    class Tokenizer:
        def apply_chat_template(self, messages, **kwargs): return "rendered"
        def __call__(self, text, **kwargs):
            assert kwargs["truncation"] is False
            return {"input_ids": SimpleNamespace(shape=(1, 2049))}
    monkeypatch.setitem(sys.modules, "local_ai_run", runner)
    monkeypatch.setattr(runner, "_load_llm", lambda device: (Tokenizer(), object()))
    with pytest.raises(ValueError, match="context too long"):
        infer_mod._llm_token_count("source records", "cpu")


@pytest.mark.parametrize("size,duration", [((1281, 1), 100), ((20, 20), 11000)])
def test_uploaded_video_resolution_and_duration_limits(tmp_path, size, duration):
    from PIL import Image
    path = tmp_path / "too-large.gif"
    Image.new("RGB", size, "red").save(path, duration=duration)
    with pytest.raises(ValueError, match="exceeds"):
        infer_mod._video_frames(path)


def test_invalid_formats_raw_size_and_bounded_frames(tmp_path):
    from PIL import Image
    corrupt = tmp_path / "corrupt.png"
    corrupt.write_bytes(b"\x89PNG\r\n\x1a\ntruncated")
    with pytest.raises(ValueError, match="invalid image"):
        infer_mod._image_info(corrupt)
    huge = tmp_path / "oversized.png"
    with huge.open("wb") as handle: handle.truncate(infer_mod.MAX_RAW_INPUT + 1)
    with pytest.raises(ValueError, match="8 MiB"):
        infer_mod._image_info(huge)
    image = infer_mod._downsample_video_frame(Image.new("RGB", (1280, 720)))
    assert image.width <= 224 and image.height <= 224


def test_video_generation_contract_and_every_frame_synthetic_stamp(tmp_path):
    from PIL import Image
    adapter = FakeAdapter()
    adapter.video_generation = lambda *_: [Image.new("RGB", (256, 256), (n * 20, 20, 20)) for n in range(9)]
    result = infer_mod.infer({"group": "video-generation", "device": "cuda", "prompt": "moving shapes", "output_dir": str(tmp_path)}, adapter)
    assert result["synthetic"] and result["frames"] == 9 and result["mime"] == "image/gif"
    with Image.open(tmp_path / result["artifact"]) as im:
        assert im.n_frames == 9
        for n in range(im.n_frames):
            im.seek(n)
            assert im.convert("RGB").getpixel((0, 0)) == (0, 0, 0)


def test_missing_pinned_model_cli_fails_without_network_or_download(tmp_path):
    import os
    import subprocess
    import sys
    request = tmp_path / "request.json"
    result = tmp_path / "result.json"
    request.write_text(json.dumps({"group": "llm", "device": "cpu", "prompt": "hi", "context": []}))
    command = [sys.executable, str(Path(infer_mod.__file__).resolve()), "--request", str(request), "--result", str(result)]
    completed = subprocess.run(command, env={**os.environ, "UCAS_AI_HOME": str(tmp_path / "missing")}, capture_output=True, timeout=10)
    assert completed.returncode == 1
    payload = json.loads(result.read_text())
    assert payload["error"]["code"] == "model_not_installed"
    assert not (tmp_path / "missing").exists()


def test_real_mp4_decoder_is_local_and_reports_clip_time(tmp_path):
    imageio = pytest.importorskip("imageio.v2")
    np = pytest.importorskip("numpy")
    path = tmp_path / "sample.mp4"
    with imageio.get_writer(path, fps=4, macro_block_size=16) as writer:
        for n in range(4): writer.append_data(np.full((32, 32, 3), n * 50, dtype=np.uint8))
    frames, seconds = infer_mod._video_frames(path)
    assert len(frames) == 4 and seconds == pytest.approx(1.0)
    assert all(frame.width <= 224 for frame in frames)


@pytest.mark.parametrize("resource,device,error", [("free_disk_gb", "cpu", "free disk"), ("ram_gb", "cpu", "available RAM"), ("vram_gb", "cuda", "CUDA unavailable")])
def test_resource_preflight_refuses_insufficient_host_budget(monkeypatch, tmp_path, resource, device, error):
    import sys
    from types import SimpleNamespace
    monkeypatch.setattr(infer_mod.shutil, "disk_usage", lambda _: SimpleNamespace(free=0))
    monkeypatch.setattr(Path, "read_text", lambda *args, **kwargs: "MemAvailable: 1 kB\n")
    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False)))
    registry = {"models": {"llm": {"resources": {resource: 1}}}}
    with pytest.raises(RuntimeError, match=error):
        REAL_PREFLIGHT("llm", device, registry, str(tmp_path))


def test_video_frame_count_limit_precedes_model_loading(tmp_path):
    from PIL import Image
    path = tmp_path / "many-frames.gif"
    frames = [Image.new("RGB", (16, 16), "red" if i % 2 else "blue") for i in range(301)]
    frames[0].save(path, save_all=True, append_images=frames[1:], duration=10, optimize=False)
    with pytest.raises(ValueError, match="300-frame"):
        infer_mod.infer({"group": "video-classification", "device": "cpu", "input": str(path)}, FakeAdapter())
