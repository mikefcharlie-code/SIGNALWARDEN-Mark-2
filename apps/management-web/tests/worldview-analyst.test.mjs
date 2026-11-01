import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const output = mkdtempSync(join(tmpdir(), "worldview-analyst-"));
writeFileSync(join(output, "package.json"), '{"type":"module"}\n');
const tsc = resolve(here, "../node_modules/typescript/bin/tsc");
const sources = [
  resolve(here, "../src/worldview-core.ts"),
  resolve(here, "../src/worldview-analyst.ts"),
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
    `Unable to compile worldview analyst harness:\n${compile.stdout}\n${compile.stderr}`,
  );
const analystTarget = join(output, "worldview-analyst.js");
writeFileSync(
  analystTarget,
  readFileSync(analystTarget, "utf8").replaceAll(
    /(['"])\.\/worldview-core\1/g,
    '"./worldview-core.js"',
  ),
);
const analyst = await import(
  `${pathToFileURL(analystTarget).href}?test=${Date.now()}`
);
test.after(() => rmSync(output, { recursive: true, force: true }));

const at = (h) => `2025-01-0${h}T00:00:00.000Z`;
const record = (id, layer = "aircraft", extra = {}) => ({
  id,
  layer,
  point: { lat: 0, lon: 0 },
  observedAt: at(1),
  source: "feed-alpha",
  label: id,
  freshness: "fresh",
  ...extra,
});
const context = (patch = {}) => ({
  records: [],
  annotations: [],
  providers: {},
  passes: [],
  platformEvidence: [],
  platformVerified: false,
  center: { lat: 0, lon: 0 },
  radiusKm: 100,
  visibleLayers: ["aircraft", "vessels", "weather", "earthquakes"],
  sceneName: "test",
  now: Date.parse("2025-01-10T00:00:00.000Z"),
  ...patch,
});
const answer = (question, c = context(), scope = {}) =>
  analyst.answerQuestion(question, c, scope);
const allCitationIdsExist = (a) =>
  a.claims.every(
    (claim) =>
      claim.citationIds.length > 0 &&
      claim.citationIds.every((id) => a.citations.some((c) => c.id === id)),
  );

test("unknown layer scope and natural-language named radar layer abstain", () => {
  for (const [question, scope] of [
    ["Summarize the radar layer", {}],
    ["Summarize visible layers", { layers: ["radar"] }],
  ]) {
    const a = answer(question, context(), scope);
    assert.equal(a.abstained, true, question);
    assert.match(a.warnings.join(" "), /unknown layer|radar/i);
    assert.equal(a.claims.length, 0);
  }
});

test("unsupported questions abstain without invented claims", () => {
  const a = answer("Who will win the election?", context());
  assert.equal(a.abstained, true);
  assert.equal(a.claims.length, 0);
  assert.equal(a.citations.length, 0);
});

test("stale and failed provider context is never represented as fresh", () => {
  const r = record("weather-1", "weather", {
    source: "NOAA",
    freshness: "fresh",
    properties: { temperature: 72 },
  });
  const a = answer(
    "What is the weather temperature?",
    context({
      records: [r],
      providers: {
        NOAA: {
          providerId: "NOAA",
          freshness: "failed",
          error: "offline",
          retrievedAt: at(1),
          observations: [r],
        },
      },
    }),
  );
  assert.match(a.warnings.join(" "), /failed|offline|not treated as current/i);
  assert.doesNotMatch(
    a.claims.map((x) => x.text).join(" "),
    /current|fresh weather/i,
  );
  assert.notEqual(a.citations[0].freshness, "fresh");
});

test("contradictory same-entity same-time field values are retained and disclosed", () => {
  const rs = [
    record("a", "aircraft", {
      id: "a",
      properties: { entityId: "E1", status: "airborne" },
    }),
    record("b", "aircraft", {
      id: "b",
      properties: { entityId: "E1", status: "landed" },
    }),
  ];
  const a = answer("Summarize visible layers", context({ records: rs }));
  assert.match(a.warnings.join(" "), /conflicting status/i);
  assert.match(a.claims.map((x) => x.text).join(" "), /2 latest|aircraft/i);
  assert.ok(
    a.citations.some((c) => c.recordId === "a") &&
      a.citations.some((c) => c.recordId === "b"),
  );
});

test("old and offline platform context is explicitly non-current and cited", () => {
  const evidence = [
    {
      id: "ev1",
      entityId: "drone-1",
      subjectId: "sub-1",
      sourceId: "offline-platform",
      field: "mode",
      value: "AUTO",
      observedAt: at(1),
      trust: "medium",
      freshness: "stale",
      synthetic: false,
    },
  ];
  const a = answer(
    "What platform evidence is verified?",
    context({ platformEvidence: evidence, platformVerified: false }),
  );
  assert.match(
    a.warnings.join(" "),
    /not independently verified|non-fresh|not presented as current|offline\/unverified|historical, not current/i,
  );
  assert.ok(a.claims.length > 0 && allCitationIdsExist(a));
  assert.equal(a.citations[0].recordId, "ev1");
  assert.equal(a.citations[0].observedAt, at(1));
});

test("every non-abstained claim has existing record/source/time citations and no fake citations", () => {
  const a = answer(
    "Summarize visible layers",
    context({ records: [record("a")] }),
  );
  assert.equal(a.abstained, false);
  assert.equal(allCitationIdsExist(a), true);
  for (const c of a.citations) {
    assert.ok(c.recordId && c.source && c.observedAt && c.detail);
    assert.ok(
      c.observedAt === "unknown" || Number.isFinite(Date.parse(c.observedAt)),
    );
    assert.ok(c.recordId !== "fake" && c.source !== "fake");
  }
});

test("synthetic evidence emits a clear warning and citation disclosure", () => {
  const a = answer(
    "Summarize visible layers",
    context({
      records: [
        record("sim", "aircraft", {
          freshness: "synthetic",
          source: "Synthetic feed",
          label: "simulated aircraft",
        }),
      ],
    }),
  );
  assert.match(
    a.warnings.join(" "),
    /synthetic.*not.*live|synthetic evidence/i,
  );
  assert.equal(a.citations[0].synthetic, true);
});

test("answering is deterministic, local, and never consults fetch", () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("network must not be used");
  };
  try {
    const c = context({ records: [record("a")] });
    const one = answer("Summarize visible layers", c);
    const two = answer("Summarize visible layers", c);
    assert.deepEqual(one, two);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("voice permits safe layer, navigation, annotation, and query stages", () => {
  assert.deepEqual(analyst.parseAnalystVoice("show layer aircraft"), {
    kind: "layer",
    layer: "aircraft",
    visible: true,
  });
  assert.deepEqual(analyst.parseAnalystVoice("hide weather"), {
    kind: "layer",
    layer: "weather",
    visible: false,
  });
  assert.deepEqual(analyst.parseAnalystVoice("navigate to London"), {
    kind: "navigate",
    place: "London",
  });
  assert.deepEqual(analyst.parseAnalystVoice("annotate inspection needed"), {
    kind: "annotation",
    text: "inspection needed",
  });
  assert.deepEqual(analyst.parseAnalystVoice("show aircraft near center"), {
    kind: "query",
    question: "show aircraft near center",
  });
});

test("voice rejects actuation, targeting, stalking, recognition, weapons, URLs, SQL, and shell instructions", () => {
  for (const command of [
    "launch drone",
    "rank targets",
    "track person",
    "recognize person",
    "fire weapon",
    "open https://evil.example",
    "select * from users",
    "run rm -rf /",
    "execute shell command",
  ]) {
    const result = analyst.parseAnalystVoice(command);
    assert.equal(result.kind, "reject", command);
  }
});

test("compare honors requested layers, radius, time, and latest per id/source rather than historical double count", () => {
  const rs = [
    record("a", "aircraft", {
      observedAt: at(1),
      source: "A",
      label: "old aircraft",
    }),
    record("a", "aircraft", {
      observedAt: at(2),
      source: "A",
      label: "latest aircraft",
    }),
    record("v", "vessels", { observedAt: at(2), source: "V", label: "vessel" }),
    record("far", "fires", {
      point: { lat: 10, lon: 10 },
      observedAt: at(2),
      source: "F",
      label: "far fire",
    }),
  ];
  const a = answer(
    "Compare aircraft and vessels",
    context({ records: rs, radiusKm: 100 }),
    { layers: ["aircraft", "vessels"], from: at(1), to: at(2) },
  );
  assert.equal(a.abstained, false);
  assert.match(a.claims.map((x) => x.text).join(" "), /aircraft: 1|vessels: 1/);
  assert.doesNotMatch(
    a.claims.map((x) => x.text).join(" "),
    /old aircraft|fires|far fire/,
  );
});

test("history includes multiple samples of one id with unique citations", () => {
  const rs = [
    record("a", "aircraft", { observedAt: at(1), source: "A", label: "first" }),
    record("a", "aircraft", {
      observedAt: at(2),
      source: "A",
      label: "second",
    }),
  ];
  const a = answer(
    "Show history for the selected observation",
    context({ records: rs }),
    { selectedId: "a" },
  );
  assert.match(a.claims[0].text, /2 (?:observations|loaded samples)/);
  assert.equal(new Set(a.citations.map((c) => c.id)).size, 2);
});

test("briefing annotations are context notes, not factual evidence", () => {
  const a = answer(
    "Give a briefing",
    context({
      annotations: [
        {
          id: "note-1",
          point: { lat: 0, lon: 0 },
          text: "operator note",
          createdAt: at(1),
        },
      ],
      records: [record("a")],
    }),
  );
  assert.match(
    a.warnings.join(" "),
    /context notes.*not evidence|operator notes.*not evidence/i,
  );
  assert.doesNotMatch(
    a.citations.map((c) => c.detail).join(" "),
    /operator note/,
  );
});

test("weather and earthquake details are cited from records", () => {
  const rs = [
    record("wx", "weather", {
      properties: { temperature: 68, temperatureUnit: "F", forecast: "Clear" },
    }),
    record("quake", "earthquakes", {
      properties: { magnitude: 4.2, depth: 12 },
    }),
  ];
  const weather = answer(
    "What is the weather temperature?",
    context({ records: rs }),
    { layers: ["weather"] },
  );
  const quake = answer(
    "What is the earthquake magnitude?",
    context({ records: rs }),
    { layers: ["earthquakes"] },
  );
  assert.match(weather.claims[0].text, /temperature[": ]+68/);
  assert.match(quake.claims[0].text, /magnitude[": ]+4\.2/);
  assert.ok(allCitationIdsExist(weather) && allCitationIdsExist(quake));
});

test("orbital passes are cited as derived geometry, never sightings", () => {
  const a = answer(
    "What orbital passes are precomputed?",
    context({ passes: [{ rise: at(2), satellite: "SAT-1" }] }),
  );
  assert.equal(a.abstained, false);
  assert.match(
    a.claims[0].text,
    /derived from TLE geometry|not observed sightings|visibility not assessed/i,
  );
  assert.match(
    a.citations[0].detail,
    /Derived orbital geometry|visibility not assessed|Derived, not observed/i,
  );
  assert.equal(a.citations[0].synthetic, false);
  assert.match(a.citations[0].freshness, /fallback|derived|unknown/i);
});

test("fresh labels require a current matching connector record", () => {
  const now = Date.parse(at(2));
  const r = record("live", "aircraft", { observedAt: at(2) });
  const c = context({ now, records: [r] });
  assert.notEqual(
    answer("Summarize aircraft", c).citations[0].freshness,
    "fresh",
  );
  const p = {
    providerId: "aircraft-provider",
    observations: [r],
    freshness: "fresh",
    retrievedAt: at(2),
  };
  assert.equal(
    answer("Summarize aircraft", { ...c, providers: { p } }).citations[0]
      .freshness,
    "fresh",
  );
  assert.notEqual(
    answer("Summarize aircraft", { ...c, now: now + 180000, providers: { p } })
      .citations[0].freshness,
    "fresh",
  );
  assert.notEqual(
    answer("Summarize aircraft", {
      ...c,
      providers: { p: { ...p, error: "offline", freshness: "failed" } },
    }).citations[0].freshness,
    "fresh",
  );
});

test("synthetic weather markers do not invent temperature measurements", () => {
  const c = context({
    records: [
      record("wx", "weather", {
        freshness: "synthetic",
        properties: { demo: true, readOnly: true },
      }),
    ],
  });
  const a = answer("Show weather temperature", c);
  assert.equal(a.abstained, true);
  assert.equal(a.claims.length, 0);
});

test("calculated pass comparisons include time-scoped weather and preserve derived labels", () => {
  const c = context({
    records: [
      record("wx", "weather", {
        observedAt: at(2),
        properties: { temperature: 60 },
      }),
    ],
    passes: [
      {
        rise: at(2),
        peak: at(2),
        set: at(2),
        calculatedAt: at(1),
        maxElevationDeg: 30,
      },
    ],
  });
  const a = answer("Compare satellite passes and weather", c, {
    from: at(1),
    to: at(2),
  });
  assert.equal(a.abstained, false);
  assert.ok(a.citations.some((c) => /SGP4/.test(c.source)));
  assert.ok(a.citations.some((c) => c.recordId === "wx"));
  assert.match(
    a.claims.map((c) => c.text).join(" "),
    /not observed sightings/i,
  );
});

test("unknown platform times are gaps rather than invented epoch timestamps", () => {
  const c = context({
    platformEvidence: [
      {
        id: "ev",
        entityId: "x",
        subjectId: "x",
        sourceId: "",
        field: "health",
        value: null,
        observedAt: null,
        trust: "unknown",
        freshness: "unknown",
        synthetic: false,
      },
    ],
  });
  const a = answer("Summarize platform evidence", c);
  assert.equal(a.citations[0].observedAt, "unknown");
  assert.equal(a.citations[0].source, "unknown source");
  assert.equal(
    answer("Summarize platform evidence", c, { from: at(1), to: at(2) })
      .abstained,
    true,
  );
});
