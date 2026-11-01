import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const out = mkdtempSync(join(here, ".space-visibility-"));
writeFileSync(join(out, "package.json"), '{"type":"module"}\n');
symlinkSync(resolve(here, "../node_modules"), join(out, "node_modules"), "dir");
const compiled = spawnSync(
  process.execPath,
  [resolve(here, "../node_modules/typescript/bin/tsc"), resolve(here, "../src/worldview-space-visibility.ts"),
    "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--skipLibCheck", "--outDir", out],
  { encoding: "utf8" },
);
assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
const vis = await import(pathToFileURL(join(out, "worldview-space-visibility.js")).href);
const satellite = await import("satellite.js");
test.after(() => rmSync(out, { recursive: true, force: true }));

// Synthetic, non-provider fixture: fictional catalog number 99998 with ISS-like elements.
function withChecksum(base) {
  const line = base.padEnd(68, " ");
  let sum = 0;
  for (const c of line) {
    if (c >= "0" && c <= "9") sum += Number(c);
    else if (c === "-") sum += 1;
  }
  return `${line}${sum % 10}`;
}
const line1 = withChecksum("1 99998U 24001A   25001.00000000  .00000000  00000-0  00000-0 0  999");
const line2 = withChecksum("2 99998  51.6400 120.0000 0005000  10.0000  20.0000 15.5000000012345");
const satrec = satellite.twoline2satrec(line1, line2);
const DC = { lat: 38.9072, lon: -77.0369 };
const START = new Date("2025-01-01T00:00:00Z");

// Independent reference: Skyfield 1.55 + sgp4 2.27 + JPL DE421 (scratch venv only, not a runtime
// dependency). find_events(altitude_degrees=10) and is_sunlit() for the same synthetic TLE/observer.
const SKYFIELD = [
  { riseMs: 1735717523494, culmMs: 1735717664474, maxEl: 18.04, az: 130.5, rangeKm: 1087.3, sunEl: -53.31, sunlit: false, setMs: 1735717805935 },
  { riseMs: 1735723261807, culmMs: 1735723454278, maxEl: 44.59, az: 326.1, rangeKm: 577.9, sunEl: -34.69, sunlit: false, setMs: 1735723648320 },
  { riseMs: 1735729206245, culmMs: 1735729299602, maxEl: 12.59, az: 345.1, rangeKm: 1343.7, sunEl: -16.07, sunlit: false, setMs: 1735729393228 },
  { riseMs: 1735740879795, culmMs: 1735741042641, maxEl: 22.11, az: 25.9, rangeKm: 964.6, sunEl: 15.89, sunlit: true, setMs: 1735741205244 },
  { riseMs: 1735746661656, culmMs: 1735746858119, maxEl: 50.63, az: 222.7, rangeKm: 533.8, sunEl: 25.54, sunlit: true, setMs: 1735747053744 },
  { riseMs: 1735806750651, culmMs: 1735806949852, maxEl: 79.06, az: 321.6, rangeKm: 424.6, sunEl: -44.14, sunlit: false, setMs: 1735807150730 },
  { riseMs: 1735812653175, culmMs: 1735812781609, maxEl: 15.77, az: 339.9, rangeKm: 1188.1, sunEl: -25.3, sunlit: false, setMs: 1735812910658 },
  { riseMs: 1735824393606, culmMs: 1735824528197, maxEl: 16.48, az: 20.9, rangeKm: 1163.0, sunEl: 9.1, sunlit: true, setMs: 1735824662654 },
  { riseMs: 1735830155796, culmMs: 1735830357867, maxEl: 85.99, az: 39.4, rangeKm: 422.1, sunEl: 21.52, sunlit: true, setMs: 1735830559272 },
];
const SKYFIELD_SHADOW_EXIT_PASS3 = 1735729328375;

test("pass geometry, sun elevation and illumination match an independent Skyfield reference", () => {
  const { passes, uncertainty } = vis.forecastVisibility(satrec, DC, START, { hours: 48, maxElementAgeDays: 60 });
  assert.equal(uncertainty.status, "current");
  assert.equal(passes.length, SKYFIELD.length);
  passes.forEach((p, i) => {
    const r = SKYFIELD[i];
    assert.equal(p.kind, "forecast");
    assert.ok(Math.abs(Date.parse(p.rise.time) - r.riseMs) < 2000, `rise ${i}`);
    assert.ok(Math.abs(Date.parse(p.set.time) - r.setMs) < 2000, `set ${i}`);
    assert.ok(Math.abs(Date.parse(p.culmination.time) - r.culmMs) < 3000, `culmination ${i}`);
    assert.ok(Math.abs(p.maxElevationDeg - r.maxEl) < 0.1, `max elevation ${i}`);
    assert.ok(Math.abs(p.culmination.rangeKm - r.rangeKm) < 1, `range ${i}`);
    assert.ok(Math.abs(p.culmination.sunElevationDeg - r.sunEl) < 0.1, `sun elevation ${i}`);
    assert.equal(p.culmination.illumination !== "umbra", r.sunlit, `illumination ${i}`);
    const azDiff = Math.abs(((p.culmination.azimuthDeg - r.az + 540) % 360) - 180);
    assert.ok(azDiff < (r.maxEl > 80 ? 2 : 1), `azimuth ${i}`);
  });
  assert.deepEqual(
    passes.map((p) => p.verdict),
    ["eclipsed", "eclipsed", "visible", "daylight", "daylight", "eclipsed", "eclipsed", "daylight", "daylight"],
  );
});

test("visible segment honours sunlit, dark-sky and elevation conditions", () => {
  const { passes } = vis.forecastVisibility(satrec, DC, START, { hours: 48, maxElementAgeDays: 60, standardMagnitude: -1.8 });
  const v = passes[2].visible;
  assert.ok(v);
  // Penumbra edge precedes Skyfield's centre-of-Sun line-of-sight transition by a few seconds.
  const lead = SKYFIELD_SHADOW_EXIT_PASS3 - Date.parse(v.start.time);
  assert.ok(lead > 0 && lead < 10_000, `shadow exit lead ${lead}`);
  assert.ok(Math.abs(Date.parse(v.end.time) - SKYFIELD[2].setMs) < 2000);
  for (const p of [v.start, v.max, v.end, v.brightest]) {
    assert.ok(p.sunElevationDeg <= -6);
    assert.ok(p.elevationDeg >= 9.99);
    assert.notEqual(p.illumination, "umbra");
  }
  assert.ok(Number.isFinite(v.brightest.magnitude));
  assert.equal(passes[2].twilightAtCulmination, "astronomical-twilight");
  // Stricter configurable thresholds remove the segment.
  const strict = vis.forecastVisibility(satrec, DC, START, { hours: 48, maxElementAgeDays: 60, maxSunElevationDeg: -18 });
  assert.equal(strict.passes[2].visible, null);
  assert.equal(strict.passes[2].verdict, "daylight"); // sky never darker than -18° during this pass
});

test("magnitude: standard magnitude, phase term, penumbra dimming and unknown objects", () => {
  assert.equal(vis.apparentMagnitude(-1.8, 1000, 90), -1.8);
  assert.ok(vis.apparentMagnitude(-1.8, 500, 90) < -1.8);
  assert.ok(vis.apparentMagnitude(-1.8, 1000, 30) < vis.apparentMagnitude(-1.8, 1000, 150));
  assert.ok(vis.apparentMagnitude(-1.8, 1000, 90, 0.5) > -1.8);
  assert.equal(vis.apparentMagnitude(-1.8, 1000, 180), null);
  const unknown = vis.forecastVisibility(satrec, DC, START, { hours: 48, maxElementAgeDays: 60 });
  assert.match(unknown.passes[2].magnitudeNote, /magnitude unknown/);
  assert.equal(unknown.passes[2].visible.brightest.magnitude, null);
  const iss = vis.forecastVisibility(satrec, DC, START, { hours: 48, maxElementAgeDays: 60, noradId: 25544 });
  assert.match(iss.passes[2].magnitudeNote, /ISS standard magnitude -1\.8/);
});

test("conical shadow model distinguishes sunlit, penumbra and umbra", () => {
  const sun = { x: 1.496e8, y: 0, z: 0 };
  assert.equal(vis.sunlitFraction({ x: 7000, y: 0, z: 0 }, sun), 1);
  assert.equal(vis.sunlitFraction({ x: -7000, y: 0, z: 0 }, sun), 0);
  // Near the shadow edge, the fraction is between 0 and 1.
  let partial = 0;
  for (let y = 6300; y <= 6460; y += 2) {
    const f = vis.sunlitFraction({ x: -3000, y, z: 0 }, sun);
    if (f > 0 && f < 1) partial++;
  }
  assert.ok(partial > 0);
  assert.equal(vis.twilightPhase(5), "day");
  assert.equal(vis.twilightPhase(-3), "civil-twilight");
  assert.equal(vis.twilightPhase(-9), "nautical-twilight");
  assert.equal(vis.twilightPhase(-15), "astronomical-twilight");
  assert.equal(vis.twilightPhase(-30), "night");
  // Sun elevation sanity: local noon vs midnight at the equator on the March equinox.
  assert.ok(vis.sunElevationDeg({ lat: 0, lon: 0 }, new Date("2025-03-20T12:07:00Z")) > 85);
  assert.ok(vis.sunElevationDeg({ lat: 0, lon: 0 }, new Date("2025-03-20T00:07:00Z")) < -85);
});

test("element age warns, degrades, and refuses old or future elements", () => {
  const at = (days) => new Date(START.getTime() + days * 86_400_000);
  assert.equal(vis.elementUncertainty(satrec, at(1)).status, "current");
  assert.equal(vis.elementUncertainty(satrec, at(5)).status, "aging");
  const old = vis.elementUncertainty(satrec, at(10));
  assert.equal(old.status, "old");
  assert.match(old.note, /Low confidence/);
  assert.ok(old.alongTrackKm > vis.elementUncertainty(satrec, at(1)).alongTrackKm);
  assert.ok(old.timingSeconds > 0);
  const refused = vis.forecastVisibility(satrec, DC, at(20), { hours: 6 });
  assert.equal(refused.passes.length, 0);
  assert.match(refused.refused, /refused/);
  assert.equal(vis.forecastVisibility(satrec, DC, at(-5), { hours: 6 }).uncertainty.status, "future-epoch");
});

test("bounds are validated", () => {
  assert.throws(() => vis.forecastVisibility(satrec, { lat: 91, lon: 0 }, START), /observer/i);
  assert.throws(() => vis.forecastVisibility(satrec, DC, START, { hours: 73 }), /bounds/);
  assert.throws(() => vis.forecastVisibility(satrec, DC, START, { maxSunElevationDeg: 5 }), /bounds/);
  assert.throws(() => vis.forecastVisibility(satrec, DC, START, { minElevationDeg: -1 }), /bounds/);
  assert.throws(() => vis.forecastVisibility(satrec, DC, new Date(NaN)), /bounds/);
  const pos = vis.forecastPosition(satrec, START);
  assert.ok(Math.abs(pos.latitude) <= 51.7 && pos.altitudeKm > 300);
});
