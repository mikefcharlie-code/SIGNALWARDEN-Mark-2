import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Hand-written fixtures modelled on live responses captured 2026-10-31; no network in CI.
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const out = mkdtempSync(join(tmpdir(), "worldview-ocean-"));
writeFileSync(join(out, "package.json"), '{"type":"module"}\n');
symlinkSync(resolve(root, "node_modules"), join(out, "node_modules"), "dir");
const require = createRequire(realpathSync(resolve(root, "node_modules/vite/package.json")));
const { buildSync } = require("esbuild");
const build = (entry, file) => buildSync({ entryPoints: [resolve(root, entry)], outfile: join(out, file), bundle: true, format: "esm", platform: "node", jsx: "automatic", external: ["react", "react-dom", "three"], loader: { ".css": "empty" }, logLevel: "silent" });
build("src/worldview-ocean.ts", "ocean.js");
const oc = await import(pathToFileURL(join(out, "ocean.js")).href);
test.after(() => rmSync(out, { recursive: true, force: true }));
test.beforeEach(() => oc.resetOceanState());

const NET = { network: true };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const recorder = (responder) => { const calls = []; const f = async (url, init) => { calls.push({ url, init }); return responder(url, init); }; f.calls = calls; return f; };
const hourAgo = (h) => new Date(Date.now() - h * 3600_000);
const omTime = (d) => d.toISOString().slice(0, 16);
const coopsT = (d) => d.toISOString().slice(0, 16).replace("T", " ");
const marineLoc = (lat, lon, cur, extra = {}) => ({
  latitude: lat, longitude: lon, generationtime_ms: 0.2, utc_offset_seconds: 0, timezone: "GMT", timezone_abbreviation: "GMT", elevation: 0,
  current_units: { time: "iso8601", interval: "seconds", wave_height: "m", ocean_current_velocity: "km/h", sea_surface_temperature: "°C" },
  current: { time: omTime(hourAgo(0.5)), interval: 900, wave_height: 1.28, wave_direction: 57, wave_period: 6.05, swell_wave_height: 1.1, swell_wave_direction: 47, swell_wave_period: 4.95, wind_wave_height: 0.38, wind_wave_direction: 33, ocean_current_velocity: 0.9, ocean_current_direction: 180, sea_surface_temperature: 17.7, ...cur },
  ...extra,
});
const tinyPng = () => new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), { status: 200, headers: { "content-type": "image/png", "layer-time-actual": "2026-10-29T00:00:00Z" } });

test("nothing is requested without explicit network opt-in", async () => {
  const f = recorder(() => json({}));
  const box = { west: -80, south: 30, east: -65, north: 42 };
  for (const r of [await oc.refreshMarinePoint({ lat: 36, lon: -75 }, {}, f), await oc.refreshMarineGrid(box, 4, {}, f), await oc.refreshNdbcBuoys(box, {}, f), await oc.refreshCoopsTides(box, { lat: 36, lon: -75 }, {}, f)]) {
    assert.equal(r.freshness, "failed"); assert.match(r.error, /opt-in/);
  }
  await assert.rejects(oc.fetchOceanTile(oc.oceanTileUrl(oc.OCEAN_TILE_LAYERS["gebco-relief"], { z: 1, x: 0, y: 0 }), {}, f), /opt-in/);
  const loader = new oc.OceanTileLoader({ network: false, decode: async () => 1, fetcher: f });
  const r = await loader.load(oc.OCEAN_TILE_LAYERS["noaa-enc"], "default", [{ z: 2, x: 1, y: 1 }]);
  assert.equal(r.failed.length, 1); assert.match(r.failed[0].error, /opt-in/);
  assert.equal(f.calls.length, 0);
});

test("tile URLs follow each provider's verified request shape and stay on the allowlist", () => {
  const L = oc.OCEAN_TILE_LAYERS;
  assert.equal(oc.oceanTileUrl(L["gibs-mur-sst"], { z: 3, x: 2, y: 3 }, "2026-10-29"), "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature/default/2026-10-29/GoogleMapsCompatible_Level7/3/3/2.png");
  assert.equal(oc.oceanTileUrl(L["gibs-bathymetry"], { z: 1, x: 1, y: 0 }), "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/default/GoogleMapsCompatible_Level8/1/0/1.jpg");
  const gebco = new URL(oc.oceanTileUrl(L["gebco-relief"], { z: 0, x: 0, y: 0 }));
  assert.equal(gebco.origin + gebco.pathname, "https://wms.gebco.net/mapserv");
  assert.equal(gebco.searchParams.get("crs"), "EPSG:3857");
  assert.equal(gebco.searchParams.get("layers"), "GEBCO_LATEST");
  assert.equal(gebco.searchParams.get("bbox"), "-20037508.34,-20037508.34,20037508.34,20037508.34");
  const enc = new URL(oc.oceanTileUrl(L["noaa-enc"], { z: 1, x: 0, y: 0 }));
  assert.match(enc.pathname, /MCS\/ENCOnline\/MapServer\/exts\/MaritimeChartService\/MapServer\/export$/);
  assert.equal(enc.searchParams.get("transparent"), "true");
  assert.equal(enc.searchParams.get("bbox"), "-20037508.34,0,0,20037508.34");
  assert.match(oc.oceanTileUrl(L["ncei-hillshade"], { z: 2, x: 1, y: 1 }), /^https:\/\/gis\.ngdc\.noaa\.gov\/arcgis\/rest\/services\/DEM_mosaics\/DEM_global_mosaic_hillshade\/ImageServer\/exportImage\?/);
  for (const id of oc.OCEAN_LAYER_ORDER) assert.ok(oc.allowedOceanUrl(oc.oceanTileUrl(L[id], { z: 2, x: 1, y: 1 }, "2026-10-29")), id);
  assert.throws(() => oc.oceanTileUrl(L["gibs-mur-sst"], { z: 9, x: 0, y: 0 }, "2026-10-29"), /out of range/);
  assert.throws(() => oc.oceanTileUrl(L["gibs-mur-sst"], { z: 2, x: 4, y: 0 }, "2026-10-29"), /out of range/);
  for (const bad of [
    "http://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature/default/2026-10-29/GoogleMapsCompatible_Level7/3/3/2.png",
    "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/Some_Other_Layer/default/2026-10-29/GoogleMapsCompatible_Level7/3/3/2.png",
    "https://user:pw@wms.gebco.net/mapserv?service=WMS&request=GetMap",
    "https://wms.gebco.net/mapserv?service=WMS&request=GetCapabilities",
    "https://evil.example/v1/marine",
    "https://marine-api.open-meteo.com/v1/marine?latitude=1&longitude=1&apikey=secret",
    "/api/v1/worldview-ocean/ndbc/latest?west=1&south=1&east=2&north=2&x=1",
    "/api/v1/worldview-weather/status",
  ]) assert.equal(oc.allowedOceanUrl(bad), false, bad);
});

test("product dates are validated and freshness distinguishes daily, static and chart layers", () => {
  const sst = oc.OCEAN_TILE_LAYERS["gibs-mur-sst"], now = Date.parse("2026-10-31T21:00:00Z");
  assert.equal(oc.defaultOceanDate(sst, now), "2026-10-29");
  assert.equal(oc.validateOceanDate(sst, "2026-10-29", now), "2026-10-29");
  assert.throws(() => oc.validateOceanDate(sst, "2026-11-02", now), /future/);
  assert.throws(() => oc.validateOceanDate(sst, "2001-01-01", now), /on or after/);
  assert.throws(() => oc.validateOceanDate(sst, "2026-02-30", now), /real/);
  assert.equal(oc.validateOceanDate(oc.OCEAN_TILE_LAYERS["gebco-relief"], "anything", now), "default");
  assert.equal(oc.parseProviderTime("2026-10-29T00:00:00Z"), "2026-10-29T00:00:00.000Z");
  assert.equal(oc.parseProviderTime("2026-10-29"), "2026-10-29T00:00:00.000Z");
  assert.equal(oc.parseProviderTime("nonsense"), undefined);
  assert.equal(oc.oceanTileFreshness(sst, "2026-10-29T00:00:00Z", now).freshness, "recent");
  assert.equal(oc.oceanTileFreshness(sst, "2026-10-15T00:00:00Z", now).freshness, "stale");
  assert.equal(oc.oceanTileFreshness(sst, "2025-10-01T00:00:00Z", now).freshness, "historical");
  assert.equal(oc.oceanTileFreshness(oc.OCEAN_TILE_LAYERS["gebco-colour"], undefined, now).freshness, "static-dataset");
  assert.equal(oc.oceanTileFreshness(oc.OCEAN_TILE_LAYERS["noaa-enc"], undefined, now).freshness, "unknown");
});

test("tile loader is bounded, cached, rate-limited and records provenance", async () => {
  const f = recorder(() => tinyPng());
  let t = Date.parse("2026-10-31T21:00:00Z");
  const loader = new oc.OceanTileLoader({ network: true, decode: async (b) => b.size, fetcher: f, now: () => t });
  const sst = oc.OCEAN_TILE_LAYERS["gibs-mur-sst"];
  const tiles = [{ z: 2, x: 1, y: 1 }, { z: 2, x: 2, y: 1 }];
  const r1 = await loader.load(sst, "2026-10-29", tiles);
  assert.equal(r1.fetched, 2);
  const rec = r1.loaded[0];
  assert.equal(rec.provider, "NASA GIBS"); assert.equal(rec.live, true); assert.equal(rec.providerTime, "2026-10-29T00:00:00.000Z");
  assert.equal(rec.freshness, "recent"); assert.match(rec.attribution, /GHRSST/); assert.match(rec.sourceUrl, /^https:\/\/gibs/);
  assert.equal(f.calls[0].init.credentials, "omit"); assert.equal(f.calls[0].init.redirect, "error"); assert.equal(f.calls[0].init.referrerPolicy, "no-referrer");
  const r2 = await loader.load(sst, "2026-10-29", tiles);
  assert.equal(r2.fromCache, 2); assert.equal(f.calls.length, 2);
  const enc = oc.OCEAN_TILE_LAYERS["noaa-enc"]; // 60/min
  const many = Array.from({ length: 70 }, (_, i) => ({ z: 7, x: i, y: 40 }));
  const r3 = await loader.load(enc, "default", many);
  assert.equal(r3.fetched + r3.throttled, oc.MAX_OCEAN_TILES, "capped at 48 tiles per view");
  const r4 = await loader.load(enc, "default", many.map((t) => ({ ...t, y: 41 })));
  assert.ok(r4.throttled > 0, "ENC per-minute budget enforced");
  t += 61_000;
  const r5 = await loader.load(enc, "default", [{ z: 7, x: 1, y: 42 }]);
  assert.equal(r5.fetched, 1, "budget recovers after a minute");
  await assert.rejects(loader.load(sst, "2027-01-01", tiles), /future/);
});

test("tile fetch rejects oversized and non-image responses", async () => {
  const url = oc.oceanTileUrl(oc.OCEAN_TILE_LAYERS["gebco-relief"], { z: 1, x: 0, y: 0 });
  await assert.rejects(oc.fetchOceanTile(url, NET, async () => new Response("x", { headers: { "content-type": "image/png", "content-length": String(3 * 1024 * 1024) } })), /size limit/);
  await assert.rejects(oc.fetchOceanTile(url, NET, async () => new Response("<ServiceExceptionReport/>", { headers: { "content-type": "text/xml" } })), /non-image/);
  await assert.rejects(oc.fetchOceanTile(url, NET, async () => new Response("x", { status: 500, headers: { "content-type": "image/png" } })), /HTTP 500/);
});

test("Open-Meteo Marine point read: one keyless browser GET, model-labelled observation with provenance", async () => {
  const f = recorder(() => json(marineLoc(36.791664, -75.54166, {})));
  const r = await oc.refreshMarinePoint({ lat: 36.8, lon: -75.5 }, NET, f);
  assert.equal(r.status, "live"); assert.equal(f.calls.length, 1);
  const u = new URL(f.calls[0].url);
  assert.equal(u.origin + u.pathname, "https://marine-api.open-meteo.com/v1/marine");
  assert.equal(u.searchParams.get("timezone"), "GMT"); assert.equal(u.searchParams.get("cell_selection"), "sea");
  assert.ok(u.searchParams.get("current").includes("ocean_current_direction"));
  assert.equal(u.searchParams.has("apikey"), false);
  const o = r.observations[0];
  assert.equal(o.layer, "ocean"); assert.equal(o.source, "Open-Meteo Marine"); assert.equal(o.freshness, "fresh");
  assert.match(o.label, /^Marine model: Hs 1\.3 m · SST 17\.7 °C · current 0\.25 m\/s$/);
  for (const k of ["provider", "sourceUrl", "retrievedAt", "providerTimestamp", "ageMinutesAtRetrieval", "attribution", "license", "disclosure"]) assert.ok(o.properties[k] !== undefined, k);
  assert.equal(o.properties.notForNavigation, true); assert.equal(o.properties.dataKind, "model");
  assert.match(o.properties.attribution, /Open-Meteo\.com \(CC BY 4\.0\).*Copernicus Marine/);
  assert.equal(o.properties.currentSpeedMs, 0.25); assert.equal(o.properties.currentDirectionTowardDeg, 180);
  // A second immediate call is throttled and served from cache without a request.
  const again = await oc.refreshMarinePoint({ lat: 36.8, lon: -75.5 }, NET, f);
  assert.equal(f.calls.length, 1); assert.match(again.error, /throttled/); assert.equal(again.observations.length, 1);
});

test("Open-Meteo Marine land cells and malformed responses are handled honestly", async () => {
  const land = marineLoc(38.04, -78.04, Object.fromEntries(["wave_height", "wave_direction", "wave_period", "swell_wave_height", "swell_wave_direction", "swell_wave_period", "wind_wave_height", "wind_wave_direction", "ocean_current_velocity", "ocean_current_direction", "sea_surface_temperature"].map((k) => [k, null])), { elevation: 128 });
  const r = await oc.refreshMarinePoint({ lat: 38, lon: -78 }, NET, async () => json(land));
  assert.match(r.observations[0].label, /no ocean data at this cell/);
  oc.resetOceanState();
  const future = await oc.refreshMarinePoint({ lat: 38, lon: -78 }, NET, async () => json(marineLoc(1, 1, { time: omTime(new Date(Date.now() + 6 * 3600_000)) })));
  assert.equal(future.status, "failed"); assert.match(future.error, /future/);
  oc.resetOceanState();
  const offset = await oc.refreshMarinePoint({ lat: 38, lon: -78 }, NET, async () => json(marineLoc(1, 1, {}, { utc_offset_seconds: 3600 })));
  assert.match(offset.error, /GMT/);
  oc.resetOceanState();
  const err = await oc.refreshMarinePoint({ lat: 38, lon: -78 }, NET, async () => json({ error: true, reason: "Invalid value" }, 400));
  assert.equal(err.status, "failed"); assert.match(err.error, /HTTP 400: Invalid value/);
});

test("marine grid: bounded point count, one multi-location request, mismatch rejected", async () => {
  assert.throws(() => oc.marineGridPoints({ west: -80, south: 30, east: -65, north: 42 }, 9), /2-8/);
  assert.throws(() => oc.marineGridPoints({ west: -80, south: 30, east: 0, north: 42 }, 4), /capped/);
  const pts = oc.marineGridPoints({ west: -80, south: 30, east: -64, north: 42 }, 2);
  assert.deepEqual(pts, [{ lat: 39, lon: -76 }, { lat: 39, lon: -68 }, { lat: 33, lon: -76 }, { lat: 33, lon: -68 }]);
  const f = recorder(() => json(pts.map((p, i) => marineLoc(p.lat + 0.01, p.lon + 0.01, { wave_height: i }, i ? { location_id: i } : {}))));
  const r = await oc.refreshMarineGrid({ west: -80, south: 30, east: -64, north: 42 }, 2, NET, f);
  assert.equal(f.calls.length, 1); assert.equal(r.status, "live"); assert.equal(r.cells.length, 4);
  assert.deepEqual(r.grid, { bbox: { west: -80, south: 30, east: -64, north: 42 }, n: 2, dLat: 6, dLon: 8 });
  assert.equal(new URL(f.calls[0].url).searchParams.get("latitude"), "39.0000,39.0000,33.0000,33.0000");
  assert.equal(r.observations.length, 0, "grid is drawn on the globe, not added as markers");
  oc.resetOceanState();
  const bad = await oc.refreshMarineGrid({ west: -80, south: 30, east: -64, north: 42 }, 2, NET, async () => json([marineLoc(1, 1, {})]));
  assert.equal(bad.status, "failed"); assert.match(bad.error, /different number of locations/);
});

test("grid paint ops: cells clipped to the tile, arrows point toward travel direction", () => {
  const cells = [
    { lat: 10, lon: 10, requestedLat: 10, requestedLon: 10, time: "x", noData: false, values: { wave_height: 4, ocean_current_direction: 90, wave_direction: 0, swell_wave_direction: 270 } },
    { lat: -60, lon: -150, requestedLat: -60, requestedLon: -150, time: "x", noData: false, values: { wave_height: 2, ocean_current_direction: 0 } },
    { lat: 20, lon: 20, requestedLat: 20, requestedLon: 20, time: "x", noData: true, values: { wave_height: null, ocean_current_direction: null } },
  ];
  const ops = oc.gridPaintOps(cells, { dLat: 10, dLon: 10 }, "wave_height", "current", { z: 1, x: 1, y: 0 });
  const kinds = ops.map((o) => o.kind);
  assert.deepEqual(kinds, ["cell", "arrow"], "southern-hemisphere cell outside the tile and null values skipped");
  const [cell, arrow] = ops;
  assert.ok(cell.x > 0 && cell.x < 256 && cell.y > 0 && cell.y + cell.h <= 256);
  assert.ok(Math.abs(arrow.angleRad - Math.PI / 2) < 1e-9, "current toward east");
  const wave = oc.gridPaintOps(cells.slice(0, 1), { dLat: 10, dLon: 10 }, "wave_height", "wave", { z: 1, x: 1, y: 0 });
  assert.ok(Math.abs(wave[1].angleRad - Math.PI) < 1e-9, "waves from north travel south");
  assert.equal(oc.metricColor("wave_height", null), null);
  assert.notDeepEqual(oc.metricColor("sea_surface_temperature", -2), oc.metricColor("sea_surface_temperature", 32));
});

const NDBC_BODY = (over = {}) => ({
  provider: "noaa-ndbc", sourceUrl: "https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt", retrievedAt: new Date().toISOString(),
  fileLastModified: hourAgo(0.2).toISOString(), truncated: false, attribution: "x", termsUrl: "x", notForNavigation: true,
  stations: [
    { station: "44008", lat: 40.5, lon: -69.254, observedAt: hourAgo(0.5).toISOString(), values: { windDirDeg: 330, windSpeedMs: 6, gustMs: 8, waveHeightM: null, waterTempC: 16.3, pressureHpa: 1028.1 }, name: "NANTUCKET 54 NM Southeast of Nantucket", owner: "NDBC", stationType: "buoy", sourceUrl: "https://www.ndbc.noaa.gov/station_page.php?station=44008" },
    { station: "44097", lat: 40.966, lon: -71.123, observedAt: hourAgo(5).toISOString(), values: { waveHeightM: 0.7, dominantPeriodS: 9 }, name: "Block Island, RI  (154)", owner: "SCRIPPS", stationType: "buoy", sourceUrl: "https://evil.example/" },
    { station: "bad id!", lat: 1, lon: 1, observedAt: hourAgo(1).toISOString(), values: {} },
    { station: "41001", lat: 34.7, lon: -72.7, observedAt: new Date(Date.now() + 3600_000).toISOString(), values: {} },
  ],
  ...over,
});

test("NDBC buoys go only through the same-origin relay with the opt-in header", async () => {
  const f = recorder(() => json(NDBC_BODY()));
  const r = await oc.refreshNdbcBuoys({ west: -80, south: 30, east: -60, north: 45 }, NET, f);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "/api/v1/worldview-ocean/ndbc/latest?west=-80&south=30&east=-60&north=45");
  assert.equal(f.calls[0].init.headers["X-SignalWarden-Ocean"], "enabled"); assert.equal(f.calls[0].init.mode, "same-origin");
  assert.equal(r.observations.length, 2, "bad id and future timestamp dropped");
  const [a, b] = r.observations;
  assert.equal(a.id, "ndbc-44008"); assert.equal(a.freshness, "fresh"); assert.equal(b.freshness, "stale");
  assert.match(a.label, /NDBC buoy 44008 \(NANTUCKET.*water 16\.3 °C · wind 6 m\/s/);
  assert.equal(a.properties.dataKind, "measured"); assert.equal(a.properties.waveHeightM, null);
  assert.match(a.properties.attribution, /station owner: NDBC/);
  assert.equal(b.properties.sourceUrl, "https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt", "untrusted station URL replaced");
});

test("NDBC empty and malformed-only payloads do not claim live data", async () => {
  const box = { west: -80, south: 30, east: -60, north: 45 };
  const cases = [
    { stations: [] },
    { stations: [{ station: "bad id!", lat: 40, lon: -70, observedAt: hourAgo(0.5).toISOString(), values: {} }, { station: "41001", lat: 40, lon: -70, observedAt: new Date(Date.now() + 3600_000).toISOString(), values: {} }] },
  ];
  for (const body of cases) {
    oc.resetOceanState();
    const r = await oc.refreshNdbcBuoys(box, NET, async () => json(NDBC_BODY(body)));
    assert.equal(r.status, "failed"); assert.equal(r.freshness, "failed"); assert.equal(r.observations.length, 0);
    assert.match(r.error, /No current usable observations/);
  }
});

test("NDBC relay disabled and failures are reported, last snapshot retained as stale", async () => {
  const off = await oc.refreshNdbcBuoys({ west: -80, south: 30, east: -60, north: 45 }, NET, async () => json({ error: { code: "ocean_relay_disabled", message: "WorldView ocean relay is disabled" } }, 404));
  assert.equal(off.status, "disabled"); assert.match(off.error, /UCAS_WORLDVIEW_OCEAN_ENABLED=1/);
  oc.resetOceanState();
  const now = Date.now(), realNow = Date.now;
  await oc.refreshNdbcBuoys({ west: -80, south: 30, east: -60, north: 45 }, NET, async () => json(NDBC_BODY()));
  Date.now = () => now + 61_000;
  try {
    const r = await oc.refreshNdbcBuoys({ west: -80, south: 30, east: -60, north: 45 }, NET, async () => { throw new TypeError("network down"); });
    assert.equal(r.status, "stale"); assert.equal(r.observations.length, 2); assert.ok(r.observations.every((o) => o.stale === true));
    assert.match(r.error, /last successful snapshot/);
  } finally { Date.now = realNow; }
  assert.equal((await oc.refreshNdbcBuoys({ west: -80, south: 30, east: 0, north: 45 }, NET, async () => json({}))).status, "stale");
});

const STATIONS = { count: 4, units: null, stations: [
  { tidal: true, greatlakes: false, state: "VA", id: "8638610", name: "Sewells Point", lat: 36.9428, lng: -76.3286 },
  { tidal: true, greatlakes: false, state: "VA", id: "8639348", name: "Money Point", lat: 36.7783, lng: -76.3017 },
  { tidal: false, greatlakes: true, state: "OH", id: "9063063", name: "Cleveland", lat: 41.5408, lng: -81.6355 },
  { tidal: true, greatlakes: false, state: "HI", id: "1611400", name: "Nawiliwili", lat: 21.9544, lng: -159.3561 },
  { id: "bad", lat: 1, lng: 1 },
] };
const coopsResponder = (url) => {
  const u = new URL(url);
  if (u.pathname.endsWith("stations.json")) return json(STATIONS);
  const st = u.searchParams.get("station"), product = u.searchParams.get("product");
  if (product === "water_level") {
    if (st === "8639348") return json({ error: { message: "No data was found. This product may not be offered at this station at the requested time." } });
    return json({ metadata: { id: st, name: "x", lat: "0", lon: "0" }, data: [{ t: coopsT(hourAgo(0.2)), v: "0.768", s: "0.012", f: "1,0,0,0", q: "p" }] });
  }
  return json({ predictions: [
    { t: coopsT(hourAgo(3)), v: "0.103", type: "L" }, { t: coopsT(new Date(Date.now() + 2 * 3600_000)), v: "0.935", type: "H" },
    { t: coopsT(new Date(Date.now() + 8 * 3600_000)), v: "0.157", type: "L" },
  ] });
};

test("CO-OPS tides: nearest stations in view, measured water level + predictions, datum per station type", async () => {
  const f = recorder(coopsResponder);
  const r = await oc.refreshCoopsTides({ west: -85, south: 35, east: -75, north: 45 }, { lat: 36.9, lon: -76.3 }, NET, f, 5);
  assert.equal(r.status, "live");
  assert.deepEqual(r.stations.map((s) => s.station.id), ["8638610", "8639348", "9063063"], "in-bbox only, nearest first");
  const urls = f.calls.map((c) => new URL(c.url));
  assert.equal(urls[0].href, "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=waterlevels");
  const wl = urls.find((u) => u.searchParams.get("station") === "8638610" && u.searchParams.get("product") === "water_level");
  assert.equal(wl.searchParams.get("datum"), "MLLW"); assert.equal(wl.searchParams.get("time_zone"), "gmt"); assert.equal(wl.searchParams.get("units"), "metric");
  const gl = urls.filter((u) => u.searchParams.get("station") === "9063063");
  assert.deepEqual(gl.map((u) => [u.searchParams.get("product"), u.searchParams.get("datum")]), [["water_level", "IGLD"]], "Great Lakes: IGLD, no tide predictions");
  const pred = urls.find((u) => u.searchParams.get("product") === "predictions");
  assert.equal(pred.searchParams.get("interval"), "hilo"); assert.equal(pred.searchParams.get("range"), "48"); assert.match(pred.searchParams.get("begin_date"), /^\d{8}$/);
  const sewells = r.observations.find((o) => o.id === "coops-8638610");
  assert.equal(sewells.freshness, "fresh"); assert.equal(sewells.properties.waterLevelM, 0.768); assert.equal(sewells.properties.qualityFlag, "preliminary");
  assert.equal(sewells.properties.nextHighM, 0.935); assert.ok(Date.parse(sewells.properties.nextHighTime) > Date.now(), "future prediction kept, not clamped");
  assert.match(sewells.label, /Sewells Point, VA: water level 0\.77 m MLLW · next high/);
  const money = r.stations.find((s) => s.station.id === "8639348");
  assert.match(money.error, /No data was found/); assert.equal(money.waterLevelM, null);
  const moneyObs = r.observations.find((o) => o.id === "coops-8639348");
  assert.equal(moneyObs.properties.dataKind, "prediction"); assert.equal(moneyObs.freshness, "stale");
  // Station list is cached for the session; the next refresh (after the throttle) does not refetch it.
  const realNow = Date.now, t0 = Date.now();
  Date.now = () => t0 + 61_000;
  try { await oc.refreshCoopsTides({ west: -85, south: 35, east: -75, north: 45 }, { lat: 36.9, lon: -76.3 }, NET, f, 1); } finally { Date.now = realNow; }
  assert.equal(f.calls.filter((c) => c.url.includes("stations.json")).length, 1);
});

test("CO-OPS empty and malformed-only payloads do not claim live data", async () => {
  const box = { west: -85, south: 35, east: -75, north: 45 }, center = { lat: 36.9, lon: -76.3 };
  const emptyStations = { count: 0, units: null, stations: [] };
  oc.resetOceanState();
  let r = await oc.refreshCoopsTides(box, center, NET, async (url) => url.includes("stations.json") ? json(emptyStations) : json({ data: [] }), 5);
  assert.equal(r.status, "failed"); assert.equal(r.freshness, "failed"); assert.equal(r.observations.length, 0);
  assert.match(r.error, /No current usable observations/);

  oc.resetOceanState();
  const malformedStations = { count: 1, units: null, stations: [{ tidal: true, greatlakes: false, state: "VA", id: "8638610", name: "Sewells Point", lat: 36.9428, lng: -76.3286 }] };
  r = await oc.refreshCoopsTides(box, center, NET, async (url) => {
    if (url.includes("stations.json")) return json(malformedStations);
    if (new URL(url).searchParams.get("product") === "water_level") return json({ data: [{ t: coopsT(new Date(Date.now() + 3600_000)), v: "not-a-number", q: "p" }] });
    return json({ predictions: [{ t: coopsT(new Date(Date.now() + 2 * 3600_000)), v: "not-a-number", type: "H" }] });
  }, 5);
  assert.equal(r.status, "failed"); assert.equal(r.freshness, "failed"); assert.equal(r.observations.length, 0);
  assert.match(r.error, /No current usable observations/);
});

test("panel renders opt-in controls and the not-for-navigation notice without requests", async () => {
  build("src/WorldViewOcean.tsx", "ocean-component.js");
  const old = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error("unexpected network"); };
  try {
    const { default: Component } = await import(pathToFileURL(join(out, "ocean-component.js")).href);
    const html = renderToStaticMarkup(createElement(Component, { bounds: [], center: { lat: 36, lon: -75 }, zoom: 1, onOverlay: () => {}, onObservations: () => {} }));
    assert.equal(calls, 0);
    assert.match(html, /No ocean provider requests have been made/);
    assert.match(html, /Not for navigation/);
    assert.match(html, /<button disabled="">Read marine conditions at view centre/);
    assert.match(html, /UCAS_WORLDVIEW_OCEAN_ENABLED=1/);
    assert.doesNotMatch(html, /<img|<iframe/);
  } finally { globalThis.fetch = old; }
});

test("client source carries no credentials or environment reads", () => {
  const src = ["src/worldview-ocean.ts", "src/WorldViewOcean.tsx", "src/worldview-ocean-globe.tsx"].map((p) => readFileSync(resolve(root, p), "utf8")).join("\n");
  assert.doesNotMatch(src, /import\.meta\.env|process\.env/);
  assert.doesNotMatch(src, /apikey=|api_key=|token=/i);
});
