import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as THREE from "three";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const out = mkdtempSync(join(tmpdir(), "worldview-windair-"));
writeFileSync(join(out, "package.json"), '{"type":"module"}\n');
symlinkSync(resolve(root, "node_modules"), join(out, "node_modules"), "dir");
const compiled = spawnSync(process.execPath, [
  resolve(root, "node_modules/typescript/bin/tsc"),
  resolve(root, "src/worldview-windfield.ts"), resolve(root, "src/worldview-airgrid.ts"),
  resolve(root, "src/worldview-windair-globe.tsx"), resolve(root, "src/WorldViewWindAir.tsx"),
  "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--skipLibCheck", "--jsx", "react-jsx",
  "--lib", "ES2022,DOM,DOM.Iterable", "--outDir", out,
], { encoding: "utf8" });
assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
for (const f of readdirSync(out).filter((n) => n.endsWith(".js"))) {
  const p = join(out, f);
  writeFileSync(p, readFileSync(p, "utf8")
    .replace(/^import\s+["']\.\/[^"']+\.css["'];?$/gm, "")
    .replace(/from\s+(['"])\.\/([^'"]+?)\1/g, (_m, _q, name) => `from "./${name}.js"`));
}
const WF = await import(pathToFileURL(join(out, "worldview-windfield.js")).href);
const AG = await import(pathToFileURL(join(out, "worldview-airgrid.js")).href);
const GL = await import(pathToFileURL(join(out, "worldview-windair-globe.js")).href);
const UI = await import(pathToFileURL(join(out, "WorldViewWindAir.js")).href);
const BM = await import(pathToFileURL(join(out, "worldview-basemap.js")).href);
test.after(() => rmSync(out, { recursive: true, force: true }));
test.beforeEach(() => WF.resetGridState());

const NOW = Date.parse("2026-10-31T21:20:00Z");
const json = (value, status = 200) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return { ok: status >= 200 && status < 300, status, headers: new Headers({ "content-length": String(bytes.byteLength) }),
    body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }) };
};
const recorder = (responder) => { const calls = []; const f = async (url, init) => { calls.push({ url, init }); return responder(url, init); }; f.calls = calls; return f; };
const SPAN = { west: -80, south: 30, east: -70, north: 40 };
const SHAPE = { rows: 2, cols: 3 };
// Hand-written Open-Meteo multi-location shape (verified live 2026-10-31): array of per-location objects, location_id from the 2nd on.
const windLoc = (i) => ({
  latitude: 32.5, longitude: -78, elevation: 15, ...(i ? { location_id: i } : {}),
  hourly_units: { time: "iso8601", wind_speed_10m: "m/s", wind_direction_10m: "°", pressure_msl: "hPa" },
  hourly: {
    time: ["2026-10-31T21:00", "2026-10-31T22:00"],
    wind_speed_10m: [5 + i, 6], wind_direction_10m: [270, 280], wind_gusts_10m: [9, 10],
    wind_speed_80m: i === 5 ? [null, null] : [7, 8], wind_direction_80m: [270, 270],
    wind_speed_120m: [8, 8], wind_direction_120m: [265, 265],
    wind_speed_850hPa: [12, 12], wind_direction_850hPa: [300, 300], wind_speed_500hPa: [20, 21], wind_direction_500hPa: [290, 290],
    wind_speed_250hPa: [40, 42], wind_direction_250hPa: [285, 285], pressure_msl: [1012 + i, 1013],
  },
});
const WIND = Array.from({ length: 6 }, (_, i) => windLoc(i));
const airLoc = (i) => ({ latitude: 32.5, longitude: -78, ...(i ? { location_id: i } : {}), hourly_units: { us_aqi: "USAQI", pm2_5: "μg/m³" },
  hourly: { time: ["2026-10-31T21:00", "2026-10-31T22:00"], pm2_5: [4.9, 7.6], pm10: [5.1, 7.8], ozone: [66, 50], nitrogen_dioxide: [9, 21.5], us_aqi: [25 + i * 30, 27], dust: [0, 0], aerosol_optical_depth: [0.1, 0.12] } });
const AIR = Array.from({ length: 6 }, (_, i) => airLoc(i));
const META = { last_run_initialisation_time: Date.parse("2026-10-31T12:00:00Z") / 1000 };

test("viewport span merges antimeridian rectangles and grid points match the relay algorithm", () => {
  assert.deepEqual(WF.viewportSpan([{ west: -80, south: 30, east: -70, north: 40 }]), SPAN);
  assert.deepEqual(WF.viewportSpan([{ west: -180, south: -10, east: -170, north: 10 }, { west: 170, south: -12, east: 180, north: 9 }]), { west: 170, south: -12, east: 190, north: 10 });
  assert.equal(WF.viewportSpan([]), null);
  const pts = WF.gridPoints({ west: 170, south: -10, east: 190, north: 10 }, { rows: 2, cols: 4 });
  assert.deepEqual(pts[0], [-5, 172.5]);
  assert.deepEqual(pts[3], [-5, -172.5]);
  for (const cap of [36, 64, 100, 500]) {
    const s = WF.chooseGridShape({ west: -180, south: -80, east: 180, north: 80 }, cap);
    assert.ok(s.rows * s.cols <= Math.min(cap, 100) && s.rows >= 2 && s.cols >= 2 && s.rows <= 10 && s.cols <= 10, JSON.stringify(s));
  }
  const tall = WF.chooseGridShape({ west: 0, south: -60, east: 10, north: 60 }, 64);
  assert.ok(tall.rows > tall.cols);
});

test("nothing is requested without opt-in, and bad shapes are refused before any request", async () => {
  const f = recorder(() => json(WIND));
  assert.equal((await WF.refreshWindField(SPAN, SHAPE, "gfs_seamless", { fetcher: f })).status, "failed");
  assert.equal((await AG.refreshAirGrid(SPAN, SHAPE, { fetcher: f })).status, "failed");
  assert.equal((await AG.refreshOpenAqStations({ west: -77.2, south: 38.8, east: -76.9, north: 39 }, { fetcher: f })).status, "failed");
  assert.match((await WF.refreshWindField(SPAN, { rows: 11, cols: 10 }, "gfs_seamless", { network: true, fetcher: f })).error, /≤100/);
  assert.match((await WF.refreshWindField(SPAN, SHAPE, "evil", { network: true, fetcher: f })).error, /Unknown model/);
  assert.equal(f.calls.length, 0);
});

test("direct wind grid: one bounded multi-location request, provenance, cache, throttle", async () => {
  const f = recorder((url) => json(url.includes("meta.json") ? META : WIND));
  const r = await WF.refreshWindField(SPAN, SHAPE, "ecmwf_ifs025", { network: true, fetcher: f, now: () => NOW });
  assert.equal(r.status, "live");
  assert.equal(f.calls.length, 2);
  const u = new URL(f.calls[0].url);
  assert.equal(u.origin, "https://api.open-meteo.com");
  assert.equal(u.searchParams.get("latitude").split(",").length, 6);
  assert.equal(u.searchParams.get("forecast_hours"), "24");
  assert.equal(u.searchParams.get("models"), "ecmwf_ifs025");
  assert.equal(u.searchParams.get("wind_speed_unit"), "ms");
  assert.match(u.searchParams.get("hourly"), /wind_speed_250hPa/);
  assert.equal(f.calls[0].init.credentials, "omit");
  assert.equal(f.calls[0].init.redirect, "error");
  assert.ok(f.calls[1].url.endsWith("/data/ecmwf_ifs025/static/meta.json"));
  const p = r.provenance;
  assert.equal(p.modelRun, "2026-10-31T12:00:00.000Z");
  assert.equal(p.freshness, "fresh");
  assert.equal(p.validFrom, "2026-10-31T21:00:00.000Z");
  assert.equal(p.route, "direct");
  assert.equal(p.pointCount, 6);
  assert.match(p.attribution, /Open-Meteo/);
  assert.match(p.attribution, /ECMWF/);
  assert.equal(p.termsUrl, "https://open-meteo.com/en/terms");
  assert.equal(p.sourceUrl, f.calls[0].url);
  assert.equal(r.field.values.wind_speed_10m[0][5], 10);
  assert.equal(r.field.values.wind_speed_80m[0][5], null);
  assert.equal(r.field.units.pressure_msl, "hPa");
  const again = await WF.refreshWindField(SPAN, SHAPE, "ecmwf_ifs025", { network: true, fetcher: f, now: () => NOW + 1000 });
  assert.equal(again.provenance.cache, "hit");
  assert.equal(f.calls.length, 2);
  const moved = await WF.refreshWindField({ ...SPAN, west: -81 }, SHAPE, "ecmwf_ifs025", { network: true, fetcher: f, now: () => NOW + 5000 });
  assert.equal(moved.status, "throttled");
  assert.equal(f.calls.length, 2);
});

test("stale when the model run is old; unknown when run time is unavailable; mismatched location count fails", async () => {
  const old = recorder((url) => json(url.includes("meta.json") ? { last_run_initialisation_time: META.last_run_initialisation_time - 86400 } : WIND));
  const r = await WF.refreshWindField(SPAN, SHAPE, "gfs_seamless", { network: true, fetcher: old, now: () => NOW });
  assert.equal(r.status, "stale");
  assert.equal(r.provenance.freshness, "stale");
  WF.resetGridState();
  const nometa = recorder((url) => (url.includes("meta.json") ? json({}, 500) : json(WIND)));
  const u = await WF.refreshWindField(SPAN, SHAPE, "gfs_seamless", { network: true, fetcher: nometa, now: () => NOW });
  assert.equal(u.provenance.freshness, "unknown");
  assert.equal(u.status, "unknown");
  assert.match(u.error, /not labeled live/);
  WF.resetGridState();
  const short = recorder(() => json(WIND.slice(0, 4)));
  const bad = await WF.refreshWindField(SPAN, SHAPE, "gfs_seamless", { network: true, fetcher: short, now: () => NOW });
  assert.equal(bad.status, "failed");
  assert.match(bad.error, /expected 6/);
});

test("grid parser rejects duplicate or out-of-range locations and inconsistent time arrays", () => {
  const duplicate = WIND.map((row, i) => i === 2 ? { ...row, location_id: 1 } : row);
  assert.throws(() => WF.parseGridLocations(duplicate, WF.WIND_GRID_VARIABLES, SPAN, SHAPE), /duplicate location_id/);
  const outOfRange = WIND.map((row, i) => i === 2 ? { ...row, location_id: 99 } : row);
  assert.throws(() => WF.parseGridLocations(outOfRange, WF.WIND_GRID_VARIABLES, SPAN, SHAPE), /out-of-range location_id/);
  const inconsistent = WIND.map((row, i) => i === 2 ? { ...row, hourly: { ...row.hourly, time: ["2026-10-31T21:00", "2026-10-31T23:00"] } } : row);
  assert.throws(() => WF.parseGridLocations(inconsistent, WF.WIND_GRID_VARIABLES, SPAN, SHAPE), /inconsistent hourly times/);
  const unordered = WIND.map((row, i) => i === 0 ? { ...row, hourly: { ...row.hourly, time: ["2026-10-31T22:00", "2026-10-31T21:00"] } } : row);
  assert.throws(() => WF.parseGridLocations(unordered, WF.WIND_GRID_VARIABLES, SPAN, SHAPE), /strictly increasing/);
});

test("future-only and unusable grid data are not live", async () => {
  const future = WIND.map((row) => ({ ...row, hourly: { ...row.hourly, time: ["2026-10-31T22:00", "2026-10-31T23:00"] } }));
  const futureFetcher = recorder(() => json(future));
  const futureResult = await WF.refreshWindField(SPAN, SHAPE, "gfs_seamless", { network: true, fetcher: futureFetcher, now: () => NOW });
  assert.equal(futureResult.status, "stale");
  assert.match(futureResult.error, /current hour/);

  WF.resetGridState();
  const unusable = WIND.map((row) => ({ ...row, hourly: { ...row.hourly, ...Object.fromEntries(WF.WIND_GRID_VARIABLES.map((v) => [v, []])) } }));
  const unusableFetcher = recorder(() => json(unusable));
  const unusableResult = await WF.refreshWindField(SPAN, SHAPE, "gfs_seamless", { network: true, fetcher: unusableFetcher, now: () => NOW });
  assert.equal(unusableResult.status, "failed");
  assert.match(unusableResult.error, /insufficient usable fields/);
});

test("cached grid status is recomputed when its model run crosses the stale threshold", async () => {
  const runAt = NOW - 18 * 3600_000 + 60_000;
  const meta = { last_run_initialisation_time: runAt / 1000 };
  const f = recorder((url) => json(url.includes("meta.json") ? meta : WIND));
  const fresh = await WF.refreshWindField(SPAN, SHAPE, "gfs_seamless", { network: true, fetcher: f, now: () => NOW });
  assert.equal(fresh.status, "live");
  const stale = await WF.refreshWindField(SPAN, SHAPE, "gfs_seamless", { network: true, fetcher: f, now: () => NOW + 120_000 });
  assert.equal(stale.provenance.cache, "hit");
  assert.equal(stale.provenance.freshness, "stale");
  assert.equal(stale.status, "stale");
  assert.equal(f.calls.length, 2);
});

test("relay route (commercial key server-side) sends bbox + grid only and maps relay states", async () => {
  const f = recorder(() => json({ sourceUrl: "https://customer-api.open-meteo.com/v1/forecast?latitude=…", tier: "commercial", modelRun: "2026-10-31T12:00:00Z", locations: WIND }));
  const r = await WF.refreshWindField({ west: 170, south: -10, east: 190, north: 10 }, SHAPE, "gfs_seamless", { network: true, relay: true, fetcher: f, now: () => NOW });
  assert.equal(r.status, "live");
  assert.equal(r.provenance.tier, "commercial");
  assert.equal(r.provenance.route, "relay");
  const url = f.calls[0].url;
  assert.ok(url.startsWith("/api/v1/worldview-weather/open-meteo/wind-grid?"));
  assert.equal(new URLSearchParams(url.split("?")[1]).get("bbox"), "170,-10,190,10");
  assert.equal(new URLSearchParams(url.split("?")[1]).get("grid"), "2x3");
  assert.equal(f.calls[0].init.headers["X-SignalWarden-Weather"], "enabled");
  assert.ok(!/apikey|key=/i.test(url));
  WF.resetGridState();
  const off = recorder(() => json({ error: { code: "weather_relay_disabled", message: "off" } }, 404));
  assert.equal((await AG.refreshAirGrid(SPAN, SHAPE, { network: true, relay: true, fetcher: off })).status, "disabled");
  const busy = recorder(() => json({ error: { code: "relay_throttled", message: "retry in 20s" } }, 429));
  assert.equal((await AG.refreshAirGrid({ ...SPAN, east: -69 }, SHAPE, { network: true, relay: true, fetcher: busy })).status, "throttled");
});

test("wind maths: u/v conversion, bilinear sampler and arrows", () => {
  const w = WF.windToUV(10, 270); // from the west → blows east
  assert.ok(Math.abs(w.u - 10) < 1e-9 && Math.abs(w.v) < 1e-9);
  const n = WF.windToUV(5, 0); // from the north → blows south
  assert.ok(Math.abs(n.v + 5) < 1e-9);
  const back = WF.uvToWind(w.u, w.v);
  assert.ok(Math.abs(back.speed - 10) < 1e-9 && Math.abs(back.directionFrom - 270) < 1e-9);
  const field = WF.parseGridLocations(WIND, WF.WIND_GRID_VARIABLES, SPAN, SHAPE);
  const sample = WF.windSampler(field, "10m", 0);
  const atCell = sample(32.5, -78.33);
  assert.ok(atCell && Math.abs(atCell.speed - 5) < 0.2 && atCell.u > 0);
  assert.equal(sample(50, -75), null);
  const mid = WF.sampleField(field, field.values.pressure_msl[0], 35, -75);
  assert.ok(mid > 1012 && mid < 1017);
  const sparse = WF.sampleField(field, field.values.wind_speed_80m[0], 37.5, -71.67);
  assert.equal(sparse, 7); // null corner dropped, neighbours renormalised
  const arrows = WF.windArrows(field, "80m", 0);
  assert.equal(arrows.length, 5);
  assert.deepEqual(WF.speedColor(0), [98, 113, 183]);
  assert.deepEqual(WF.speedColor(1000), [240, 230, 255]);
  assert.equal(WF.fieldStats(field, "pressure_msl", 0).min, 1012);
  assert.equal(WF.currentHourIndex(field.times, NOW), 0);
});

test("particles advect downwind, respawn inside the span, and are capped", () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const ps = WF.createParticles(5000, SPAN, rand);
  assert.equal(ps.length, 2000);
  const few = WF.createParticles(20, SPAN, rand, 1000);
  const east = () => ({ u: 10, v: 0, speed: 10 });
  const before = few.map((p) => p.lon);
  WF.stepParticles(few, east, SPAN, 0.05, rand, 1000);
  few.forEach((p, i) => assert.ok(p.lon > before[i]));
  WF.stepParticles(few, () => null, SPAN, 0.05, rand, 1000);
  few.forEach((p) => assert.ok(WF.insideSpan(SPAN, p.lat, p.lon) && p.age === 0));
});

test("modelled air grid parses CAMS shape and colours by EPA categories", async () => {
  const f = recorder(() => json(AIR));
  const r = await AG.refreshAirGrid(SPAN, SHAPE, { network: true, fetcher: f, now: () => NOW });
  assert.equal(r.status, "live");
  assert.equal(new URL(f.calls[0].url).origin, "https://air-quality-api.open-meteo.com");
  assert.match(new URL(f.calls[0].url).searchParams.get("hourly"), /aerosol_optical_depth/);
  assert.match(r.provenance.dataKind, /modelled/);
  assert.match(r.provenance.attribution, /CAMS/);
  assert.equal(r.field.values.us_aqi[0][3], 115);
  assert.deepEqual(AG.scaleColor(AG.AIR_VARIABLES.us_aqi.stops, 40), [0, 228, 0]);
  assert.deepEqual(AG.scaleColor(AG.AIR_VARIABLES.us_aqi.stops, 150), [255, 126, 0]);
  assert.equal(AG.hourIndexFor(r.field, "2026-10-31T22:00:00.000Z"), 1);
  assert.equal(AG.hourIndexFor(r.field, "1999-01-01T00:00:00.000Z"), 0);
});

test("OpenAQ stations: ≤4° box, not_configured surfaced, measured markers carry provenance", async () => {
  const box = AG.openAqBox({ west: -100, south: 20, east: -60, north: 50 });
  assert.ok(box.east - box.west <= 4 && box.north - box.south <= 4);
  assert.equal(AG.openAqBox({ west: 178, south: -1, east: 182, north: 1 }), null);
  const nc = recorder(() => json({ error: { code: "not_configured", message: "OpenAQ is not configured; set UCAS_OPENAQ_API_KEY" } }, 503));
  const r0 = await AG.refreshOpenAqStations(box, { network: true, fetcher: nc });
  assert.equal(r0.status, "not_configured");
  assert.equal(r0.observations.length, 0);
  assert.ok(nc.calls[0].url.startsWith("/api/v1/worldview-weather/openaq/bbox?bbox="));
  const ok = recorder(() => json({ sourceUrl: "https://api.openaq.org/v3/locations?bbox=…", retrievedAt: "2026-10-31T21:19:00Z", truncated: false, stations: [
    { locationId: 3, label: "River Terrace", isMonitor: true, dataProvider: "AirNow", lat: 35.1, lon: -80.1, sourceUrl: "https://explore.openaq.org/locations/3",
      licenses: [{ id: 1, name: "CC BY 4.0", sourceUrl: "https://creativecommons.org/licenses/by/4.0/", attribution: "EPA", commercialUseAllowed: true,
        attributionRequired: true, shareAlikeRequired: false, modificationAllowed: true, redistributionAllowed: true, dateFrom: "2016-01-01", dateTo: "" }],
      measurements: [{ parameter: "pm25", units: "µg/m³", value: 8.1, datetimeUtc: "2026-10-31T20:00:00Z", licenseId: 1 }] },
    { locationId: 7, label: "Low-cost / community sensor", isMonitor: false, lat: 38.9, lon: -77, measurements: [{ parameter: "pm25", value: 3, datetimeUtc: "2026-10-30T01:00:00Z" }] },
    { locationId: 8, lat: 999, lon: 0, measurements: [] },
  ] }));
  const r = await AG.refreshOpenAqStations(box, { network: true, fetcher: ok, now: () => NOW });
  assert.equal(r.observations.length, 1);
  assert.equal(r.status, "live");
  const [a] = r.observations;
  assert.equal(a.source, AG.OPENAQ_MAP_SOURCE);
  assert.equal(a.freshness, "fresh");
  for (const k of ["provider", "sourceUrl", "retrievedAt", "providerTimestamp", "ageSeconds", "attribution", "termsUrl", "dataKind"]) assert.ok(a.properties[k] !== undefined, k);
  assert.match(a.properties.attribution, /CC BY 4.0/);
  assert.match(a.properties.licenseUrls, /creativecommons.org/);
  const malformed = recorder(() => json({ sourceUrl: "https://api.openaq.org/v3/locations", stations: [] }));
  const bad = await AG.refreshOpenAqStations(box, { network: true, fetcher: malformed, now: () => NOW });
  assert.equal(bad.status, "failed");
  assert.equal(bad.observations.length, 0);
});

test("GIBS satellite air layers: WMTS URLs, dates, and the shared tile allowlist", async () => {
  const now = NOW;
  const layer = AG.AIR_SAT_LAYERS["tropomi-no2"];
  assert.equal(AG.airSatTileUrl(layer, "2026-10-29", { z: 2, x: 1, y: 1 }, now),
    "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/TROPOMI_L2_Nitrogen_Dioxide_Tropospheric_Column/default/2026-10-29/GoogleMapsCompatible_Level6/2/1/1.png");
  assert.throws(() => AG.airSatTileUrl(layer, "2026-11-05", { z: 2, x: 1, y: 1 }, now), /future/);
  assert.throws(() => AG.airSatTileUrl(layer, "2017-01-01", { z: 2, x: 1, y: 1 }, now), /on or after/);
  assert.throws(() => AG.airSatTileUrl(layer, "2026-10-29", { z: 7, x: 1, y: 1 }, now), /out of range/);
  assert.equal(AG.defaultAirSatDate(AG.AIR_SAT_LAYERS["omi-no2"], now), "2026-10-25");
  const png = new Uint8Array([137, 80, 78, 71]);
  const f = recorder(() => ({ ok: true, status: 200, headers: new Headers({ "content-type": "image/png", "content-length": "4", "layer-time-actual": "2026-10-29T00:00:00Z" }),
    body: new ReadableStream({ start(c) { c.enqueue(png); c.close(); } }) }));
  const loader = new BM.TileLoader({ network: true, fetcher: f, decode: async (blob) => blob.size, now: () => now });
  const res = await loader.load(AG.airSatSource("modis-aod", "2026-10-29", now), [{ z: 2, x: 1, y: 1 }]);
  assert.equal(res.loaded.length, 1);
  assert.equal(res.loaded[0].freshness, "recent");
  assert.match(res.loaded[0].attribution, /GIBS/);
  assert.equal(f.calls[0].init.credentials, "omit");
  const none = new BM.TileLoader({ network: false, fetcher: f, decode: async () => 1 });
  assert.equal((await none.load(AG.airSatSource("airs-dust", "2026-10-29", now), [{ z: 2, x: 0, y: 0 }])).failed.length, 1);
  assert.equal(f.calls.length, 1);
  for (const l of Object.values(AG.AIR_SAT_LAYERS)) assert.ok(l.legendUrl.startsWith("https://gibs.earthdata.nasa.gov/legends/"));
});

test("globe layer builds bounded particles, arrows, heatmap and disposes cleanly", () => {
  const field = WF.parseGridLocations(WIND, WF.WIND_GRID_VARIABLES, SPAN, SHAPE);
  const air = WF.parseGridLocations(AIR, AG.AIR_GRID_VARIABLES, SPAN, SHAPE);
  const parent = new THREE.Group();
  let seed = 3;
  const layer = GL.createWindAirGlobeLayer(parent, () => ((seed = (seed * 16807) % 2147483647) / 2147483647));
  const animated = { wind: { field, level: "10m", hour: 0, animate: true, validTime: field.times[0] }, credits: [] };
  layer.sync(animated, 1000);
  layer.sync(animated, 1016);
  assert.equal(layer.particleCount, GL.MAX_PARTICLES);
  const arrows = { wind: { field, level: "10m", hour: 0, animate: false, validTime: field.times[0] }, heat: { field: air, variable: "us_aqi", hour: 0, opacity: 0.5, validTime: air.times[0] }, credits: [] };
  layer.sync(arrows, 1032);
  assert.equal(layer.particleCount, 0);
  let lines = 0, meshes = 0;
  layer.root.traverse((o) => { if (o.isLineSegments) lines++; if (o.isMesh) meshes++; });
  assert.equal(lines, 1);
  assert.equal(meshes, 1);
  const arrowGeo = GL.arrowGeometry(field, "10m", 0);
  assert.equal(arrowGeo.getAttribute("position").count, 6 * 3 * 2);
  const heat = GL.heatGeometry(field, "us_aqi", 0); // wind field has no us_aqi → all transparent
  const alpha = heat.getAttribute("color").array.filter((_, i) => i % 4 === 3);
  assert.ok(alpha.every((a) => a === 0));
  const aq = GL.heatGeometry(air, "us_aqi", 0);
  assert.ok(aq.getAttribute("color").array.filter((_, i) => i % 4 === 3).every((a) => a === 1));
  layer.sync(null, 1048);
  layer.dispose();
  assert.equal(parent.children.length, 0);
});

test("panel renders opted-out with no requests; globe legend labels model vs modelled", () => {
  const calls = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (...a) => { calls.push(a); throw new Error("no network in tests"); };
  try {
    const html = renderToStaticMarkup(createElement(UI.WorldViewWindAir, { bounds: [SPAN], center: { lat: 35, lon: -75 }, zoom: 1, onGlobeLayer: () => {} }));
    assert.match(html, /WIND &amp; AIR/);
    assert.match(html, /allow map-layer requests/);
    assert.doesNotMatch(html, /checked=""[^>]*Allow wind/);
    assert.match(html, /disabled=""[^>]*>Sample wind grid/);
    assert.doesNotMatch(html, /<img/);
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = saved;
  }
  const field = WF.parseGridLocations(WIND, WF.WIND_GRID_VARIABLES, SPAN, SHAPE);
  const air = WF.parseGridLocations(AIR, AG.AIR_GRID_VARIABLES, SPAN, SHAPE);
  const legend = renderToStaticMarkup(createElement(GL.WindAirGlobeCredits, { fallback: true, state: {
    wind: { field, level: "250hPa", hour: 1, animate: false, validTime: field.times[1] },
    heat: { field: air, variable: "pm2_5", hour: 0, opacity: 0.5, validTime: air.times[0] },
    credits: [{ text: "Weather data by Open-Meteo.com (CC BY 4.0)", termsUrl: "https://open-meteo.com/en/terms" }],
  } }));
  assert.match(legend, /MODEL FORECAST/);
  assert.match(legend, /MODELLED \(CAMS\)/);
  assert.match(legend, /2026-10-31 22Z/);
  assert.match(legend, /not drawn on the 2D fallback/);
  assert.equal(renderToStaticMarkup(createElement(GL.WindAirGlobeCredits, { fallback: false, state: null })), "");
});
