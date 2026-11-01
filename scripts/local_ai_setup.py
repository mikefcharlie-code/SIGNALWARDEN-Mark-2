#!/usr/bin/env python3
"""Plan, install dependencies for, and explicitly download UCAS local AI models."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
import venv
from pathlib import Path
from typing import Any, Mapping

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REGISTRY = ROOT / "configs" / "local-ai-models.json"
GROUPS = ("llm", "image-generation", "video-generation", "image-classification", "video-classification")
_ALLOWED_HOSTS = ("huggingface.co", "hf.co", "xethub.hf.co")
_PERMISSIVE_LICENSES = {"apache-2.0", "mit", "bsd-2-clause", "bsd-3-clause", "isc", "cc0-1.0"}
_REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$")
_HEX = re.compile(r"^[0-9a-f]+$")
_ALLOWED_NAMES = {"README", "README.md", "LICENSE", "LICENSE.md", "tokenizer.model", "sentencepiece.bpe.model"}
_ALLOWED_SUFFIXES = (".json", ".txt", ".model", ".safetensors")


def cache_root() -> Path:
    return Path(os.environ.get("UCAS_AI_HOME", "~/.cache/ucas-ai")).expanduser().absolute()


def _assert_cache_safe() -> Path:
    root = cache_root()
    if root.is_symlink():
        raise ValueError("UCAS_AI_HOME/cache root must not be a symlink")
    return root


def _group(group: str) -> str:
    if group not in GROUPS:
        raise ValueError(f"unsupported group: {group}")
    return group


def model_dir(group: str) -> Path:
    return _assert_cache_safe() / "models" / _group(group)


def _venv_dir(group: str) -> Path:
    return _target(_assert_cache_safe(), Path("venvs") / _group(group))


def _valid_file_name(path: str) -> bool:
    name = Path(path).name
    return name in _ALLOWED_NAMES or any(name.endswith(s) for s in _ALLOWED_SUFFIXES)


def load_registry(path: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    """Load and validate the checked-in model registry before any cache mutation."""
    source = Path(path) if path is not None else DEFAULT_REGISTRY
    with source.open(encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict) or data.get("schemaVersion") != 1 or not isinstance(data.get("models"), dict):
        raise ValueError("registry must have schemaVersion 1 and a models object")
    for group, item in data["models"].items():
        _group(group)
        if not isinstance(item, dict):
            raise ValueError(f"registry entry {group} must be an object")
        for key in ("repo_id", "revision", "license", "source_url", "files"):
            if key not in item:
                raise ValueError(f"registry entry {group} missing {key}")
        repo = item["repo_id"]
        if not isinstance(repo, str) or not _REPO_RE.fullmatch(repo):
            raise ValueError(f"{group} repo_id must be owner/name without queries or traversal")
        expected = f"https://huggingface.co/{repo}"
        if item["source_url"] != expected:
            raise ValueError(f"{group} source_url must be exactly {expected}")
        revision = item["revision"]
        if not isinstance(revision, str) or len(revision) != 40 or not _HEX.fullmatch(revision):
            raise ValueError(f"{group} revision must be a 40-hex lowercase immutable revision")
        if not isinstance(item["files"], list) or not item["files"]:
            raise ValueError(f"{group} files must be a non-empty list")
        seen: set[str] = set()
        for file in item["files"]:
            if not isinstance(file, dict) or not isinstance(file.get("path"), str):
                raise ValueError(f"{group} has an invalid file entry")
            rel = file["path"]
            _safe_relative(rel)
            if rel in seen:
                raise ValueError(f"{group} contains duplicate file path: {rel}")
            seen.add(rel)
            if not _valid_file_name(rel):
                raise ValueError(f"{group} file is not an allowed model/config file: {rel}")
            size = file.get("size")
            if isinstance(size, bool) or not isinstance(size, int) or size < 0:
                raise ValueError(f"{group} has an invalid file size")
            sha = file.get("sha256")
            blob = file.get("git_blob_sha1")
            if sha is not None and (not isinstance(sha, str) or len(sha) != 64 or not _HEX.fullmatch(sha)):
                raise ValueError(f"{group}/{rel} sha256 must be 64 lowercase hex characters")
            if blob is not None and (not isinstance(blob, str) or len(blob) != 40 or not _HEX.fullmatch(blob)):
                raise ValueError(f"{group}/{rel} git_blob_sha1 must be 40 lowercase hex characters")
            if sha is None and blob is None:
                raise ValueError(f"{group}/{rel} has no content hash")
    return data


def _safe_relative(path: str) -> Path:
    if not path or "\\" in path:
        raise ValueError(f"unsafe model path: {path!r}")
    candidate = Path(path)
    if candidate.is_absolute() or ".." in candidate.parts or candidate == Path("."):
        raise ValueError(f"unsafe model path: {path!r}")
    return candidate


def _official(url: str) -> bool:
    parsed = urllib.parse.urlparse(url)
    host = (parsed.hostname or "").lower().rstrip(".")
    try:
        port = parsed.port or 443
    except ValueError:
        return False
    return (parsed.scheme == "https" and parsed.username is None and parsed.password is None
            and port == 443 and (host in _ALLOWED_HOSTS or any(host.endswith("." + suffix) for suffix in _ALLOWED_HOSTS)))


class _OfficialRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not _official(newurl):
            raise ValueError(f"refusing redirect to non-official host: {newurl}")
        headers = {k: v for k, v in req.headers.items() if k.lower() not in {"authorization", "cookie"}}
        return urllib.request.Request(newurl, headers=headers, method=req.get_method())


def _file_url(entry: Mapping[str, Any], model: Mapping[str, Any]) -> str:
    base = str(model["source_url"]).rstrip("/")
    path = urllib.parse.quote(str(_safe_relative(entry["path"])), safe="/")
    return f"{base}/resolve/{model['revision']}/{path}?download=true"


def _hash_matches(path: Path, entry: Mapping[str, Any]) -> bool:
    sha = hashlib.sha256(); size = 0
    with path.open("rb") as fh:
        while chunk := fh.read(1024 * 1024):
            size += len(chunk); sha.update(chunk)
    if size != entry["size"] or (entry.get("sha256") and sha.hexdigest() != entry["sha256"]): return False
    if entry.get("git_blob_sha1"):
        blob = hashlib.sha1(f"blob {size}\0".encode())
        with path.open("rb") as fh:
            while chunk := fh.read(1024 * 1024): blob.update(chunk)
        if blob.hexdigest() != entry["git_blob_sha1"]: return False
    return True


def _target(root: Path, relative: Path) -> Path:
    _assert_cache_safe()
    # Reject symlinks at models/, models/<group>, and every path component below it.
    cache = cache_root()
    try:
        rel_root = root.relative_to(cache)
    except ValueError as exc:
        raise ValueError("model root is outside the cache") from exc
    current = cache
    for part in rel_root.parts:
        current /= part
        if current.is_symlink(): raise ValueError("refusing symlink cache path")
    target = root / relative
    current = root
    for part in relative.parts:
        current /= part
        if current.is_symlink(): raise ValueError(f"refusing symlink model path: {relative}")
    if target.resolve(strict=False).parent != target.parent.resolve(strict=False):
        raise ValueError(f"model path escapes cache: {relative}")
    return target


def verify_group(group: str, registry: Mapping[str, Any] | None = None) -> bool:
    _group(group); registry = registry or load_registry(); model = registry["models"].get(group)
    if not model: return False
    try:
        root = model_dir(group)
        for entry in model["files"]:
            target = _target(root, _safe_relative(entry["path"]))
            if not target.is_file() or not _hash_matches(target, entry): return False
    except (OSError, ValueError, KeyError): return False
    return True


def _available_bytes(path: Path) -> int:
    while not path.exists():
        path = path.parent
    return shutil.disk_usage(path).free


def _human(num: float) -> str:
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if num < 1024 or unit == "TiB": return f"{num:.1f} {unit}"
        num /= 1024
    return f"{num:.1f} TiB"


def plan(group: str, registry: Mapping[str, Any] | None = None) -> dict[str, Any]:
    _group(group); registry = registry or load_registry(); model = registry["models"][group]; resources = model.get("resources", {})
    free = _available_bytes(cache_root().parent if cache_root().parent.exists() else Path.home())
    baseline = 3 if resources.get("vram_gb") in (None, "none", 0) else 8
    result = {"group": group, "repo_id": model["repo_id"], "revision": model["revision"], "license": model.get("license"), "download_bytes": resources.get("download_bytes", sum(x["size"] for x in model["files"])), "free_bytes": free, "free_enough": free >= int(float(resources.get("free_disk_gb", 0)) * 1024**3), "ram_gb": resources.get("ram_gb", "unknown"), "vram_gb": resources.get("vram_gb", "unknown"), "files": len(model["files"])}
    result["warnings"] = ["Framework setup also needs about 3 GiB free disk for CPU or 8 GiB for CUDA per isolated group; package caches can add more.", model.get("notes", "Memory figures are planning estimates, not guarantees.")]
    if group == "video-generation": result["warnings"].append("This runner requires CUDA for video generation; CPU-only video generation is not supported.")
    return result


def _check_platform() -> None:
    if not sys.platform.startswith("linux") or platform.machine() not in ("x86_64", "AMD64"):
        raise RuntimeError("local AI setup supports Linux x86_64 only")
    if not (3, 10) <= sys.version_info[:2] <= (3, 12):
        raise RuntimeError("Python 3.10 through 3.12 is supported")


def setup(group: str, device: str, yes: bool, registry: Mapping[str, Any] | None = None) -> Path:
    if not yes: raise ValueError("setup requires --yes (it changes an isolated environment)")
    if device not in ("cpu", "cuda"): raise ValueError("device must be cpu or cuda")
    _check_platform(); _group(group); load_registry() if registry is None else registry
    if group == "video-generation" and device == "cpu":
        raise ValueError("video generation requires --device cuda in this runner")
    if _available_bytes(cache_root()) < (3 if device == "cpu" else 8) * 1024**3:
        raise OSError("insufficient free disk for the isolated model runtime")
    target = _venv_dir(group); target.parent.mkdir(parents=True, exist_ok=True)
    device_record = target / ".ucas-device"
    if device_record.exists() and device_record.read_text().strip() != device:
        raise ValueError("existing environment uses another device; remove this group's venv before changing CPU/CUDA")
    if not (target / "bin" / "python").exists(): venv.EnvBuilder(with_pip=True).create(target)
    py = str(target / "bin" / "python"); req = ROOT / "requirements-ai" / f"{group}.txt"
    if not req.is_file(): raise FileNotFoundError(req)
    torch_index = "https://download.pytorch.org/whl/cpu" if device == "cpu" else "https://download.pytorch.org/whl/cu126"
    subprocess.run([py, "-m", "pip", "--isolated", "install", "--index-url", torch_index, "torch==2.7.1"], check=True)
    subprocess.run([py, "-m", "pip", "--isolated", "install", "--index-url", "https://pypi.org/simple", "-r", str(req)], check=True)
    device_record.write_text(device + "\n")
    return target


def download(group: str, accept_license: bool, yes: bool, registry: Mapping[str, Any] | None = None) -> bool:
    if not yes: raise ValueError("download requires --yes")
    if not accept_license: raise ValueError("download requires --accept-license: review and accept the model license")
    _group(group); registry = registry or load_registry(); model = registry["models"][group]; resources = model.get("resources", {})
    root = model_dir(group)
    missing = []
    for entry in model["files"]:
        target = _target(root, _safe_relative(entry["path"]))
        if not (target.is_file() and _hash_matches(target, entry)): missing.append(entry)
    remaining = sum(int(e["size"]) for e in missing); overhead = max((int(e["size"]) for e in missing), default=0)
    if _available_bytes(root.parent) < remaining + overhead + 256 * 1024 * 1024: raise OSError("insufficient free disk space for remaining model files")
    root.mkdir(parents=True, exist_ok=True); opener = urllib.request.build_opener(_OfficialRedirect())
    for entry in model["files"]:
        relative = _safe_relative(entry["path"]); target = _target(root, relative); target.parent.mkdir(parents=True, exist_ok=True)
        if target.is_file() and _hash_matches(target, entry): print(f"already valid: {relative}", file=sys.stderr); continue
        print(f"downloading: {relative} ({entry['size']} bytes)", file=sys.stderr)
        with opener.open(urllib.request.Request(_file_url(entry, model), headers={"User-Agent": "ucas-local-ai/1"}), timeout=60) as response:
            with tempfile.NamedTemporaryFile(dir=target.parent, prefix=f".{target.name}.", delete=False) as tmp:
                temporary = Path(tmp.name); total = 0; next_report = 256 * 1024 * 1024
                try:
                    while chunk := response.read(1024 * 1024):
                        total += len(chunk)
                        if total > entry["size"]: raise ValueError(f"download larger than manifest: {entry['path']}")
                        tmp.write(chunk)
                        if total >= next_report: print(f"  {relative}: {total} bytes", file=sys.stderr); next_report += 256 * 1024 * 1024
                    tmp.flush(); os.fsync(tmp.fileno())
                    if not _hash_matches(temporary, entry): raise ValueError(f"size or hash mismatch: {entry['path']}")
                    os.replace(temporary, target)
                finally: temporary.unlink(missing_ok=True)
    return verify_group(group, registry)


def doctor() -> dict[str, Any]:
    free = _available_bytes(cache_root().parent if cache_root().parent.exists() else Path.home()); ram = None
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemTotal:"): ram = round(int(line.split()[1]) / 1024**2, 1); break
    except OSError: pass
    return {"python": platform.python_version(), "supported_python": (3, 10) <= sys.version_info[:2] <= (3, 12), "platform": platform.platform(), "architecture": platform.machine(), "linux_x86_64_baseline": sys.platform.startswith("linux") and platform.machine() in ("x86_64", "AMD64"), "ram_gb": ram, "free_disk": _human(free), "nvidia_smi": shutil.which("nvidia-smi") is not None, "cache_root": str(cache_root())}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__); sub = parser.add_subparsers(dest="command", required=True)
    def group_parser(name: str, *, device=False):
        p = sub.add_parser(name); p.add_argument("--group", choices=GROUPS, required=True)
        if device: p.add_argument("--device", choices=("cpu", "cuda"), required=True)
        p.add_argument("--yes", action="store_true")
        if name == "download": p.add_argument("--accept-license", action="store_true")
        return p
    group_parser("plan"); group_parser("setup", device=True); group_parser("download"); group_parser("verify"); sub.add_parser("doctor")
    args = parser.parse_args(argv)
    try:
        if args.command == "plan": print(json.dumps(plan(args.group), indent=2)); return 0
        if args.command == "setup": setup(args.group, args.device, args.yes); print(f"ready: {_venv_dir(args.group)}"); return 0
        if args.command == "download": return 0 if download(args.group, args.accept_license, args.yes) else 1
        if args.command == "verify": return 0 if verify_group(args.group) else 1
        print(json.dumps(doctor(), indent=2)); return 0
    except (ValueError, OSError, RuntimeError, KeyError, subprocess.CalledProcessError) as exc: parser.error(str(exc))


if __name__ == "__main__": raise SystemExit(main())
