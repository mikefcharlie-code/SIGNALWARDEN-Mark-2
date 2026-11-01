# ADR 0007: Warden-NAV navigation-integrity advisory

**Status:** Proposed in PR #28; not merged or deployed.

**Decision scope:** A receive-only, synthetic-development slice of Warden-NAV.

## Context

Warden-NAV compares the aircraft's own navigation telemetry for internal consistency. A fused position stream can appear self-consistent even when the estimator has absorbed a slow input error; this model therefore detects observable disagreements and stale or contradictory receiver state, not every navigation fault. It is not a GNSS-denied navigation aid and cannot establish that the reported position is correct.

## Decision

The service uses a fixed 120-second window at 2 Hz (240 slots). A deterministic residual layer calculates 5/15/30-second position-versus-integrated-velocity residuals, vertical-rate residuals using the NED `vz` convention, wrapped heading/yaw difference, MSL-relative offset drift, course-versus-heading when speed and airframe gates allow it, GPS fix/satellite inconsistency, GPS/position age divergence, receiver-state transitions, fresh-but-stuck receiver state, and sequence/timestamp replay indicators. Missing fields stay missing; the response carries presence, coverage, age, freshness, trust, airframe, and sequence evidence explicitly.

The deterministic baseline always runs beside any learned result. Its development thresholds are fixed in `services/warden_nav/baseline.py`: position residuals 5/12/20 m at 5/15/30 seconds, vertical-rate residual 0.25 m/s, MSL-relative drift 5 m, heading/yaw difference 45°, plus receiver-state, freshness, presence, and replay checks. These are prototype thresholds, not aircraft limits or operational alarms.

Autopilot `armed` and `custom_mode` presence plus adjacent transition counts are retained as scalar window diagnostics. A mode transition alone does not create an alert, and these discrete fields are not yet features of the learned head.

An optional compact linear softmax head is exported as ONNX and runs only through the explicitly installed, CPU-only local inference group. It is intentionally a smaller first slice than the proposed temporal-convolution/reconstruction architecture: there is no learned residual-group head, no self-supervised masked-reconstruction loss, no flight-hour hysteresis state, and no hardware-derived per-airframe normalization. A maximum-standardized-feature OOD gate and nominal class-score gates cause abstention; class output is described as pattern resemblance, never confidence, cause, or source attribution. The baseline remains visible even when the learned head abstains or disagrees.

The API and UI demo create only server-side seeded synthetic scenarios. They do not read aircraft records or accept client telemetry, feature vectors, file paths, or aircraft history. The operator panel is read-only in Telemetry Inspector and shows residual traces, missingness/age/trust, baseline evidence, advisory events, and optional local ONNX status. Events are response-only and cite time/sequence ranges. No event changes canonical telemetry or observations.

## Location privacy and safety boundary

Raw latitude and longitude are used only inside the transient residual calculation to form a window-relative local frame. They are dropped before a window, feature vector, finding, event, API response, trace, or UI payload is constructed. Warden-NAV emits neither a raw absolute coordinate nor a corrected position or navigation solution.

The package and API have no path to MAVLink transmit, the civilian command gateway, control, arming, mission planning/upload, or actuators. No direction-finding, interference-source attribution/localization, or targeting is performed. `untrusted_ingress` is a provenance/trust label, not a spoofing-like pattern; an unauthenticated source can forge every observed field. Low field presence, stale/unknown navigation ages, unknown airframe, untrusted ingress, and OOD inputs fail closed or abstain as applicable.

## Training, weights, and evidence

Only reproducible seeded synthetic scenarios with randomized synthetic origins are used in this pass for training, nominal calibration, OOD calibration, and held-out evaluation. No private operational telemetry, public log, external AI provider, live hardware, SITL/flight test, or deployment was used. Public logs remain out of scope until a separate license review. The manifest `configs/warden-nav-artifact.json` and model registry pin SHA-256 values for the ONNX file and calibration JSON; neither file is committed. The training script refuses an output directory inside the checkout.

To provision weights manually, generate them to an external directory with `scripts/warden_nav_train.py`, create `~/.cache/ucas-ai/models/navigation-integrity/`, copy the two files there, then run:

```sh
python3 scripts/local_ai_setup.py setup --group navigation-integrity --device cpu --yes
python3 scripts/local_ai_setup.py verify --group navigation-integrity
```

The registry marks the group `local-only`; its download command must refuse rather than fetch weights. Runtime packages have separate exact pins in `requirements-ai/navigation-integrity.txt`, while ONNX exporter packages are isolated in `requirements-ai/navigation-integrity-training.txt`. Package dependencies are not model weights.

Every count, score, precision/recall/F1, coverage figure, and parity result in the artifact manifest is labeled synthetic/SITL-development evidence only and is not operational validation. The deterministic baseline is reported alongside the learned head. The known blind spot is a slow spoof or estimator error that remains internally self-consistent; underlying mapper telemetry also lacks raw GNSS coordinates, accuracy, and barometric pressure for independent sensor cross-checks.

## Deferred work and next gate

This slice does not implement event hysteresis, a persistent per-aircraft sliding-window service, learned autopilot-mode or tilt/acceleration features, a Fleet Explorer badge, evidence-copilot/report citation, Tracegate readiness integration, a temporal-convolution encoder, or SITL/flight validation. None is implied to be ready. Any later use of non-synthetic data, additional event integration, operational threshold, or navigation-adjacent interface needs separate review and explicit approval; licensing and per-airframe calibration must precede public-log or hardware-derived data use.
