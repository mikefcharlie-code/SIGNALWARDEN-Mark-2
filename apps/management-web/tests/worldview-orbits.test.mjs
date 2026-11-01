import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../src/worldview-orbits.ts");
const output = mkdtempSync(join(here, ".worldview-orbits-"));
writeFileSync(join(output, "package.json"), '{"type":"module"}\n');
const tsc = resolve(here, "../node_modules/typescript/bin/tsc");
const compile = spawnSync(
  process.execPath,
  [
    tsc,
    source,
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
  { encoding: "utf8", cwd: output },
);
if (compile.status !== 0)
  throw new Error(
    `Unable to compile worldview-orbits.ts:\n${compile.stdout}\n${compile.stderr}`,
  );
const orbit = await import(
  `${pathToFileURL(join(output, "worldview-orbits.js")).href}?test=${Date.now()}`
);
test.after(() => rmSync(output, { recursive: true, force: true }));

// Synthetic, non-provider fixture: deliberately fictional catalog number and orbital elements.
function withChecksum(base) {
  const line = base.padEnd(68, " ");
  let sum = 0;
  for (const c of line) {
    if (c >= "0" && c <= "9") sum += Number(c);
    else if (c === "-") sum += 1;
  }
  return `${line}${sum % 10}`;
}
const line1 = withChecksum(
  "1 99999U 24001A   25001.00000000  .00000000  00000-0  00000-0 0  999",
);
const line2 = withChecksum(
  "2 99999  51.6400 120.0000 0005000  10.0000  20.0000 15.5000000012345",
);
const fixture = `SYNTHETIC TEST ORBIT\n${line1}\n${line2}`;

test("parses the labeled synthetic TLE and rejects checksum/length mutations", () => {
  const parsed = orbit.parseTle(fixture);
  assert.equal(parsed.name, "SYNTHETIC TEST ORBIT");
  assert.equal(parsed.line1.length, 69);
  assert.throws(() => orbit.parseTle(`${line1.slice(0, -1)}1\n${line2}`));
  assert.throws(() => orbit.parseTle(`${line1}\n${line2.slice(0, -1)}`));
  assert.throws(() => orbit.parseTle(`${line1}\n${line2}\nextra`));
});

test("propagation is deterministic and returns finite bounded geodetic values", () => {
  const tle = orbit.parseTle(fixture);
  const at = new Date("2025-01-01T00:00:00.000Z");
  const first = orbit.satellitePosition(tle, at);
  assert.deepEqual(first, orbit.satellitePosition(tle, at));
  assert.equal(first.at, at.toISOString());
  assert.ok(
    Number.isFinite(first.latitude) &&
      first.latitude >= -90 &&
      first.latitude <= 90,
  );
  assert.ok(
    Number.isFinite(first.longitude) &&
      first.longitude >= -180 &&
      first.longitude <= 180,
  );
  assert.ok(Number.isFinite(first.altitudeKm) && first.altitudeKm > 0);
});

test("pass prediction is bounded, finite, and explicitly does not assess visibility", () => {
  const tle = orbit.parseTle(fixture);
  const passes = orbit.predictPasses(
    tle,
    { lat: 38.9, lon: -77, altitudeKm: 0.1 },
    new Date("2025-01-01T00:00:00Z"),
    6,
    10,
  );
  assert.ok(Array.isArray(passes));
  for (const pass of passes) {
    assert.equal(pass.visibility, "not-assessed");
    assert.ok(Number.isFinite(pass.maxElevationDeg));
    assert.ok(Date.parse(pass.rise) <= Date.parse(pass.peak));
    assert.ok(Date.parse(pass.peak) <= Date.parse(pass.set));
  }
  assert.throws(() =>
    orbit.predictPasses(tle, { lat: 0, lon: 0 }, new Date(), 24.01),
  );
  assert.throws(() =>
    orbit.predictPasses(tle, { lat: 91, lon: 0 }, new Date(), 1),
  );
  assert.throws(() =>
    orbit.predictPasses(tle, { lat: 0, lon: 0 }, new Date(), 1, 91),
  );
});
