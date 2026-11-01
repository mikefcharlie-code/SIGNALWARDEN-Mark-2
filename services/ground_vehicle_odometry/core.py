"""Local-only KISS-ICP processing for user-supplied KITTI-style LiDAR scans.

This module is intentionally not imported by the Management API or UAV subsystems.
"""
from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

KISS_ICP_VERSION = "1.3.0"
MAX_SCAN_COUNT = 10_000
MAX_SCAN_BYTES = 256 * 1024 * 1024

LIMITATIONS = [
    "Relative LiDAR odometry only; the first scan defines an arbitrary local origin.",
    "Drift and registration failure can accumulate; no global position or loop closure is provided.",
    "No covariance, calibrated confidence, or quantitative uncertainty estimate is produced.",
    "Filesystem modification time is provenance metadata, not a sensor capture timestamp; copying can reset it.",
    "The adapter accepts KITTI-style float32 x,y,z,intensity .bin scans and supplies no per-point timing; deskew is disabled.",
    "Results are estimates, not ground truth, a safety case, or a validated vehicle localization solution.",
]


class GroundOdometryError(ValueError):
    """A scan sequence or optional local dependency is invalid or unavailable."""


def _natural_name_key(path: Path) -> tuple[Any, ...]:
    """Sort zero-padded and ordinary numeric scan names in sequence order."""
    return tuple((1, int(part)) if part.isdigit() else (0, part.lower()) for part in re.split(r"(\d+)", path.name))


def discover_scans(input_dir: str | Path) -> tuple[Path, list[Path]]:
    """Find immediate .bin scans in a supplied folder or its KITTI velodyne folder."""
    root = Path(input_dir).expanduser()
    try:
        root = root.resolve(strict=True)
    except OSError as error:
        raise GroundOdometryError(f"input folder is unavailable: {error}") from error
    if not root.is_dir():
        raise GroundOdometryError("--input must be an existing local directory")

    scan_dir = root / "velodyne" if (root / "velodyne").is_dir() else root
    if scan_dir.is_symlink():
        raise GroundOdometryError("scan directory must not be a symlink")
    scans = sorted(scan_dir.glob("*.bin"), key=_natural_name_key)
    if len(scans) < 2:
        raise GroundOdometryError("provide at least two immediate .bin scans in the folder (or velodyne/)")
    if len(scans) > MAX_SCAN_COUNT:
        raise GroundOdometryError(f"scan count exceeds the safety limit of {MAX_SCAN_COUNT}")
    for path in scans:
        if path.is_symlink() or not path.is_file():
            raise GroundOdometryError(f"scan must be a regular local file, not a symlink: {path.name}")
        try:
            size = path.stat().st_size
        except OSError as error:
            raise GroundOdometryError(f"cannot inspect scan {path.name}: {error}") from error
        if size <= 0 or size % 16 != 0:
            raise GroundOdometryError(f"{path.name}: expected non-empty float32 x,y,z,intensity records (16 bytes each)")
        if size > MAX_SCAN_BYTES:
            raise GroundOdometryError(f"{path.name}: exceeds the {MAX_SCAN_BYTES}-byte per-scan limit")
    return root, scans


def _load_numpy() -> Any:
    try:
        import numpy as np
    except ImportError as error:
        raise GroundOdometryError(
            "NumPy is missing; use the explicit optional install command in docs/ground-vehicle-odometry.md"
        ) from error
    return np


def _new_odometry() -> tuple[Any, str, Any]:
    """Load only the pinned KISS-ICP API; never fall back to another estimator."""
    try:
        installed = importlib.metadata.version("kiss-icp")
    except importlib.metadata.PackageNotFoundError as error:
        raise GroundOdometryError(
            "KISS-ICP is not installed; follow the explicit optional install instructions in "
            "docs/ground-vehicle-odometry.md"
        ) from error
    if installed != KISS_ICP_VERSION:
        raise GroundOdometryError(
            f"KISS-ICP version mismatch: expected {KISS_ICP_VERSION}, found {installed}; "
            "install the pinned optional requirements"
        )
    try:
        from kiss_icp.config import KISSConfig
        from kiss_icp.kiss_icp import KissICP
    except ImportError as error:
        raise GroundOdometryError(
            "KISS-ICP's Python/native API is unavailable; install the pinned optional requirements "
            "for a supported Python platform"
        ) from error

    # Avoid load_config's environment-variable overrides and any output-directory side effects.
    config = KISSConfig.model_validate({})
    config.mapping.voxel_size = float(config.data.max_range / 100.0)
    # .bin scans contain no point-time channel. Do not invent timing or deskew data.
    config.data.deskew = False
    return KissICP(config=config), installed, _load_numpy()


def _read_scan(path: Path, np: Any) -> tuple[Any, dict[str, Any]]:
    """Read and hash the same bytes that will be processed, rejecting concurrent edits."""
    try:
        before = path.stat()
        payload = path.read_bytes()
        after = path.stat()
    except OSError as error:
        raise GroundOdometryError(f"cannot read scan {path.name}: {error}") from error
    if (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
        raise GroundOdometryError(f"scan changed while being read: {path.name}; rerun with a stable local copy")
    if len(payload) != before.st_size or len(payload) % 16 != 0 or not payload:
        raise GroundOdometryError(f"{path.name}: scan bytes are incomplete or not KITTI-style float32 x,y,z,intensity")

    points4 = np.frombuffer(payload, dtype="<f4")
    if points4.size < 12:
        raise GroundOdometryError(f"{path.name}: at least three four-value point records are required")
    points4 = points4.reshape((-1, 4))
    if not bool(np.isfinite(points4).all()):
        raise GroundOdometryError(f"{path.name}: scan contains NaN or infinite values")
    points = np.ascontiguousarray(points4[:, :3], dtype=np.float64)
    modified = datetime.fromtimestamp(before.st_mtime, timezone.utc).isoformat().replace("+00:00", "Z")
    provenance = {
        "relative_path": path.name,
        "size_bytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "filesystem_modified_at": modified,
        "point_count": int(points.shape[0]),
    }
    return points, provenance


def _atomic_write_json(path: Path, report: dict[str, Any], *, overwrite: bool) -> None:
    path = path.expanduser()
    parent = path.parent.resolve()
    target = parent / path.name
    if target.exists() and not overwrite:
        raise GroundOdometryError(f"output already exists; choose another --output path or pass --overwrite: {target}")
    parent.mkdir(parents=True, exist_ok=True)
    temp_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=parent, prefix=f".{target.name}.", suffix=".tmp", delete=False) as temp:
            temp_name = temp.name
            json.dump(report, temp, indent=2, sort_keys=True, allow_nan=False)
            temp.write("\n")
            temp.flush()
            os.fsync(temp.fileno())
        if overwrite:
            os.replace(temp_name, target)
        else:
            try:
                os.link(temp_name, target)
            except FileExistsError as error:
                raise GroundOdometryError(
                    f"output already exists; choose another --output path or pass --overwrite: {target}"
                ) from error
            os.unlink(temp_name)
            temp_name = None
    except OSError as error:
        raise GroundOdometryError(f"could not write the explicitly selected report path: {error}") from error
    finally:
        if temp_name and os.path.exists(temp_name):
            os.unlink(temp_name)


def run_sequence(
    input_dir: str | Path,
    output_path: str | Path,
    *,
    overwrite: bool = False,
    odometry_factory: Callable[[], tuple[Any, str, Any]] | None = None,
    clock: Callable[[], datetime] | None = None,
) -> dict[str, Any]:
    """Estimate a local relative trajectory from one explicitly selected scan folder."""
    root, scans = discover_scans(input_dir)
    report_target = Path(output_path).expanduser()
    report_target = report_target.parent.resolve() / report_target.name
    if report_target in scans:
        raise GroundOdometryError("--output must not replace one of the explicitly supplied .bin input scans")
    if report_target.exists() and not overwrite:
        raise GroundOdometryError(f"output already exists; choose another --output path or pass --overwrite: {report_target}")
    started_at = (clock or (lambda: datetime.now(timezone.utc)))()
    if started_at.tzinfo is None:
        raise GroundOdometryError("clock must return a timezone-aware timestamp")
    factory = odometry_factory or _new_odometry
    odometry, library_version, np = factory()
    if library_version != KISS_ICP_VERSION:
        raise GroundOdometryError(f"KISS-ICP version mismatch: expected {KISS_ICP_VERSION}, found {library_version}")

    scan_sources: list[dict[str, Any]] = []
    poses: list[dict[str, Any]] = []
    for index, scan_path in enumerate(scans):
        points, source = _read_scan(scan_path, np)
        try:
            timestamps = np.zeros(points.shape[0], dtype=np.float64)
            odometry.register_frame(points, timestamps)
            pose = np.asarray(odometry.last_pose, dtype=np.float64)
        except Exception as error:
            raise GroundOdometryError(f"KISS-ICP failed on scan {scan_path.name}: {error}") from error
        if pose.shape != (4, 4) or not bool(np.isfinite(pose).all()):
            raise GroundOdometryError(f"KISS-ICP returned an invalid 4x4 pose for {scan_path.name}")
        scan_sources.append(source)
        poses.append({
            "frame_index": index,
            "scan": scan_path.name,
            "pose_matrix": pose.tolist(),
            "translation_m": pose[:3, 3].tolist(),
        })

    finished_at = (clock or (lambda: datetime.now(timezone.utc)))()
    if finished_at.tzinfo is None:
        raise GroundOdometryError("clock must return a timezone-aware timestamp")
    for source in scan_sources:
        modified_at = datetime.fromisoformat(source["filesystem_modified_at"].replace("Z", "+00:00"))
        source["filesystem_mtime_age_seconds_at_start"] = round(max(0.0, (started_at - modified_at).total_seconds()), 3)

    report: dict[str, Any] = {
        "schema_version": "1.0",
        "report_type": "relative_ground_vehicle_lidar_odometry",
        "created_at": finished_at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "processing_started_at": started_at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "domain": "ground_vehicle",
        "status": "ESTIMATE_ONLY_NOT_GROUND_TRUTH",
        "algorithm": {"name": "KISS-ICP", "version": library_version, "upstream": "https://github.com/PRBonn/kiss-icp/tree/v1.3.0"},
        "input": {
            "source_directory": str(root),
            "format": "KITTI-style Velodyne .bin: little-endian float32 x,y,z,intensity records",
            "ordering": "natural numeric filename order; immediate files only",
            "scan_count": len(scan_sources),
            "point_time_channel": "not supplied; deskew disabled",
            "freshness_basis": "filesystem modification time at processing start; not a sensor capture time and may change when copied",
            "scans": scan_sources,
        },
        "trajectory": {
            "frame": "local relative LiDAR odometry; first scan starts at identity",
            "translation_units": "meters (as assumed from input scan coordinates)",
            "rotation_units": "3x3 rotation matrix in pose_matrix",
            "poses": poses,
        },
        "uncertainty": {"status": "not_estimated", "covariance": None, "confidence": None},
        "model_provenance": {"learned_weights": "none used by this integration; classical geometric ICP only"},
        "separation": {
            "uav_telemetry_input": False,
            "warden_nav_input_or_output": False,
            "live_navigation_correction": False,
            "aircraft_control_or_fusion_eligible": False,
            "mission_planning_or_command_eligible": False,
            "effector_eligible": False,
        },
        "limitations": LIMITATIONS,
    }
    _atomic_write_json(Path(output_path), report, overwrite=overwrite)
    return report
