from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.ground_vehicle_odometry import GroundOdometryError, run_sequence
from services.ground_vehicle_odometry import core


SCRIPT = ROOT / "scripts" / "ground_vehicle_odometry.py"


def _synthetic_points(seed: int = 7) -> np.ndarray:
    """Generated test geometry only; no recorded or third-party dataset capture."""
    rng = np.random.default_rng(seed)
    xyz = rng.uniform(-8.0, 8.0, size=(400, 3)).astype("<f4")
    intensity = rng.uniform(0.0, 1.0, size=(400, 1)).astype("<f4")
    return np.concatenate((xyz, intensity), axis=1)


def _write_scan(directory: Path, name: str, seed: int = 7) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    _synthetic_points(seed).tofile(path)
    return path


class FakeOdometry:
    def __init__(self):
        self.last_pose = np.eye(4, dtype=np.float64)
        self.calls: list[tuple[np.ndarray, np.ndarray]] = []

    def register_frame(self, points: np.ndarray, timestamps: np.ndarray) -> None:
        self.calls.append((points.copy(), timestamps.copy()))
        self.last_pose = np.eye(4, dtype=np.float64)
        self.last_pose[0, 3] = float(len(self.calls) - 1)


def _fake_factory(odometry: FakeOdometry | None = None):
    instance = odometry or FakeOdometry()
    return instance, lambda: (instance, core.KISS_ICP_VERSION, np)


def test_report_uses_local_scans_and_contains_provenance_freshness_and_separation(tmp_path: Path):
    scan_dir = tmp_path / "sequence" / "velodyne"
    first = _write_scan(scan_dir, "000002.bin", seed=9)
    second = _write_scan(scan_dir, "000010.bin", seed=8)
    _write_scan(scan_dir, "000001.bin", seed=7)
    (scan_dir / "README.txt").write_text("ignored; only immediate .bin files are scans", encoding="utf-8")
    old_mtime = datetime.now(timezone.utc) - timedelta(hours=2)
    os.utime(first, (old_mtime.timestamp(), old_mtime.timestamp()))

    fake, factory = _fake_factory()
    output = tmp_path / "reports" / "relative.json"
    now = datetime.now(timezone.utc)
    result = run_sequence(
        tmp_path / "sequence",
        output,
        odometry_factory=factory,
        clock=lambda: now,
    )
    saved = json.loads(output.read_text(encoding="utf-8"))

    assert result == saved
    assert result["report_type"] == "relative_ground_vehicle_lidar_odometry"
    assert result["status"] == "ESTIMATE_ONLY_NOT_GROUND_TRUTH"
    assert result["algorithm"] == {
        "name": "KISS-ICP",
        "version": "1.3.0",
        "upstream": "https://github.com/PRBonn/kiss-icp/tree/v1.3.0",
    }
    assert [item["relative_path"] for item in result["input"]["scans"]] == [
        "000001.bin", "000002.bin", "000010.bin"
    ]
    assert result["input"]["freshness_basis"].startswith("filesystem modification time")
    assert result["input"]["scans"][1]["sha256"] == __import__("hashlib").sha256(first.read_bytes()).hexdigest()
    assert result["input"]["scans"][1]["filesystem_mtime_age_seconds_at_start"] >= 7100
    assert result["trajectory"]["poses"][0]["translation_m"] == [0.0, 0.0, 0.0]
    assert result["trajectory"]["poses"][1]["translation_m"] == [1.0, 0.0, 0.0]
    assert result["uncertainty"] == {"status": "not_estimated", "covariance": None, "confidence": None}
    assert result["model_provenance"]["learned_weights"].startswith("none used")
    assert all(value is False for value in result["separation"].values())
    assert len(fake.calls) == 3
    assert all(np.array_equal(times, np.zeros(len(points))) for points, times in fake.calls)
    assert all(np.isfinite(points).all() for points, _ in fake.calls)


def test_requires_at_least_two_scans_and_never_writes_partial_output(tmp_path: Path):
    scan_dir = tmp_path / "one"
    _write_scan(scan_dir, "000000.bin")
    output = tmp_path / "report.json"
    with pytest.raises(GroundOdometryError, match="at least two"):
        run_sequence(scan_dir, output, odometry_factory=_fake_factory()[1])
    assert not output.exists()


def test_rejects_invalid_scan_shape_and_non_finite_values(tmp_path: Path):
    scan_dir = tmp_path / "invalid"
    scan_dir.mkdir()
    (scan_dir / "000000.bin").write_bytes(b"bad")
    _write_scan(scan_dir, "000001.bin")
    with pytest.raises(GroundOdometryError, match="16 bytes each"):
        run_sequence(scan_dir, tmp_path / "bad.json", odometry_factory=_fake_factory()[1])

    (scan_dir / "000000.bin").unlink()
    bad = _write_scan(scan_dir, "000000.bin")
    values = _synthetic_points()
    values[0, 0] = np.nan
    values.tofile(bad)
    with pytest.raises(GroundOdometryError, match="NaN or infinite"):
        run_sequence(scan_dir, tmp_path / "bad.json", odometry_factory=_fake_factory()[1])


def test_enforces_exact_kiss_version_and_does_not_fallback(tmp_path: Path):
    scan_dir = tmp_path / "sequence"
    _write_scan(scan_dir, "000000.bin")
    _write_scan(scan_dir, "000001.bin")
    fake, _ = _fake_factory()
    with pytest.raises(GroundOdometryError, match="version mismatch"):
        run_sequence(scan_dir, tmp_path / "report.json", odometry_factory=lambda: (fake, "9.9.9", np))
    assert not (tmp_path / "report.json").exists()


def test_existing_report_requires_explicit_overwrite(tmp_path: Path):
    scan_dir = tmp_path / "sequence"
    _write_scan(scan_dir, "000000.bin")
    _write_scan(scan_dir, "000001.bin")
    output = tmp_path / "report.json"
    output.write_text("keep", encoding="utf-8")
    with pytest.raises(GroundOdometryError, match="output already exists"):
        run_sequence(scan_dir, output, odometry_factory=_fake_factory()[1])
    assert output.read_text(encoding="utf-8") == "keep"

    report = run_sequence(scan_dir, output, overwrite=True, odometry_factory=_fake_factory()[1])
    assert json.loads(output.read_text(encoding="utf-8")) == report


def test_cli_help_is_explicit_and_does_not_require_or_download_optional_package():
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--help"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0
    assert "--input" in result.stdout and "--output" in result.stdout
    assert "offline analysis only" in result.stdout


def test_cli_blocks_network_access_in_its_own_process():
    code = (
        "import runpy, socket; "
        f"module=runpy.run_path({str(SCRIPT)!r}, run_name='ground_odometry_test'); "
        "module['_disable_network'](); "
        "try_connect=False; "
        "\ntry: socket.create_connection(('example.invalid', 9), timeout=0.01)\n"
        "except RuntimeError as error:\n    try_connect='network access is disabled' in str(error)\n"
        "assert try_connect"
    )
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr


@pytest.mark.skipif(importlib.util.find_spec("kiss_icp") is None, reason="optional KISS-ICP wheel is not installed")
def test_real_kiss_icp_accepts_generated_local_scan_sequence(tmp_path: Path):
    """Optional integration check with generated synthetic geometry, never a dataset capture."""
    scan_dir = tmp_path / "sequence" / "velodyne"
    data = _synthetic_points(seed=31)
    _write_scan(scan_dir, "000000.bin", seed=31)
    _write_scan(scan_dir, "000001.bin", seed=31)
    report = run_sequence(tmp_path / "sequence", tmp_path / "report.json")
    assert report["algorithm"]["version"] == "1.3.0"
    assert len(report["trajectory"]["poses"]) == 2
    assert all(np.isfinite(pose["pose_matrix"]).all() for pose in report["trajectory"]["poses"])


def test_natural_sort_handles_mixed_numeric_and_text_names():
    names = ["scan10.bin", "2.bin", "scan2.bin", "10.bin"]
    ordered = sorted((Path(name) for name in names), key=core._natural_name_key)
    assert [path.name for path in ordered] == ["2.bin", "10.bin", "scan2.bin", "scan10.bin"]


def test_output_cannot_replace_an_input_scan_even_with_overwrite(tmp_path: Path):
    scan_dir = tmp_path / "sequence"
    first = _write_scan(scan_dir, "000000.bin")
    _write_scan(scan_dir, "000001.bin")
    original = first.read_bytes()
    with pytest.raises(GroundOdometryError, match="must not replace"):
        run_sequence(scan_dir, first, overwrite=True, odometry_factory=_fake_factory()[1])
    assert first.read_bytes() == original
