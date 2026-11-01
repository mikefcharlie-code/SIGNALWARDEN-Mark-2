import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const output = mkdtempSync(join(tmpdir(), "worldview-security-"));
writeFileSync(join(output, "package.json"), '{"type":"module"}\n');
const tsc = resolve(here, "../node_modules/typescript/bin/tsc");
const sources = [
  resolve(here, "../src/worldview-core.ts"),
  resolve(here, "../src/worldview-scene-runtime.ts"),
];
const compile = spawnSync(
  process.execPath,
  [
    tsc,
    ...sources,
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
if (compile.status !== 0)
  throw Error(
    `Unable to compile worldview security harness:\n${compile.stdout}\n${compile.stderr}`,
  );
const runtimeTarget = join(output, "worldview-scene-runtime.js");
writeFileSync(
  runtimeTarget,
  readFileSync(runtimeTarget, "utf8").replaceAll(
    /(['"])\.\/worldview-core\1/g,
    '"./worldview-core.js"',
  ),
);
let core = await import(
  `${pathToFileURL(join(output, "worldview-core.js")).href}?security=${Date.now()}`
);
const runtime = await import(
  `${pathToFileURL(runtimeTarget).href}?security=${Date.now()}`
);
test.after(() => rmSync(output, { recursive: true, force: true }));

const observation = (id = "track", lat = 0, lon = 0, extra = {}) => ({
  id,
  layer: "aircraft",
  point: { lat, lon },
  observedAt: "2025-01-01T00:00:00.000Z",
  source: "test",
  label: id,
  freshness: "fresh",
  ...extra,
});
const scene = (patch = {}) => ({
  schemaVersion: 1,
  name: "secure",
  center: { lat: 0, lon: 0 },
  zoom: 3,
  layers: [{ layer: "aircraft", visible: true, opacity: 1 }],
  annotations: [],
  keyframes: [],
  createdAt: "2025-01-01T00:00:00.000Z",
  ...patch,
});
function response(value, status = 200) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-length": String(bytes.byteLength) }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
}

let caseId = 0;
test.beforeEach(async () => {
  core = await import(
    `${pathToFileURL(join(output, "worldview-core.js")).href}?case=${++caseId}`
  );
});
const originalFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("credential-bearing top-level fields reject while ordinary unknown fields are stripped", () => {
  for (const key of [
    "apiKey",
    "token",
    "password",
    "authorization",
    "secret",
    "credential",
  ])
    assert.equal(
      core.validateObservation({ ...observation(), [key]: "must reject" }),
      false,
      key,
    );
  const normalized = core.normalizeObservation({
    ...observation(),
    internalNote: "drop me",
    nested: "also drop",
    properties: { visible: "keep", unknown: true },
  });
  assert.equal(normalized.internalNote, undefined);
  assert.deepEqual(Object.keys(normalized).sort(), [
    "freshness",
    "id",
    "label",
    "layer",
    "observedAt",
    "point",
    "properties",
    "source",
  ]);
  assert.deepEqual(normalized.properties, { visible: "keep", unknown: true });
});

test("properties accept only bounded primitives and bounded counts", () => {
  assert.equal(
    core.validateObservation({
      ...observation(),
      properties: { n: 1, b: false, s: "text", nil: null },
    }),
    true,
  );
  assert.equal(
    core.validateObservation({ ...observation(), properties: { bad: {} } }),
    false,
  );
  assert.equal(
    core.validateObservation({ ...observation(), properties: { bad: NaN } }),
    false,
  );
  assert.equal(
    core.validateObservation({
      ...observation(),
      properties: Object.fromEntries(
        Array.from({ length: 33 }, (_, i) => [`p${i}`, i]),
      ),
    }),
    false,
  );
  assert.equal(
    core.validateObservation({
      ...observation(),
      properties: { long: "x".repeat(501) },
    }),
    false,
  );
});

test("observation pack rejects duplicate IDs and invalid or future exportedAt", () => {
  const base = {
    schemaVersion: 1,
    exportedAt: "2025-01-01T00:00:00.000Z",
    observations: [observation()],
  };
  assert.throws(
    () =>
      core.importObservationPack(
        JSON.stringify({
          ...base,
          observations: [observation(), observation()],
        }),
      ),
    /Invalid observation pack schema/,
  );
  assert.throws(
    () =>
      core.importObservationPack(
        JSON.stringify({ ...base, exportedAt: "not-a-date" }),
      ),
    /Invalid observation pack schema/,
  );
  assert.throws(
    () =>
      core.importObservationPack(
        JSON.stringify({
          ...base,
          exportedAt: new Date(Date.now() + 120000).toISOString(),
        }),
      ),
    /Invalid observation pack schema/,
  );
});

test("scene strips unknown point fields and rejects null or duplicate layer and annotation IDs", () => {
  const encoded = core.encodeScene(
    scene({
      center: { lat: 1, lon: 2, internal: "drop" },
      annotations: [
        {
          id: "a",
          point: { lat: 1, lon: 2, ignored: true },
          text: "ok",
          createdAt: "2025-01-01T00:00:00.000Z",
        },
      ],
    }),
  );
  const decoded = core.decodeScene(encoded);
  assert.deepEqual(decoded.center, { lat: 1, lon: 2 });
  assert.deepEqual(decoded.annotations[0].point, { lat: 1, lon: 2 });
  assert.equal(core.validateScene(scene({ center: null })), false);
  assert.equal(
    core.validateScene(
      scene({ layers: [{ layer: null, visible: true, opacity: 1 }] }),
    ),
    false,
  );
  assert.equal(
    core.validateScene(
      scene({
        annotations: [
          {
            id: null,
            point: { lat: 0, lon: 0 },
            text: "",
            createdAt: "2025-01-01T00:00:00.000Z",
          },
        ],
      }),
    ),
    false,
  );
  assert.equal(
    core.validateScene(
      scene({
        layers: [
          { layer: "aircraft", visible: true, opacity: 1 },
          { layer: "aircraft", visible: false, opacity: 1 },
        ],
      }),
    ),
    false,
  );
});

test("prototype-sensitive layer counts remain safe", () => {
  const items = [observation("__proto__"), observation("constructor", 1, 1)];
  const counts = core.countByLayer(items);
  assert.equal(Object.getPrototypeOf(counts), null);
  assert.equal(counts.aircraft, 2);
});

test("replay is synthetic-aware, explicitly non-live, and interpolates across the antimeridian", () => {
  const a = observation("plane", 0, 179, {
    observedAt: "2025-01-01T00:00:00.000Z",
    freshness: "fresh",
  });
  const b = observation("plane", 10, -179, {
    observedAt: "2025-01-01T01:00:00.000Z",
    freshness: "fresh",
  });
  const mid = core.replayAt([a, b], "2025-01-01T00:30:00.000Z")[0];
  assert.equal(mid.freshness, "fallback");
  assert.match(mid.properties.replayDisclosure, /not live/);
  assert.equal(mid.point.lat, 5);
  assert.ok(Math.abs(Math.abs(mid.point.lon) - 180) < 1e-9);
  const synthetic = core.replayAt(
    [
      { ...a, freshness: "synthetic" },
      { ...b, freshness: "synthetic" },
    ],
    "2025-01-01T00:30:00.000Z",
  )[0];
  assert.equal(synthetic.freshness, "synthetic");
});

test("local decimal geo and city search stay offline", () => {
  assert.deepEqual(runtime.findLocalPlace("38.9072, -77.0369"), {
    lat: 38.9072,
    lon: -77.0369,
  });
  assert.deepEqual(runtime.findLocalPlace("London"), {
    name: "London",
    country: "GB",
    lat: 51.5074,
    lon: -0.1278,
  });
  assert.equal(runtime.findLocalPlace("not a city"), null);
});

test("directorAt smoothly interpolates zoom and antimeridian longitude", () => {
  const frames = [
    { atMs: 0, center: { lat: 0, lon: 179 }, zoom: 2 },
    { atMs: 1000, center: { lat: 10, lon: -179 }, zoom: 4 },
  ];
  const mid = runtime.directorAt(frames, 500);
  assert.equal(mid.center.lat, 5);
  assert.ok(Math.abs(Math.abs(mid.center.lon) - 180) < 1e-9);
  assert.equal(mid.zoom, 3);
});

test("provider fetch rejects redirects", async () => {
  let seen;
  globalThis.fetch = async (_url, options) => {
    seen = options;
    throw new Error("redirected");
  };
  const redirect = await core.refreshNoaaWeather(
    { lat: 11.1111, lon: 22.2222 },
    { network: true },
  );
  assert.equal(redirect.freshness, "failed");
  assert.match(redirect.error, /redirected/);
  assert.equal(seen.redirect, "error");
});

test("NOAA rejects non-allowlisted forecast hosts", async () => {
  globalThis.fetch = async () =>
    response({
      properties: {
        forecast: "https://evil.example/gridpoints/ABC/1/forecast",
      },
    });
  const host = await core.refreshNoaaWeather(
    { lat: 12.1212, lon: 23.2323 },
    { network: true },
  );
  assert.equal(host.freshness, "failed");
  assert.match(host.error, /not allowlisted/);
});

test("NOAA forecast values and issuance timestamps are preserved", async () => {
  const forecast = "https://api.weather.gov/gridpoints/LWX/1,2/forecast";
  globalThis.fetch = async (url) =>
    String(url).includes("/points/")
      ? response({ properties: { forecast } })
      : response({
          properties: {
            updateTime: "2025-02-03T04:05:06Z",
            periods: [
              {
                name: "Tonight",
                temperature: 42,
                temperatureUnit: "F",
                windSpeed: "5 mph",
                shortForecast: "Clear",
                startTime: "2025-02-03T05:00:00Z",
                endTime: "2025-02-03T11:00:00Z",
              },
            ],
          },
        });
  const result = await core.refreshNoaaWeather(
    { lat: 13.1313, lon: 24.2424 },
    { network: true },
  );
  assert.equal(result.freshness, "stale");
  assert.equal(result.observations[0].observedAt, "2025-02-03T04:05:06.000Z");
  assert.deepEqual(result.observations[0].properties, {
    temperature: 42,
    temperatureUnit: "F",
    windSpeed: "5 mph",
    shortForecast: "Clear",
    validFrom: "2025-02-03T05:00:00Z",
    validTo: "2025-02-03T11:00:00Z",
  });
});
