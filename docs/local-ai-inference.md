# Local AI inference: five explicit, advisory workflows

The AI workbench can now submit actual local inference jobs, not just installation commands. No model runs on page load. Each job requires its installed group runtime and pinned model files; it never installs packages, downloads weights, or selects an external provider. This route remains local even if a different advisory feature is configured for an external provider.

## What each model does

| Group | Workflow | Returned result |
| --- | --- | --- |
| `llm` | Qwen3-0.6B selects source-grounded text for an observation summary or question. | An **extractive** answer assembled only from validated exact source quotes, with record/time citations. Free-form model prose is not published. Empty context or unsupported model claims produce abstention; missing models/runtime failures produce errors. |
| `image-generation` | SSD-1B turns a demo/training prompt into a bounded 256×256 image. | PNG with a visible **SYNTHETIC DEMO/TRAINING** banner. |
| `video-generation` | Wan2.1 T2V 1.3B generates a short demo from a text prompt. | Nine-frame 256×256 animated GIF, with the synthetic banner on every frame. CUDA is required. |
| `image-classification` | ResNet-18 classifies an uploaded PNG/JPEG. | Up to five ImageNet class names and softmax scores. These are not validated drone-observation classes. |
| `video-classification` | X-CLIP compares an uploaded GIF/MP4 with a fixed benign label set. | One bounded whole-clip interval with class scores from eight sampled frames. No object tracking, frame-level localization, or operational labels. |

The X-CLIP labels are fixed server-side: “a geometric shape moving”, “a nature scene”, “a person walking”, and “a static pattern”. Clients cannot supply custom labels. Similarity/softmax scores are **not calibrated confidence or physical truth**.

All results are advisory. There are no aircraft, weapon/effector, targeting, arming, tasking, or engagement connections. Inference code has no observation/evidence write path. Generated artifacts remain in a separate private job directory, never enter the sensor stream, and cannot be selected as canonical observation records. Uploaded media has unverified provenance; a classifier result does not establish that it is real sensor data. Qwen responses preserve an explicit warning when their cited sources are synthetic fixtures.

## Enable deliberately

Use the [installation guide](local-ai-setup.md) or [browser installer](local-ai-browser-setup.md) to install the chosen group and accept its license **before** inference. Run `doctor`, `plan`, and `verify` for that group. CPU is supported except for Wan; select the device matching the installed runtime. CUDA requires a compatible GPU/runtime and enough free VRAM. Registry RAM/VRAM/disk budgets are conservative estimates, not performance guarantees.

Start the Management API with:

```bash
export UCAS_AI_INSTALL_ENABLED=1
export UCAS_AI_INFERENCE_ENABLED=1
# Set UCAS_AI_INSTALL_TOKEN to a random secret of at least 32 characters.
# Do not commit it or put it in a URL or frontend bundle.
export UCAS_AI_MODE=local
python services/management-api/app.py
```

The inference form uses the **same administrator bearer credential** as installation, entered separately and kept only in component memory. Use HTTPS outside loopback. Every mutation needs an exact allowed `Origin`, JSON content type, and bounded Content-Length; null/missing origins, transfer encoding, query tokens, client paths/URLs/provider controls, and arbitrary context text are rejected. Configure origins with `UCAS_AI_INSTALL_ORIGINS`; the default development origins are localhost/127.0.0.1 on ports 3000 and 8000. This is a local reference/admin surface, not a multi-user authorization system.

## Browser flow and limits

Choose a group/device, enter the administrator token, and click **Check readiness**. Status is a cheap presence check, explicitly shown as **files present — validation pending**. It does not hash large files or load models on the API thread. On submission the worker validates media, verifies every pinned file hash, checks host resources, and invokes the group's isolated Python environment. No installed files means `model_not_installed`; unavailable dependencies/device/resources fail locally, with no external fallback.

For Qwen, enter a question and up to eight evidence record IDs visible in the observation view or returned by `GET /api/v1/lattice/overview` → `assessment.evidence`. The API resolves their canonical source data and times itself. Unknown IDs fail; records without a value/time or with canonical text exceeding 600 characters are omitted, never silently truncated. No usable context yields abstention. The rendered Qwen input must fit 2,048 tokens and output is capped by the existing 400-token runner.

| Input | Limit |
| --- | --- |
| Prompt | 2,000 characters |
| Upload | 8 MiB decoded; complete JSON request ≤12 MiB |
| Image | PNG/JPEG, one frame, ≤4,096 per side and ≤16 million pixels |
| Video | GIF/MP4, ≤10 seconds, ≤1,280×720, ≤300 decoded frames |
| Generation | 256×256; video nine frames; two denoising steps for a deliberately small demo |

Video is decoded locally and retained frames are downscaled before X-CLIP sampling. MP4 decoding restricts FFmpeg protocols to local file/pipe input; inconsistent duration/frame-rate metadata is rejected. Use constant-frame-rate MP4 for predictable whole-clip timing. GIF timing uses frame durations. This is clip classification, not accurate temporal action localization.

Queued/running jobs expose stage/state and can be cancelled. Cancellation terminates the process group, escalating from SIGTERM to SIGKILL. `UCAS_AI_INFERENCE_TIMEOUT_SECONDS` defaults to 300 seconds and is capped at 900, including waiting for the shared installer lock. The shared lock has a service-owned 0700 directory and 0600 file; a custom `UCAS_AI_INSTALL_LOCK` also needs a private parent directory. Installation and inference cannot mutate/use the same runtime concurrently.

## API examples

All endpoints are under `/api/v1/local-ai/inference`. `$TOKEN` below is the existing administrator token; `$RECORD_ID` is a real ID from the current canonical evidence view, not a generated job/artifact ID.

```bash
BASE=http://127.0.0.1:8000/api/v1/local-ai/inference
curl -fSs -H "Authorization: Bearer $TOKEN" "$BASE/status"

python -c 'import json,os; print(json.dumps({"group":"llm","device":"cpu","prompt":"Quote the selected source observations and abstain if unsupported.","recordIds":[os.environ["RECORD_ID"]]}))' > /tmp/qwen-job.json
curl -fSs -H "Authorization: Bearer $TOKEN" \
  -H 'Origin: http://localhost:3000' -H 'Content-Type: application/json' \
  --data-binary @/tmp/qwen-job.json "$BASE"

# Copy the returned ID. Poll; cancellation is a separate explicit action.
JOB_ID='returned-job-id'
curl -fSs -H "Authorization: Bearer $TOKEN" "$BASE/jobs/$JOB_ID"
curl -fSs -H "Authorization: Bearer $TOKEN" \
  -H 'Origin: http://localhost:3000' -H 'Content-Type: application/json' \
  --data '{}' "$BASE/jobs/$JOB_ID/cancel"

# Only succeeded generation jobs have artifacts; use the returned MIME type.
curl -fSs -H "Authorization: Bearer $TOKEN" \
  -o SYNTHETIC-demo.bin "$BASE/jobs/$JOB_ID/artifact"
```

Create requests contain `group`, `device`, and only the fields for that workflow: Qwen `prompt`/`recordIds`; generators `prompt`; classifiers `media: {name, data}` where `data` is raw base64 without a data-URL prefix. The API ignores filenames as paths and validates content signatures and actual decoding. Create returns HTTP 202. Job results include `advisory`, `synthetic`, `kind`, and workflow-specific `answer`/`citations`/`abstained`, `artifact`/`mime`, `topk`, or `clips`. Citations use `{record_id,timestamp}`; clips use `{start_seconds,end_seconds,topk}`. Artifact bytes are authenticated, bounded, and returned with no-store, nosniff and synthetic headers; the browser fetches a private blob rather than putting credentials in a URL.

## Real local smoke commands for all five models

These commands execute the **actual new inference adapters** once runtimes and weights have been installed and verified. They were not run with model weights as part of this change. From the repository root, set `UCAS_AI_HOME` and ensure all five group venvs exist. The commands below assume CPU runtimes except Wan; change each request's device to match your installed runtime if needed. A GPU/large-memory host is required for Wan's preflight.

First create small clearly synthetic fixtures and absolute-path requests using the installed image-classification environment (Pillow is already part of that runtime):

```bash
export UCAS_AI_HOME="${UCAS_AI_HOME:-$HOME/.cache/ucas-ai}"
"$UCAS_AI_HOME/venvs/image-classification/bin/python" - <<'PY'
import json
from pathlib import Path
from PIL import Image
root = (Path.cwd() / 'artifacts' / 'local-inference-smoke').resolve()
root.mkdir(parents=True, exist_ok=True)
image = root / 'synthetic-input.png'
video = root / 'synthetic-input.gif'
frames = [Image.new('RGB', (224, 224), (20*i, 40, 120)) for i in range(8)]
frames[0].save(image)
frames[0].save(video, save_all=True, append_images=frames[1:], duration=100)
requests = {
 'llm': {'device':'cpu', 'prompt':'Quote the fixture status.', 'context':[{'record_id':'synthetic-fixture-1','timestamp':'2025-01-01T00:00:00Z','text':'This is a synthetic training fixture.','synthetic':True}]},
 'image-generation': {'device':'cpu', 'prompt':'A simple blue geometric shape on a white background'},
 'video-generation': {'device':'cuda', 'prompt':'A blue geometric shape moving slowly on white'},
 'image-classification': {'device':'cpu', 'input':str(image)},
 'video-classification': {'device':'cpu', 'input':str(video)},
}
for group, fields in requests.items():
    output = root / group
    output.mkdir(exist_ok=True)
    (root / (group + '.request.json')).write_text(json.dumps({'group':group,'output_dir':str(output),**fields}))
print(root)
PY

SMOKE_ROOT="$(pwd)/artifacts/local-inference-smoke"
for GROUP in llm image-generation video-generation image-classification video-classification; do
  python scripts/local_ai_setup.py verify --group "$GROUP" || break
  timeout --signal=TERM --kill-after=5s 300 \
    "$UCAS_AI_HOME/venvs/$GROUP/bin/python" scripts/local_ai_infer.py \
    --request "$SMOKE_ROOT/$GROUP.request.json" \
    --result "$SMOKE_ROOT/$GROUP.result.json" || break
  cat "$SMOKE_ROOT/$GROUP.result.json"
  printf '\n'
done
```

Direct CLI paths must be absolute. It accepts trusted local `context` records, unlike the browser/API, which resolves source records itself. The shell `timeout` above is important: API-managed jobs enforce timeout/cancellation, but a standalone CLI process relies on its caller for a hard deadline. A Qwen smoke may safely abstain if it cannot emit valid claims; that does not prove model quality.

## Tested versus unvalidated

CI uses fake adapters and mocked framework loaders, never model weights or GPU inference. It checks all five result contracts, quote/citation validation and abstention, installed/unavailable errors, actual small image/GIF/MP4 decoding, malformed/oversized input refusal, resource refusals, offline loader options and a subprocess network guard, authenticated API actions, process timeout/cancellation, credential isolation and synthetic artifact separation. Lightweight codec packages in development dependencies are not ML frameworks.

Real weights, output quality, latency, GPU compatibility and peak memory remain **unvalidated**. The two-step generation settings are a bounded integration demo, not a quality benchmark. Job state is process-local: run a single reference API process (no multi-worker routing). At most 20 records are retained; one-hour expiry is checked lazily on subsequent status/read/submission calls and at normal shutdown. Input uploads/source snapshots are removed after completion. Hard crashes can leave private temporary directories requiring administrator cleanup; jobs are not resumable. No deployment or production-readiness claim is made.
