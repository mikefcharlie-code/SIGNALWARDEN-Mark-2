#!/usr/bin/env python3
"""Review one local PX4 ULog with the experimental Warden-NAV v2 model.

This is an offline, read-only analysis tool. It accepts no live telemetry,
never uploads data, never invokes a command/mission interface, and emits only
coordinate-free advisory pattern hints. A model must already be manually
provisioned and hash-verified; there is no download or fallback path.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parents[1]
GROUP = "navigation-integrity-multimodal"
MAX_LOG_BYTES = 128 * 1024 * 1024
MAX_WINDOWS = 10_000

LIMITATIONS = [
    "Experimental offline advisory only; not flight-, field-, SITL-, or operationally validated.",
    "The supplied evaluation is owner-reported, uses only 14 live attack windows across three flights, and is not independently reproduced here.",
    "All four live spoofing windows in the supplied evaluation were labeled as jamming; real spoof-versus-jam typing remains unresolved.",
    "The supplied maximum-standardized-feature OOD limit is 1248.28, unusually high and not independently validated as an effective OOD screen.",
    "Some Flight Review windows used as nominal training/evaluation data were not verified as truly nominal; calibration may be optimistic or contaminated.",
    "The IEEE DataPort landing page shows account-gated open access but no explicit dataset reuse license; rights for individual Flight Review uploads are also unclear.",
    "Raw GNSS coordinates are consumed transiently to calculate relative features but are not included in model inputs, reports, or output files.",
    "No deterministic-baseline fusion is performed; no position correction, navigation solution, alert authorization, command, mission, or effector action is produced.",
]


def _disable_network() -> None:
    """Install the project's network-denial guard before loading parsers/models."""
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    from scripts.local_ai_infer import _deny_network

    _deny_network()


def _check_log(path: Path) -> Path:
    if path.is_symlink():
        raise ValueError("refusing a symlink as the input log")
    if path.suffix.lower() != ".ulg":
        raise ValueError("input must be one local .ulg file")
    try:
        info = path.stat()
    except OSError as error:
        raise ValueError(f"cannot access input log: {error}") from error
    if not path.is_file():
        raise ValueError("input must be a regular file")
    if info.st_size <= 0 or info.st_size > MAX_LOG_BYTES:
        raise ValueError(f"input log must be between 1 byte and {MAX_LOG_BYTES} bytes")
    return path.resolve()


def _load_model():
    from scripts.local_ai_setup import load_registry, model_dir, verify_group
    from services.warden_nav.multimodal.model import MultimodalNavModel

    registry = load_registry()
    entry = registry.get("models", {}).get(GROUP)
    if not isinstance(entry, dict) or entry.get("distribution") != "local-only":
        raise RuntimeError("Warden-NAV v2 is not registered as a local-only model")
    manifest_path = ROOT / "configs" / "warden-nav-mm-artifact.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    expected_files = {
        manifest["artifact_file"]: (manifest["size_bytes"], manifest["sha256"]),
        manifest["calibration_file"]: (manifest["calibration_size_bytes"], manifest["calibration_sha256"]),
    }
    registered_files = {item["path"]: (item["size"], item["sha256"]) for item in entry.get("files", [])}
    if registered_files != expected_files:
        raise RuntimeError("Warden-NAV v2 registry and artifact manifest disagree")
    if not verify_group(GROUP, registry):
        raise RuntimeError(
            f"Warden-NAV v2 is missing or failed hash verification; manually copy the two pinned files to {model_dir(GROUP)} and run local_ai_setup.py verify --group {GROUP}"
        )
    model = MultimodalNavModel(
        model_dir(GROUP),
        expected_sha256=manifest["sha256"],
        expected_size_bytes=manifest["size_bytes"],
        expected_calibration_sha256=manifest["calibration_sha256"],
        expected_calibration_size_bytes=manifest["calibration_size_bytes"],
    )
    return model, manifest


def build_report(results: Iterable[dict[str, Any]], *, airframe_family: str,
                 model_sha256: str, calibration_sha256: str, input_attested: bool,
                 model_loaded: bool, ood_limit: float,
                 abstention_reason: str | None = None) -> dict[str, Any]:
    rows = list(results)
    statuses = Counter(str(row.get("status", "unknown")) for row in rows)
    patterns = Counter(str(row["pattern"]) for row in rows if row.get("status") == "pattern")
    return {
        "schema_version": "1.0",
        "model_id": "warden-nav-multimodal-v2",
        "model_sha256": model_sha256,
        "calibration_sha256": calibration_sha256,
        "ood_limit_max_standardized_feature": ood_limit,
        "offline_log_review": True,
        "local_only": True,
        "advisory_only": True,
        "model_loaded": model_loaded,
        "review_status": "abstained" if abstention_reason else "complete",
        "abstention_reason": abstention_reason,
        "input_provenance": "operator-attested local file; not cryptographically verified" if input_attested else "unknown",
        "input_trust": "operator-attested; not independently verified" if input_attested else "unknown",
        "airframe_family_supplied_by_operator": airframe_family,
        "freshness_policy": "each contributing modality and explicit land/armed flight-state stream must have a sample no older than 5 seconds at the window end; stale modalities are masked; this heuristic is not operationally validated",
        "baseline_fusion": "not_run",
        "windows_analyzed": len(rows),
        "status_counts": dict(sorted(statuses.items())),
        "pattern_counts": dict(sorted(patterns.items())),
        "window_assessments": rows,
        "safety_boundary": {
            "raw_coordinates_emitted": False,
            "corrected_position_or_navigation_solution_emitted": False,
            "live_telemetry_or_vehicle_interface_used": False,
            "command_or_mission_action_issued": False,
            "effector_action_issued": False,
        },
        "limitations": LIMITATIONS,
    }


def review(log_path: Path, airframe_family: str, *, input_attested: bool) -> dict[str, Any]:
    """Load one user-selected local log and return a coordinate-free report."""
    if not input_attested:
        raise ValueError("explicit --attest-input-provenance is required; the attestation does not cryptographically verify the log")
    _disable_network()
    safe_log = _check_log(log_path)
    import numpy as np

    from services.warden_nav.multimodal.features import (
        CONTEXT_SLICE, MODALITIES, MODALITY_SLICES, flight_state_freshness,
        iter_window_ends, modality_freshness, window_features,
    )
    from services.warden_nav.multimodal.streams import load_streams

    streams = load_streams(safe_log)
    ends: list[float] = []
    for end in iter_window_ends(streams):
        ends.append(float(end))
        if len(ends) > MAX_WINDOWS:
            raise ValueError(f"log exceeds the {MAX_WINDOWS}-window review limit")
    manifest = json.loads((ROOT / "configs" / "warden-nav-mm-artifact.json").read_text(encoding="utf-8"))
    if not ends:
        return build_report([], airframe_family=airframe_family, model_sha256=manifest["sha256"],
                            calibration_sha256=manifest["calibration_sha256"], input_attested=True,
                            model_loaded=False, ood_limit=manifest["ood_limit_max_standardized_feature"],
                            abstention_reason="no_window_with_fresh_explicit_in_air_evidence_or_sufficient_log_span")
    model, manifest = _load_model()
    results: list[dict[str, Any]] = []
    for index, end in enumerate(ends):
        feature_vector, modality_mask = window_features(streams, end, airframe_family)
        freshness = modality_freshness(streams, end)
        for modality_index, name in enumerate(MODALITIES):
            if freshness[name]["status"] != "fresh":
                modality_mask[modality_index] = 0.0
                feature_vector[MODALITY_SLICES[name]] = np.nan
        if freshness["gnss"]["status"] != "fresh":
            feature_vector[CONTEXT_SLICE.start] = np.nan
        result = model.assess(feature_vector, modality_mask)
        results.append({
            "window_index": index,
            "window_end_seconds_since_boot": round(end, 3),
            "input_trust": "operator-attested; not independently verified",
            "flight_state_freshness": flight_state_freshness(streams, end),
            "modality_freshness": freshness,
            **result,
        })
    return build_report(results, airframe_family=airframe_family, model_sha256=manifest["sha256"],
                        calibration_sha256=manifest["calibration_sha256"], input_attested=True,
                        model_loaded=True, ood_limit=manifest["ood_limit_max_standardized_feature"])


def _write_report(report: dict[str, Any], output: Path | None) -> None:
    payload = json.dumps(report, indent=2, allow_nan=False) + "\n"
    if output is None:
        sys.stdout.write(payload)
        return
    if output.is_symlink() or output.exists():
        raise ValueError("output path already exists or is a symlink; choose a new path")
    resolved = output.resolve(strict=False)
    if resolved == ROOT or ROOT in resolved.parents:
        raise ValueError("output report must be outside the repository checkout")
    if output.parent.is_symlink():
        raise ValueError("refusing a symlink output directory")
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf-8") as handle:
        handle.write(payload)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--log", type=Path, required=True, help="one local PX4 .ulg file; it is never uploaded")
    parser.add_argument("--airframe-family", choices=("multicopter", "fixed_wing", "vtol"), required=True,
                        help="explicit coarse family required by the model")
    parser.add_argument("--attest-input-provenance", action="store_true", required=True,
                        help="attest that you reviewed the local log's provenance; this does not verify it cryptographically")
    parser.add_argument("--output-json", type=Path, help="new report path outside this checkout; default is stdout")
    args = parser.parse_args(argv)
    try:
        report = review(args.log, args.airframe_family, input_attested=args.attest_input_provenance)
        _write_report(report, args.output_json)
        return 0
    except (OSError, RuntimeError, ValueError, KeyError, ImportError, json.JSONDecodeError) as error:
        print(f"warden-nav-mm-review: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
