import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const here = dirname(fileURLToPath(import.meta.url));
const out = mkdtempSync(join(here, ".space-feeds-"));
writeFileSync(join(out, "package.json"), '{"type":"module"}\n');
symlinkSync(resolve(here, "../node_modules"), join(out, "node_modules"), "dir");
const compiled = spawnSync(
  process.execPath,
  [resolve(here, "../node_modules/typescript/bin/tsc"), resolve(here, "../src/worldview-space-feeds.ts"),
    "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--skipLibCheck", "--outDir", out],
  { encoding: "utf8" },
);
assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
const feedsJs = join(out, "worldview-space-feeds.js");
writeFileSync(feedsJs, readFileSync(feedsJs, "utf8").replace(/(["'])\.\/worldview-space-visibility\1/g, '"./worldview-space-visibility.js"'));
const f = await import(pathToFileURL(feedsJs).href);
test.after(() => rmSync(out, { recursive: true, force: true }));

const NOW = Date.parse("2025-01-02T00:00:00Z");
// Hand-written synthetic OMM record (fictional NORAD 99998); not provider data.
const OMM = [{
  OBJECT_NAME: "SYNTHETIC SAT", OBJECT_ID: "2024-001A", EPOCH: "2025-01-01T00:00:00.000000", MEAN_MOTION: 15.5,
  ECCENTRICITY: 0.0005, INCLINATION: 51.64, RA_OF_ASC_NODE: 120, ARG_OF_PERICENTER: 10, MEAN_ANOMALY: 20,
  EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: "U", NORAD_CAT_ID: 99998, ELEMENT_SET_NO: 999, REV_AT_EPOCH: 1,
  BSTAR: 0, MEAN_MOTION_DOT: 0, MEAN_MOTION_DDOT: 0,
}];
const OLD_OMM = [{ ...OMM[0], NORAD_CAT_ID: 99997, OBJECT_NAME: "OLD SYNTHETIC", EPOCH: "2024-12-01T00:00:00" }];

function mockFetch(routes) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    for (const [match, reply] of routes) {
      if (String(url).includes(match)) {
        const r = typeof reply === "function" ? reply(url, init) : reply;
        const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
        return new Response(body, { status: r.status ?? 200, headers: r.headers ?? {} });
      }
    }
    throw new Error(`unexpected URL ${url}`);
  };
  return { fetcher, calls };
}
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m };
}

test("network opt-in is required and nothing is fetched without it", async () => {
  f.resetSpaceFeedState();
  const { fetcher, calls } = mockFetch([]);
  const opts = { fetcher, storage: null, now: () => NOW };
  assert.equal((await f.refreshCelestrak({ kind: "catnr", value: 25544 }, opts)).freshness, "disabled");
  assert.equal((await f.refreshCloudForecast("nws-skycover", { lat: 1, lon: 1 }, opts)).freshness, "disabled");
  assert.equal((await f.refreshSatnogsObservations(25544, opts)).freshness, "disabled");
  assert.equal((await f.refreshLaunches("direct", opts)).freshness, "disabled");
  assert.equal(calls.length, 0);
});

test("CelesTrak: query allowlist, parsing, epoch age and 2-hour cache", async () => {
  f.resetSpaceFeedState();
  assert.throws(() => f.catalogQueryString({ kind: "group", value: "starlink" }), /allowlisted/);
  assert.throws(() => f.catalogQueryString({ kind: "group", value: "active" }), /allowlisted/);
  assert.throws(() => f.catalogQueryString({ kind: "name", value: "a&b=c" }), /Name search/);
  assert.throws(() => f.catalogQueryString({ kind: "catnr", value: 0 }), /NORAD/);
  assert.equal(f.catalogQueryString({ kind: "name", value: "iss" }), "NAME=ISS");
  const storage = memoryStorage();
  let now = NOW;
  const { fetcher, calls } = mockFetch([["celestrak.org", { body: [...OMM, ...OLD_OMM] }]]);
  const opts = { network: true, fetcher, storage, now: () => now };
  const first = await f.refreshCelestrak({ kind: "group", value: "stations" }, opts);
  assert.equal(first.freshness, "fresh");
  assert.equal(calls[0].url, "https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(first.entries.length, 2);
  assert.equal(first.entries[0].kind, "orbital-elements");
  assert.equal(first.entries[0].epoch, "2025-01-01T00:00:00.000Z");
  assert.equal(first.entries[0].ageStatus, "current");
  assert.equal(first.entries[1].ageStatus, "too-old");
  assert.match(first.note, /days old/);
  assert.equal(first.providerTimestamp, "2025-01-01T00:00:00.000Z");
  assert.match(first.attribution, /CelesTrak/);
  assert.ok(first.licenseUrl.startsWith("https://celestrak.org/"));
  // Within 2 hours: served from cache, no request. Survives a memory reset via storage.
  now = NOW + 119 * 60_000;
  f.resetSpaceFeedState();
  const second = await f.refreshCelestrak({ kind: "group", value: "stations" }, opts);
  assert.equal(second.freshness, "cached");
  assert.equal(calls.length, 1);
  assert.equal(second.nextAllowedAt, new Date(NOW + 2 * 3_600_000).toISOString());
  now = NOW + 121 * 60_000;
  assert.equal((await f.refreshCelestrak({ kind: "group", value: "stations" }, opts)).freshness, "fresh");
  assert.equal(calls.length, 2);
});

test("CelesTrak: no data, 403 policy refusal, non-JSON and oversize responses", async () => {
  f.resetSpaceFeedState();
  let reply = { status: 404, body: "No GP data found" };
  const { fetcher } = mockFetch([["celestrak.org", () => reply]]);
  let now = NOW;
  const opts = { network: true, fetcher, storage: null, now: () => now };
  const none = await f.refreshCelestrak({ kind: "catnr", value: 123 }, opts);
  assert.equal(none.entries.length, 0);
  assert.match(none.note, /no GP data/);
  reply = { status: 403, body: "GP data has not updated since your last successful download" };
  const refused = await f.refreshCelestrak({ kind: "catnr", value: 124 }, opts);
  assert.equal(refused.freshness, "failed");
  assert.match(refused.error, /2 hours/);
  reply = { status: 200, body: "Invalid query" };
  assert.match((await f.refreshCelestrak({ kind: "catnr", value: 125 }, opts)).error, /non-JSON/);
  reply = { status: 200, body: "[" + " ".repeat(1_100_000) + "]" };
  assert.match((await f.refreshCelestrak({ kind: "catnr", value: 126 }, opts)).error, /1 MiB/);
  reply = { status: 200, body: "[]", headers: { "content-length": "5000000" } };
  assert.match((await f.refreshCelestrak({ kind: "catnr", value: 127 }, opts)).error, /1 MiB/);
});

test("NWS skyCover forecast: gridpoint allowlist, parsing and obscured label", async () => {
  f.resetSpaceFeedState();
  assert.equal(f.parseIsoDurationMs("PT1H"), 3_600_000);
  assert.equal(f.parseIsoDurationMs("P1DT6H"), 30 * 3_600_000);
  assert.equal(f.parseIsoDurationMs("bogus"), null);
  const grid = {
    properties: {
      updateTime: "2025-01-01T20:00:00+00:00",
      skyCover: { uom: "wmoUnit:percent", values: [
        { validTime: "2025-01-02T00:00:00+00:00/PT2H", value: 85 },
        { validTime: "2025-01-02T02:00:00+00:00/PT1H", value: 10 },
        { validTime: "bad", value: 5 },
        { validTime: "2025-01-02T03:00:00+00:00/PT1H", value: 150 },
      ] },
    },
  };
  const { fetcher, calls } = mockFetch([
    ["/points/", { body: { properties: { forecastGridData: "https://api.weather.gov/gridpoints/LWX/96,72" } } }],
    ["/gridpoints/LWX/96,72", { body: grid }],
  ]);
  const opts = { network: true, fetcher, storage: null, now: () => NOW };
  const fc = await f.refreshCloudForecast("nws-skycover", { lat: 38.9072, lon: -77.0369 }, opts);
  assert.equal(fc.freshness, "fresh");
  assert.equal(fc.kind, "cloud-forecast");
  assert.equal(fc.series.length, 2);
  assert.equal(fc.providerTimestamp, "2025-01-01T20:00:00.000Z");
  assert.match(fc.note, /Forecast/);
  assert.equal(f.cloudAt(fc, NOW + 30 * 60_000).label, "likely-obscured");
  assert.equal(f.cloudAt(fc, NOW + 150 * 60_000).label, "clear-to-partly-cloudy");
  assert.equal(f.cloudAt(fc, NOW + 10 * 3_600_000).label, "no-forecast");
  assert.equal(calls.length, 2);
  // Cached for an hour.
  assert.equal((await f.refreshCloudForecast("nws-skycover", { lat: 38.9072, lon: -77.0369 }, opts)).freshness, "cached");
  assert.equal(calls.length, 2);
  // A points response redirecting to a foreign host is rejected.
  f.resetSpaceFeedState();
  const evil = mockFetch([["/points/", { body: { properties: { forecastGridData: "https://evil.example/gridpoints/LWX/1,2" } } }]]);
  const bad = await f.refreshCloudForecast("nws-skycover", { lat: 1, lon: 1 }, { ...opts, fetcher: evil.fetcher });
  assert.equal(bad.freshness, "failed");
  assert.match(bad.error, /allowlisted/);
  assert.equal(evil.calls.length, 1);
});

test("Open-Meteo cloud_cover forecast parses and reports rate limits honestly", async () => {
  f.resetSpaceFeedState();
  const t0 = NOW / 1000;
  const { fetcher, calls } = mockFetch([["open-meteo", { body: { hourly: { time: [t0, t0 + 3600], cloud_cover: [90, 20] } } }]]);
  const denied = await f.refreshCloudForecast("open-meteo", { lat: 10, lon: 20 }, { network: true, fetcher, now: () => NOW });
  assert.equal(denied.freshness, "disabled"); assert.equal(calls.length, 0); assert.match(denied.error, /non-commercial/);
  const fc = await f.refreshCloudForecast("open-meteo", { lat: 10, lon: 20 }, { network: true, openMeteoTermsConfirmed: true, fetcher, storage: null, now: () => NOW });
  assert.equal(fc.freshness, "unknown");
  assert.match(calls[0].url, /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?latitude=10&longitude=20&hourly=cloud_cover/);
  assert.equal(f.cloudAt(fc, NOW + 10 * 60_000).label, "likely-obscured");
  assert.equal(f.cloudAt(fc, NOW + 3600_000).percent, 20);
  assert.match(fc.attribution, /Open-Meteo/);
  f.resetSpaceFeedState();
  const limited = mockFetch([["open-meteo", { status: 429, body: { error: true } }]]);
  const r = await f.refreshCloudForecast("open-meteo", { lat: 10, lon: 20 }, { network: true, openMeteoTermsConfirmed: true, fetcher: limited.fetcher, storage: null, now: () => NOW });
  assert.equal(r.freshness, "failed");
  assert.match(r.error, /rate limit/);
  assert.equal(r.series.length, 0);
});

test("SatNOGS radio observations go through the opt-in relay and are labelled observed radio data", async () => {
  f.resetSpaceFeedState();
  const disabled = mockFetch([["/satnogs/", { status: 404, body: { error: { code: "space_relay_disabled", message: "x" } } }]]);
  const d = await f.refreshSatnogsObservations(25544, { network: true, fetcher: disabled.fetcher, now: () => NOW });
  assert.equal(d.freshness, "disabled");
  assert.match(d.error, /UCAS_SPACE_RELAY_ENABLED=1/);
  assert.equal(disabled.calls[0].url, "/api/v1/worldview/space/satnogs/observations?norad=25544");
  assert.equal(disabled.calls[0].init.headers["X-SignalWarden-Space"], "enabled");
  const ok = mockFetch([["/satnogs/", { body: {
    retrievedAt: "2025-01-01T23:59:00Z", cached: false,
    observations: [
      { id: 7, start: "2025-01-01T20:00:00Z", end: "2025-01-01T20:08:00Z", status: "good", stationId: 4, stationName: "TEST", transmitter: "Beacon", mode: "FSK", frequencyHz: 437e6 },
      { id: 8, start: "2030-01-01T20:00:00Z", end: "2030-01-01T20:08:00Z", status: "good" },
      { id: "x", start: "2025-01-01T20:00:00Z", end: "2025-01-01T20:08:00Z" },
    ],
  } }]]);
  const r = await f.refreshSatnogsObservations(25544, { network: true, fetcher: ok.fetcher, now: () => NOW });
  assert.equal(r.freshness, "fresh");
  assert.equal(r.kind, "radio-observations");
  assert.equal(r.observations.length, 1);
  assert.equal(r.observations[0].kind, "radio-observation");
  assert.equal(r.observations[0].url, "https://network.satnogs.org/observations/7/");
  assert.match(r.note, /not optical sightings/);
  assert.equal(r.providerTimestamp, "2025-01-01T20:08:00.000Z");
  assert.equal((await f.refreshSatnogsObservations(-1, { network: true, fetcher: ok.fetcher })).error, "Invalid NORAD catalog number");
});

test("SatNOGS explicit stale fallback stays stale and retains relay timestamps", async () => {
  f.resetSpaceFeedState();
  const retrievedAt = "2025-01-01T23:00:00Z";
  const ok = mockFetch([["/satnogs/", { body: {
    retrievedAt, stale: true, cached: false,
    observations: [{ id: 9, start: "2025-01-01T20:00:00Z", end: "2025-01-01T20:08:00Z", status: "good" }],
  } }]]);
  const r = await f.refreshSatnogsObservations(25544, { network: true, fetcher: ok.fetcher, now: () => NOW });
  assert.equal(r.freshness, "stale");
  assert.equal(r.retrievedAt, "2025-01-01T23:00:00.000Z");
  assert.equal(r.providerTimestamp, "2025-01-01T20:08:00.000Z");
  assert.match(r.error, /stale fallback/);
});

test("Launch Library 2: direct keyless reads are throttled; relay reports key status without the key", async () => {
  f.resetSpaceFeedState();
  const body = { results: [
    { id: "00000000-0000-4000-8000-000000000001", name: "Synthetic | Test", net: "2025-01-03T12:00:00Z", window_start: "2025-01-03T11:00:00Z",
      window_end: "2025-01-03T13:00:00Z", last_updated: "2025-01-01T12:00:00Z", status: { abbrev: "Go", description: "d" },
      lsp_name: "Example", mission: "Test", pad: "Pad 0", location: "Range" },
    { id: "not a uuid!", net: "2025-01-03T12:00:00Z" },
  ] };
  let now = NOW;
  const direct = mockFetch([["ll.thespacedevs.com", { body }]]);
  const r = await f.refreshLaunches("direct", { network: true, fetcher: direct.fetcher, now: () => now });
  assert.equal(direct.calls[0].url, "https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=10&mode=list");
  assert.equal(r.launches.length, 1);
  assert.equal(r.launches[0].kind, "scheduled-launch");
  assert.match(r.note, /not a confirmation/);
  assert.equal(r.providerTimestamp, "2025-01-01T12:00:00.000Z");
  now += 16 * 60_000; // past both the 15-minute cache and the 10-minute keyless floor
  await f.refreshLaunches("direct", { network: true, fetcher: direct.fetcher, now: () => now });
  assert.equal(direct.calls.length, 2);
  now += 60_000;
  f.resetSpaceFeedState();
  const relay = mockFetch([["/launches/upcoming", { body: { ...body, keyConfigured: true, retrievedAt: "2025-01-02T00:00:00Z" } }]]);
  const rr = await f.refreshLaunches("relay", { network: true, fetcher: relay.fetcher, now: () => now });
  assert.equal(rr.keyConfigured, true);
  assert.equal(rr.via, "relay");
  // Direct throttle: two quick direct reads with an empty cache only make one request.
  f.resetSpaceFeedState();
  const quick = mockFetch([["ll.thespacedevs.com", { status: 429, body: {} }]]);
  const a = await f.refreshLaunches("direct", { network: true, fetcher: quick.fetcher, now: () => now });
  const b = await f.refreshLaunches("direct", { network: true, fetcher: quick.fetcher, now: () => now + 1000 });
  assert.match(a.error, /rate limit/);
  assert.match(b.error, /wait 10 minutes/);
  assert.equal(quick.calls.length, 1);
});

test("Launch Library caches valid empty results and honors an explicit stale relay fallback", async () => {
  f.resetSpaceFeedState();
  let now = NOW;
  const empty = mockFetch([["/launches/upcoming", { body: { results: [], stale: true, retrievedAt: "2025-01-01T23:00:00Z", keyConfigured: false } }]]);
  const first = await f.refreshLaunches("relay", { network: true, fetcher: empty.fetcher, now: () => now });
  assert.equal(first.launches.length, 0);
  assert.equal(first.freshness, "stale");
  assert.equal(first.retrievedAt, "2025-01-01T23:00:00.000Z");
  now += 60_000;
  const cached = await f.refreshLaunches("relay", { network: true, fetcher: empty.fetcher, now: () => now });
  assert.equal(cached.freshness, "stale");
  assert.match(cached.error, /stale fallback/);
  assert.equal(empty.calls.length, 1);
});

test("empty space results remain unknown, and invalid records are not a fresh empty result", async () => {
  f.resetSpaceFeedState();
  const empty = mockFetch([["/launches/upcoming", { body: { results: [], retrievedAt: "2025-01-02T00:00:00Z" } }]]);
  const first = await f.refreshLaunches("relay", { network: true, fetcher: empty.fetcher, now: () => NOW });
  assert.equal(first.freshness, "unknown");
  const cached = await f.refreshLaunches("relay", { network: true, fetcher: empty.fetcher, now: () => NOW + 60_000 });
  assert.equal(cached.freshness, "unknown"); assert.equal(cached.providerTimestamp, null); assert.equal(cached.ageSeconds, null);
  assert.throws(() => f.parseLaunches({ results: [{ id: "malformed", net: "not-time" }] }), /No usable launch events/);
  const radio = mockFetch([["/satnogs/", { body: { observations: [], retrievedAt: "2025-01-02T00:00:00Z" } }]]);
  const r = await f.refreshSatnogsObservations(25544, { network: true, fetcher: radio.fetcher, now: () => NOW });
  assert.equal(r.freshness, "unknown"); assert.equal(r.providerTimestamp, null);
});

test("no API key value or key header is constructed in client code", () => {
  const src = (n) => readFileSync(resolve(here, "../src", n), "utf8");
  for (const name of ["worldview-space-feeds.ts", "WorldViewSpace.tsx", "worldview-space-visibility.ts"]) {
    const text = src(name);
    assert.doesNotMatch(text, /Authorization/);
    assert.doesNotMatch(text, /import\.meta\.env/);
    assert.doesNotMatch(text, /process\.env/);
  }
});

test("panel renders without any network request and labels forecast vs observed", async () => {
  const require = createRequire(realpathSync(resolve(here, "../node_modules/vite/package.json")));
  const { buildSync } = require("esbuild");
  buildSync({ entryPoints: [resolve(here, "../src/WorldViewSpace.tsx")], outfile: join(out, "space-component.js"), bundle: true,
    format: "esm", platform: "node", jsx: "automatic", external: ["react", "react-dom"], loader: { ".css": "empty" } });
  const old = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error("unexpected network"); };
  try {
    const { default: Component } = await import(pathToFileURL(join(out, "space-component.js")).href);
    const html = renderToStaticMarkup(createElement(Component, { active: true, observer: { lat: 38.9, lon: -77 } }));
    assert.match(html, /FORECAST<\/b> = computed from orbital elements \(not seen\)/);
    assert.match(html, /OBSERVED<\/b> = SatNOGS ground-station radio receptions \(not\s+optical sightings\)/);
    assert.match(html, /SCHEDULED/);
    assert.match(html, /No space-data requests have been made/);
    assert.doesNotMatch(html, /<input type="checkbox" checked/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = old;
  }
});

test("inactive panel refuses provider work and reports that space reads are paused", async () => {
  const require = createRequire(realpathSync(resolve(here, "../node_modules/vite/package.json")));
  const { buildSync } = require("esbuild");
  buildSync({ entryPoints: [resolve(here, "../src/WorldViewSpace.tsx")], outfile: join(out, "space-component-inactive.js"), bundle: true,
    format: "esm", platform: "node", jsx: "automatic", external: ["react", "react-dom"], loader: { ".css": "empty" } });
  const { default: Component } = await import(pathToFileURL(join(out, "space-component-inactive.js")).href);
  const html = renderToStaticMarkup(createElement(Component, { active: false, observer: { lat: 38.9, lon: -77 } }));
  assert.match(html, /Paused\. No space-data requests are made while the globe is hidden/);
  assert.match(html, /<button disabled="">Forecast visible passes/);
});
