import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { rasterFixture as tif } from "./fixtures/local-raster-fixtures.mjs";

class FileReaderPolyfill {
  abort() { this.aborted = true; this.onabort?.(); }
  readAsArrayBuffer(blob) { blob.arrayBuffer().then((b) => { if (!this.aborted) { this.result = b; this.onload?.(); } }, (e) => { this.error = e; this.onerror?.(); }); }
}
globalThis.FileReader = FileReaderPolyfill;
const here = dirname(fileURLToPath(import.meta.url));
const out = mkdtempSync(join(tmpdir(), "worldview-local-raster-"));
writeFileSync(join(out, "package.json"), '{"type":"module"}\n');
symlinkSync(resolve(here, "../node_modules"), join(out, "node_modules"), "dir");
const source = resolve(here, "../src/worldview-local-raster.ts");
const tsc = resolve(here, "../node_modules/typescript/bin/tsc");
const compiled = spawnSync(process.execPath, [tsc, source, "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--skipLibCheck", "--outDir", out], { encoding: "utf8", cwd: out });
if (compiled.status !== 0) throw new Error(`${compiled.stdout}\n${compiled.stderr}`);
const { inspectLocalRaster } = await import(`${pathToFileURL(join(out, "worldview-local-raster.js"))}?t=${Date.now()}`);
test.after(() => rmSync(out, { recursive: true, force: true }));

const near = (value, expected, tolerance = 1e-7) => assert.ok(Math.abs(value - expected) < tolerance, `${value} != ${expected}`);

test("reports WGS84 file metadata and sparse original-pixel preview", async () => {
  const result = await inspectLocalRaster(await tif(), { name: "fixture.tif", lastModified: 7 });
  assert.equal(result.crs, "EPSG:4326");
  assert.deepEqual([result.width, result.height, result.bands], [2, 2, 1]);
  assert.equal(result.name, "fixture.tif");
  assert.equal(result.lastModified, 7);
  assert.ok(Number.isFinite(Date.parse(result.importedAt)));
  assert.deepEqual(result.nativeBounds, [-10, 18, -8, 20]);
  assert.deepEqual(result.resolution, [1, 1]);
  assert.equal(result.preview.cells.length, 4);
  assert.equal(result.preview.validCount, 4);
  assert.deepEqual(result.preview.cells[0].corners[0], { lon: -10, lat: 20 });
  assert.equal(result.nodata, null);
});

test("known Web Mercator values transform into WGS84 pixel corners", async () => {
  const result = await inspectLocalRaster(await tif({ GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: 3857, ModelPixelScale: [1000, 1000, 0], ModelTiepoint: [0, 0, 0, 1113194.9079327357, 0, 0] }));
  assert.equal(result.crs, "EPSG:3857");
  near(result.preview.cells[0].corners[0].lon, 10);
  near(result.preview.cells[0].corners[0].lat, 0);
  near(result.preview.cells[0].corners[1].lon, 10.008983152841195);
});

test("known WGS84 UTM central meridian values are not treated as degrees", async () => {
  const result = await inspectLocalRaster(await tif({ GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: 32631, ModelPixelScale: [10, 10, 0], ModelTiepoint: [0, 0, 0, 500000, 0, 0] }));
  near(result.preview.cells[0].corners[0].lon, 3);
  near(result.preview.cells[0].corners[0].lat, 0);
});

test("honors non-zero raster tiepoint offsets", async () => {
  const result = await inspectLocalRaster(await tif({ ModelTiepoint: [2, 3, 0, -8, 17, 0] }));
  assert.deepEqual(result.nativeBounds, [-10, 18, -8, 20]);
});

test("numeric zero/nan nodata remain transparent, including all-nodata rasters", async () => {
  for (const missing of [0, -9999, NaN]) {
    const result = await inspectLocalRaster(await tif({ GDAL_NODATA: String(missing) }, new Float32Array([1, missing, 2, missing])));
    assert.equal(result.preview.validCount, 2);
    assert.equal(result.preview.nodataCount, 2);
    assert.equal(result.preview.cells[1].value, null);
    assert.equal(result.preview.min, 1);
    assert.equal(result.preview.max, 2);
  }
  const all = await inspectLocalRaster(await tif({ GDAL_NODATA: "0" }, new Float32Array(4)));
  assert.equal(all.preview.validCount, 0);
  assert.equal(all.preview.min, null);
  assert.equal(all.footprint.length, 4);
});

test("caps the preview at 32x32 samples", async () => {
  const result = await inspectLocalRaster(await tif({ width: 64, height: 64, ModelPixelScale: [0.01, 0.01, 0] }, new Float32Array(4096).fill(7)));
  assert.equal(result.preview.cells.length, 1024);
});

test("rejects malformed data and non-Blob URLs", async () => {
  await assert.rejects(() => inspectLocalRaster(new Blob(["not a TIFF"])), /TIFF|byte|offset|magic|order/i);
  await assert.rejects(() => inspectLocalRaster("https://example.test/file.tif"), /Blob/);
});

test("rejects oversized bytes, dimensions, pixel count, bands and compressed TIFF before decoding", async () => {
  await assert.rejects(() => inspectLocalRaster(new Blob([new Uint8Array(16 * 1024 * 1024 + 1)])), /16 MiB/);
  await assert.rejects(() => inspectLocalRaster(tif()), /Blob/);
  for (const [metadata, pattern] of [
    [{ width: 4097 }, /dimensions/],
    [{ width: 3000, height: 3000 }, /pixel count/],
    [{ SamplesPerPixel: 5, BitsPerSample: [32, 32, 32, 32, 32] }, /bands/],
    [{ Compression: 5 }, /compressed/],
    [{ RowsPerStrip: 5000 }, /strip/],
  ]) await assert.rejects(() => tif(metadata).then(blob => inspectLocalRaster(blob)), pattern);
});

test("rejects unknown/conflicting CRS, custom datums, grids, units and georeferencing", async () => {
  for (const metadata of [
    { GeographicTypeGeoKey: 4269 },
    { GeographicTypeGeoKey: 32767 },
    { ProjectedCSTypeGeoKey: 9999 },
    { ProjectedCSTypeGeoKey: 3857, GeographicTypeGeoKey: 4269 },
    { GeogGeodeticDatumGeoKey: 6267 },
    { GeogAngularUnitsGeoKey: 9101 },
    { ProjLinearUnitsGeoKey: 9002 },
    { GeogCitationGeoKey: "+nadgrids=missing.gsb" },
    { GeogTOWGS84GeoKey: [1, 2, 3] },
    { ProjCoordTransGeoKey: 1 },
    { GTRasterTypeGeoKey: 2 },
    { VerticalCSTypeGeoKey: 5703 },
    { ModelPixelScale: [-1, 1, 0] },
    { ModelTiepoint: [0, 0, 0, 179, 20, 0] },
    { ModelTransformation: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
  ]) await assert.rejects(() => tif(metadata).then(blob => inspectLocalRaster(blob)), /Unsupported local raster/, JSON.stringify(metadata));
});

test("cancels both before work and during local file reading", async () => {
  const early = new AbortController(); early.abort();
  await assert.rejects(() => inspectLocalRaster(new Blob(["x"]), { signal: early.signal }), /cancelled|AbortError/);
  const mid = new AbortController();
  class CancellingBlob extends Blob { slice(...args) { mid.abort(); return super.slice(...args); } }
  const fixture = await tif();
  await assert.rejects(() => inspectLocalRaster(new CancellingBlob([fixture]), { signal: mid.signal }), /cancelled|AbortError/);
});

test("valid local processing and malformed rejection make zero fetch/XHR calls", async () => {
  const oldFetch = globalThis.fetch, oldXHR = globalThis.XMLHttpRequest;
  let requests = 0;
  globalThis.fetch = () => { requests++; throw Error("network forbidden"); };
  globalThis.XMLHttpRequest = class { constructor() { requests++; throw Error("network forbidden"); } };
  try {
    assert.equal((await inspectLocalRaster(await tif())).preview.validCount, 4);
    await assert.rejects(() => inspectLocalRaster(new Blob(["not a TIFF"])));
    assert.equal(requests, 0);
  } finally { globalThis.fetch = oldFetch; globalThis.XMLHttpRequest = oldXHR; }
});
