# Warden-TH synthetic prototype

Warden-TH is a local, advisory telemetry-health prototype. This first slice uses only the project’s seeded synthetic fault generator; it has not used private logs or public datasets. It does not write telemetry, reports, or canonical observations. Anomaly and endurance events are evidence-linked advisory projections, and the local inference boundary rejects command, mission, target, effector, or flight-authorization fields. The separate civilian command capability is unchanged.

## What is implemented

The synthetic generator produces reproducible nominal and fault scenarios. The feature builder creates a fixed 120-second window at 2 Hz (240 samples) and preserves per-channel values, presence/missingness, age/freshness, and telemetry trust labels. The deterministic rule baseline is shown next to an optional tiny CPU ONNX model; low-presence windows below 60% abstain. The telemetry-inspector panel shows the window, baseline findings, learned findings or abstention, evidence-channel and sequence references, and battery-endurance bands. Its synthetic evaluation banner displays the current held-out stream metrics and whether the spec targets were met.

The prototype and synthetic metric summary are not field, flight, or SITL validation. See [`configs/warden-th-artifact.json`](../configs/warden-th-artifact.json) for the artifact hashes and latest evaluation. Weights are intentionally not committed. The checked-in hash manifest and local model registry describe availability, not an installed model.

## Train or reproduce the artifact

Install only the training dependencies in an isolated environment, then write outputs outside the checkout:

```bash
python3 -m venv /tmp/warden-th-training
/tmp/warden-th-training/bin/python -m pip install -r requirements-ai/telemetry-health-training.txt
/tmp/warden-th-training/bin/python scripts/warden_th_train.py \
  --seed 73021 --train-seeds 32 --validation-seeds 60 \
  --output-dir /path/to/external/warden-th-artifacts
```

The output directory contains `warden-th.onnx`, `calibration.json`, and `manifest.json`. The trainer uses independent seeded train, calibration, and evaluation ranges; its replay evaluation uses 120-second windows at 5-second strides. `weights_in_git` is false. Do not copy the ONNX file into the repository.

## Make the model available locally (manual; no weight download)

From the repository root, inspect the plan and install the CPU runtime. This installs the pinned Python runtime only; the model weights are not fetched:

```bash
python3 scripts/local_ai_setup.py plan --group telemetry-health
python3 scripts/local_ai_setup.py setup --group telemetry-health --device cpu --yes
```

Manually place the two files from the external training output in the local cache and verify their size and SHA-256 against the registry:

```bash
mkdir -p ~/.cache/ucas-ai/models/telemetry-health
cp /path/to/external/warden-th-artifacts/warden-th.onnx \
   /path/to/external/warden-th-artifacts/calibration.json \
   ~/.cache/ucas-ai/models/telemetry-health/
python3 scripts/local_ai_setup.py verify --group telemetry-health
```

The default cache can be changed with `UCAS_AI_HOME`; when changing it, use the same value for setup, copying, verification, and the app. The inference status reports the group unavailable until both files and the pinned local CPU runtime are present. Hash checks run again before inference. There is no remote inference path, implicit weight download, or fallback to another model. The app’s existing local-AI feature gate and authenticated job lifecycle still apply.

## Dependency review

See [`docs/warden-th-dependency-audit.md`](warden-th-dependency-audit.md) for package pins, transitive license identifiers, external package documentation, and vulnerability-audit results. The project has not selected an open-source license, so the generated model is labeled `NOASSERTION`; this is not a grant of reuse rights.
