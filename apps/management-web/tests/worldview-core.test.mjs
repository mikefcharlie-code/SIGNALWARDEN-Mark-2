import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../src/worldview-core.ts");
const output = mkdtempSync(join(tmpdir(), "worldview-core-"));
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
    `Unable to compile worldview-core.ts:\n${compile.stdout}\n${compile.stderr}`,
  );
const core = await import(
  `${pathToFileURL(join(output, "worldview-core.js")).href}?test=${Date.now()}`
);
test.after(() => rmSync(output, { recursive: true, force: true }));
const obs = (
  id,
  lat,
  lon,
  layer = "aircraft",
  at = "2025-01-01T00:00:00.000Z",
) => ({
  id,
  layer,
  point: { lat, lon },
  observedAt: at,
  source: "test",
  label: id,
  freshness: "fresh",
});
test("validates coordinates and rejects unsafe observations", () => {
  assert.equal(core.validatePoint({ lat: 0, lon: 0 }), true);
  assert.equal(core.validatePoint({ lat: 91, lon: 0 }), false);
  assert.equal(core.validateObservation(obs("a", 0, 0)), true);
  assert.equal(
    core.validateObservation({ ...obs("a", 0, 0), confidence: 2 }),
    false,
  );
  assert.throws(() =>
    core.normalizeObservation({
      ...obs("a", 0, 0),
      point: { lat: 999, lon: 0 },
    }),
  );
});
test("geo URI and bundled city search are deterministic and offline", () => {
  const p = { lat: 51.5, lon: -0.12, uncertaintyM: 10 };
  assert.deepEqual(core.parseGeoUri(core.formatGeoUri(p)), p);
  assert.throws(() => core.parseGeoUri("geo:91,0"));
  assert.equal(core.searchCities("london")[0].country, "GB");
  assert.deepEqual(core.searchCities("not a city"), []);
});
test("nearby and analyst query filter/rank without mutating input", () => {
  const items = [
    obs("far", 40.1, -74.1),
    obs("near", 40.01, -74.01, "earthquakes"),
  ];
  const result = core.nearbyObservations(items, { lat: 40, lon: -74 }, 10);
  assert.deepEqual(
    result.map((x) => x.id),
    ["near"],
  );
  assert.deepEqual(
    core
      .queryObservations(items, { layers: ["earthquakes"], text: "near" })
      .map((x) => x.id),
    ["near"],
  );
  assert.deepEqual(
    { ...core.countByLayer(items) },
    { aircraft: 1, earthquakes: 1 },
  );
});
test("scene round trip and schema validation enforce limits", () => {
  const scene = {
    schemaVersion: 1,
    name: "test",
    center: { lat: 0, lon: 0 },
    zoom: 3,
    layers: [{ layer: "aircraft", visible: true, opacity: 1 }],
    annotations: [],
    keyframes: [],
    createdAt: "2025-01-01T00:00:00.000Z",
  };
  const decoded = core.decodeScene(core.encodeScene(scene));
  assert.deepEqual(decoded, scene);
  assert.equal(core.validateScene({ ...scene, schemaVersion: 2 }), false);
  assert.throws(() =>
    core.decodeScene(
      encodeURIComponent(JSON.stringify({ ...scene, schemaVersion: 2 })),
    ),
  );
  assert.throws(() => core.encodeScene({ ...scene, name: "x".repeat(121) }));
});
test("pack limits and replay interpolation are safe", () => {
  const a = obs("track", 0, 0, "aircraft", "2025-01-01T00:00:00.000Z"),
    b = obs("track", 10, 20, "aircraft", "2025-01-01T01:00:00.000Z");
  const pack = core.importObservationPack(
    core.exportObservationPack([a, { ...b, id: "other" }]),
  );
  assert.equal(pack.observations.length, 2);
  const mid = core.replayAt([a, b], "2025-01-01T00:30:00.000Z");
  assert.equal(mid[0].point.lat, 5);
  assert.equal(mid[0].point.lon, 10);
  assert.throws(() =>
    core.importObservationPack(
      '{"schemaVersion":1,"observations":[]} trailing',
    ),
  );
});
test("demo observations are explicitly synthetic and provider failure discloses state", async () => {
  assert.ok(
    core
      .createDemoObservations()
      .every((x) => x.freshness === "synthetic" && x.properties.demo === true),
  );
  const result = await core.refreshUsgsEarthquakes();
  assert.equal(result.freshness, "failed");
  assert.match(result.error, /opt-in/);
  assert.match(core.providerStatus(result).disclosure, /no live claim/);
});
