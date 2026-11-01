# Local offline layers in World View

World View’s **Open local offline layers** button opens a separate, opt-in workbench. Choose a local observation pack, explicitly load the generated synthetic sample, or inspect a local GeoTIFF. Nothing from public feeds, receive-only telemetry, or visible aircraft is admitted automatically. Closing the panel clears its in-memory datasets and globe layer; only imagery AOI polygons and their selected ID persist in browser local storage.

This is informational and simulation-only. It adds no aircraft control, target selection, sensor tasking, mission planning, provider configuration, external tile source, or imagery assets. PX4/ArduPilot remain receive-only. Imagery AOIs are display masks, not aircraft or flight-safety geofences. This feature is independent of PR #20 and the Turf/uPlot work in PR #21.

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

The file picker accepts a user-selected File/Blob only. The parser uses `fromBlob`, not remote URL APIs. There is no backend upload, HTTP range loading, tile request, provider lookup, or datum-grid download. Raster bytes, observations, and previews are memory-only and are not included in shared scene URLs/exports; AOI polygon settings are stored in local browser storage when available. If storage rejects a write, the AOI remains available only for the current session and the UI warns instead of claiming it was saved. Opening the panel loads its application code and preloads the raw decoder before the file controls appear; selecting a file does not need a provider or decoder-asset request. As with the existing app, this assumes the application assets have already been loaded; this is not a new service-worker/PWA installation feature.

Limits are deliberately conservative:

- File size: 16 MiB; dimensions: 4,096 per side; total pixels: 4 million; bands: 1–4.
- Sample widths: 8/16/32/64 bits, with a 128 MiB decoded-data ceiling and bounded strip/tile dimensions.
- **Uncompressed TIFF only for local files**. Compressed TIFFs are rejected before raster decoding to avoid decompression bombs. The separate, already-integrated Umbra reader remains range-bounded to small single-band COG overview images; it is not a full-resolution COG/tile viewer.
- Only the first image and first band are previewed. The original raster is read locally within those limits; up to 32 × 32 **sparse original pixels** are displayed, not interpolated blocks or a full-resolution image. Statistics describe these samples, not the entire raster.
- An explicit **Show validated raster on globe** control creates a separately bounded display surface of at most 128 × 128 cells from source pixel values. Grayscale display stretch is for visualization, not calibrated radiometry. Every cell boundary and center is derived from the source affine transform and supported CRS before projection onto the sphere; the source footprint alone is never used to position image pixels.
- Zero, finite sentinels and NaN nodata values are masked; nonfinite pixel values are also missing. Missing samples stay transparent, including an all-nodata raster. A dashed footprint preserves the raster extent.

The metadata panel reports filename, bytes, file modification/import time, CRS, native bounds, native pixel resolution, dimensions, band count, sample bit depths, compression, nodata and sampled valid/missing counts. File modification time is **not acquisition time**. The app does not verify imagery currency, source authority, elevation units or terrain accuracy.

### Projection support is explicit

Supported CRS are EPSG:4326, EPSG:3857 and WGS84 UTM EPSG:32601–32660 / 32701–32760, using the installed Proj4js definitions. Every displayed sample’s corners are transformed into WGS84. No unknown EPSG code is looked up or guessed.

Unknown/conflicting CRS, non-WGS84 datums, custom transformation parameters, datum-grid references, unsupported units, vertical datums, rotated/model-matrix rasters, PixelIsPoint, multiple tiepoints and unsafe bounds are rejected. Nonzero raster tiepoint offsets are handled explicitly. Antimeridian-crossing rasters are supported on the globe using wrapped WGS84 coordinates; the separate equirectangular workbench preview omits date-line-crossing polygons rather than drawing across the map. User-defined WKT/proj strings and datum grid files are not accepted. Proj4js can support grid transformations, but that requires separately supplied datasets; this slice intentionally rejects them.

## Georeferenced globe layers and imagery AOIs

The Three.js globe draws registered raster cells as a textured spherical mesh above its surface. Local GeoTIFFs appear only after file selection and explicit globe-layer opt-in. The already-integrated Umbra overview is eligible only through the existing public-imagery opt-in and bounded range reader; it is draped only when its own GeoTIFF CRS GeoKeys, WGS84 datum/unit properties, north-up pixel scale and tiepoint pass validation. Otherwise its preview and footprint remain, with the specific registration limitation stated; no image is stretched over a scene footprint. Sentinel-1 browse/thumbnail scenes remain footprint/card-only unless a future asset supplies independently valid georeferencing. Registered surfaces suppress centroid-pinned cards so the image remains visible; source, acquisition/retrieval time, freshness/error and attribution remain available in the source/local workbench panels. Unregistered previews retain their pinned provenance cards.

Choose **Draw new AOI**, then click the globe to add vertices or edit longitude/latitude fields. Finish and save at least three vertices; saved polygons can be selected, edited or deleted. Up to 50 polygons and 128 vertices per polygon are supported, including date-line-crossing boundaries. The selected AOI clips each visible georeferenced surface by its bounded display-cell centers; the outline stays visible in amber on the selected polygon and teal on other saved polygons. **No AOI** displays the full valid source raster. AOI selection is local-only: it does not change provider search parameters or broaden requests, and no observation/raster content or AOI is uploaded. **Reset imagery AOIs** removes the locally stored polygon set when storage is available.

This implementation adds no XYZ/WMTS/third-party basemap source, so no new external tile-provider terms, licenses, attribution rules or bandwidth policy are implied. “Raster tiles” here means the bounded georeferenced cells within an already-accepted raster overview/surface—not a new network map-tile service.

## SVG remains useful without WebGL

The local workbench retains its compact SVG equirectangular sample map. Separately, the main globe's SVG orthographic fallback paints visible raster cells on their projected spherical positions and draws AOI boundaries; it is usable without WebGL, with no exaggerated plane or footprint-stretched preview. Both views are informational, not navigation maps. Local raster labels identify user-supplied data, never authoritative terrain or current imagery; public-source layers retain their own provenance labels. Controls provide cancel, visibility, clear, and close-and-clear actions. Cancellation discards pending results; synchronous work is not hard-preempted by a worker.

## Validation and limits of the evidence

Run from the repository root:

```sh
pnpm --dir apps/management-web install --frozen-lockfile
pnpm --dir apps/management-web test
pnpm --dir apps/management-web typecheck
pnpm --dir apps/management-web build
pnpm --dir apps/management-web licenses:check
pnpm --dir apps/management-web audit --prod
python -m pytest -q
```

Synthetic fixtures are generated in `apps/management-web/tests/fixtures/local-raster-fixtures.mjs`; no external raster is bundled. Tests include the official H3 vector `87283472bffffff`, resolution/count conservation, bounded/invalid inputs, known Web Mercator and UTM transforms, nonzero tiepoint origins, zero/sentinel/NaN/all-nodata, sparse preview bounds, unsupported CRS/datums/grids/units, malformed/oversized files, pre/mid-read cancellation, affine-to-globe positioning, date-line round trips, invalid geographic extent rejection, inside/outside AOI masking, AOI persistence failure reporting and zero fetch/XHR calls during valid local processing. Static privacy checks protect the feature’s network boundary. Production Chromium checks exercised WebGL2 via SwiftShader and the SVG fallback: an asymmetric north-bright/south-dark raster remained north-up; explicit local-file draping, globe AOI vertex drawing, close-to-click coordinate results (maximum 0.315° at a 780 × 437 viewport), clipping, persistence across reload, resource timing and runtime errors. These flows made **zero non-local resource requests** and raised no browser runtime errors. Verified locally: **230 frontend tests and 610 backend tests passed**, with TypeScript, production build, frozen-lock install, 16-package license-notice verification and production dependency audit passing (no known vulnerabilities reported). The build retains its globe chunk-size warning (527.42 kB minified); the lazy local panel is 232.61 kB minified / 72.08 kB gzip. This is not a hostile-TIFF fuzzing campaign, an exhaustive projection audit or a browser/device compatibility matrix.

## Later candidates, not installed

**PMTiles / MapLibre** could support separately authorized local archive rendering, but need a file-only data source, style/asset licensing and a no-egress review. **React Flow** could help a future explanatory simulation/data-processing graph; it is not needed for this small panel and must not silently introduce aircraft mission planning or control. Neither candidate is installed in this slice.
