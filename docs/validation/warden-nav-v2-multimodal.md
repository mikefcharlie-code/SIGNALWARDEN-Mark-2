# Warden-NAV v2 multimodal model: offline review only

## What it does

This experimental model scores a manually selected PX4 `.ulg` log in an offline review command. It analyzes 30-second windows at 5-second steps using up to five modalities: GNSS, inertial, barometer, magnetometer, and estimator telemetry. Its ONNX inputs are a 34-value feature vector and a five-bit modality mask; it returns four class logits (nominal and three telemetry-pattern labels). The artifact note describes five small per-modality experts combined only across modalities present, with 38,520 parameters. The ONNX file is 279,780 bytes and uses opset 17.

The runtime is CPU-only (`onnxruntime==1.31.1`); the bundle provides no measured latency or minimum-RAM benchmark. The offline reader needs NumPy and `pyulog==1.3.0`. These package/runtime requirements are separate from the model weights.

Raw latitude/longitude can be read transiently from the explicitly selected local log to compute relative features. They are not passed to the model as absolute coordinates and are not serialized in the report. The model does not estimate, correct, or replace a position/navigation solution.

## Results are preliminary

All figures below are copied from the supplied model note and evaluation JSON; this repository change did not rerun the model or independently reproduce these results.

- On 29 held-out PX4 Flight Review flights, the authors report 24 false alerts among 988 nominal windows (2.4%). The note says some “nominal” windows may contain real GNSS degradation and were not hand-verified.
- On live test set 1, the authors report zero false alerts in 90 nominal windows, 5 of 14 attack windows detected, and 4 of 14 typed correctly.
- For live spoofing specifically, the model reportedly detected 1 of 4 windows and correctly typed 0 of 4; the detected spoofing pattern was called jamming-like. Spoof-versus-jam typing on live RF remains unresolved.
- On a held-out simulated set, the authors report zero false alerts across 501 nominal windows and 6 of 6 simulated spoofing windows detected and typed. This is not evidence of field performance.

The live attack evidence is only three flights and 14 attack windows. The model note also says the simulated estimator modality has more training examples than real estimator responses, and injected attacks do not rerun the PX4 estimator. Treat every result as a telemetry-pattern hint, not proof of an attack, a verified detection, a calibrated confidence, or a safety state. The runtime checks OOD before emitting a class label and abstains on invalid inputs, missing modalities, or a crossed threshold; however, the supplied max-standardized-feature limit is 1248.28, unusually high and not independently validated as an effective novelty screen. A configured gate is not proof that real-world OOD cases will be caught.

## Provenance and license status

The supplied notes report training on 100 public PX4 Flight Review logs, 12 UAV Attack Dataset simulated logs, and 13,867 windows. Live UAV Attack Dataset logs were reportedly held out for evaluation. The repository does not include those logs, training scripts, or dataset manifests in this integration.

The [IEEE DataPort dataset page](https://ieee-dataport.org/open-access/uav-attack-dataset) describes account-gated “Open Access” downloads but does not display an explicit reuse license. The [PX4 Flight Review repository](https://github.com/PX4/flight_review) has a BSD-3-Clause license for its software; that license does not establish reuse rights for individual user-uploaded logs. The supplied model manifest itself says `NOASSERTION`. Accordingly, model/data rights remain unresolved: no weights or raw data are redistributed here, and users must establish that they have the necessary rights before local use or further sharing. A SHA-256 pin verifies file identity, not ownership, provenance, or license.

The other supplied model, `ground-nav-egomotion`, is included in a separate ground-vehicle-only offline path. Its learned ONNX inference is CUDA-only; an explicitly enabled CPU fallback is a separate standard-library kinematic baseline and never runs the learned model on CPU. Model-specific rights remain unresolved, and it is not wired to UAV profiles or Warden-NAV. See the [ground model review](ground-nav-egomotion-review.md) for its artifact hash, license constraints, and validation limits.

## Manual local setup

The model is never downloaded automatically and is not committed to Git. Only the exact supplied ONNX artifact and calibration JSON are accepted, each checked against a pinned SHA-256 and size in [`configs/warden-nav-mm-artifact.json`](../../configs/warden-nav-mm-artifact.json) and the local model registry. The registry’s `download` command must refuse this group.

```bash
export UCAS_AI_HOME="$HOME/.cache/ucas-ai"
python3 scripts/local_ai_setup.py plan --group navigation-integrity-multimodal
python3 scripts/local_ai_setup.py setup --group navigation-integrity-multimodal --device cpu --yes
mkdir -p "$UCAS_AI_HOME/models/navigation-integrity-multimodal"
cp /path/to/warden-nav-mm.onnx "$UCAS_AI_HOME/models/navigation-integrity-multimodal/"
cp /path/to/calibration.json "$UCAS_AI_HOME/models/navigation-integrity-multimodal/"
python3 scripts/local_ai_setup.py verify --group navigation-integrity-multimodal
"$UCAS_AI_HOME/venvs/navigation-integrity-multimodal/bin/python" scripts/warden_nav_mm_review.py \
  --log /path/to/selected-flight.ulg --airframe-family multicopter \
  --attest-input-provenance
```

The review accepts one local `.ulg` file, requires an operator-supplied airframe family, and blocks network access while parsing and scoring. It does not read live telemetry, create application/API events, upload logs, or fuse results with the existing deterministic baseline. JSON output omits log paths and coordinates. If saved with `--output-json`, the report must be a new path outside the checkout.

## Explicit boundary

This model is a separate local review aid, not a replacement for the current Warden-NAV position solution or baseline. The baseline and existing UI/API behavior remain unchanged. No result is wired to live navigation, command dispatch, arming, control, mission planning/upload, effectors, targeting, or source localization. No model output authorizes a flight or action.
