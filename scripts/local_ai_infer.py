#!/usr/bin/env python3
"""Offline, bounded inference boundary for local advisory AI."""
from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import socket
import sys
import time
from pathlib import Path
from typing import Any, Mapping

os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1", DO_NOT_TRACK="1")

GROUPS = {"llm", "image-generation", "video-generation", "image-classification", "video-classification"}
IMAGE_MAX_SIDE = 4096
IMAGE_MAX_PIXELS = 16_000_000
VIDEO_MAX_SECONDS = 10.0
VIDEO_MAX_FRAMES = 300
VIDEO_MAX_WIDTH, VIDEO_MAX_HEIGHT = 1280, 720
MAX_RAW_INPUT = 8 * 1024 * 1024
MAX_PROMPT_CHARS = 2000
MAX_CONTEXT_RECORDS = 8
MAX_CONTEXT_TEXT = 600
MAX_INPUT_TOKENS = 2048
BENIGN_LABELS = ("a geometric shape moving", "a nature scene", "a person walking", "a static pattern")

_ORIGINAL_SOCKET = socket.socket
_NETWORK_GUARD_INSTALLED = False


def _deny_network() -> None:
    """Fail closed without replacing ``socket.socket`` with a non-class callable."""
    global _NETWORK_GUARD_INSTALLED
    if _NETWORK_GUARD_INSTALLED:
        return

    class DeniedSocket(_ORIGINAL_SOCKET):
        def connect(self, *args: Any, **kwargs: Any) -> Any:
            raise RuntimeError("network access is disabled for local inference")
        def connect_ex(self, *args: Any, **kwargs: Any) -> Any:
            raise RuntimeError("network access is disabled for local inference")
        def sendto(self, *args: Any, **kwargs: Any) -> Any:
            raise RuntimeError("network access is disabled for local inference")
        def sendmsg(self, *args: Any, **kwargs: Any) -> Any:
            raise RuntimeError("network access is disabled for local inference")

    def denied(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("network access is disabled for local inference")

    socket.socket = DeniedSocket  # type: ignore[assignment]
    socket.create_connection = denied  # type: ignore[assignment]
    for name in ("getaddrinfo", "gethostbyname", "gethostbyname_ex", "getnameinfo"):
        if hasattr(socket, name):
            setattr(socket, name, denied)
    # Audit hooks catch libraries which bypass the convenience functions.
    def audit(event: str, _args: Any) -> None:
        if event in {"socket.connect", "socket.sendto", "socket.sendmsg", "socket.getaddrinfo", "socket.gethostbyname"}:
            raise RuntimeError("network access is disabled for local inference")
    sys.addaudithook(audit)
    _NETWORK_GUARD_INSTALLED = True


def _setup():
    try:
        from local_ai_setup import load_registry, model_dir, verify_group
    except ImportError:
        from scripts.local_ai_setup import load_registry, model_dir, verify_group
    return load_registry, model_dir, verify_group


def _resource_preflight(group: str, device: str, registry: Mapping[str, Any] | None = None, output_dir: str | None = None) -> None:
    if device not in {"cpu", "cuda"}:
        raise ValueError("device must be cpu or cuda")
    load_registry, _model_dir, _verify = _setup()
    reg = registry if registry is not None else load_registry()
    model = reg.get("models", {}).get(group, {}) if isinstance(reg, Mapping) else {}
    resources = model.get("resources", {}) if isinstance(model, Mapping) else {}
    required_disk = float(resources.get("free_disk_gb", 0)) * 1024**3
    target = Path(output_dir) if output_dir else Path.cwd()
    target_parent = target if target.exists() else target.parent
    free = shutil.disk_usage(target_parent).free
    if required_disk and free < required_disk:
        raise RuntimeError(f"insufficient free disk: need {required_disk:.0f} bytes, have {free} bytes")
    required_ram = float(resources.get("ram_gb", 0)) * 1024**3
    try:
        available_ram = next(int(line.split()[1]) * 1024 for line in Path("/proc/meminfo").read_text().splitlines() if line.startswith("MemAvailable:"))
    except (OSError, StopIteration, ValueError):
        available_ram = 0
    if required_ram and (not available_ram or available_ram < required_ram):
        raise RuntimeError(f"insufficient available RAM: need {required_ram:.0f} bytes, have {available_ram:.0f} bytes")
    if device == "cuda":
        import torch
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA unavailable")
        required_vram = float(resources.get("vram_gb", 0)) * 1024**3
        free_vram = int(torch.cuda.mem_get_info()[0])
        if required_vram and free_vram < required_vram:
            raise RuntimeError(f"insufficient CUDA VRAM: need {required_vram:.0f} bytes, have {free_vram} bytes")


def _validate_request(request: Mapping[str, Any]) -> dict[str, Any]:
    if not isinstance(request, Mapping): raise ValueError("request must be an object")
    group = request.get("group")
    if not isinstance(group, str) or group not in GROUPS: raise ValueError("unsupported group")
    device = request.get("device", "cpu")
    if not isinstance(device, str) or device not in {"cpu", "cuda"}: raise ValueError("device must be cpu or cuda")
    prompt = request.get("prompt", "")
    if not isinstance(prompt, str) or len(prompt) > MAX_PROMPT_CHARS: raise ValueError("prompt must be a string of at most 2000 characters")
    context = request.get("context", [])
    if not isinstance(context, list) or len(context) > MAX_CONTEXT_RECORDS or any(not isinstance(x, Mapping) for x in context):
        raise ValueError("context must be a list of at most 8 records")
    clean_context = []
    for item in context:
        if not all(isinstance(item.get(k), str) for k in ("record_id", "timestamp", "text")):
            raise ValueError("context records require record_id, timestamp, and text strings")
        if len(item["text"]) > MAX_CONTEXT_TEXT: raise ValueError("context text is too long")
        synthetic = item.get("synthetic", False)
        if not isinstance(synthetic, bool): raise ValueError("context synthetic must be boolean")
        clean_context.append({"record_id": item["record_id"], "timestamp": item["timestamp"], "text": item["text"], "synthetic": synthetic})
    path = request.get("input")
    if path is not None and (not isinstance(path, str) or not Path(path).is_absolute()): raise ValueError("input must be an absolute path")
    out = request.get("output_dir")
    if out is not None and (not isinstance(out, str) or not Path(out).is_absolute()): raise ValueError("output_dir must be an absolute path")
    return {"group": group, "device": device, "prompt": prompt, "context": clean_context, "input": path, "output_dir": out}


def _check_raw_input(path: Path) -> None:
    try:
        st = path.stat()
    except OSError as exc:
        raise ValueError(f"invalid input: {exc}") from exc
    if not path.is_file(): raise ValueError("input must be a regular file")
    if st.st_size > MAX_RAW_INPUT: raise ValueError("input exceeds 8 MiB")


def _image_info(path: Path, allow_animation: bool = False):
    _check_raw_input(path)
    try:
        from PIL import Image
        with Image.open(path) as im:
            if im.format not in {"PNG", "JPEG", "JPG"}: raise ValueError("image input must be PNG or JPEG")
            w, h = im.size
            if max(w, h) > IMAGE_MAX_SIDE or w * h > IMAGE_MAX_PIXELS: raise ValueError("image exceeds 4096-side or 16M-pixel limit")
            if getattr(im, "n_frames", 1) != 1 and not allow_animation: raise ValueError("animated images are not accepted")
            return im.convert("RGB").copy()
    except (OSError, SyntaxError) as exc: raise ValueError(f"invalid image input: {exc}") from exc


def _video_frames(path: Path) -> tuple[list[Any], float]:
    _check_raw_input(path)
    suffix = path.suffix.lower()
    if suffix not in {".gif", ".mp4"}: raise ValueError("video input must be GIF or MP4")
    try:
        if suffix == ".gif":
            from PIL import Image
            with Image.open(path) as im:
                frames, duration = [], 0.0
                for n in range(VIDEO_MAX_FRAMES + 1):
                    try: im.seek(n)
                    except EOFError: break
                    if im.size[0] > VIDEO_MAX_WIDTH or im.size[1] > VIDEO_MAX_HEIGHT: raise ValueError("video exceeds 1280x720 limit")
                    duration += float(im.info.get("duration", 100)) / 1000.0
                    if duration > VIDEO_MAX_SECONDS or n >= VIDEO_MAX_FRAMES: raise ValueError("video exceeds 10-second or 300-frame limit")
                    frames.append(_downsample_video_frame(im.convert("RGB")))
                if not frames: raise ValueError("video has no frames")
                return frames, duration
        import imageio.v2 as imageio
        reader = imageio.get_reader(str(path), format="ffmpeg", input_params=["-protocol_whitelist", "file,pipe", "-enable_drefs", "0"])
        try:
            meta = reader.get_meta_data()
            fps = float(meta.get("fps") or 0)
            duration = float(meta.get("duration") or 0)
            size = meta.get("size") or (0, 0)
            if not math.isfinite(fps) or fps <= 0 or not math.isfinite(duration) or duration <= 0 or duration > VIDEO_MAX_SECONDS: raise ValueError("video duration/fps metadata unavailable or exceeds 10 seconds")
            if size[0] > VIDEO_MAX_WIDTH or size[1] > VIDEO_MAX_HEIGHT: raise ValueError("video exceeds 1280x720 limit")
            frames = []
            for n, frame in enumerate(reader):
                if n >= VIDEO_MAX_FRAMES: raise ValueError("video exceeds 300-frame limit")
                if frame.shape[1] > VIDEO_MAX_WIDTH or frame.shape[0] > VIDEO_MAX_HEIGHT: raise ValueError("video frame exceeds 1280x720 limit")
                frames.append(_downsample_video_frame(frame))
            if not frames: raise ValueError("video has no frames")
            actual_duration = len(frames) / fps
            if actual_duration > VIDEO_MAX_SECONDS: raise ValueError("video exceeds 10-second limit")
            if abs(duration - actual_duration) > max(0.25, 1 / fps): raise ValueError("video timing is inconsistent; use constant-frame-rate MP4")
            return frames, actual_duration
        finally: reader.close()
    except ValueError: raise
    except Exception as exc: raise ValueError(f"invalid video input or decoder unavailable: {exc}") from exc


def _call(adapter: Any, name: str, *args: Any, **kwargs: Any) -> Any:
    fn = getattr(adapter, name, None)
    if fn is None and isinstance(adapter, Mapping): fn = adapter.get(name)
    if not callable(fn): raise RuntimeError(f"adapter does not implement {name}")
    return fn(*args, **kwargs)


def _llm_result(req: dict[str, Any], adapter: Any) -> dict[str, Any]:
    context = req["context"]
    source_synthetic = any(r["synthetic"] for r in context)
    base = {"group": "llm", "advisory": True, "synthetic": False, "source_synthetic": source_synthetic, "kind": "llm", "citations": [], "abstained": True, "model_ran": False, "answer": ""}
    if not context: return base
    records = "\n".join(f"[{r['record_id']} @ {r['timestamp']}] {r['text']}" for r in context)
    instruction = ("Return ONLY JSON with keys answer, claims. claims must be non-empty and each object has quote, record_id, timestamp. "
                   "quote must be an exact non-empty substring of its cited record text. The answer is ignored and must not add information.\n" + records + "\nUser: " + req["prompt"])
    # Adapters have no tokenizer; use a conservative bound. Production counts the
    # exact rendered chat-template input before invoking the runner.
    if adapter is not None and len(instruction) * 2 > MAX_INPUT_TOKENS * 4: return base
    if adapter is None: _llm_token_count(instruction, req["device"])
    try:
        raw = _call(adapter, "llm", instruction, req["device"]) if adapter is not None else _real_llm(instruction, req["device"])
        base["model_ran"] = True
        obj = json.loads(raw) if isinstance(raw, str) else raw
        if not isinstance(obj, Mapping) or not isinstance(obj.get("claims"), list) or not obj["claims"]: return base
        by_key = {(r["record_id"], r["timestamp"]): r for r in context}; quotes = []; citations = []
        for c in obj["claims"]:
            if not isinstance(c, Mapping) or not all(isinstance(c.get(k), str) for k in ("quote", "record_id", "timestamp")): return base
            key = (c["record_id"], c["timestamp"])
            if key not in by_key or not c["quote"] or c["quote"] not in by_key[key]["text"]: return base
            quotes.append(c["quote"]); citations.append({"record_id": c["record_id"], "timestamp": c["timestamp"]})
        base.update(answer=" ".join(quotes), citations=citations, abstained=False, model_ran=True)
    except (TypeError, json.JSONDecodeError):
        pass
    return base


def _llm_token_count(prompt: str, device: str) -> int:
    """Count exact rendered chat-template tokens; never permit runner truncation."""
    try:
        from local_ai_run import _load_llm
    except ImportError:
        from scripts.local_ai_run import _load_llm
    tokenizer, _model = _load_llm(device)
    rendered = tokenizer.apply_chat_template([{"role": "user", "content": prompt}], tokenize=False, add_generation_prompt=True, enable_thinking=False)
    encoded = tokenizer(rendered, return_tensors="pt", truncation=False)
    ids = encoded["input_ids"]
    count = int(ids.shape[-1]) if hasattr(ids, "shape") else len(ids[0] if ids and isinstance(ids[0], list) else ids)
    if count > MAX_INPUT_TOKENS: raise ValueError(f"LLM context too long: {count} tokens (maximum {MAX_INPUT_TOKENS})")
    return count


def _real_llm(prompt: str, device: str) -> str:
    try:
        from local_ai_run import _llm
    except ImportError:
        from scripts.local_ai_run import _llm
    return _llm(prompt, device)


def _stamp(image: Any, text: str = "SYNTHETIC DEMO/TRAINING") -> Any:
    from PIL import ImageDraw
    im = image.convert("RGB"); draw = ImageDraw.Draw(im); draw.rectangle((0, 0, im.width, 18), fill="black"); draw.text((3, 3), text, fill="white"); return im


def _write_media(req: dict[str, Any], frames: list[Any], suffix: str) -> str:
    outdir = Path(req["output_dir"] or Path.cwd()); outdir.mkdir(parents=True, exist_ok=True)
    path = outdir / f"synthetic_{int(time.time() * 1000)}.{suffix}"
    stamped = []
    for frame in frames:
        frame = frame.convert("RGB")
        if frame.width > 256 or frame.height > 256: frame.thumbnail((256, 256))
        stamped.append(_stamp(frame))
    if not stamped: raise RuntimeError("generation adapter returned no frames")
    if suffix == "png": stamped[0].save(path, format="PNG")
    else: stamped[0].save(path, save_all=True, append_images=stamped[1:], duration=100, loop=0, format="GIF")
    return path.name


def infer(request: Mapping[str, Any], adapter: Any = None) -> dict[str, Any]:
    req = _validate_request(request)
    if req["group"] == "image-classification":
        if not req["input"]: raise ValueError("input is required")
        image = _image_info(Path(req["input"]))
    elif req["group"] == "video-classification":
        if not req["input"]: raise ValueError("input is required")
        frames, duration = _video_frames(Path(req["input"]))
    else: frames = None
    # Test adapters bypass installation checks; production must verify the exact
    # cached model even when an empty request will later abstain.
    if adapter is None:
        try:
            from local_ai_run import _verified
        except ImportError:
            from scripts.local_ai_run import _verified
        _verified(req["group"])
    _resource_preflight(req["group"], req["device"], None, req["output_dir"])
    group = req["group"]
    if group == "llm": return _llm_result(req, adapter)
    if group == "image-generation":
        if not req["output_dir"]: raise ValueError("output_dir is required")
        generated = _call(adapter, "image_generation", req["prompt"], req["device"]) if adapter is not None else _real_generation("image", req)
        return {"group": group, "advisory": True, "synthetic": True, "kind": "image", "artifact": _write_media(req, [generated], "png"), "mime": "image/png"}
    if group == "video-generation":
        if req["device"] != "cuda": raise ValueError("video generation requires CUDA")
        if not req["output_dir"]: raise ValueError("output_dir is required")
        generated = _call(adapter, "video_generation", req["prompt"], req["device"]) if adapter is not None else _real_generation("video", req)
        generated = list(generated)[:9]
        if not generated: raise RuntimeError("video adapter returned no frames")
        generated.extend([generated[-1]] * (9 - len(generated)))
        return {"group": group, "advisory": True, "synthetic": True, "kind": "video", "artifact": _write_media(req, generated, "gif"), "mime": "image/gif", "frames": 9}
    if group == "image-classification":
        topk = _call(adapter, "image_classification", image, req["device"]) if adapter is not None else _real_classification("image", image, req)
        normalized = _normalize_topk(topk)
        if not normalized: raise ValueError("classifier returned no valid labels")
        return {"group": group, "advisory": True, "synthetic": False, "kind": group, "score_semantics": "model score normalized to [0,1], not calibrated confidence", "topk": normalized}
    sampled = [_downsample_video_frame(frames[min(len(frames)-1, round(i * (len(frames)-1) / 7))]) for i in range(8)]
    topk = _call(adapter, "video_classification", sampled, BENIGN_LABELS, req["device"]) if adapter is not None else _real_classification("video", sampled, req)
    normalized = _normalize_topk(topk, BENIGN_LABELS)
    if not normalized: raise ValueError("classifier returned no valid labels")
    return {"group": group, "advisory": True, "synthetic": False, "kind": group, "score_semantics": "candidate similarity normalized to [0,1], not calibrated confidence", "clips": [{"start_seconds": 0.0, "end_seconds": round(duration, 3), "topk": normalized}]}


def _normalize_topk(value: Any, labels: tuple[str, ...] = ()) -> list[dict[str, Any]]:
    rows = value if isinstance(value, list) else value.get("topk", []) if isinstance(value, Mapping) else []
    result = []
    for row in rows:
        if isinstance(row, Mapping) and isinstance(row.get("label"), str) and isinstance(row.get("score"), (int, float)) and not isinstance(row["score"], bool) and math.isfinite(float(row["score"])):
            score = float(row["score"])
            if 0.0 <= score <= 1.0 and (not labels or row["label"] in labels):
                result.append({"label": row["label"], "score": score})
    return sorted(result, key=lambda x: x["score"], reverse=True)[:5]


def _downsample_video_frame(frame: Any) -> Any:
    """Bound retained XCLIP frames to 224px without changing clip timing."""
    from PIL import Image
    image = frame if isinstance(frame, Image.Image) else Image.fromarray(frame)
    image = image.convert("RGB")
    image.thumbnail((224, 224))
    return image.copy()


def _real_generation(kind: str, req: dict[str, Any]) -> Any:
    try:
        from local_ai_run import _image_generation, _video_generation
    except ImportError:
        from scripts.local_ai_run import _image_generation, _video_generation
    suffix = "png" if kind == "image" else "gif"
    p = Path(req["output_dir"] or Path.cwd()) / (".model-output." + suffix)
    try:
        (_image_generation if kind == "image" else _video_generation)(req["prompt"], p, req["device"])
        from PIL import Image
        with Image.open(p) as im:
            if kind == "image": return im.convert("RGB").copy()
            result = []
            for i in range(min(getattr(im, "n_frames", 1), 9)):
                im.seek(i); result.append(im.convert("RGB").copy())
            return result
    finally:
        try: p.unlink()
        except FileNotFoundError: pass


def _real_classification(kind: str, value: Any, req: dict[str, Any]) -> Any:
    try:
        from local_ai_run import _verified, _torch
    except ImportError:
        from scripts.local_ai_run import _verified, _torch
    directory, _ = _verified("image-classification" if kind == "image" else "video-classification")
    torch, _dtype = _torch(req["device"])
    if kind == "image":
        from transformers import AutoImageProcessor, AutoModelForImageClassification
        processor = AutoImageProcessor.from_pretrained(str(directory), local_files_only=True, trust_remote_code=False, use_fast=False)
        model = AutoModelForImageClassification.from_pretrained(str(directory), local_files_only=True, trust_remote_code=False, use_safetensors=True).to(req["device"]).eval()
        with torch.inference_mode(): logits = model(**{k: v.to(req["device"]) for k, v in processor(images=value, return_tensors="pt").items()}).logits
        vals, inds = logits.softmax(-1)[0].topk(min(5, logits.shape[-1])); labels = model.config.id2label
        return [{"label": labels.get(int(i), str(int(i))), "score": float(v)} for v, i in zip(vals, inds)]
    from transformers import XCLIPProcessor, XCLIPModel
    processor = XCLIPProcessor.from_pretrained(str(directory), local_files_only=True, trust_remote_code=False)
    model = XCLIPModel.from_pretrained(str(directory), local_files_only=True, trust_remote_code=False, use_safetensors=True).to(req["device"]).eval()
    batch = processor(text=list(BENIGN_LABELS), videos=value, return_tensors="pt", padding=True)
    with torch.inference_mode(): logits = model(**{k: v.to(req["device"]) for k, v in batch.items()}).logits_per_video[0]
    scores = logits.softmax(-1)
    return [{"label": BENIGN_LABELS[i], "score": float(scores[i])} for i in range(len(BENIGN_LABELS))]


def _error(code: str, message: str) -> dict[str, Any]: return {"error": {"code": code, "message": message}}


def main(argv: list[str] | None = None) -> int:
    _deny_network()
    parser = argparse.ArgumentParser(); parser.add_argument("--request", required=True); parser.add_argument("--result", required=True)
    args = parser.parse_args(argv)
    try:
        request_path, result_path = Path(args.request), Path(args.result)
        if not request_path.is_absolute() or not result_path.is_absolute(): raise ValueError("request and result paths must be absolute")
        if request_path.stat().st_size > MAX_RAW_INPUT: raise ValueError("request exceeds 8 MiB")
        request = json.loads(request_path.read_text(encoding="utf-8")); result = infer(request)
        result_path.write_text(json.dumps(result), encoding="utf-8")
    except Exception as exc:
        message = str(exc)
        lowered = message.lower()
        if any(x in lowered for x in ("model directory is missing", "no model for", "model registry", "cached model failed", "model is missing")):
            code = "model_not_installed"
        elif isinstance(exc, (ImportError, MemoryError, RuntimeError, OSError)) or any(x in lowered for x in ("cuda unavailable", "insufficient", "decoder unavailable", "local model unavailable")):
            code = "model_unavailable"
        elif isinstance(exc, ValueError):
            code = "invalid_input"
        else:
            code = type(exc).__name__.lower()
        result = _error(code, message)
        try: Path(args.result).write_text(json.dumps(result), encoding="utf-8")
        except Exception: pass
        return 1
    return 0

if __name__ == "__main__": raise SystemExit(main())
