import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const here = dirname(fileURLToPath(import.meta.url));
const text = (name) => readFileSync(resolve(here, name), "utf8");
const out = mkdtempSync(join(tmpdir(), "worldview-mobility-"));
writeFileSync(join(out, "package.json"), '{"type":"module"}\n');
symlinkSync(resolve(here, "../node_modules"), join(out, "node_modules"), "dir");
const compiled = spawnSync(process.execPath, [
  resolve(here, "../node_modules/typescript/bin/tsc"), resolve(here, "../src/worldview-mobility.ts"),
  "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--skipLibCheck", "--lib", "ES2022,DOM", "--outDir", out,
], { encoding: "utf8" });
assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
const target = join(out, "worldview-mobility.js");
writeFileSync(target, readFileSync(target, "utf8").replace(/(['"])\.\/worldview-core\1/g, '"./worldview-core.js"'));
const M = await import(pathToFileURL(target).href);
test.after(() => rmSync(out, { recursive: true, force: true }));

const NOW = Date.parse("2026-10-31T20:40:00Z");
const json = (value, status = 200, headers = {}) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return { ok: status >= 200 && status < 300, status, headers: new Headers({ "content-length": String(bytes.byteLength), ...headers }),
    body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }) };
};
const opts = (fetcher, extra = {}) => ({ network: true, fetcher, now: () => NOW, ...extra });
const recorder = (reply) => {
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url, init }); return typeof reply === "function" ? reply(url) : reply; };
  return { calls, fetcher };
};
const envelope = (extra = {}) => ({
  providerId: "gtfs-rt:mbta", provider: "MBTA (Boston) vehicle positions", status: "ok", freshness: "fresh",
  retrievedAt: "2026-10-31T20:39:55Z", providerTimestamp: "2026-10-31T20:39:50Z", ageSeconds: 10,
  sourceUrl: "https://cdn.mbta.com/realtime/VehiclePositions.pb", attribution: "Massachusetts Bay Transportation Authority (MBTA)",
  license: "Per agency terms", licenseUrl: null, termsUrl: "https://www.mbta.com/developers", ttlSeconds: 15, truncated: false,
  items: [
    { id: "y1721", kind: "transit-vehicle", lat: 42.325, lon: -71.083, label: "Route 23", providerTimestamp: "2026-10-31T20:39:46Z",
      ageSeconds: 14, freshness: "fresh", live: true, properties: { routeId: "23", bearingDeg: 344, timestampBasis: "vehicle", nested: { no: 1 }, live: true } },
    { id: "y2", kind: "transit-vehicle", lat: 42.33, lon: -71.08, label: "Route 1", providerTimestamp: "2026-10-31T20:30:00Z", ageSeconds: 600, freshness: "stale", properties: {} },
    { id: "bad", kind: "weapon", lat: 1, lon: 1, label: "unknown kind" },
    { id: "far", kind: "transit-vehicle", lat: 95, lon: 0, label: "invalid point" },
  ],
  live: true, synthetic: false, ...extra,
});
const BOX = { west: -71.2, south: 42.25, east: -70.9, north: 42.45 };

test("nothing is requested without explicit opt-in", async () => {
  let calls = 0;
  const fetcher = async () => { calls++; throw Error("must not call"); };
  for (const r of [
    await M.refreshGbfs("citibike-nyc", BOX, { fetcher }),
    await M.refreshGtfsRt("mbta", BOX, { fetcher }),
    await M.searchStreetImagery("panoramax", { lat: 1, lon: 2 }, 150, { fetcher }),
    await M.geocodePlace("Boston", { fetcher }),
    await M.refreshRadio({ lat: 1, lon: 2 }, 25, { fetcher }),
    await M.searchNews("transit", null, { fetcher }),
    await M.refreshInfrastructure(BOX, { fetcher }),
  ]) { assert.equal(r.status, "failed"); assert.match(r.error, /opt-in/); assert.equal(r.observations.length, 0); }
  const status = await M.fetchMobilityStatus({ fetcher });
  assert.equal(status.enabled, false);
  assert.equal(calls, 0);
});

test("relay request: same-origin path, opt-in header, no redirects, no referrer, bounded params", async () => {
  const { calls, fetcher } = recorder(json(envelope()));
  const r = await M.refreshGtfsRt("mbta", BOX, opts(fetcher));
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.ok(url.startsWith("/api/v1/worldview-mobility/gtfs-rt?"));
  const params = new URLSearchParams(url.split("?")[1]);
  assert.deepEqual(Object.fromEntries(params), { feed: "mbta", west: "-71.2", south: "42.25", east: "-70.9", north: "42.45" });
  assert.equal(init.method, "GET");
  assert.equal(init.redirect, "error");
  assert.equal(init.credentials, "same-origin");
  assert.equal(init.referrerPolicy, "no-referrer");
  assert.equal(init.headers["X-SignalWarden-Mobility"], "enabled");
  assert.equal(r.status, "live");
  assert.equal(r.freshness, "fresh");
});

test("envelope normalization to WorldObservation with provenance and freshness", async () => {
  const { fetcher } = recorder(json(envelope()));
  const r = await M.refreshGtfsRt("mbta", BOX, opts(fetcher));
  assert.equal(r.items.length, 2, "unknown kinds and invalid points are dropped");
  assert.equal(r.observations.length, 2);
  const [a, b] = r.observations;
  assert.equal(a.layer, "transit");
  assert.equal(a.source, "Mobility · gtfs-rt · MBTA (Boston) vehicle positions");
  assert.equal(a.observedAt, "2026-10-31T20:39:46.000Z");
  assert.deepEqual(a.point, { lat: 42.325, lon: -71.083 });
  assert.equal(a.freshness, "fresh");
  assert.equal(a.properties.live, true);
  assert.equal(a.properties.routeId, "23");
  assert.equal(a.properties.nested, undefined, "only primitive properties survive");
  assert.equal(a.properties.attribution, "Massachusetts Bay Transportation Authority (MBTA)");
  assert.equal(a.properties.synthetic, false);
  assert.equal(b.freshness, "stale");
  assert.equal(b.stale, true);
  assert.equal(b.properties.live, false);
  assert.equal(r.termsUrl, "https://www.mbta.com/developers");
  assert.equal(r.licenseUrl, undefined);
  assert.match(M.freshnessLabel(r, NOW), /^LIVE · provider time 10s ago · retrieved 5s ago$/);
});

test("stale and throttled envelopes never claim live items", async () => {
  const { fetcher } = recorder(json(envelope({ status: "stale", error: "provider could not be reached; showing last successful snapshot" })));
  const r = await M.refreshGtfsRt("mbta", BOX, opts(fetcher));
  assert.equal(r.status, "stale");
  assert.ok(r.observations.every((o) => o.freshness === "stale"));
  assert.ok(r.observations.every((o) => o.properties.live === false));
  assert.match(r.error, /last successful snapshot/);
  const t = await M.refreshGtfsRt("mbta", BOX, opts(recorder(json(envelope({ status: "throttled", cached: true }))).fetcher));
  assert.equal(t.status, "throttled");
  assert.equal(t.cached, true);
  assert.ok(t.items.every((i) => i.freshness === "stale"));
  assert.ok(t.items.every((i) => i.properties.live === false));
  assert.ok(t.observations.every((o) => o.properties.live === false));
  assert.match(M.freshnessLabel(t, NOW), /^THROTTLED · cached/);
});

test("not_configured, disabled, failed and rate-limited states", async () => {
  const nc = await M.refreshGtfsRt("sf-bay-511-muni", BOX, opts(recorder(json({ ...envelope(), status: "not_configured", items: [],
    error: "API key not configured; set UCAS_GTFSRT_511_API_KEY on the server", live: false })).fetcher));
  assert.equal(nc.status, "not_configured");
  assert.match(nc.error, /UCAS_GTFSRT_511_API_KEY/);
  assert.equal(nc.observations.length, 0);
  const disabled = await M.refreshRadio({ lat: 1, lon: 2 }, 25, opts(recorder(json({ error: { code: "worldview_mobility_disabled", message: "disabled" } }, 404)).fetcher));
  assert.equal(disabled.status, "disabled");
  assert.match(disabled.error, /UCAS_WORLDVIEW_MOBILITY_ENABLED=1/);
  const unrouted = await M.refreshRadio({ lat: 1, lon: 2 }, 25, opts(recorder({ ok: false, status: 404, headers: new Headers(), body: null }).fetcher));
  assert.equal(unrouted.status, "disabled");
  const limited = await M.refreshRadio({ lat: 1, lon: 2 }, 25, opts(recorder(json({ error: { code: "upstream_rate_limited", message: "provider rate limit reached" } }, 429)).fetcher));
  assert.equal(limited.status, "throttled");
  const bad = await M.refreshRadio({ lat: 1, lon: 2 }, 25, opts(recorder(json({ error: { code: "invalid_query", message: "lat must be between -90 and 90" } }, 400)).fetcher));
  assert.equal(bad.status, "failed");
  assert.match(bad.error, /lat must be/);
  const failed = await M.refreshRadio({ lat: 1, lon: 2 }, 25, opts(recorder(json({ ...envelope(), providerId: "radio-browser", status: "failed", items: [], errorCode: "upstream_unreachable", error: "provider could not be reached" })).fetcher));
  assert.equal(failed.status, "failed");
  assert.equal(failed.freshness, "failed");
  const thrown = await M.refreshRadio({ lat: 1, lon: 2 }, 25, opts(async () => { throw new TypeError("Failed to fetch"); }));
  assert.equal(thrown.status, "failed");
  const garbage = await M.refreshRadio({ lat: 1, lon: 2 }, 25, opts(recorder(json({ hello: "world" })).fetcher));
  assert.equal(garbage.status, "failed");
  assert.match(garbage.error, /invalid envelope/);
});

test("oversized relay responses are rejected", async () => {
  const r = await M.refreshRadio({ lat: 1, lon: 2 }, 25, opts(recorder(json(envelope(), 200, { "content-length": "999999999" })).fetcher));
  assert.equal(r.status, "failed");
  assert.match(r.error, /exceeds 2 MB/);
});

test("client-side limits mirror the relay and send nothing when violated", async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return json(envelope()); };
  assert.match((await M.refreshGbfs("x", { west: -74, south: 40, east: -72.5, north: 40.5 }, opts(fetcher))).error, /at most 1°/);
  assert.match((await M.refreshGtfsRt("x", { west: -74, south: 40, east: -71, north: 40.5 }, opts(fetcher))).error, /at most 2°/);
  assert.match((await M.refreshInfrastructure({ west: -73, south: 40, east: -74, north: 40.5 }, opts(fetcher))).error, /invalid/);
  assert.equal((await M.searchStreetImagery("panoramax", { lat: 1, lon: 2 }, 900, opts(fetcher))).status, "failed");
  assert.equal((await M.searchStreetImagery("google", { lat: 1, lon: 2 }, 100, opts(fetcher))).status, "failed");
  assert.equal((await M.refreshRadio({ lat: 1, lon: 2 }, 500, opts(fetcher))).status, "failed");
  assert.equal((await M.geocodePlace("x", opts(fetcher))).status, "failed");
  assert.equal((await M.searchNews("<script>", null, opts(fetcher))).status, "failed");
  assert.equal(calls, 0);
  assert.deepEqual(M.bboxAround({ lat: 89.9, lon: 179.95 }, 0.5), { west: 179.45, east: 180, south: 89.4, north: 90 });
  assert.throws(() => M.relayUrl("../../local-ai/jobs"), /not allowlisted/);
});

test("street imagery: links validated, capture time is historical, thumbnails never fetched by the client", async () => {
  const body = { ...envelope(), providerId: "panoramax", provider: "Panoramax federated API", providerTimestamp: null, items: [
    { id: "9cc38bf6-6a40-4adf-b2be-4447eb361202", kind: "street-image", lat: 48.8565, lon: 2.3518, label: "Panoramax street-level image",
      providerTimestamp: "2023-05-20T17:55:39+00:00", freshness: "fresh",
      properties: { thumbnailUrl: "https://panoramax.example.org/thumb.jpg", pageUrl: "javascript:alert(1)", author: "mapcomplete", license: "CC-BY-SA-4.0",
        licenseUrl: "https://user:pw@spdx.org/x", homepage: "http://ok.example/" } },
  ] };
  const { calls, fetcher } = recorder(json(body));
  const r = await M.searchStreetImagery("panoramax", { lat: 48.8566, lon: 2.3522 }, 150, opts(fetcher));
  assert.equal(calls.length, 1);
  const params = new URLSearchParams(calls[0].url.split("?")[1]);
  assert.deepEqual(Object.fromEntries(params), { provider: "panoramax", lat: "48.8566", lon: "2.3522", radius: "150" });
  const o = r.observations[0];
  assert.equal(o.layer, "street-imagery");
  assert.equal(o.observedAt, "2023-05-20T17:55:39.000Z");
  assert.equal(o.properties.thumbnailUrl, "https://panoramax.example.org/thumb.jpg");
  assert.equal(o.properties.pageUrl, null);
  assert.equal(o.properties.licenseUrl, null);
  assert.equal(o.properties.homepage, "http://ok.example/");
  assert.match(M.freshnessLabel(r, NOW), /capture times are historical/);
  assert.doesNotMatch(M.freshnessLabel(r, NOW), /provider time/);
});

test("news without a place stays list-only; geocoder and infrastructure normalize", async () => {
  const news = { ...envelope(), providerId: "gdelt-doc", provider: "GDELT DOC 2.0 API", items: [
    { id: "a1", kind: "news-link", label: "Subway delays continue", providerTimestamp: "2026-10-31T18:30:00Z", freshness: "fresh",
      properties: { articleUrl: "https://news.example.com/a", domain: "news.example.com" } }] };
  const r = await M.searchNews("subway delays", null, opts(recorder(json(news)).fetcher));
  assert.equal(r.items.length, 1);
  assert.equal(r.observations.length, 0);
  const places = { ...envelope(), providerId: "osm-nominatim", provider: "OpenStreetMap Nominatim", providerTimestamp: null, license: "ODbL 1.0",
    items: [{ id: "361897680", kind: "place", lat: 42.355, lon: -71.066, label: "Boston Common", providerTimestamp: null, freshness: "fresh",
      properties: { osmUrl: "https://www.openstreetmap.org/relation/17995454" } }] };
  const g = await M.geocodePlace("Boston Common", opts(recorder(json(places)).fetcher));
  assert.equal(g.observations[0].layer, "places");
  assert.equal(g.observations[0].observedAt, "2026-10-31T20:39:55.000Z");
  assert.equal(g.observations[0].properties.timeBasis, "retrieval");
  const infra = { ...envelope(), providerId: "osm-overpass", provider: "OpenStreetMap via Overpass API", items: [
    { id: "node-1", kind: "datacenter", lat: 40.71, lon: -74, label: "DC One", providerTimestamp: "2026-10-31T20:00:00Z", freshness: "fresh", properties: {} },
    { id: "way-2", kind: "dam", lat: 40.72, lon: -74.01, label: "Dam (unnamed in OSM)", providerTimestamp: "2026-10-31T20:00:00Z", freshness: "fresh", properties: {} }] };
  const i = await M.refreshInfrastructure({ west: -74.05, south: 40.68, east: -73.95, north: 40.78 }, opts(recorder(json(infra)).fetcher));
  assert.deepEqual(i.observations.map((o) => o.layer), ["infrastructure", "infrastructure"]);
});

test("GBFS stations and vehicles normalize to the bikeshare layer", async () => {
  const body = { ...envelope(), providerId: "gbfs:citibike-nyc", provider: "Citi Bike (New York City)", items: [
    { id: "s1", kind: "station", lat: 40.71, lon: -74, label: "Main & 1st", providerTimestamp: "2026-10-31T20:39:00Z", freshness: "fresh",
      properties: { bikesAvailable: 7, docksAvailable: 13, isRenting: true } },
    { id: "v1", kind: "vehicle", lat: 40.715, lon: -74.005, label: "Available shared vehicle", freshness: "fresh", properties: { vehicleType: "ebike" } }] };
  const r = await M.refreshGbfs("citibike-nyc", { west: -74.05, south: 40.68, east: -73.95, north: 40.78 }, opts(recorder(json(body)).fetcher));
  assert.deepEqual(r.observations.map((o) => [o.layer, o.properties.kind]), [["bikeshare", "station"], ["bikeshare", "vehicle"]]);
  assert.equal(r.observations[0].properties.bikesAvailable, 7);
  assert.equal(r.observations[1].properties.timeBasis, "retrieval");
});

test("merge replaces on success, marks stale on failure, and clear removes only panel records", async () => {
  const base = [{ id: "keep", layer: "aircraft", point: { lat: 0.1, lon: 0.1 }, observedAt: "2026-10-31T20:00:00Z", source: "adsb.lol", label: "x" }];
  const ok = await M.refreshGtfsRt("mbta", BOX, opts(recorder(json(envelope())).fetcher));
  let records = M.mergeMobilityObservations(base, ok);
  assert.equal(records.length, 3);
  records = M.mergeMobilityObservations(records, ok);
  assert.equal(records.length, 3, "no duplicates on repeat refresh");
  const failed = { ...ok, status: "failed", observations: [], items: [], error: "boom" };
  records = M.mergeMobilityObservations(records, failed);
  assert.equal(records.length, 3);
  assert.ok(records.filter((o) => o.source.startsWith("Mobility")).every((o) => o.freshness === "stale" && o.stale));
  assert.ok(records.filter((o) => o.source.startsWith("Mobility")).every((o) => o.properties.live === false));
  assert.deepEqual(M.clearMobilityObservations(records).map((o) => o.id), ["keep"]);
});

test("status endpoint: feeds listed, no secrets expected or rendered", async () => {
  const { calls, fetcher } = recorder(json({
    enabled: true, readOnly: true,
    gbfs: { feeds: [{ id: "citibike-nyc", name: "Citi Bike (New York City)", status: "configured", termsUrl: "https://citibikenyc.com/data-sharing-policy" }], error: null },
    gtfsRealtime: { feeds: [{ id: "sf-bay-511-muni", name: "511", status: "not_configured", keyEnv: "UCAS_GTFSRT_511_API_KEY" }, { id: "Bad ID", name: "x", status: "configured" }], error: null },
    streetImagery: { mapillary: { status: "not_configured" }, panoramax: { status: "configured" }, kartaview: { status: "configured" } },
    geocoder: { status: "configured" }, contactConfigured: true,
  }));
  const s = await M.fetchMobilityStatus(opts(fetcher));
  assert.equal(calls[0].url, "/api/v1/worldview-mobility/status");
  assert.equal(s.enabled, true);
  assert.deepEqual(s.gbfs.map((f) => f.id), ["citibike-nyc"]);
  assert.deepEqual(s.gtfsRealtime.map((f) => [f.id, f.status]), [["sf-bay-511-muni", "not_configured"]]);
  assert.equal(s.streetImagery.mapillary, "not_configured");
});

test("panel: React render and module import make no requests; opt-in is off; WorldView lazy-loads behind a button", async () => {
  const require = createRequire(realpathSync(resolve(here, "../node_modules/vite/package.json")));
  const { buildSync } = require("esbuild");
  buildSync({ entryPoints: [resolve(here, "../src/WorldViewMobility.tsx")], outfile: join(out, "mobility-component.js"), bundle: true, format: "esm",
    platform: "node", jsx: "automatic", external: ["react", "react-dom"], loader: { ".css": "empty" } });
  const old = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error("unexpected network"); };
  try {
    const { default: Component } = await import(pathToFileURL(join(out, "mobility-component.js")).href);
    const html = renderToStaticMarkup(createElement(Component, { center: { lat: 40.71, lon: -74 } }));
    assert.match(html, /TRANSIT · STREET IMAGERY · CONTEXT/);
    assert.match(html, /aria-label="Allow transit and context relay requests"/);
    assert.doesNotMatch(html, /checked=""/);
    assert.match(html, /<button disabled="">Check local relay<\/button>/);
    assert.match(html, /<button disabled="">Find images near view center<\/button>/);
    assert.doesNotMatch(html, /<img/);
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    globalThis.fetch = old;
  }
  assert.equal(calls, 0);
  const wv = text("../src/WorldView.tsx");
  assert.match(wv, /const WorldViewMobility = lazy\(\(\) => import\("\.\/WorldViewMobility"\)\)/);
  assert.doesNotMatch(wv, /import \{?[^;]*\}? from "\.\/WorldViewMobility"/);
  assert.match(wv, /mobilityOpen && <Suspense/);
  assert.match(wv, /Open transit, street imagery and context/);
  const src = text("../src/worldview-mobility.ts") + text("../src/WorldViewMobility.tsx");
  assert.match(src, /active\?: boolean/);
  assert.match(src, /const generation = useRef\(0\)/);
  assert.match(src, /if \(!next\) clearAll\(\)/, "opt-out clears results, thumbnails and emitted records");
  assert.match(src, /requestGeneration !== generation\.current/, "late mobility results cannot commit");
  assert.doesNotMatch(src, /api[_-]?key\s*[:=]\s*["'][^"']+["']/i, "no keys in the client");
  assert.doesNotMatch(src, /https:\/\/(graph\.mapillary|api\.511|nominatim|api\.gdeltproject|overpass)/, "the client never calls providers directly");
});
