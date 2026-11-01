# Local-first assistance and resilient observation reads

The observation workspace now adds advisory data-quality assistance and a more resilient connection to the local Management API. Neither feature connects to Lattice, controls a platform, or provides a mesh network.

## AI stays local unless explicitly configured otherwise

`UCAS_AI_MODE=local` is the default. Without a configured model runtime, the service uses deterministic, source-grounded rules and labels them **rules, not a model**. This default makes no AI provider requests and requires no credentials. It does not pretend an AI model is installed.

For model dependencies, verified sources/licenses, five separately optional model groups, hardware/storage limits, pinned downloads and smoke commands, follow the [local-model setup guide](local-ai-setup.md). It installs an actual Qwen loopback runtime without automatic model downloads. Image/video generation and classification remain separate advisory smoke runners, not vehicle integrations.

For actual local model inference, run an OpenAI-compatible model server on this computer, bind it to loopback, and explicitly configure its runtime, base URL, and installed model:

```bash
UCAS_LATTICE_MODE=mock \
UCAS_AI_MODE=local \
UCAS_AI_LOCAL_RUNTIME=openai-compatible \
UCAS_LATTICE_AI_ENDPOINT=http://127.0.0.1:8080 \
UCAS_AI_LOCAL_MODEL=Qwen/Qwen3-0.6B \
python services/management-api/app.py
```

The adapter posts to the configured runtime's `/v1/chat/completions` endpoint. The base URL must be a literal loopback address with an explicit port; non-loopback destinations, credentials in the URL, redirects, and proxy routing are rejected. The runtime and model must be installed and operated separately. A local runtime is a trust boundary: configure it not to relay prompts to a hosted provider. Loopback HTTP is still a local network request; “no network calls by default” means the unconfigured rules default, not configured model inference.

`UCAS_LATTICE_AI_TIMEOUT` defaults to 45 seconds for local inference and is capped at 60; external inference retains a 2-second cap. The response reader checks its deadline between chunks and rejects oversized results. These socket/decode budgets are not a hard process-kill deadline; a stalled read can consume its socket timeout. The browser allows one 60-second assistance read, without inference replay, while overview/catalog responses update independently. Aborting the browser read does not kill server-side generation already in progress.

When local inference fails, times out, or produces an invalid result, the response explicitly reports an unavailable model and retains rules-based assistance. It never changes to an external provider.

## External AI is a separate opt-in

External mode sends an allowlisted aggregate data-quality payload off this computer. It must be chosen deliberately on the server; selecting a model or setting an API key alone cannot enable it. The workspace displays an external-data disclosure separately from local mode.

The supported external provider is OpenAI. Configure all of the following explicitly in the API process environment or a deployment secret manager:

```bash
UCAS_AI_MODE=external
UCAS_AI_EXTERNAL_PROVIDER=openai
UCAS_AI_EXTERNAL_CONSENT=true
UCAS_AI_EXTERNAL_MODEL=your-selected-model
# Set UCAS_AI_EXTERNAL_API_KEY through your environment/secret manager.
```

`UCAS_AI_EXTERNAL_CONSENT=true` acknowledges that the allowlisted payload will leave the local system. Requests go only to the fixed OpenAI chat-completions endpoint, not a caller-supplied destination. Credentials are server-side only: never put them in Git, a browser bundle, a `VITE_` variable, or a checked-in configuration file. There is no browser control that silently enables data export. Restart the API after changing provider settings.

Before enabling external mode, review the selected model's availability, provider data-handling terms, applicable authorization, and expected usage costs. No external provider call is needed to use or test the default workspace. A hosted provider outage reports failure and rules fallback, not success or a switch to another provider.

## What assistance can say

`GET /api/v1/lattice/assistance` returns a separately generated, read-only assistance snapshot. It reports the selected mode/provider, actual engine, model status, disclosure, source generation time, evidence-linked insights, and limitations. Its timestamp may differ from the overview's timestamp; neither is a new source observation.

Only bounded data-quality counts and known statement identifiers reach the model. Locations, entity names and IDs, raw records, weapon/effector inventory, control payloads, and free-form operator prompts are excluded. A model can select only supported data-quality statements; arbitrary model text is not displayed or executed. Invalid evidence, unexpected output, provider errors, and missing configuration fail back to clearly labeled rules. Review the source evidence and limitations before relying on any summary.

Assistance is advisory and requires human review. It cannot issue vehicle, sensor, or effector commands, alter readiness, rank threats, select targets, or provide operational recommendations. Existing read-only API restrictions remain in place. This is a local demonstration, not operational AI validation or production authorization.

## Resilience means the workspace-to-API link

The browser's observation client uses same-origin GET requests only, restricted to `/api/v1/lattice/`. Ordinary reads default to a four-second per-attempt timeout covering response-body decoding, at most three attempts, and bounded jittered backoff. Assistance instead uses one attempt with a 60-second budget for local CPU inference. Network/timeouts and selected transient HTTP failures are retried for ordinary reads; ordinary client errors and invalid JSON are not. Bounded `Retry-After` values are respected for throttling/unavailable responses. Requests are aborted on unmount or superseding refresh, and no write is replayed.

The browser retains the last successfully validated snapshot **in memory only** when a refresh fails. It marks the retained data **NOT CURRENTLY VERIFIED**, preserves its original receipt time and source timestamps, and never inserts replacement fixtures. No browser storage or service worker cache is added. Reloading the page loses the retained snapshot. An initial failure has no fallback data. A successful response with invalid structure is treated as failure, not an empty inventory.

Overview, assistance, catalog, and capability reads have independent success/error states. The workspace shows browser-reported connectivity separately from actual API-read success: an “online” event is not proof the API or any source is reachable. A browser reconnect triggers one fresh bounded read; there is no endless background retry loop.

This does **not** implement redundant transports, failover servers, peer discovery, mesh routing, distributed consensus, cross-site synchronization, offline write queues, or resilient aircraft communications. Source diagnostics continue to report no live source and no mesh. Future distributed networking needs a separate authorized design and validation effort.

The [evidence copilot](evidence-copilot.md) adds deterministic, exact local citations and a memory-only outage/return digest. It tracks source observation versions, duplicate responses, removals, and remaining uncertainty. It does not renew timestamps on return, restore removed records from old payloads, or apply an explanation to an unrelated evidence snapshot. Local citation details do not expand the external-provider export boundary: external inference still receives only redacted aggregate data-quality information. Deterministic findings remain available even when a model is absent or unavailable.

## Run the checks

```bash
python -m pytest -q
cd apps/management-web
pnpm test
pnpm typecheck
pnpm build
```

Automated provider tests use mocked local/external responses and verify gating, evidence, error handling, and no-call defaults. They do not demonstrate an installed model's quality, a real hosted-provider integration, Lattice compatibility, hardware behavior, or field networking. A real model/runtime requires a separate local acceptance test with the owner's chosen model. The localhost-first API still lacks production read authentication and rate limits; do not expose it publicly or load sensitive operational data.
