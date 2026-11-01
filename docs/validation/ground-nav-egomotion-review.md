# Ground ego-motion model: constrained offline inclusion

## Decision

The supplied model is included as a **separate, local-only ground-vehicle review tool**, not as a navigation replacement or part of the application runtime. It is never routed to Warden-NAV, UAV/aircraft profiles, live navigation, planning, vehicle control, missions, or effectors. The model file is not included in Git, is not downloaded, and must be manually supplied and SHA-256 verified.

The ONNX model is CUDA-only: the runner requests NVIDIA CUDA and disables ONNX Runtime's CPU execution-provider fallback. If an operator explicitly enables `--allow-cpu-baseline-fallback`, the tool may instead return a clearly labeled, independently implemented CPU kinematic baseline when the CUDA model is unavailable or abstains. That fallback does **not** load or run the supplied model or its weights on CPU, does not claim calibrated uncertainty, and is not a silent substitution.

This includes a useful ground-only review path without silently accepting a broader operational or licensing scope. It does not resolve the trained model's legal rights; only operators with verified authorization may use it.

## Provenance and license

The user-provided bundle identifies the training source as NVIDIA PhysicalAI-Autonomous-Vehicles egomotion labels and reports 46 chunks with a chunk-level split. That provenance is owner-reported and has not been independently reproduced. The bundle does not contain a standalone model license that clarifies the trained artifact's permitted use.

The [NVIDIA Autonomous Vehicle Dataset License Agreement](https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA_Autonomous_Vehicle_Dataset_License_Agreement.pdf) and [dataset card](https://huggingface.co/datasets/nvidia/PhysicalAI-Autonomous-Vehicles) limit dataset use to internal autonomous-vehicle/ADAS development using NVIDIA technology and restrict redistribution of dataset materials. The agreement also treats dataset outputs and benchmark results as confidential. Accordingly, this repository does not include the dataset, training/evaluation scripts, weights, or benchmark figures. A model-specific rights determination remains outstanding; the command-line attestation is not a grant of rights and does not replace license review.

The model runtime requires NVIDIA's [CUDA Execution Provider](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html). It is pinned to `onnxruntime-gpu==1.26.0`; the official compatibility table specifies CUDA 12.8 and cuDNN 9.x for that package line. The actual driver, runtime libraries, and GPU must be supplied and verified by the operator. Setup does not install a GPU driver or model weights. The CPU baseline is a separate standard-library implementation and does not use NumPy, ONNX Runtime, or learned weights.

## Model and local input/output

The supplied ONNX model is **914,359 bytes**, SHA-256 `f0d825222bfcefc1e4c670da5124dc6083832c15229c31ab249c192f613de562`. The hash and size are pinned in [`configs/ground-ego-motion-artifact.json`](../../configs/ground-ego-motion-artifact.json) and the local-AI registry. The model uses a history tensor of 20 samples × 9 motion features at 10 Hz. The offline CLI accepts one CSV with the exact header `timestamp_s,vbx,vby,yaw_rate,abx,aby,curvature,pitch,roll,vz`, requires exactly 20 finite rows with 10 Hz timestamps, and does not read absolute coordinates.

The CUDA model outputs a 30-step, 3-second trajectory in the vehicle frame at the end of the supplied history, plus model-supplied x/y sigma values. These are relative displacements, not a global position or corrected current pose. The sigma values are not independently validated confidence intervals or safety bounds. The artifact has no supplied OOD detector; the CLI validates format, finiteness and sample spacing, not whether values are in the model's training domain. The supplied description also says the model has no road or future-control input and cannot anticipate a turn before it begins.

The CPU baseline uses only recent forward speed, longitudinal acceleration, and yaw rate to produce a separate constant-turn-rate/acceleration forecast. It marks its status as `baseline_fallback`, sets sigma values to `null`, and reports the fallback reason. This is a conventional kinematic reference, not the learned model and not an accuracy claim.

## Use and limits

The runner requires an explicit `ground_vehicle` profile, a ground-input provenance attestation, and an attestation that the operator has rights to use the model for authorized internal AV/ADAS development with NVIDIA technology. By default, a missing CUDA model causes a clear failure. The optional `--allow-cpu-baseline-fallback` switch explicitly permits the separate baseline when CUDA model setup/inference is unavailable or abstains; every report identifies whether the GPU model or CPU baseline produced the forecast. The runner has no API or adapter to the management application, Warden-NAV, vehicle buses, or control systems. Output reports must be written outside the repository checkout.

The model's benchmark figures from the supplied report are intentionally not reproduced here because the source agreement treats dataset-related benchmark results as confidential. The reported evaluation was not independently reproduced. The supplied bundle says the model was not validated for closed-loop control; this repository provides no field, vehicle-in-the-loop, or operational validation.

The archive was inspected as untrusted content. No included training script, binary, dataset, or model weights were executed or loaded. This PR adds a new local offline path only; it does not change the existing Warden-NAV implementation or its advisory-only boundaries.
