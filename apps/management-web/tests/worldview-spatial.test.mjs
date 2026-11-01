import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../src/worldview-spatial.ts");
const output = mkdtempSync(join(tmpdir(), "worldview-spatial-"));
writeFileSync(join(output, "package.json"), '{"type":"module"}\n');
// The compiled adapter retains Turf imports; make the app's installed modules resolvable from tmp.
symlinkSync(resolve(here, "../node_modules"), join(output, "node_modules"), "dir");
const tsc = resolve(here, "../node_modules/typescript/bin/tsc");
const compile = spawnSync(process.execPath, [tsc, source, "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--skipLibCheck", "--outDir", output], { encoding: "utf8", cwd: output });
if (compile.status !== 0) throw new Error(`Unable to compile spatial adapter:\n${compile.stdout}\n${compile.stderr}`);
const spatial = await import(`${pathToFileURL(join(output, "worldview-spatial.js")).href}?test=${Date.now()}`);
test.after(() => rmSync(output, { recursive: true, force: true }));
const box = { south: 0, west: 0, north: 10, east: 10 };
const obs = (id, lat, lon, freshness = "synthetic", source = "local synthetic scene") => ({ id, label: id, point: { lat, lon }, freshness, source });

test("Turf rectangle uses a closed ring and boundary point intersects", () => {
  const rectangle = spatial.createSpatialRectangle(box);
  assert.deepEqual(rectangle.geometry.coordinates[0][0], rectangle.geometry.coordinates[0].at(-1));
  const result = spatial.analyzeSpatial({ lat: -5, lon: 5 }, { lat: 0, lon: 5 }, box, [], false);
  assert.equal(result.selectedIntersects, true);
  assert.equal(result.routeStatus, "not-requested");
});

test("Turf line intersection distinguishes crossing and disjoint routes", () => {
  const crossing = spatial.analyzeSpatial({ lat: 5, lon: -5 }, { lat: 5, lon: 15 }, box, [], true);
  const disjoint = spatial.analyzeSpatial({ lat: 20, lon: 0 }, { lat: 30, lon: 0 }, box, [], true);
  assert.equal(crossing.routeIntersects, true);
  assert.equal(disjoint.routeIntersects, false);
});

test("malformed, degenerate, pole, and date-line rectangles are rejected", () => {
  for (const invalid of [
    { south: 0, west: 10, north: 0, east: 20 },
    { south: 0, west: 170, north: 10, east: -170 },
    { south: -90, west: 0, north: 10, east: 10 },
    { south: 0, west: 0, north: 10, east: Number.NaN },
    { south: 0, west: -100, north: 10, east: 80 },
  ]) assert.throws(() => spatial.createSpatialRectangle(invalid));
  const rejected = spatial.analyzeSpatial({ lat: 0, lon: 179 }, { lat: 0, lon: -179 }, box, [], true);
  assert.equal(rejected.routeStatus, "rejected-antimeridian");
  assert.equal(rejected.routeIntersects, null);
  const polar = spatial.analyzeSpatial({ lat: 90, lon: 5 }, { lat: 0, lon: 5 }, box, [], true);
  assert.equal(polar.routeStatus, "rejected-polar");
  assert.equal(polar.routeIntersects, null);
  assert.throws(() => spatial.analyzeSpatial({ lat: 0, lon: 0 }, { lat: 91, lon: 0 }, box, [], false), /Selected coordinate/);
});

test("bounded scene query sorts eligible points and excludes provider/live or malformed records", () => {
  const result = spatial.analyzeSpatial({ lat: 5, lon: 5 }, null, box, [
    obs("far", 9, 9), obs("near", 5, 5), obs("provider", 5, 5, "fresh", "adsb.lol"),
    obs("live", 5, 5, "fresh", "live aircraft"), { ...obs("bad", 5, 5), point: { lat: Number.NaN, lon: 5 } },
    obs("outside", 30, 30),
  ], false);
  assert.deepEqual(result.matches.map((x) => x.id), ["near", "far"]);
  assert.equal(result.excludedCount, 3);
});

test("source policy is explicit and oversized input is rejected before Turf processing", () => {
  assert.equal(spatial.isSpatiallyEligible({ freshness: "synthetic", source: "SignalWarden synthetic demo" }), true);
  assert.equal(spatial.isSpatiallyEligible({ freshness: "synthetic", source: "SignalWarden synthetic replay" }), true);
  assert.equal(spatial.isSpatiallyEligible({ freshness: "synthetic", source: "Imported synthetic pack" }), true);
  assert.equal(spatial.isSpatiallyEligible({ freshness: "synthetic", source: "provider synthetic aircraft" }), false);
  assert.equal(spatial.isSpatiallyEligible({ freshness: "synthetic", source: 42 }), false);
  assert.equal(spatial.isSpatiallyEligible(null), false);
  assert.throws(() => spatial.analyzeSpatial({ lat: 5, lon: 5 }, null, box, Array.from({ length: spatial.MAX_SPATIAL_RECORDS + 1 }, (_, i) => obs(String(i), 5, 5)), false), /at most 5000 records/);
});
