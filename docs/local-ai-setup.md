# Practical local AI setup and safe Management API startup

Nothing here requires Lattice access. The observation workspace still starts with local deterministic rules, not an installed model. These optional groups add an actual local LLM runtime plus standalone image/video generation and classification smoke runners. They do not add live sensor ingestion, autonomous decisions, or vehicle/effector controls.

**No model weights download at app startup, during dependency setup, or in CI.** Installing dependencies and downloading a chosen model are separate explicit actions. The workbench can launch either action, or both in sequence, through the opt-in administrator installer API; the CLI remains available. External API inference remains a separate server-side opt-in and is never a local-model fallback.

## Start the reference API safely

The installer API is disabled by default. Start it only on the management host, with a long random administrator token and an explicit browser origin:

```bash
export UCAS_AI_INSTALL_ENABLED=1
export UCAS_AI_INSTALL_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
export UCAS_AI_INSTALL_ORIGINS=http://localhost:3000
export UCAS_API_HOST=127.0.0.1
python3 services/management-api/app.py
```

The reference API is HTTP-only for local development. Do **not** bind it to `0.0.0.0` or expose it to the internet. For a real network deployment, terminate HTTPS in a reviewed reverse proxy, restrict ingress to the operator network, and forward only the required API routes; the bundled server does not provide production TLS, account management, or internet-safe authentication. Keep the installer token out of shell history and do not use the isolated model environment to run the API.

Installer mutations are serialized with a persistent lock inherited by each setup/download subprocess, plus normal exit cleanup. If the API is forcibly killed, an inherited CLI may finish its current operation while retaining the lock; a new API process cannot start an overlapping mutation. A forced stop can still leave filesystem work partially completed, so inspect the job and cache before starting another mutation. The API will not automatically relaunch a job after restart.

## Launch from the browser

Open **Local AI workbench → Model Download and Installation**, connect using the installer administrator token, review the selected model and API-host resources, then explicitly launch installation or download. The browser operates on the **Management API host**, not your browser device. Follow the [browser installer setup guide](local-ai-browser-setup.md) to enable this capability; it is disabled by default. Inference and smoke tests remain separate.

## Choose only what your hardware can run

The installer baseline is **Linux x86-64, Python 3.10–3.12**, with `venv` and pip. CPU works for the LLM and both classifiers; image generation can run on CPU but is very slow. The supplied video-generation runner requires an NVIDIA CUDA GPU. Windows/macOS/ARM/MPS/ROCm are not supported by this installer; do not assume the commands work there.

Sizes below are the exact selected pinned snapshots rounded to decimal GB, not the entire upstream repository. RAM/VRAM and free-disk figures are conservative **planning estimates, not measurements or minimum guarantees**. RAM means available headroom for one runtime. Run one group at a time.

| Optional group | Model | Selected download | Plan available RAM | GPU guidance | Initial free-disk budget |
| --- | --- | ---: | ---: | --- | ---: |
| `llm` | Qwen3-0.6B | 1.519 GB | 6 GiB | Optional; roughly 3 GiB VRAM for short inputs | 8 GiB CPU; allow more for CUDA |
| `image-generation` | SSD-1B, fp16 snapshot | 4.469 GB | 16 GiB | 8 GiB+ recommended; large images may need more | 14 GiB |
| `video-generation` | Wan2.1 T2V 1.3B, full Diffusers snapshot | **28.929 GB** | **48 GiB free; 64 GiB installed recommended** | 16 GiB+ recommended with CPU offload; CUDA required | **42 GiB** |
| `image-classification` | ResNet-18 | 0.047 GB | 2 GiB | Optional; about 1 GiB VRAM planning allowance | 4 GiB CPU |
| `video-classification` | X-CLIP base patch32 | 0.790 GB | 6 GiB | Optional; about 3 GiB VRAM planning allowance | 6 GiB CPU |

Each group has its own environment: allow approximately **3 GiB for CPU dependencies or 8 GiB for CUDA dependencies**, plus pip caches and outputs. The table's free-disk budgets include a planning allowance, but CUDA packages and duplicated environments can exceed it. The installer checks actual remaining model bytes and temporary-file headroom separately. `plan` does not promise your GPU/RAM is adequate.

Wan's **1.3B name describes its denoising transformer, not the full bundle**: the selected T5 text encoder alone is about 22.7 GB. Its [official card](https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B-Diffusers) reports 8.19 GB VRAM and about four minutes for five seconds of 480p video on an RTX 4090 in the native runtime. That is **not a tested minimum for this Diffusers runner**. It uses model CPU offload, trading VRAM for substantial host RAM and transfer time. Diffusers can still move the whole BF16 T5 encoder onto the GPU during prompt encoding; this is why the recommendation is higher than the native-runtime benchmark. Machines with 8 GB GPUs or 16–24 GB system RAM should skip this group rather than expect it to work. BF16-capable NVIDIA hardware is preferred; the FP16 fallback on older CUDA hardware may be less numerically stable. No prompt-expansion API is enabled.

Check your computer before installing anything:

```bash
python3 scripts/local_ai_setup.py doctor
python3 scripts/local_ai_setup.py plan --group llm
python3 scripts/local_ai_setup.py plan --group video-generation
# For NVIDIA hardware, also inspect the real driver and VRAM:
nvidia-smi
```

`doctor` reports RAM, disk, architecture and whether `nvidia-smi` exists; it does not validate CUDA kernels or guarantee the model fits. The CUDA environment uses PyTorch's **cu126** wheels. Install a compatible NVIDIA driver yourself following [PyTorch's installation guidance](https://pytorch.org/get-started/locally/); the script does not install drivers or modify your system CUDA installation. Debian/Ubuntu may need `sudo apt install python3-venv` before creating environments. No Docker, Ollama, ffmpeg executable, Git LFS checkout, paid account or API key is required for these public snapshots.

## Install one group

Run these from the repository root. Keep `UCAS_AI_HOME` consistent between setup, download, and runtime shells:

```bash
export UCAS_AI_HOME="$HOME/.cache/ucas-ai"

# Dependencies only: no model download and no inference server started.
python3 scripts/local_ai_setup.py setup --group llm --device cpu --yes

# Review the source/license table below, then explicitly download this group.
python3 scripts/local_ai_setup.py download --group llm --accept-license --yes
python3 scripts/local_ai_setup.py verify --group llm

"$UCAS_AI_HOME/venvs/llm/bin/python" scripts/local_ai_run.py \
  smoke --group llm --device cpu
```

For another group, replace `llm` in both setup/download commands and the environment path. Choose `--device cuda` during setup and inference if you have suitable NVIDIA hardware; use CUDA for `video-generation`. Do not install all groups by default. Setup refuses CPU video-generation and unsupported platforms before changing an environment.

The CPU and CUDA variants use the same per-group environment path. To change device type, remove **only that group's environment** and rerun setup; model weights can remain. Do not reuse one group's environment for a different group. The script records the selected device after successful setup; after an interrupted install, remove the incomplete group environment before switching device type.

The layout is:

```text
$UCAS_AI_HOME/venvs/<group>/       # isolated Python runtime
$UCAS_AI_HOME/models/<group>/     # exact pinned model snapshot
$UCAS_AI_HOME/outputs/            # suggested location for local smoke outputs
```

Changing `UCAS_AI_HOME` moves all three paths. A relocated drive needs sufficient free space; cache/model/venv symlinks are rejected. A missing or corrupted snapshot fails closed before loading a model. To remove a group, stop its process and delete only its `venvs/<group>` and `models/<group>` directories. No model is copied into Git or the application bundle.

## Start the local LLM and connect the workspace

Start the verified model on literal loopback only:

```bash
export UCAS_AI_HOME="$HOME/.cache/ucas-ai"
"$UCAS_AI_HOME/venvs/llm/bin/python" scripts/local_ai_run.py \
  serve-llm --host 127.0.0.1 --port 8080 --device cpu
```

Loading and hash verification can take time. In another shell:

```bash
curl --fail http://127.0.0.1:8080/health
curl --fail http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"Qwen/Qwen3-0.6B","messages":[{"role":"user","content":"Reply with a brief greeting."}],"max_tokens":32}'
```

Health becomes ready only after the model is loaded. The runner limits input to 2,048 tokens/4,096 prompt characters, output to 400 tokens, and generation to a requested 55-second stopping budget. That generation budget is checked between decoding steps, not a hard process-kill deadline. It is a small demonstration model: valid constrained JSON is **not guaranteed**. The workspace validates every result and labels rules assistance when model output is invalid or late.

Then start the Management API using the project's normal API Python environment, **not** the isolated LLM environment:

```bash
UCAS_LATTICE_MODE=mock \
UCAS_AI_MODE=local \
UCAS_AI_LOCAL_RUNTIME=openai-compatible \
UCAS_AI_LOCAL_MODEL=Qwen/Qwen3-0.6B \
UCAS_LATTICE_AI_ENDPOINT=http://127.0.0.1:8080 \
UCAS_LATTICE_AI_TIMEOUT=45 \
python services/management-api/app.py
```

The local provider defaults to 45 seconds, configurable up to 60. The browser allows one 60-second assistance attempt rather than replaying expensive inference; overview and catalog reads finish independently. Slow inference cannot block those UI reads. Aborting a browser request does not forcibly terminate inference already running on the server. A busy runner returns 503 rather than queuing another generation. Never expose either development server publicly; this is not a production authenticated inference service. Browser-origin requests to the model server are rejected, and the browser talks only to the Management API.

The workspace forwards only aggregate data-quality counts, never coordinates, identifiers, imagery, raw records, weapon/effector inventory or free-form operator prompts. The local runner does not call an external model. If you choose some other loopback-compatible server, its own routing behavior is your separate trust boundary. See [assistance and networking boundaries](observation-assistance-networking.md).

## Smoke-test the other groups

First run `setup`, `download`, and `verify` separately for the desired group, as above. These commands **do not download missing models**:

```bash
export UCAS_AI_HOME="$HOME/.cache/ucas-ai"
mkdir -p "$UCAS_AI_HOME/outputs"

"$UCAS_AI_HOME/venvs/image-generation/bin/python" scripts/local_ai_run.py \
  smoke --group image-generation --device cuda \
  --output "$UCAS_AI_HOME/outputs/image-smoke.png"

"$UCAS_AI_HOME/venvs/video-generation/bin/python" scripts/local_ai_run.py \
  smoke --group video-generation --device cuda \
  --output "$UCAS_AI_HOME/outputs/video-smoke.gif"

"$UCAS_AI_HOME/venvs/image-classification/bin/python" scripts/local_ai_run.py \
  smoke --group image-classification --device cpu \
  --output "$UCAS_AI_HOME/outputs/image-classification-fixture.png"

"$UCAS_AI_HOME/venvs/video-classification/bin/python" scripts/local_ai_run.py \
  smoke --group video-classification --device cpu \
  --output "$UCAS_AI_HOME/outputs/video-classification-fixture.gif"
```

The image smoke uses a fixed benign geometric prompt, 256×256 pixels and two inference steps. Video uses nine 256×256 frames and two steps, written as a GIF through Pillow—no ffmpeg download or hosted encoder. These deliberately tiny settings exercise loading and inference, **not visual quality**. They are project smoke settings, not publisher-validated quality presets. For Wan's published quality example, consult its card's 832×480 / 81-frame settings and budget substantially more memory/time.

The classifiers create deterministic geometric RGB fixtures locally: one image or eight frames with a moving shape. No public dataset, camera stream, aircraft image, or video file is downloaded. ResNet emits ImageNet class scores; X-CLIP compares the fixture against three fixed text candidates. Its scores are relative to that candidate set, **not calibrated certainty or an operational interpretation**. Correct-looking scores on meaningless geometry are not an accuracy test. Classification outputs are advisory JSON; generated media and fixtures stay in the chosen local output path.

Only the LLM is wired to the workspace's bounded data-quality assistance. Media models are standalone optional smoke/inference modules, **not UI media ingestion or command capabilities**. Nothing generated or classified is linked to a vehicle, sensor or effector control path.

## Verified model sources and licenses

The exact file allowlist, byte sizes, immutable revisions and expected content hashes are checked in at [`configs/local-ai-models.json`](../configs/local-ai-models.json). Source/model cards and code repositories are distinct: a code license alone does not establish a checkpoint's license.

| Group | Official Hugging Face ID and pinned revision | Publisher/model-card license | Source on GitHub |
| --- | --- | --- | --- |
| LLM | [Qwen/Qwen3-0.6B](https://huggingface.co/Qwen/Qwen3-0.6B/tree/c1899de289a04d12100db370d81485cdf75e47ca) · `c1899de289a04d12100db370d81485cdf75e47ca` | Apache-2.0; full LICENSE is included in the snapshot | [QwenLM/Qwen3](https://github.com/QwenLM/Qwen3) |
| Image generation | [segmind/SSD-1B](https://huggingface.co/segmind/SSD-1B/tree/60987f37e94cd59c36b1cba832b9f97b57395a10) · `60987f37e94cd59c36b1cba832b9f97b57395a10` | Publisher card and repository declare Apache-2.0; retain teacher/base-model provenance caveat | [segmind/SSD-1B](https://github.com/segmind/SSD-1B), Apache-2.0 |
| Video generation | [Wan-AI/Wan2.1-T2V-1.3B-Diffusers](https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B-Diffusers/tree/0fad780a534b6463e45facd96134c9f345acfa5b) · `0fad780a534b6463e45facd96134c9f345acfa5b` | Apache-2.0 on the model card | [Wan-Video/Wan2.1](https://github.com/Wan-Video/Wan2.1), Apache-2.0 |
| Image classification | [microsoft/resnet-18](https://huggingface.co/microsoft/resnet-18/tree/65a5785d9156231087c481e0c7dd33a5ff6f7e3e) · `65a5785d9156231087c481e0c7dd33a5ff6f7e3e` | Apache-2.0 on HF card; original ResNet research repository is MIT, not the license source for this exact converted checkpoint | [KaimingHe/deep-residual-networks](https://github.com/KaimingHe/deep-residual-networks) |
| Video classification | [microsoft/xclip-base-patch32](https://huggingface.co/microsoft/xclip-base-patch32/tree/a2e27a78a2b5d802e894b8a1ef14f3a8ce490963) · `a2e27a78a2b5d802e894b8a1ef14f3a8ce490963` | MIT on HF card; original VideoX source is MIT | [microsoft/VideoX / X-CLIP](https://github.com/microsoft/VideoX/tree/master/X-CLIP) |

HF cards for ResNet/X-CLIP disclose they were written by the Hugging Face team rather than the original research authors. License metadata is not a legal opinion or a guarantee about all training-data, likeness, trademark or downstream content rights. Preserve model cards, attribution and applicable license/NOTICE text when redistributing. SSD-1B's declared Apache license is not a blanket claim that every SDXL teacher, dataset or upstream component is Apache-licensed. The installer requires `--accept-license` for every selected group.

VideoMAE and TimeSformer Kinetics checkpoints were considered but not selected because their published cards impose **CC BY-NC-4.0** terms. X-CLIP avoids that non-commercial restriction. No automatically chosen model substitution is implemented.

## Runtime versions and source checks

Direct dependencies are pinned per group in [`requirements-ai/`](../requirements-ai/): PyTorch 2.7.1, Transformers 4.53.3, Diffusers 0.35.1 where needed, Accelerate 1.10.1, Safetensors 0.6.2, Hugging Face Hub 0.34.4, NumPy 2.2.6, Pillow 11.3.0 where needed, and tokenizer dependencies. CPU/CUDA PyTorch comes first from the selected official PyTorch index; other packages come from PyPI. Transitive dependencies are not a fully hash-locked reproducible environment; capture your validated environment with `pip freeze` before deployment and review updates/security advisories.

The [Qwen card](https://huggingface.co/Qwen/Qwen3-0.6B) requires Transformers ≥4.51.0. The [SSD card](https://huggingface.co/segmind/SSD-1B) specifies `StableDiffusionXLPipeline`, safe weights and `variant="fp16"`; its older instructions suggest installing Diffusers from source. This setup instead pins a released Diffusers version that contains that pipeline and [`WanPipeline`](https://github.com/huggingface/diffusers/tree/v0.35.1/src/diffusers/pipelines/wan). Wan's native runtime requires torch ≥2.4.0. ResNet and X-CLIP are built-in Transformers architectures in the [pinned runtime source](https://github.com/huggingface/transformers/tree/v4.53.3/src/transformers/models). No third-party model Python code executes through `trust_remote_code`.

Downloads use only explicit `download` commands, HTTPS publisher URLs and pinned revision paths, with official Hugging Face/CDN redirect restrictions. Every file is allowlisted, size-checked, and checked against HF's published LFS SHA-256 or Git blob SHA-1. Downloads use a temporary file and atomic rename; interrupted or corrupt files are not accepted. Rerun to reuse fully verified files; partial files are redownloaded, not byte-resumed. No arbitrary `.bin`/pickle checkpoints or remote `.py` files are installed. This detects corruption/substitution relative to the checked-in manifest; it does **not** independently prove that an upstream model is benign or that a compromised publisher signed its release.

Runtime forces offline/telemetry-disabled Hub settings and uses `local_files_only=True`, `trust_remote_code=False`, and safetensors for all model loads. Those flags prevent this code's implicit Hub downloads; they are not an OS-level firewall. Use a firewall or network-isolated acceptance environment when independently auditing egress. There is no automatic fallback to another local checkpoint or an external API.

## Tests and acceptance limits

Normal tests use mocks and synthetic fixtures, never download or load multi-GB checkpoints:

```bash
python -m pytest -q tests/test_local_ai_setup.py \
  tests/test_local_ai_run.py tests/test_local_ai_models_contract.py \
  tests/test_observation_assistance.py
```

Run real smoke commands only after explicitly downloading the chosen groups on suitable hardware. Unit tests verify installer/source/hash behavior, safe local loading contracts and advisory boundaries. They do not establish numerical quality, GPU fit, model accuracy, CUDA driver compatibility, or operational suitability. Real GPU/model acceptance is intentionally not part of CI.
