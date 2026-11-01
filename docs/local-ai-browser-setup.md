# Local AI browser setup API

The management API can optionally launch the checked-in local model setup script for a browser UI. This is a **local administrative feature**, not an inference endpoint. It is disabled unless both of these are set before the server starts:

```bash
export UCAS_AI_INSTALL_ENABLED=1
export UCAS_AI_INSTALL_TOKEN='at-least-32-characters-of-random-secret'
```

The token is sent as `Authorization: Bearer ...`. Every installer route authenticates it with a constant-time comparison. Do not put the token in a URL, browser history, source code, or a frontend bundle. Mutation requests additionally require `Content-Type: application/json`, an `Origin` in the configured allowlist, and a bounded JSON body. The API does not add CORS headers; it is intended for a same/local-origin development UI.

Configure exact comma-separated origins with `UCAS_AI_INSTALL_ORIGINS`. The default is:

```text
http://localhost:3000,http://127.0.0.1:3000,http://localhost:8000,http://127.0.0.1:8000
```

`*`, an absent Origin, and the browser `null` Origin are never accepted for mutations.

## Status

```http
GET /api/v1/local-ai/status
Authorization: Bearer <token>
```

The response is `{enabled,host,cacheRoot,groups,job}`. Each group reports the pinned registry `repo_id`, immutable `revision`, declared `license`, estimated `download_bytes`, current `free_bytes`, `free_enough`, `ram_gb`, `vram_gb`, warnings, `runtimeInstalled`, and a CPU/CUDA `device` marker or `null`.

Status intentionally reads registry metadata, the cache path, disk usage, and the isolated environment marker only. It **does not hash model weights on the API thread** and `runtimeInstalled` does not mean that inference is ready or that weights are present. Verification is always a job.

## Jobs

Create one job at a time:

```http
POST /api/v1/local-ai/jobs
Authorization: Bearer <token>
Content-Type: application/json
Origin: http://localhost:3000

{"group":"llm","device":"cpu","action":"install-download","acceptLicense":true}
```

The body must contain exactly those four fields. `group` is one of `llm`, `image-generation`, `video-generation`, `image-classification`, or `video-classification`; `device` is `cpu` or `cuda`; `action` is `install`, `download`, `install-download`, or `verify`. `acceptLicense: true` is mandatory for `download` and `install-download`; it is not a blanket acceptance for unrelated models.

A successful request returns **202** and a Job:

```json
{
  "id":"...", "group":"llm", "device":"cpu", "action":"verify",
  "state":"queued", "stage":"queued", "logs":[], "error":null
}
```

Poll with `GET /api/v1/local-ai/jobs/{id}`. A Job has `state` `queued`, `running`, `succeeded`, `failed`, or `cancelled`, a short `stage`, bounded `logs`, and a safe `error` string or `null`. Use `POST /api/v1/local-ai/jobs/{id}/cancel` with the same authentication and allowed Origin to cancel. Cancellation terminates the whole process group with SIGTERM and then SIGKILL if needed. Logs and errors never intentionally include the installer token.

Only fixed argument vectors invoking the repository's `scripts/local_ai_setup.py` through the server's `sys.executable` are allowed. No client-provided paths, URLs, shell fragments, or shell execution are accepted. The server runs at most one installer job globally, keeps bounded terminal history, and applies a bounded job timeout (`UCAS_AI_INSTALL_TIMEOUT_SECONDS`, default 3600 seconds).

The server process owns these jobs. **Jobs are ephemeral:** a restart loses job history and a running subprocess is not represented as resumable state. The user can start a fresh verify or install/download after restart. No model weights are downloaded by the API tests; tests monkeypatch subprocess execution.

## Setup CLI relationship

The job manager delegates to the pinned registry and setup CLI. The CLI is the authority for platform checks, isolated runtime installation, license-gated downloads, and manifest verification. The browser API does not expose inference, aircraft control, vehicle commands, or external AI providers.

## Separate inference workbench

Installation still does **not** run inference. The same workbench now includes a separate, explicitly submitted [local inference surface](local-ai-inference.md) for the five installed models. It additionally requires `UCAS_AI_INFERENCE_ENABLED=1` and the same administrator bearer token. Its routes live under `/api/v1/local-ai/inference`, not the installer job namespace above. They do not install dependencies or download weights. Source-grounded language answers and uploaded-media classifications remain advisory; generated demo media is visibly marked synthetic and is never appended to observation/evidence stores. There is no aircraft, effector, targeting, arming, tasking or engagement connection.
