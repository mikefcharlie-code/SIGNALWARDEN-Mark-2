import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const here = dirname(fileURLToPath(import.meta.url));
const output = mkdtempSync(join(tmpdir(), "worldview-globe-"));
writeFileSync(join(output, "package.json"), '{"type":"module"}\n');
const compile = spawnSync(
  process.execPath,
  [
    resolve(here, "../node_modules/typescript/bin/tsc"),
    resolve(here, "../src/worldview-globe-math.ts"),
    "--target",
    "ES2022",
    "--module",
    "ESNext",
    "--moduleResolution",
    "Bundler",
    "--skipLibCheck",
    "--outDir",
    output,
  ],
  { encoding: "utf8" },
);
if (compile.status !== 0) throw Error(compile.stdout + compile.stderr);
const m = await import(
  pathToFileURL(join(output, "worldview-globe-math.js")).href
);
test.after(() => rmSync(output, { recursive: true, force: true }));
test("globe coordinates map to unit sphere with north up", () => {
  assert.deepEqual(m.globeVector(0, 0), [0, 0, 1]);
  const north = m.globeVector(90, 0);
  assert.equal(north[1], 1);
  for (const [lat, lon] of [
    [-90, 180],
    [38, -77],
    [60, 130],
  ])
    assert.ok(Math.abs(Math.hypot(...m.globeVector(lat, lon)) - 1) < 1e-10);
});
test("projection hides the far side and centers the requested location", () => {
  const center = { lat: 38, lon: -77 };
  const p = m.orthographic(38, -77, center);
  assert.ok(Math.abs(p.x) < 1e-10 && Math.abs(p.y) < 1e-10 && p.visible);
  assert.equal(m.orthographic(-38, 103, center).visible, false);
});
test("navigation wraps date line and clamps pole singularities", () => {
  assert.deepEqual(m.normalizedCenter(100, 181), { lat: 89, lon: -179 });
  assert.deepEqual(m.normalizedCenter(-100, -181), { lat: -89, lon: 179 });
  assert.deepEqual(m.normalizedCenter(NaN, Infinity), { lat: 0, lon: 0 });
});
