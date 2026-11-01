# Scene analyst: evidence before inference

The World View **Scene analyst** answers bounded natural-language questions about data already loaded in the browser. Its default is local deterministic analysis: no model, installation, provider key or WebGL is required to ask questions. The assistant is advisory and read-only, including for PX4 and ArduPilot. It cannot identify people, enrich identities, rank targets, task weapons or control aircraft.

## What operators can do

Use the question presets to summarize enabled layers around the current camera, compare reported events and conditions, examine loaded observation history, inspect source quality, or draft a briefing. The nearby-radius control sets the geographic scope; the analyst adds optional from/to times and a selected-record history filter. Imported packs and explicit feed refreshes supply observations. History is bounded to 1,000 retained session samples plus the current loaded records; each analysis uses at most the 80 most recent matching samples and clearly discloses bounded counts. It is not an archive or continuous tracker. Importing a new pack clears retained history. Synthetic replay remains synthetic.

**Load platform context** explicitly reads the same-origin overview assessment. This remains the reference mock/offline platform dataset, not a live aircraft connection. Without this step, the analyst does not invent platform evidence. Failed reads retain evidence as unverified. Platform facts have field-level record/source/time citations and preserve trust, freshness and synthetic labels.

Calculated satellite passes are local SGP4 geometry from a user-supplied TLE, not sightings or visibility predictions. Pass context is supplied only while the camera matches the observer location used for calculation. Recalculate after moving the camera. Weather forecasts are forecasts, earthquakes are reported events, and contacts are provider observations; comparison does not imply causation or operational suitability.

## Grounding and drafts

Every factual finding is built from typed, allowlisted query tools and includes exact citations. Click a citation in **Grounding & provenance** to inspect record ID, source, observation time, freshness, synthetic status and evidence detail. Unknown layers, unsupported requests, missing evidence, provider failures and contradictory reports result in warnings or abstention rather than invented answers. A fresh label requires actual matching fresh connector data; a recently generated synthetic record is never a live feed.

Annotations are operator notes, not evidence. Saved notes can provide context for a briefing but cannot validate facts. **Draft annotation** stages an advisory note for review before saving it separately from observation records. **Export briefing draft** creates a Markdown advisory draft containing findings, citations, uncertainty and model disclosure. The analyst never promotes its own output into verified evidence. Scope or evidence changes mark the existing answer historical and disable draft export until the operator asks again.

## Local model versus deterministic fallback

| Configuration | Actual behavior |
|---|---|
| No administrator token or no configured local runtime | Deterministic cited queries and templates. No model inference. Questions make no network calls. |
| Installed Qwen alone, but no running/configured endpoint | Still deterministic. Installation is not proof of inference readiness. |
| Installed Qwen served locally, valid administrator token, and configured loopback endpoint/model | The fixed same-origin analyst API asks the model to order/highlight existing cited candidate findings. It cannot author factual prose, choose tools or create citations. All deterministic findings remain visible. To fit the existing runner, at most 12 eligible candidate findings are presented to the model within a 4,096-character prompt; omitted findings still remain in the answer. |
| Invalid or unavailable model / invalid selected IDs / timeout | Explicit deterministic fallback with status. Never an external fallback. |
| Explicit external selection plus browser export consent and server configuration/consent | One configured external provider may organize the candidate findings. The question and candidate text with citation identifiers leave the system; any sensitive values contained in those findings are included. Raw packs and tokens are not part of the model prompt. |

To use the existing installed local Qwen runtime, follow [local AI setup](local-ai-setup.md), then serve the installed model with its isolated Python environment:

```bash
"$UCAS_AI_HOME/venvs/llm/bin/python" scripts/local_ai_run.py serve-llm \
  --host 127.0.0.1 --port 8080 --device cpu
```

Start the management API with the existing local-AI administrator authorization/origin configuration and:

```bash
UCAS_AI_LOCAL_MODEL=Qwen/Qwen3-0.6B
UCAS_LATTICE_AI_ENDPOINT=http://127.0.0.1:8080
```

Enter the administrator token under **Model & privacy settings**; it stays in component memory, not local storage, URLs or exported reports. The analyst's explicit local mode ignores the general external-mode environment setting. Only literal loopback local endpoints are accepted; redirects and proxies are disabled. No endpoint, URL, SQL, shell command, arbitrary network fetch or vehicle instruction can be supplied by the model. This is a reference API, not production read authorization; do not expose it publicly.

External AI is disabled unless the operator selects it and consents in the panel **and** the server has `UCAS_AI_EXTERNAL_PROVIDER=openai`, `UCAS_AI_EXTERNAL_CONSENT=true`, `UCAS_AI_EXTERNAL_MODEL`, and `UCAS_AI_EXTERNAL_API_KEY`. The external URL is fixed in server code. Consent is not inferred from provider keys. Local mode never silently exports data. Model output is reduced to allowlisted candidate IDs; provider-authored text is discarded.

## Cancellation and speech

**Cancel analysis** aborts the browser request and rejects late model output. Local provider requests have a maximum 60-second timeout; external calls use a short bounded timeout. The server-side provider call may continue until its timeout after browser cancellation. Cancellation does not terminate an installed model server. Changing model mode, token, consent or scene scope invalidates an outstanding answer update.

Browser speech is separate and off by default. Its disclosure explains that the browser's speech service may send audio outside the system even when analysis is local. A transcript is staged for review. The safe UI parser accepts only bounded layer toggles, local place/camera navigation and annotation drafts; queries are staged before execution. It rejects operational, identity, surveillance and weapon instructions. Typed questions remain available when speech is unsupported or denied.

## Data and rendering limits

The analyst is not a global search index or universal chatbot. It cannot fetch new sources on its own. USGS, NOAA/NWS and adsb.lol must first be explicitly refreshed with the existing provider-network opt-in; coverage, issuance time, staleness and failure metadata survive analysis. No new feed or provider credential is configured by this feature. Vessels, traffic, cameras, ALPR locations and fires remain synthetic/imported unless a separately reviewed adapter exists. Other proposed providers still require adapter implementation, source/license review and, where applicable, keys.

WebGL is needed for the 3D globe presentation, not the analyst tools or the existing 2D fallback. No new imagery, terrain, license-restricted data or upstream visual asset is introduced. See the [capability matrix](gods-eye-capability-coverage.md) and [source coverage](worldview-data-sources.md).

## Verification

Focused engine tests cover unknown layers, stale/failing providers, contradictory sources, offline/old records, unsupported questions, record/source/time citations, model-free no-network behavior, voice filtering and scoped comparisons/history/briefings. Transport tests cover explicit external consent, same-origin routing, cancellation, response validation and citation-preserving draft export. Server tests cover authorization, bounded input, loopback-only local calls, external consent gates, invalid output and provider failure. These checks describe local/reference behavior. The scene analyst is included in main through PR #18 (merge commit `b68d913`); no deployment or operational readiness is established by that merge.

### Validation in this checkout

The full suite passed with **132 frontend tests** and **523 backend tests**, along with TypeScript and the production build. The build retains the existing large globe-chunk warning. Browser checks exercised cited summaries/provenance, unsupported-query abstention, explicit platform-context loading, unsafe voice rejection, annotation drafting/review and separation from observation evidence. Model-free questions generated no API requests. WebGL could not initialize here; the existing 2D fallback and analyst worked. Qwen weights were not installed in this environment, so actual Qwen inference and external-provider behavior were not exercised against real models: model selection/egress/timeout and runner-input contracts were tested with fixtures. Existing live adapters were not broadened, and no provider keys, live aircraft connection, merge or deployment were performed.
