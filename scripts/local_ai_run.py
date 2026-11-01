#!/usr/bin/env python3
"""Verified, offline-only local model runner."""
from __future__ import annotations
import argparse, json, os, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

# Force these values; inherited environment must never enable hub access.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["DO_NOT_TRACK"] = "1"

GROUPS = {"llm", "image-generation", "video-generation", "image-classification", "video-classification"}
MAX_BODY = 16 * 1024
MAX_PROMPT_CHARS = 4096
MAX_INPUT_TOKENS = 2048
MAX_NEW_TOKENS = 400
MAX_GENERATION_SECONDS = 55
_MODEL_LOCK = threading.RLock()
_LLM_CACHE: dict[tuple[str, str, str], tuple[Any, Any]] = {}
_SERVE_LLM_KEY: tuple[str, str, str] | None = None


def _setup():
    try:
        from local_ai_setup import cache_root, load_registry, model_dir, verify_group
    except ImportError:
        from scripts.local_ai_setup import cache_root, load_registry, model_dir, verify_group
    return cache_root, load_registry, model_dir, verify_group


def _verified(group: str, registry: dict[str, Any] | None = None):
    if group not in GROUPS: raise ValueError(f"unsupported group: {group}")
    _, load_registry, model_dir, verify_group = _setup()
    reg = registry if registry is not None else load_registry()
    if not isinstance(reg, dict) or not isinstance(reg.get("models"), dict): raise RuntimeError("invalid local model registry")
    meta = reg["models"].get(group)
    if not isinstance(meta, dict) or not isinstance(meta.get("repo_id"), str): raise RuntimeError(f"registry has no model for {group}")
    if verify_group(group, reg) is False: raise RuntimeError("cached model failed integrity verification")
    directory = Path(model_dir(group))
    if not directory.is_dir(): raise RuntimeError("verified model directory is missing")
    return directory, meta


def _torch(device: str):
    import torch
    if device not in {"cpu", "cuda"}: raise ValueError("invalid device")
    if device == "cuda" and not torch.cuda.is_available(): raise RuntimeError("CUDA unavailable")
    return torch, torch.float32 if device == "cpu" else (torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16)


def _load_llm(device: str, registry=None):
    if _SERVE_LLM_KEY is not None and _SERVE_LLM_KEY[1] == device:
        cached = _LLM_CACHE.get(_SERVE_LLM_KEY)
        if cached is not None:
            return cached
    directory, meta = _verified("llm", registry)
    if meta.get("repo_id") != "Qwen/Qwen3-0.6B": raise RuntimeError("unsupported llm model")
    key = (str(directory.resolve()), device, str(meta.get("revision", "")))
    with _MODEL_LOCK:
        if key in _LLM_CACHE: return _LLM_CACHE[key]
        torch, dtype = _torch(device)
        from transformers import AutoModelForCausalLM, AutoTokenizer
        tokenizer = AutoTokenizer.from_pretrained(str(directory), local_files_only=True, trust_remote_code=False)
        model = AutoModelForCausalLM.from_pretrained(str(directory), local_files_only=True, trust_remote_code=False, use_safetensors=True, torch_dtype=dtype).to(device).eval()
        _LLM_CACHE[key] = (tokenizer, model)
        return tokenizer, model


def _llm(prompt: str, device: str, registry=None, max_tokens: int = MAX_NEW_TOKENS) -> str:
    tokenizer, model = _load_llm(device, registry)
    torch, _ = _torch(device)
    messages = [{"role": "user", "content": prompt}]
    rendered = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True, enable_thinking=False)
    inputs = tokenizer(rendered, return_tensors="pt", truncation=True, max_length=MAX_INPUT_TOKENS)
    inputs = {k: v.to(device) for k, v in inputs.items()}
    with torch.inference_mode():
        output = model.generate(**inputs, do_sample=False, max_new_tokens=max_tokens, max_time=MAX_GENERATION_SECONDS)
    return tokenizer.decode(output[0][inputs["input_ids"].shape[-1]:], skip_special_tokens=True).strip()


def _image_generation(prompt, output: Path, device, registry=None):
    directory, meta = _verified("image-generation", registry); torch, dtype = _torch(device)
    from diffusers import DiffusionPipeline, StableDiffusionPipeline, StableDiffusionXLPipeline
    classes = {"StableDiffusionPipeline": StableDiffusionPipeline, "StableDiffusionXLPipeline": StableDiffusionXLPipeline, "DiffusionPipeline": DiffusionPipeline}
    cls = classes.get(meta.get("pipeline", "StableDiffusionXLPipeline"))
    if cls is None: raise RuntimeError("unsupported image pipeline")
    kw = {"local_files_only": True, "trust_remote_code": False, "use_safetensors": True, "torch_dtype": dtype}
    if meta.get("variant"): kw["variant"] = meta["variant"]
    pipe = cls.from_pretrained(str(directory), **kw).to(device)
    output.parent.mkdir(parents=True, exist_ok=True); pipe(prompt, num_inference_steps=2, height=256, width=256).images[0].save(output, format="PNG")


def _video_generation(prompt, output: Path, device, registry=None):
    if device != "cuda": raise RuntimeError("video generation requires CUDA")
    directory, _ = _verified("video-generation", registry); torch, dtype = _torch(device)
    from diffusers import AutoencoderKLWan, WanPipeline
    kw = {"torch_dtype": dtype, "local_files_only": True, "trust_remote_code": False, "use_safetensors": True}
    vae_dir = directory / "vae"
    if vae_dir.is_dir(): kw["vae"] = AutoencoderKLWan.from_pretrained(str(vae_dir), local_files_only=True, trust_remote_code=False, use_safetensors=True, torch_dtype=torch.float32)
    pipe = WanPipeline.from_pretrained(str(directory), **kw)
    pipe.enable_model_cpu_offload() if device == "cuda" and hasattr(pipe, "enable_model_cpu_offload") else pipe.to(device)
    if hasattr(pipe.vae, "enable_tiling"): pipe.vae.enable_tiling()
    frames = pipe(prompt, height=256, width=256, num_frames=9, num_inference_steps=2, output_type="pil").frames[0]
    output.parent.mkdir(parents=True, exist_ok=True)
    pil = [f.convert("RGB") if hasattr(f, "convert") else f for f in frames]
    pil[0].save(output, save_all=True, append_images=pil[1:], duration=100, loop=0, format="GIF")


def _synthetic_image(i=0):
    from PIL import Image, ImageDraw
    im = Image.new("RGB", (224, 224), "black"); d = ImageDraw.Draw(im); x = (i * 11) % 80
    d.rectangle((32 + x, 32, 112 + x, 112), fill=(220, 40, 40)); d.ellipse((112, 112, 194, 194), fill=(40, 80, 220)); return im


def _image_classification(output, device, registry=None):
    directory, _ = _verified("image-classification", registry); torch, _ = _torch(device)
    from transformers import AutoImageProcessor, AutoModelForImageClassification
    p = AutoImageProcessor.from_pretrained(str(directory), local_files_only=True, trust_remote_code=False, use_fast=False)
    m = AutoModelForImageClassification.from_pretrained(str(directory), local_files_only=True, trust_remote_code=False, use_safetensors=True).to(device).eval()
    with torch.inference_mode(): logits = m(**{k:v.to(device) for k,v in p(images=_synthetic_image(), return_tensors="pt").items()}).logits
    vals, inds = logits.softmax(-1)[0].topk(min(5, logits.shape[-1])); labels = m.config.id2label
    if output: output.parent.mkdir(parents=True, exist_ok=True); _synthetic_image().save(output, format="PNG")
    return {"group":"image-classification", "topk":[{"label":labels.get(int(i),str(int(i))),"score":float(v)} for v,i in zip(vals,inds)], "advisory":True, "synthetic":True, "score_semantics":"model softmax, not calibrated confidence; synthetic fixture is not an accuracy test"}


def _video_classification(output, device, registry=None):
    directory, _ = _verified("video-classification", registry); torch, _ = _torch(device)
    from transformers import XCLIPProcessor, XCLIPModel
    labels = ["a red ball rolling", "a blue square moving", "a static geometric pattern"]
    frames = [_synthetic_image(i) for i in range(8)]
    p = XCLIPProcessor.from_pretrained(str(directory), local_files_only=True, trust_remote_code=False)
    m = XCLIPModel.from_pretrained(str(directory), local_files_only=True, trust_remote_code=False, use_safetensors=True).to(device).eval()
    batch = p(text=labels, videos=frames, return_tensors="pt", padding=True)
    with torch.inference_mode(): logits = m(**{k:v.to(device) for k,v in batch.items()}).logits_per_video[0]
    scores = logits.softmax(-1)
    ranked = sorted([{"label":labels[i],"score":float(scores[i])} for i in range(len(labels))], key=lambda row: row["score"], reverse=True)
    result = {"group":"video-classification", "topk":ranked, "advisory":True, "synthetic":True, "score_semantics":"normalized candidate similarity, not calibrated confidence"}
    if output:
        output.parent.mkdir(parents=True, exist_ok=True); frames[0].save(output, save_all=True, append_images=frames[1:], duration=100, loop=0, format="GIF")
    return result


def smoke(group, device="cpu", output=None, registry=None):
    path = Path(output) if output else None
    with _MODEL_LOCK:
        if group == "llm": return {"group":group,"text":_llm("Reply with a brief benign greeting.",device,registry),"advisory":True}
        if group == "image-generation":
            if not path: raise ValueError("--output is required")
            _image_generation("A simple blue geometric shape on white background",path,device,registry); return {"group":group,"output":str(path),"advisory":True,"synthetic":True}
        if group == "video-generation":
            if not path: raise ValueError("--output is required")
            _video_generation("A simple blue geometric shape moving slowly",path,device,registry); return {"group":group,"output":str(path),"advisory":True,"synthetic":True}
        if group == "image-classification": return _image_classification(path,device,registry)
        if group == "video-classification": return _video_classification(path,device,registry)
        raise ValueError("unsupported group")


def _error(h, status, message):
    body=json.dumps({"error":message}).encode(); h.send_response(status); h.send_header("Content-Type","application/json"); h.send_header("Content-Length",str(len(body))); h.end_headers(); h.wfile.write(body)


class _LLMHandler(BaseHTTPRequestHandler):
    server_version="ucas-local-llm/1"
    def setup(self):
        super().setup(); self.connection.settimeout(5)
    def _common(self):
        host=self.headers.get("Host","").split(":",1)[0]
        if host not in {"127.0.0.1","localhost"}: _error(self,400,"loopback Host required"); return False
        if "Origin" in self.headers: _error(self,403,"Origin requests are not allowed"); return False
        return True
    def do_GET(self):
        if not self._common(): return
        if self.path != "/health": return _error(self,404,"not found")
        ready=bool(getattr(self.server,"model_loaded",False)); body=json.dumps({"status":"ok" if ready else "starting","ready":ready,"local_only":True}).encode()
        self.send_response(200 if ready else 503); self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        if not self._common(): return
        if self.path != "/v1/chat/completions": return _error(self,404,"not found")
        try:
            if self.headers.get("Content-Type","").split(";",1)[0].lower() != "application/json": return _error(self,415,"JSON content type required")
            try: length=int(self.headers.get("Content-Length","-1"))
            except ValueError: return _error(self,400,"invalid request")
            if length < 0 or length > MAX_BODY: return _error(self,413,"request body too large")
            data=json.loads(self.rfile.read(length))
            if not isinstance(data,dict): raise ValueError("JSON object required")
            if set(data)-{"model","messages","max_tokens","temperature","stream"}: raise ValueError("unsupported control field")
            msgs=data.get("messages")
            if not isinstance(msgs,list) or not msgs or any(not isinstance(m,dict) or set(m)!={"role","content"} or m["role"] not in {"system","user","assistant"} or not isinstance(m["content"],str) for m in msgs): raise ValueError("invalid messages")
            prompt="\n".join(m["content"] for m in msgs)
            if len(prompt)>MAX_PROMPT_CHARS: raise ValueError("prompt too long")
            if "model" in data and data["model"] != self.server.repo_id: raise ValueError("model is fixed")
            n=data.get("max_tokens",MAX_NEW_TOKENS)
            if not isinstance(n,int) or isinstance(n,bool) or not 1<=n<=MAX_NEW_TOKENS: raise ValueError("invalid max_tokens")
            if data.get("stream",False): raise ValueError("streaming is unsupported")
            if not getattr(self.server,"model_loaded",False): return _error(self,503,"model not ready")
            if not _MODEL_LOCK.acquire(blocking=False): return _error(self,503,"local model is busy")
            try: text=_llm(prompt,self.server.device,self.server.registry,n)
            finally: _MODEL_LOCK.release()
            body=json.dumps({"id":"local-chat","object":"chat.completion","model":self.server.repo_id,"choices":[{"index":0,"message":{"role":"assistant","content":text},"finish_reason":"stop"}]}).encode(); self.send_response(200); self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(body))); self.end_headers(); self.wfile.write(body)
        except (ValueError,json.JSONDecodeError): _error(self,400,"invalid request")
        except (RuntimeError,TimeoutError,OSError): _error(self,503,"local model unavailable")
    def log_message(self,*_): pass


def serve_llm(host="127.0.0.1", port=8080, device="cpu", registry=None):
    global _SERVE_LLM_KEY
    if host!="127.0.0.1": raise ValueError("only loopback host 127.0.0.1 is permitted")
    directory,meta=_verified("llm",registry)
    _load_llm(device,registry)
    _SERVE_LLM_KEY=(str(directory.resolve()), device, str(meta.get("revision", "")))
    server=ThreadingHTTPServer(("127.0.0.1",port),_LLMHandler); server.device=device; server.registry=registry; server.repo_id=meta["repo_id"]; server.model_loaded=True
    try: server.serve_forever()
    finally: server.server_close()


def main(argv=None):
    p=argparse.ArgumentParser(); sub=p.add_subparsers(dest="command",required=True); s=sub.add_parser("smoke"); s.add_argument("--group",choices=sorted(GROUPS),required=True); s.add_argument("--device",choices=("cpu","cuda"),default="cpu"); s.add_argument("--output"); q=sub.add_parser("serve-llm"); q.add_argument("--host",default="127.0.0.1"); q.add_argument("--port",type=int,default=8080); q.add_argument("--device",choices=("cpu","cuda"),default="cpu"); a=p.parse_args(argv); result=smoke(a.group,a.device,a.output) if a.command=="smoke" else (serve_llm(a.host,a.port,a.device) or {}); print(json.dumps(result)) if result else None; return 0
if __name__=="__main__": raise SystemExit(main())
