import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const here = new URL("..", import.meta.url);
const root = fileURLToPath(here);
const out = mkdtempSync(join(tmpdir(), "globe-viewport-"));
const compiled = spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), join(root, "src/worldview-globe-viewport.ts"), "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--skipLibCheck", "--outDir", out], { encoding: "utf8" });
assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
const { visibleGlobeBounds, visibleOrthographicBounds } = await import(pathToFileURL(join(out, "worldview-globe-viewport.js")));
test.after(() => rmSync(out, { recursive: true, force: true }));

function cameraAt(lonDegrees) {
  const lon = lonDegrees * Math.PI / 180;
  const position = [3.4 * Math.sin(lon), 0, 3.4 * Math.cos(lon)];
  const forward = position.map(v => -v / 3.4);
  const right = [Math.cos(lon), 0, -Math.sin(lon)];
  return { position, right, up: [0, 1, 0], forward, aspect: 1, fovDegrees: 38 };
}

test("derives a bounded viewport from camera rays, not application records", () => {
  const bounds = visibleGlobeBounds(cameraAt(-77));
  assert.equal(bounds.length, 1);
  const [view] = bounds;
  assert.ok(view.west < -77 && view.east > -77);
  assert.ok(view.south < 0 && view.north > 0);
  assert.ok(view.west > -180 && view.east < 180);
  assert.ok(view.south >= -90 && view.north <= 90);
});

test("splits a visible viewport that crosses the antimeridian into valid provider boxes", () => {
  const bounds = visibleGlobeBounds(cameraAt(179));
  assert.equal(bounds.length, 2);
  assert.ok(bounds[0].west > 100 && bounds[0].east === 180);
  assert.ok(bounds[1].west === -180 && bounds[1].east < -100);
  assert.ok(bounds.every(b => b.west < b.east && b.south < b.north));
});

test("rejects invalid camera views instead of broadening a provider query", () => {
  assert.deepEqual(visibleGlobeBounds({ ...cameraAt(0), aspect: 0 }), []);
  assert.deepEqual(visibleGlobeBounds({ ...cameraAt(0), fovDegrees: 180 }), []);
  assert.deepEqual(visibleGlobeBounds({ ...cameraAt(0), position: [0, 0, 0.5] }), []);
  assert.deepEqual(visibleGlobeBounds(cameraAt(0), 99), []);
});

test("orthographic fallback reports only the visible disk and splits the date line", () => {
  const local = visibleOrthographicBounds({ lat: 38, lon: -77 }, 1);
  assert.equal(local.length, 1);
  assert.ok(local[0].west < -77 && local[0].east > -77);
  assert.ok(local[0].south < 38 && local[0].north > 38);
  const dateLine = visibleOrthographicBounds({ lat: 0, lon: 179 }, 1);
  assert.equal(dateLine.length, 2);
  assert.equal(dateLine[0].east, 180);
  assert.equal(dateLine[1].west, -180);
  assert.ok(dateLine.every((b) => b.west < b.east && b.south < b.north));
  assert.deepEqual(visibleOrthographicBounds({ lat: 90, lon: 0 }, 1), []);
});
