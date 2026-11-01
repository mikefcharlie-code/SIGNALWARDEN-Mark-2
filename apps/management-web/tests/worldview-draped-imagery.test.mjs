import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const out = mkdtempSync(join(tmpdir(), "worldview-draped-imagery-"));
writeFileSync(join(out, "package.json"), '{"type":"module"}');
symlinkSync(resolve(here, "../node_modules"), join(out, "node_modules"), "junction");
const compiled = spawnSync(process.execPath, [
  resolve(here, "../node_modules/typescript/bin/tsc"),
  resolve(here, "../src/worldview-draped-raster.ts"),
  resolve(here, "../src/worldview-imagery-aoi.ts"),
  resolve(here, "../src/worldview-globe-math.ts"),
  "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--skipLibCheck", "--outDir", out,
], { encoding: "utf8" });
if (compiled.status !== 0) throw Error(compiled.stdout + compiled.stderr);
const aoiModule = join(out, "worldview-imagery-aoi.js");
writeFileSync(aoiModule, readFileSync(aoiModule, "utf8").replace('from "./worldview-draped-raster"', 'from "./worldview-draped-raster.js"'));
const [{ buildGeoreferencedSurface, maskSurfaceToRing, pointInRing, splitPathAtAntimeridian }, { createImageryAoi, readImageryAoiState, writeImageryAoiState, validateImageryAoiState }, { globeVector }] = await Promise.all([
  import(pathToFileURL(join(out, "worldview-draped-raster.js"))),
  import(pathToFileURL(aoiModule)),
  import(pathToFileURL(join(out, "worldview-globe-math.js"))),
]);
after(() => rmSync(out, { recursive: true, force: true }));

const ring = [[-2, 2], [-1, 2], [-1, 1], [-2, 1], [-2, 2]];
function fixture() {
  const rgba = new Uint8ClampedArray([
    10, 20, 30, 255, 40, 50, 60, 255,
    70, 80, 90, 255, 100, 110, 120, 255,
  ]);
  return buildGeoreferencedSurface(2, 2, rgba, { crs: "EPSG:4326", originX: -2, originY: 2, pixelWidth: 1, pixelHeight: -1 });
}

test("maps known affine pixels to spherical WGS84 positions and preserves source CRS", () => {
  const surface = fixture();
  assert.equal(surface.crs, "EPSG:4326");
  assert.deepEqual(surface.grid[0], [-2, 2]);
  assert.deepEqual(surface.grid[2], [0, 2]);
  assert.deepEqual(surface.samplePoints[0], [-1.5, 1.5]);
  const [x, y, z] = globeVector(surface.samplePoints[0][1], surface.samplePoints[0][0]);
  const radians = Math.PI / 180;
  assert.ok(Math.abs(x - Math.cos(1.5 * radians) * Math.sin(-1.5 * radians)) < 1e-12);
  assert.ok(Math.abs(y - Math.sin(1.5 * radians)) < 1e-12);
  assert.ok(Math.abs(z - Math.cos(1.5 * radians) * Math.cos(-1.5 * radians)) < 1e-12);
});

test("north-first raster rows stay aligned with the globe mesh v=0 north edge", () => {
  const pixels = new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
  const surface = buildGeoreferencedSurface(2, 2, pixels, { crs: "EPSG:4326", originX: -1, originY: 1, pixelWidth: 1, pixelHeight: -1 });
  assert.deepEqual(surface.rgba, pixels, "surface row zero remains the northern source row");
  const globe = readFileSync(resolve(here, "../src/WorldGlobe.tsx"), "utf8");
  assert.match(globe, /texture\.flipY = false/);
  assert.match(globe, /uvs\[at \* 2 \+ 1\] = y \/ surface\.height/);
});

test("clips georeferenced raster tile texels inside and outside a selected AOI", () => {
  const surface = fixture();
  const masked = maskSurfaceToRing(surface, ring);
  assert.deepEqual(Array.from({ length: 4 }, (_, i) => masked[i * 4 + 3]), [255, 0, 0, 0]);
  assert.deepEqual(Array.from(surface.rgba).filter((_, i) => i % 4 === 3), [255, 255, 255, 255], "source pixels remain immutable");
  assert.deepEqual(maskSurfaceToRing(surface, null), surface.rgba);
});

test("handles narrow geofences and raster pixels crossing the antimeridian", () => {
  const dateline = [[179, -5], [-179, -5], [-179, 5], [179, 5], [179, -5]];
  assert.equal(pointInRing([179.5, 0], dateline), true);
  assert.equal(pointInRing([-179.5, 0], dateline), true);
  assert.equal(pointInRing([0, 0], dateline), false);
  const parts = splitPathAtAntimeridian([[179, 0], [-179, 2]]);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].at(-1)[0], 180);
  assert.equal(parts[1][0][0], -180);
  const surface = buildGeoreferencedSurface(2, 1, new Uint8ClampedArray([1, 1, 1, 255, 2, 2, 2, 255]), { crs: "EPSG:4326", originX: 179, originY: 1, pixelWidth: 1, pixelHeight: -1 });
  assert.deepEqual(surface.grid.slice(0, 3), [[179, 1], [-180, 1], [-179, 1]]);
  const mask = maskSurfaceToRing(surface, [[179, 0], [-179, 0], [-179, 1], [179, 1], [179, 0]]);
  assert.deepEqual(Array.from({ length: 2 }, (_, i) => mask[i * 4 + 3]), [255, 255]);
});

test("rejects unsupported CRS and non-north-up affine transforms instead of guessing", () => {
  const bytes = new Uint8ClampedArray([1, 2, 3, 255]);
  assert.throws(() => buildGeoreferencedSurface(1, 1, bytes, { crs: "EPSG:4269", originX: 0, originY: 1, pixelWidth: 1, pixelHeight: -1 }), /Unsupported CRS/);
  assert.throws(() => buildGeoreferencedSurface(1, 1, bytes, { crs: "EPSG:4326", originX: 0, originY: 1, pixelWidth: 1, pixelHeight: 1 }), /north-up/);
});

test("rejects malformed WGS84 origins and extents but permits one antimeridian crossing", () => {
  const pixel = new Uint8ClampedArray(4), twoPixels = new Uint8ClampedArray(8);
  assert.throws(() => buildGeoreferencedSurface(1, 1, pixel, { crs: "EPSG:4326", originX: 1000, originY: 1, pixelWidth: 1, pixelHeight: -1 }), /WGS84 longitude\/latitude bounds/);
  assert.throws(() => buildGeoreferencedSurface(2, 1, twoPixels, { crs: "EPSG:4326", originX: 0, originY: 1, pixelWidth: 181, pixelHeight: -1 }), /spans more than one world/);
  assert.throws(() => buildGeoreferencedSurface(1, 1, pixel, { crs: "EPSG:4326", originX: 0, originY: 91, pixelWidth: 1, pixelHeight: -1 }), /WGS84 longitude\/latitude bounds/);
  assert.throws(() => buildGeoreferencedSurface(1, 1, pixel, { crs: "EPSG:3857", originX: 20037509, originY: 1, pixelWidth: 1, pixelHeight: -1 }), /Web Mercator world bounds/);
});

test("imagery AOIs validate, close rings, persist selection, survive reload, and reset", () => {
  const memory = new Map();
  const storage = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
  const aoi = createImageryAoi("Test AOI", ring, "aoi-1");
  assert.deepEqual(aoi.ring[0], aoi.ring.at(-1));
  const saved = { features: [aoi], selectedId: aoi.id };
  assert.equal(writeImageryAoiState(saved, storage), true);
  assert.deepEqual(readImageryAoiState(storage), saved);
  assert.deepEqual(validateImageryAoiState({ features: [aoi], selectedId: "missing" }), { features: [aoi], selectedId: null });
  assert.equal(writeImageryAoiState({ features: [], selectedId: null }, storage), true);
  assert.deepEqual(readImageryAoiState(storage), { features: [], selectedId: null });
  assert.equal(writeImageryAoiState(saved, { setItem: () => { throw new Error("quota"); } }), false);
  assert.throws(() => createImageryAoi("invalid", [[0, 0], [1, 1]], "bad"), /3–128/);
  assert.throws(() => createImageryAoi("invalid", [[0, 0], [1, 1], [0, 95]], "bad"), /WGS84/);
});
