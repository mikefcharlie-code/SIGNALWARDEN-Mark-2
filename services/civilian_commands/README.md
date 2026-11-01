# Civilian command gateway interface

This separate reference module never starts with the Management API and never transmits MAVLink. It needs an independently implemented civilian HTTPS bridge. No bridge, aircraft endpoint, or hardware has been exercised. Read the [safety boundary](../../docs/civilian-operator-commands.md) and [proposed decision](../../docs/decisions/0005-civilian-operator-commands.md) before reviewing deployment.

## Trusted configuration

Configuration must be an owned regular `0600` JSON file. Actor keys and bridge status keys are separate, unique, nonzero 32-byte owned `0600` files; TLS CA, client certificate, and client key files must also be owned regular `0600` files. Their safely read bytes are pinned at process creation, included in the ledger binding, and used directly or through private temporary snapshots for OpenSSL; they are not reopened from the original paths at send time. The state directory is owned `0700`, state and lock files are `0600`, and only one process may own the ledger. This is a POSIX, single-threaded CLI/reference library; the live transport requires the main thread and an unused real-time signal timer for its total-operation timeout. It does not launch background senders. The maximum five-second timeout bounds each HTTPS exchange, not a whole multi-exchange run; command/run authorization expiry independently prevents new command sends.

This is a schema illustration only; it is deliberately disabled and contains no working credentials or endpoints:

```json
{
  "enabled": false,
  "bounded_runs_enabled": false,
  "deployment": "unique-reviewed-civilian-deployment",
  "actors": {
    "example-operator": {
      "kind": "human-operator",
      "key_file": "/protected/operator.key",
      "aircraft": ["example-civilian-aircraft"],
      "actions": ["hold", "return_home", "land"],
      "allow_bounded_runs": false
    }
  },
  "aircraft": {
    "example-civilian-aircraft": {
      "classification": "civilian",
      "status_key_file": "/protected/bridge-status.key",
      "endpoint": {
        "host": "civilian-bridge.invalid",
        "port": 443,
        "path": "/civilian/v1",
        "ca_file": "/protected/bridge-ca.pem",
        "client_cert": "/protected/operator-client.pem",
        "client_key": "/protected/operator-client.key",
        "timeout": 2
      }
    }
  }
}
```

Unknown configuration fields are rejected. `bounded_runs_enabled` and each actor's `allow_bounded_runs` default to false and must both be explicitly true for a run. HTTPS endpoints are deployment-controlled, never request-controlled. HTTP, redirects, proxy fallback, disabled certificate verification, and optional-client-certificate modes do not exist. Timeout must be greater than zero and at most five seconds. Unique deployment IDs and separate credentials must not be reused across environments.

The ledger binds configuration and actual key fingerprints. Credentials/policy are loaded at process creation, not hot-reloaded. Stop the process to revoke access; key/policy changes require a separately reviewed state/key migration, not deletion or rollback of the current ledger. Do not restore an older ledger under the same credentials. The state inode is checked around SQLite opening and before ledger writes. The owned directory and cooperative exclusive lock assume a trusted OS account: the protected local audit/replay ledger is not a tamper-proof archive against root, a malicious same-account process, or offline rollback. Disk capacity, retention, backups, clock integrity, and OS access remain deployment responsibilities.

## Signed command

An exact envelope contains `version` (integer `1`), `deployment`, `actor`, `aircraft`, `command_id`, `sequence` (nonnegative increasing 63-bit integer per actor), `issued_at`, `expires_at` (finite Unix seconds), `action`, `initiation` (exactly `operator`), and `signature`. Identifiers use 1–128 ASCII letters/digits/underscore/dot/colon/hyphen, beginning with a letter or digit. Actions are exactly `hold`, `return_home`, or `land`. There is no parameters or confirmation field.

`signature` is unpadded canonical base64url HMAC-SHA256 of the canonical UTF-8 JSON body without `signature`: sorted keys, compact separators, no NaN/Infinity, non-ASCII characters unescaped. `sign_request(body, operator_key)` is the trusted operator-tool helper. Duplicate JSON keys, unknown fields, unsigned requests, boolean numeric values, nonfinite times, expiry, future skew beyond two seconds, and lifetimes over 30 seconds are rejected. Normalized JSON values, not the caller's original whitespace, are signed.

Every accepted request atomically reserves its identity/sequence and records durable intent before transport. Replay and out-of-order sequences fail across restart. Missing/corrupt/mismatched state, lock contention, unavailable storage, or unavailable audit fails closed. `--initialize-state` is only for a new ledger; it refuses an existing ledger.

## Bridge exchange

All messages use POST to the one pinned path with bounded JSON responses, verified server TLS, and a client certificate. The bridge must implement these contracts independently:

| Exchange | Exact fields |
|---|---|
| Gateway readiness query | `kind: "status_request"`, `deployment`, `aircraft`, `command_id`, `action` |
| Signed readiness response | `deployment`, `aircraft`, `command_id`, `action`, `classification: "civilian"`, `allowed_actions`, `ready: true`, `issued_at`, `expires_at`, `signature` |
| Gateway command | `kind: "command"`, `request` (signed command body without signature), `signature` (operator signature) |
| Signed receipt | `deployment`, `actor`, `aircraft`, `command_id`, `action`, `accepted: true`, `issued_at`, `expires_at`, `signature` |
| Gateway completion query | `kind: "completion_request"`, `deployment`, `actor`, `aircraft`, `command_id`, `action` |
| Signed completion response | `kind: "completion"`, `deployment`, `actor`, `aircraft`, `command_id`, `action`, `completed` (boolean), `issued_at`, `expires_at`, `signature` |

Bridge signatures use the separate aircraft's status key and the same canonical JSON/HMAC encoding. Responses must match request identity and action, be fresh, and have at most 30 seconds' validity. Readiness and completion must not predate the command authorization. `allowed_actions` may contain only the fixed civilian allowlist. The bridge must independently enforce operator signatures, authorization, durable replay/deadlines, reviewed enrollment, and aircraft-local readiness/failsafes. A gateway cannot enforce an unimplemented or dishonest bridge's physical behavior.

## Explicitly authorized bounded runs

A run authorization contains exactly `version: 1`, `deployment`, `actor`, `aircraft`, `run_id`, `issued_at`, `expires_at`, `commands`, and `signature`. `commands` is a fixed list of **one to three already operator-signed command envelopes**, for one actor and one aircraft, with unique command IDs, strictly increasing sequences, and expiry contained within the run. The whole run lasts at most **30 seconds**. No extension, dynamic action selection, planner, model call, future schedule, automatic retry, or resume is supported.

`sign_plan(body, operator_key)` in `supervisor.py` signs the entire fixed plan with the separate domain prefix `civilian-bounded-run-v1` followed by a zero byte. There is no endpoint that automatically signs a plan or treats an AI/service identity as a human operator. Protect access to the operator signing tool and credentials; a signature proves key possession, not a human's physical presence.

The supervisor validates every command before starting, reserves the run durably, emits status, and applies the full individual-command gates before each send. It advances only after a fresh, signed, command-correlated completion report, **not** after receipt alone. Reported completion is still not independent proof of physical execution. Receipt/completion results retain `physical_success: false`.

The CLI supports `--request` for one signed envelope or `--run` for one signed run, alongside `--config`, `--state`, and optional one-time `--initialize-state`. Input may be a JSON file or `-` for bounded stdin. `--run` emits flushed JSONL state transitions on stdout for operator monitoring and writes attributed state transitions to the protected audit. Losing the status observer stops further dispatch. Operator tooling must keep this stream visible during execution; this reference supplies no remote monitoring dashboard or unattended deployment.

Press **Ctrl-C** to interrupt the CLI, or call `BoundedRunSupervisor.abort()` in an embedding operator tool. The cancellation gate is checked after readiness, immediately before send, between commands, and during bounded completion polling. The live CLI's signal also interrupts the active call. A library abort stops subsequent sends once an active bounded call returns (at most the configured transport timeout). It does not recall a command already received by the bridge and never fabricates a fallback aircraft command. Expiry/abort/unknown outcomes stop the run; no retries or restart recovery occur. Aborted or uncertain actions require operator reconciliation with the bridge/aircraft.

## Local validation only

Run `.venv/bin/pytest -q tests/test_civilian_commands.py tests/test_civilian_bounded_runs.py`. All command tests inject mocks; HTTPS behavior is tested with an in-process fake connection, not a service. Existing receive-only telemetry/security regressions must also pass. No command transport was connected to real services or hardware, and this code is not deployment or flight approval.
