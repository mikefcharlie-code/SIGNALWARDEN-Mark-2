# Local offline layers in World View

World View’s **Open local offline layers** button opens a separate, opt-in SVG workbench. Choose a local observation pack, explicitly load the generated synthetic sample, or inspect a local GeoTIFF. Nothing from public feeds, receive-only telemetry, or visible aircraft is admitted automatically. Closing the panel clears its in-memory datasets.

This is informational and simulation-only. It adds no aircraft control, target selection, sensor tasking, mission planning, provider configuration, external datasets, or imagery assets. PX4/ArduPilot remain receive-only. This feature is independent of PR #20 and the Turf/uPlot work in PR #21.

## Three small, focused library additions

| Exact version | Purpose | License / upstream |
| --- | --- | --- |
| `h3-js` 4.5.0 | Local hierarchical hex indexing, counts, boundaries and occupied-cell areas | [Apache-2.0](https://github.com/uber/h3-js) |
| `geotiff` 3.0.5 | Read the user’s local File/Blob and first-band raster samples | [MIT](https://github.com/geotiffjs/geotiff.js) |
| `proj4` 2.22.0 | Explicitly supported WGS84 coordinate transformations | [MIT](https://github.com/proj4js/proj4js) |

Direct versions are exact in `package.json`; transitive versions and integrity hashes are pinned in `pnpm-lock.yaml`. The distributable [full software notices](../apps/management-web/public/worldview-local-layers-notices.txt) include direct and added runtime dependency licenses, H3’s NOTICE, and upstream license/NOTICE recovery for packages missing those files in their npm tarballs.

## Hex counts, not sensor coverage

Load an existing World View observation-pack JSON file (maximum 2 MB / 5,000 records) or select **Load synthetic points**. Enable H3 explicitly and choose a resolution from 0–10. The panel shows point counts, occupied cells, cell geometry, summed occupied-cell area, source labels, and first/last dataset observation timestamps. All records pass the existing observation validator. Imported packs remain labelled **USER-SUPPLIED**, even if their records claim to be real; source labels are not independent verification.

The occupied-cell area is the sum of the disjoint H3 cells at that resolution. It is **not sensor coverage, observed surface area, uncertainty, or confidence**. Changing resolution preserves the record count but changes this geometric footprint. Antimeridian-crossing hexagons are omitted from the preview rather than drawn across the world; their counts remain included. The table displays the first 100 cells, with its total made explicit.

## Local GeoTIFF inspection

The file picker accepts a user-selected File/Blob only. The parser uses `fromBlob`, not remote URL APIs. There is no backend upload, HTTP range loading, tile request, provider lookup, datum-grid download, browser persistence, or file content in shared scene URLs/exports. Opening the panel loads its application code and preloads the raw decoder before the file controls appear; selecting a file does not need another decoder asset request. As with the existing app, this assumes the application assets have already been loaded; this is not a new service-worker/PWA installation feature.

Limits are deliberately conservative:

- File size: 16 MiB; dimensions: 4,096 per side; total pixels: 4 million; bands: 1–4.
- Sample widths: 8/16/32/64 bits, with a 128 MiB decoded-data ceiling and bounded strip/tile dimensions.
- **Uncompressed TIFF only**. Compressed TIFFs are rejected before raster decoding to avoid decompression bombs. This is not a general COG or satellite-imagery viewer.
- Only the first image and first band are previewed. The original raster is read locally within those limits; up to 32 × 32 **sparse original pixels** are displayed, not interpolated blocks or a full-resolution image. Statistics describe these samples, not the entire raster.
- Zero, finite sentinels and NaN nodata values are masked; nonfinite pixel values are also missing. Missing samples stay transparent, including an all-nodata raster. A dashed footprint preserves the raster extent.

The metadata panel reports filename, bytes, file modification/import time, CRS, native bounds, native pixel resolution, dimensions, band count, sample bit depths, compression, nodata and sampled valid/missing counts. File modification time is **not acquisition time**. The app does not verify imagery currency, source authority, elevation units or terrain accuracy.

### Projection support is explicit

Supported CRS are EPSG:4326, EPSG:3857 and WGS84 UTM EPSG:32601–32660 / 32701–32760, using the installed Proj4js definitions. Every displayed sample’s corners are transformed into WGS84. No unknown EPSG code is looked up or guessed.

Unknown/conflicting CRS, non-WGS84 datums, custom transformation parameters, datum-grid references, unsupported units, vertical datums, rotated/model-matrix rasters, PixelIsPoint, multiple tiepoints, unsafe bounds and antimeridian-crossing footprints are rejected. Nonzero raster tiepoint offsets are handled explicitly. User-defined WKT/proj strings and datum grid files are not accepted. Proj4js can support grid transformations, but that requires separately supplied datasets; this slice intentionally rejects them.

## SVG remains useful without WebGL

Hexagons, raster samples, footprint, metadata and counts use an SVG equirectangular, data-fit preview—not the Three.js globe. The panel is usable independently of WebGL and remains separate from the existing globe/SVG fallback. It is not a navigation map. Raster labels consistently say **user-supplied raster**, never authoritative terrain or current imagery. Controls provide cancel, visibility, clear, and close-and-clear actions. Cancellation discards pending results; synchronous work is not hard-preempted by a worker.

## Validation and limits of the evidence

Run from the repository root:

```sh
pnpm --dir apps/management-web install --frozen-lockfile
pnpm --dir apps/management-web test
pnpm --dir apps/management-web typecheck
pnpm --dir apps/management-web build
python -m pytest -q
```

Synthetic fixtures are generated in `apps/management-web/tests/fixtures/local-raster-fixtures.mjs`; no external raster is bundled. Tests include the official H3 vector `87283472bffffff`, resolution/count conservation, bounded/invalid inputs, known Web Mercator and UTM transforms, nonzero tiepoint origins, zero/sentinel/NaN/all-nodata, sparse preview bounds, unsupported CRS/datums/grids/units, malformed/oversized files, pre/mid-read cancellation, and zero fetch/XHR calls during valid local processing. Static privacy checks protect the feature’s network boundary. Browser checks cover local file inputs, provenance, resolution changes, raster rejection/metadata, resource timing and SVG behavior after simulated WebGL context loss. Verified locally: **149 frontend tests and 523 backend tests passed**, with typecheck, production build, frozen-lock install and production dependency audit passing (no known advisories reported). A production-mode browser File/Blob read displayed numeric nodata correctly and created **zero resource requests after file selection**; application/decoder assets were loaded on panel open. Vite retains its existing globe chunk-size warning (approximately 526 kB minified); the separately lazy-loaded local panel is approximately 402 kB minified / 128 kB gzip. These are bounded regressions, not a hostile-TIFF fuzzing campaign, an exhaustive projection audit, or a browser/device compatibility matrix.

## Later candidates, not installed

**PMTiles / MapLibre** could support separately authorized local archive rendering, but need a file-only data source, style/asset licensing and a no-egress review. **React Flow** could help a future explanatory simulation/data-processing graph; it is not needed for this small panel and must not silently introduce aircraft mission planning or control. Neither candidate is installed in this slice.
