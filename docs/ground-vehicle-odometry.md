# Ground-vehicle relative LiDAR odometry

This is an **optional, local-only analysis tool** for a user-selected folder of ground-vehicle LiDAR scans. It uses [KISS-ICP v1.3.0](https://github.com/PRBonn/kiss-icp/releases/tag/v1.3.0), the latest official release verified for this integration, pinned to its official [release tag](https://github.com/PRBonn/kiss-icp/tree/v1.3.0) and [MIT license](https://github.com/PRBonn/kiss-icp/blob/v1.3.0/LICENSE). The upstream Python package declares NumPy, Pydantic, PyQuaternion, Rich, tqdm, Typer and related runtime dependencies; the exact direct and transitive versions used here are pinned with artifact hashes in [`requirements-ground-odometry.txt`](../requirements-ground-odometry.txt). No KISS-ICP extra such as Open3D, ROS bags, or Ouster is installed for this workflow.

## Install only when needed

The Management API and browser app do not import KISS-ICP, build it, or download it. For Python 3.11 or 3.12 on a platform with an official compatible wheel, create a separate environment and explicitly install the lock:

```bash
python3 -m venv .venv-ground-odometry
. .venv-ground-odometry/bin/activate
python -m pip install --require-hashes --only-binary=:all: -r requirements-ground-odometry.txt
```

On Windows, activate with `.venv-ground-odometry\Scripts\activate`. If a compatible wheel is unavailable, installation fails rather than building native code or switching to another implementation. The application does not install or upgrade any dependency for you.

## Run on scans you already have locally

The input is either a folder containing `*.bin` scans or a KITTI-style sequence folder containing `velodyne/*.bin`. Every scan must be non-empty, little-endian float32 records of `x, y, z, intensity` (16 bytes per point). The tool reads only immediate `.bin` files, orders numeric names naturally, and requires 2–10,000 scans no larger than 256 MiB each. It does not read KITTI poses/labels, download or locate datasets, access a live sensor, or recurse into other folders.

```bash
python scripts/ground_vehicle_odometry.py \
  --input /absolute/path/to/your/sequence \
  --output /absolute/path/to/your/reports/relative-odometry.json
```

Both paths are required. Existing reports are not replaced unless `--overwrite` is explicitly supplied. The command runs as a one-shot local process and blocks Python socket/DNS access. A missing or wrong KISS-ICP version is an error; there is no alternate estimator or network fallback.

## Read the report as an estimate

The JSON report identifies the run as `relative_ground_vehicle_lidar_odometry`, labels its status `ESTIMATE_ONLY_NOT_GROUND_TRUTH`, gives the local scan directory, each filename, point count, size and SHA-256, and records each scan file's filesystem modification time and its age at run start. File mtime is **not** a capture timestamp and may change when files are copied. The report includes the selected absolute local directory path, so review it before sharing. The trajectory is a relative LiDAR pose sequence in an arbitrary local frame whose first scan starts at identity; coordinates are assumed to be metres from the input. It is not globally aligned.

No covariance or calibrated confidence is calculated. Relative odometry can drift or fail with sparse, repetitive, moving-object-heavy, poorly calibrated or otherwise unsuitable scans; there is no global correction or loop closure in this adapter. The scan format has no per-point time channel, so scan deskew is disabled. Review the data and result before relying on it.

This feature is fenced to ground-vehicle offline analysis: it does not read or write UAV telemetry, Warden-NAV, live navigation corrections, aircraft localization/fusion, mission planning, commands, or effectors. Its output is explicitly ineligible for aircraft control/fusion and mission use. It is not ground truth, flight data, or a safety/vehicle-validation result.

## Models, datasets, and notices

No learned model or weight files are used or shipped by this adapter. The upstream describes KISS-ICP as incremental point-cloud registration using geometric point-to-point ICP (see its [source](https://github.com/PRBonn/kiss-icp/blob/v1.3.0/python/kiss_icp/kiss_icp.py) and [paper](https://www.ipb.uni-bonn.de/wp-content/papercite-data/pdf/vizzo2023ral.pdf)). No dataset captures are included in the repository or tests; tests generate synthetic point clouds in temporary directories.

The project reuses the KISS-ICP package through its pinned package artifact and does not copy or vendor upstream source or binaries. [`THIRD_PARTY_NOTICES-ground-odometry.txt`](../THIRD_PARTY_NOTICES-ground-odometry.txt) records KISS-ICP's full MIT notice and the pinned Python dependency closure's license/source metadata. The default Python dependency set includes neither the KISS-ICP package nor its optional extras.
