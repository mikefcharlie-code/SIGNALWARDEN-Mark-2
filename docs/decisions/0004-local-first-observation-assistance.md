# 0004 — Local-first observation assistance and bounded API resilience

**Status:** Proposed; implemented for local review, not accepted for production or operational use.

## Context

The owner requested AI support and resilient networking on the existing read-only observation workspace, without Lattice developer or sandbox access. AI must run locally by default, with external AI available only through explicit provider configuration and data-export consent. No feature may issue vehicle or effector commands.

## Decision

Keep observation projection and attention deterministic. Add a separate read-only advisory endpoint. Default to local mode with no provider requests and honestly labeled rules when no local model is configured. Support an explicitly configured loopback OpenAI-compatible runtime and a separate, explicitly consented OpenAI external mode. Store credentials only in process environment/configuration secrets. Never silently switch from local to external or between providers.

Minimize inputs to aggregate non-tactical data-quality evidence, excluding entity identifiers, locations, raw records, and informational weapon/effector inventory. Constrain model output to validated evidence-backed statements; never execute or display arbitrary model instructions. Report engine/status and data-export disclosure independently from the observation source's connectivity. All outputs remain advisory and human-reviewed.

Implement browser-to-API resilience through same-origin GET allowlisting, bounded timeouts/retries/backoff, cancellation, reconnect-triggered refresh, response validation, and clearly labeled memory-only retention. Do not claim mesh, redundant links, distributed synchronization, or resilient aircraft networking.

Provide separately optional local LLM, image/video generation and image/video classification setup groups from verified GitHub/Hugging Face sources. Pin checkpoint revisions and file hashes; separate dependency setup from explicit weight downloads; force local-only safe model loading. Only bounded LLM assistance is wired to the workspace. Media models remain standalone advisory smoke runners, with synthetic fixtures and no sensor/vehicle/effector control integration. Unit tests mock every model path and do not download weights in CI.

## Alternatives

A required hosted model would violate the local-first requirement. Silently relaying a failed local request to an external provider would violate consent and data boundaries. Unconstrained model chat over raw observations would increase disclosure and instruction-injection risks. A full distributed mesh or live Lattice adapter cannot be validated with the current access and scope.

## Consequences

The project does not bundle a model, guarantee inference quality, or claim provider/hardware compatibility. A separately installed local runtime must be configured not to relay data externally. External consent in server configuration is an operator decision and must precede enabling that mode. The reference API remains localhost-first without production read authentication or rate limiting; external mode is not approval to expose it publicly. Model quality, operational acceptance, production access controls, provider terms, and any future network transport require separate review.

## Evidence

See [assistance and networking configuration](../observation-assistance-networking.md), [local-model installation and limits](../local-ai-setup.md), the pinned model manifest, backend assistance/installer/runner tests, frontend transport/state tests, and PR #18 validation notes. Provider/model tests are mocked; no real hosted-provider, installed-weight, GPU or operational validation is implied.
