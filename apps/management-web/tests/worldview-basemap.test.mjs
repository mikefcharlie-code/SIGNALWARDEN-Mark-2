import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = resolve(import.meta.dirname, "..");
const out = mkdtempSync(join(tmpdir(), "worldview-basemap-"));
writeFileSync(join(out, "package.json"), '{"type":"module"}\n');
symlinkSync(resolve(root, "node_modules"), join(out, "node_modules"), "dir");
const compile = spawnSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), resolve(root, "src/worldview-basemap.ts"), "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--skipLibCheck", "--lib", "ES2022,DOM,DOM.Iterable", "--outDir", out], { encoding: "utf8", cwd: out });
if (compile.status !== 0) throw new Error(`Unable to compile worldview-basemap.ts:\n${compile.stdout}\n${compile.stderr}`);

const realFetch = globalThis.fetch;
let importCalls = 0;
globalThis.fetch = async () => { importCalls++; throw new Error("unexpected network"); };
const bm = await import(`${pathToFileURL(join(out, "worldview-basemap.js")).href}?${Date.now()}`);
globalThis.fetch = realFetch;
test.after(() => rmSync(out, { recursive: true, force: true }));

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const png = (bytes = 64) => new Uint8Array([137, 80, 78, 71, ...new Array(bytes).fill(1)]);
const imageResponse = (headers = {}, body = png(), status = 200) => new Response(body, { status, headers: { "content-type": "image/png", ...headers } });

test("importing the module makes no network request", () => assert.equal(importCalls, 0));

test("Web Mercator tile math matches known tiles", () => {
  const f = bm.lonLatToTileFraction(39.7392, -104.9903, 12);
  assert.deepEqual([Math.floor(f.x), Math.floor(f.y)], [853, 1554]);
  const b = bm.tileBounds({ z: 1, x: 0, y: 0 });
  assert.equal(b.west, -180); assert.equal(b.east, 0); assert.equal(b.south, 0);
  assert.ok(Math.abs(b.north - bm.MAX_MERCATOR_LAT) < 1e-9);
  assert.equal(bm.chooseTileZoom(0.65, 9), 2);
  assert.equal(bm.chooseTileZoom(1.8, 9), 4);
  assert.equal(bm.chooseTileZoom(1.8, 3), 3);
});

test("visible tiles are bounded, deduplicated, centre-first and never outside the viewport", () => {
  const tiles = bm.tilesForBounds([{ west: -100, south: 20, east: -60, north: 50 }], 4, { lat: 38, lon: -77 });
  assert.ok(tiles.length > 0 && tiles.length <= bm.MAX_TILES_PER_VIEW);
  const first = bm.tileBounds(tiles[0]);
  assert.ok(first.west <= -77 && first.east >= -77 && first.south <= 38 && first.north >= 38, "first tile contains centre");
  for (const t of tiles) { const b = bm.tileBounds(t); assert.ok(b.east > -100 && b.west < -60 && b.north > 20 && b.south < 50); }
  const world = bm.tilesForBounds([{ west: -180, south: -90, east: 180, north: 90 }], 5, { lat: 0, lon: 0 });
  assert.equal(world.length, bm.MAX_TILES_PER_VIEW);
  const split = bm.tilesForBounds([{ west: 170, south: -10, east: 180, north: 10 }, { west: -180, south: -10, east: -170, north: 10 }], 3, { lat: 0, lon: 180 });
  assert.equal(new Set(split.map(bm.tileKey)).size, split.length);
  assert.ok(split.some((t) => t.x === 0) && split.some((t) => t.x === 7));
  assert.deepEqual(bm.tilesForBounds([{ west: 0, south: 0, east: 1, north: 1 }], 12, { lat: 0, lon: 0 }), [], "high zoom refused (no bulk)");
});

test("GIBS URLs use the verified WMTS REST shape, real dates and per-layer bounds", () => {
  const viirs = bm.BASEMAP_PROVIDERS["gibs-viirs-truecolor"];
  assert.equal(bm.gibsTileUrl(viirs, "2026-10-28", { z: 2, x: 1, y: 3 }, NOW),
    "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/2026-10-28/GoogleMapsCompatible_Level9/2/3/1.jpg");
  assert.equal(bm.defaultGibsDate(NOW), "2026-10-29");
  for (const bad of ["2026-10-31", "2026-02-30", "26-10-01", "2015-01-01", "2026-10-28T00:00:00Z"]) assert.throws(() => bm.gibsTileUrl(viirs, bad, { z: 1, x: 0, y: 0 }, NOW), /GIBS date/);
  assert.throws(() => bm.gibsTileUrl(viirs, "2026-10-28", { z: 10, x: 0, y: 0 }, NOW), /out of range/);
  assert.throws(() => bm.gibsTileUrl(viirs, "2026-10-28", { z: 2, x: 4, y: 0 }, NOW), /out of range/);
  const marble = bm.BASEMAP_PROVIDERS["gibs-black-marble"];
  assert.match(bm.gibsTileUrl(marble, "2026-10-28", { z: 1, x: 0, y: 0 }, NOW), /VIIRS_Black_Marble\/default\/2016-01-01\/GoogleMapsCompatible_Level8\/1\/0\/0\.png$/);
  assert.match(bm.gibsTileUrl(bm.BASEMAP_PROVIDERS["gibs-viirs-dnb"], "2026-10-29", { z: 1, x: 0, y: 0 }, NOW), /VIIRS_SNPP_DayNightBand_At_Sensor_Radiance\/default\/2026-10-29\/GoogleMapsCompatible_Level8/);
  assert.match(bm.gibsTileUrl(bm.BASEMAP_PROVIDERS["gibs-modis-lst-day"], "2026-10-29", { z: 1, x: 0, y: 0 }, NOW), /MODIS_Terra_Land_Surface_Temp_Day\/default\/2026-10-29\/GoogleMapsCompatible_Level7\/1\/0\/0\.png$/);
  for (const id of Object.keys(bm.BASEMAP_PROVIDERS).filter((k) => k.startsWith("gibs"))) assert.equal(bm.BASEMAP_PROVIDERS[id].attribution, "NASA EOSDIS GIBS / Worldview");
});

test("XYZ tile templates: OSM default accepted; keys, credentials, queries, http and odd ports rejected", () => {
  assert.equal(bm.validateTileTemplate(bm.DEFAULT_OSM_TEMPLATE), "https://tile.openstreetmap.org/{z}/{x}/{y}.png");
  assert.equal(bm.xyzTileUrl(bm.DEFAULT_OSM_TEMPLATE, bm.BASEMAP_PROVIDERS["osm-standard"], { z: 3, x: 2, y: 1 }), "https://tile.openstreetmap.org/3/2/1.png");
  assert.ok(bm.isOsmFoundationTemplate(bm.DEFAULT_OSM_TEMPLATE));
  for (const bad of [
    "http://tile.openstreetmap.org/{z}/{x}/{y}.png",
    "https://tile.openstreetmap.org/{z}/{x}/{y}.png?apikey=abc",
    "https://u:p@tile.example.org/{z}/{x}/{y}.png",
    "https://tile.example.org:8443/{z}/{x}/{y}.png",
    "https://tile.example.org/{z}/{x}.png",
    "https://tile.example.org/{z}/{x}/{y}/{s}.png",
    "https://tile.example.org/token-abc/{z}/{x}/{y}.png",
    "https://tile.example.org/{z}/{x}/{y}.png#frag",
    "https://localhost/{z}/{x}/{y}.png",
  ]) assert.throws(() => bm.validateTileTemplate(bad), undefined, bad);
});

test("Terrarium decoding, bilinear sampling and hillshade", () => {
  assert.equal(bm.terrariumElevation(128, 0, 0), 0);
  assert.equal(bm.terrariumElevation(134, 73, 217), 1609 + 217 / 256);
  const rgba = new Uint8ClampedArray([128, 0, 0, 255, 128, 100, 0, 255, 127, 156, 0, 255, 128, 200, 0, 255]);
  const h = bm.decodeTerrarium(rgba, 2, 2);
  assert.deepEqual([...h], [0, 100, -100, 200]);
  assert.equal(bm.sampleGrid(h, 2, 2, 0.5, 0.5), 50);
  assert.throws(() => bm.decodeTerrarium(rgba, 3, 3), /dimensions/);
  const flat = bm.hillshade(new Float32Array(16).fill(100), 4, 4, 1000, 10);
  assert.equal(flat.length, 64);
  assert.ok([...flat].filter((_, i) => i % 4 === 3).every((a) => a < 5), "flat terrain nearly transparent");
  const ramp = bm.hillshade(Float32Array.from({ length: 16 }, (_, i) => (i % 4) * 500), 4, 4, 100, 1);
  assert.ok([...ramp].filter((_, i) => i % 4 === 3).some((a) => a > 20));
});

test("tile loader: no request without opt-in, then bounded, cached, rate-limited and provenance-tagged", async () => {
  let calls = 0;
  const off = new bm.TileLoader({ network: false, fetcher: async () => { calls++; return imageResponse(); }, decode: async (b) => b.size });
  const source = bm.imagerySource("gibs-viirs-truecolor", { date: "2026-10-28", now: NOW });
  const tiles = [{ z: 2, x: 1, y: 1 }, { z: 2, x: 2, y: 1 }, { z: 2, x: 1, y: 2 }];
  const denied = await off.load(source, tiles);
  assert.equal(calls, 0); assert.equal(denied.failed.length, 3);

  const seen = []; let active = 0, maxActive = 0;
  const loader = new bm.TileLoader({ network: true, now: () => NOW, decode: async (b) => b.size, cacheEntries: 2, fetcher: async (url, init) => {
    seen.push({ url, init }); active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5)); active--;
    return imageResponse({ "layer-time-actual": "2026-10-28T00:00:00Z" });
  } });
  const r1 = await loader.load({ ...source, concurrency: 2 }, tiles);
  assert.equal(r1.loaded.length, 3); assert.equal(r1.fetched, 3); assert.ok(maxActive <= 2);
  const rec = r1.loaded[0];
  assert.equal(rec.live, true); assert.equal(rec.attribution, "NASA EOSDIS GIBS / Worldview");
  assert.equal(rec.providerTime, "2026-10-28T00:00:00Z"); assert.equal(rec.freshness, "recent");
  assert.ok(rec.ageMs > 0); assert.match(rec.sourceUrl, /^https:\/\/gibs\.earthdata\.nasa\.gov\//);
  assert.equal(rec.retrievedAt, new Date(NOW).toISOString()); assert.ok(rec.termsUrl.startsWith("https://"));
  for (const { init } of seen) {
    assert.equal(init.credentials, "omit"); assert.equal(init.redirect, "error"); assert.equal(init.referrerPolicy, "no-referrer");
    assert.equal(init.headers["X-SignalWarden-Basemap"], undefined);
  }
  assert.equal(loader.cache.size, 2, "LRU bounded");
  const r2 = await loader.load(source, tiles.slice(1));
  assert.equal(r2.fromCache, 2); assert.equal(r2.fetched, 0);

  const limited = new bm.TileLoader({ network: true, now: () => NOW, decode: async () => 1, fetcher: async () => imageResponse() });
  const r3 = await limited.load({ ...source, perMinute: 2 }, tiles);
  assert.equal(r3.fetched, 2); assert.equal(r3.throttled, 1);
});

test("tile fetch rejects non-images, oversize bodies, off-allowlist URLs and HTTP errors", async () => {
  const opts = (fetcher) => ({ network: true, fetcher });
  await assert.rejects(bm.fetchTileBytes("https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/x.jpg", opts(async () => new Response("<html>", { headers: { "content-type": "text/html" } }))), /non-image/);
  await assert.rejects(bm.fetchTileBytes("https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/x.jpg", opts(async () => imageResponse({}, new Uint8Array(bm.MAX_TILE_BYTES + 10)))), /2 MiB/);
  await assert.rejects(bm.fetchTileBytes("https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/x.jpg", opts(async () => imageResponse({}, png(), 404))), /HTTP 404/);
  let calls = 0;
  for (const url of ["https://gibs.earthdata.nasa.gov/other/x.jpg", "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/x.jpg?key=1", "http://tile.openstreetmap.org/1/0/0.png", "https://s3.amazonaws.com/other-bucket/1/0/0.png", "/api/v1/public-imagery/basemap/esri/tile?z=1&x=0&y=0&key=x", "https://x.example/1/0/0.png?token=t"])
    await assert.rejects(bm.fetchTileBytes(url, opts(async () => { calls++; return imageResponse(); })), /allowlist/, url);
  assert.equal(calls, 0);
  await assert.rejects(bm.fetchTileBytes("https://tile.openstreetmap.org/1/0/0.png", { network: true, fetcher: async () => { calls++; return imageResponse(); } }), /allowlist/, "unconfigured XYZ host");
  assert.equal(calls, 0);
  await assert.rejects(bm.fetchTileBytes("https://tile.openstreetmap.org/1/0/0.png", { network: false, fetcher: async () => { calls++; } }), /opt-in/);
  assert.equal(calls, 0);
});

test("OSM sends a referrer (tile policy); keyed providers go only through the same-origin relay with no key", async () => {
  const seen = [];
  const loader = new bm.TileLoader({ network: true, decode: async () => 1, fetcher: async (url, init) => { seen.push({ url, init }); return imageResponse(); } });
  await loader.load(bm.imagerySource("osm-standard"), [{ z: 1, x: 0, y: 0 }]);
  assert.equal(seen[0].url, "https://tile.openstreetmap.org/1/0/0.png");
  assert.equal(seen[0].init.referrerPolicy, "strict-origin-when-cross-origin");
  assert.equal(bm.BASEMAP_PROVIDERS["osm-standard"].concurrency, 2);
  await loader.load(bm.imagerySource("esri-world-imagery"), [{ z: 2, x: 1, y: 3 }]);
  await loader.load(bm.imagerySource("google-2d-satellite"), [{ z: 2, x: 1, y: 3 }]);
  assert.equal(seen[1].url, "/api/v1/public-imagery/basemap/esri/tile?z=2&x=1&y=3");
  assert.equal(seen[2].url, "/api/v1/public-imagery/basemap/google/tile?z=2&x=1&y=3");
  for (const s of seen.slice(1)) { assert.equal(s.init.headers["X-SignalWarden-Basemap"], "enabled"); assert.equal(s.init.mode, "same-origin"); assert.doesNotMatch(s.url, /key|token|session/i); }
  assert.throws(() => bm.relayTileUrl(bm.BASEMAP_PROVIDERS["esri-world-imagery"], { z: 9, x: 0, y: 0 }), /out of range/);
});

test("keyed Esri/Google tiles are no-store and bypass the in-memory tile cache", async () => {
  const seen = [];
  const loader = new bm.TileLoader({ network: true, decode: async (blob) => blob, fetcher: async (url, init) => { seen.push({ url, cache: init.cache }); return imageResponse(); } });
  for (const id of ["esri-world-imagery", "google-2d-satellite"]) {
    const source = bm.imagerySource(id);
    assert.equal(source.cache, "no-store");
    await loader.load(source, [{ z: 2, x: 1, y: 3 }]);
    const again = await loader.load(source, [{ z: 2, x: 1, y: 3 }]);
    assert.equal(again.fromCache, 0);
  }
  assert.equal(loader.cache.size, 0);
  assert.deepEqual(seen.map((r) => r.cache), ["no-store", "no-store", "no-store", "no-store"]);
});

test("relay status preserves configured states and makes malformed metadata explicit", async () => {
  const body = { relayEnabled: true, providers: { esri: { status: "not_configured", detail: "UCAS_ESRI_API_KEY is not set", envVar: "UCAS_ESRI_API_KEY" }, google2d: { status: "configured", detail: "ok" }, google3d: { status: "not_implemented", detail: "no 3D" } } };
  let init;
  const s = await bm.fetchRelayStatus({ network: true, fetcher: async (_u, i) => { init = i; return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }); } });
  assert.equal(s.providers.esri.status, "not_configured"); assert.equal(s.providers.google2d.status, "configured"); assert.equal(s.providers.google3d.status, "not_implemented");
  assert.equal(init.headers["X-SignalWarden-Basemap"], "enabled");
  const controller = new AbortController();
  let attributionInit;
  const copyright = await bm.fetchGoogleCopyright({ west: -78, south: 37, east: -76, north: 39 }, 3, { network: true, signal: controller.signal, fetcher: async (_u, i) => { attributionInit = i; return new Response(JSON.stringify({ copyright: "Imagery © Example" })); } });
  assert.equal(copyright, "Imagery © Example");
  assert.equal(attributionInit.cache, "no-store");
  assert.equal(attributionInit.signal, controller.signal);
  const weird = await bm.fetchRelayStatus({ network: true, fetcher: async () => new Response(JSON.stringify({ providers: { esri: { status: "fabricated" } } })) });
  assert.equal(weird.providers.esri.status, "unknown");
  assert.equal(weird.providers.google2d.status, "unknown");
  const missing = await bm.fetchRelayStatus({ network: true, fetcher: async () => new Response("", { status: 404 }) });
  assert.equal(missing.providers.esri.status, "unreachable"); assert.equal(missing.relayEnabled, false);
  await assert.rejects(bm.fetchRelayStatus({ network: false }), /opt-in/);
});

test("elevation readout decodes the real Terrarium tile for the point and carries provenance", async () => {
  let url;
  const pixel = [134, 73, 217];
  const reading = await bm.readElevation(39.7392, -104.9903, {
    network: true, now: () => NOW,
    fetcher: async (u) => { url = u; return imageResponse({ "last-modified": "Sat, 02 Dec 2017 02:55:40 GMT" }); },
    decodePixels: async () => ({ width: 256, height: 256, rgba: Uint8ClampedArray.from({ length: 256 * 256 * 4 }, (_, i) => (i % 4 === 3 ? 255 : pixel[i % 4])) }),
  });
  assert.equal(url, "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/853/1554.png");
  assert.equal(reading.meters, 1609.8);
  assert.equal(reading.live, false); assert.equal(reading.freshness, "static-dataset");
  assert.equal(reading.providerTime, "Sat, 02 Dec 2017 02:55:40 GMT");
  assert.match(reading.attribution, /Mapzen/); assert.match(reading.attribution, /U\.S\. Geological Survey/);
  assert.match(reading.note, /not for navigation/);
  await assert.rejects(bm.readElevation(89, 0, { network: true, decodePixels: async () => ({}) }), /85\.05/);
  let calls = 0;
  await assert.rejects(bm.readElevation(10, 10, { network: false, fetcher: async () => { calls++; }, decodePixels: async () => ({}) }), /opt-in/);
  assert.equal(calls, 0);
});

test("freshness: daily GIBS recent/stale/historical; Black Marble historical; others unknown", () => {
  const v = bm.BASEMAP_PROVIDERS["gibs-viirs-truecolor"];
  assert.equal(bm.imageryFreshness(v, "2026-10-29", NOW).freshness, "recent");
  assert.equal(bm.imageryFreshness(v, "2026-10-10", NOW).freshness, "stale");
  assert.equal(bm.imageryFreshness(v, "2025-10-10", NOW).freshness, "historical");
  assert.equal(bm.imageryFreshness(v, "garbage", NOW).freshness, "unknown");
  assert.equal(bm.imageryFreshness(bm.BASEMAP_PROVIDERS["gibs-black-marble"], undefined, NOW).freshness, "historical");
  assert.equal(bm.imageryFreshness(bm.BASEMAP_PROVIDERS["osm-standard"], undefined, NOW).freshness, "unknown");
});

test("successful historical or unknown basemap tiles never retain live=true", async () => {
  const loader = new bm.TileLoader({ network: true, now: () => NOW, decode: async () => 1, fetcher: async () => imageResponse() });
  const tile = [{ z: 2, x: 1, y: 1 }];
  const stale = await loader.load(bm.imagerySource("gibs-viirs-truecolor", { date: "2026-10-10", now: NOW }), tile);
  assert.equal(stale.loaded[0].freshness, "stale");
  assert.equal(stale.loaded[0].live, false);
  const recent = await loader.load(bm.imagerySource("gibs-viirs-truecolor", { date: "2026-10-29", now: NOW }), tile);
  assert.equal(recent.loaded[0].freshness, "recent");
  assert.equal(recent.loaded[0].live, true);
  const unknown = await loader.load(bm.imagerySource("osm-standard"), tile);
  assert.equal(unknown.loaded[0].freshness, "unknown");
  assert.equal(unknown.loaded[0].live, false);
});

test("client sources never carry keyed-provider secrets or upstream keyed hosts", () => {
  for (const file of ["src/worldview-basemap.ts", "src/WorldViewBasemap.tsx", "src/worldview-basemap-globe.tsx"]) {
    const text = readFileSync(resolve(root, file), "utf8");
    assert.doesNotMatch(text, /ibasemaps-api\.arcgis\.com|tile\.googleapis\.com|[?&](key|token|access_token)=/i, file);
    assert.doesNotMatch(text, /process\.env|import\.meta\.env/, file);
  }
});

test("UI renders opt-in controls with no request; globe shows provider credit only when a layer is enabled", async () => {
  const require = createRequire(realpathSync(resolve(root, "node_modules/vite/package.json")));
  const { buildSync } = require("esbuild");
  buildSync({ entryPoints: [resolve(root, "src/WorldViewBasemap.tsx")], outfile: join(out, "basemap-panel.js"), bundle: true, format: "esm", platform: "node", jsx: "automatic", external: ["react", "react-dom"], loader: { ".css": "empty" } });
  buildSync({ entryPoints: [resolve(root, "src/WorldGlobe.tsx")], outfile: join(out, "globe.js"), bundle: true, format: "esm", platform: "node", jsx: "automatic", external: ["react", "react-dom"] });
  const old = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("unexpected network"); };
  try {
    const { default: Panel } = await import(pathToFileURL(join(out, "basemap-panel.js")));
    const html = renderToStaticMarkup(createElement(Panel, { bounds: [], center: { lat: 38, lon: -77 }, zoom: 1, onBasemap: () => {} }));
    assert.match(html, /Schematic globe only \(offline default\)/);
    assert.match(html, /No imagery, basemap or terrain requests have been made/);
    assert.doesNotMatch(html, /type="checkbox"[^>]*checked/);
    assert.match(html, /<button disabled="">Read terrain elevation/);
    assert.doesNotMatch(html, /<img|<iframe/);
    const { WorldGlobe } = await import(pathToFileURL(join(out, "globe.js")));
    const common = { records: [], center: { lat: 38, lon: -77 }, selectedId: null, onSelect: () => {}, onCenter: () => {}, style: "Standard", detection: false, tilt: false, zoom: 1 };
    assert.doesNotMatch(renderToStaticMarkup(createElement(WorldGlobe, common)), /globe-basemap-credit/);
    const globe = renderToStaticMarkup(createElement(WorldGlobe, { ...common, basemap: { sourceId: "x", tiles: [], reliefExaggeration: 0, credits: [{ provider: "gibs", text: "NASA EOSDIS GIBS / Worldview", termsUrl: "https://www.earthdata.nasa.gov/" }, { provider: "osm", text: "© OpenStreetMap contributors", termsUrl: "https://www.openstreetmap.org/copyright" }] } }));
  assert.match(globe, /globe-basemap-credit/);
  assert.match(globe, /NASA EOSDIS GIBS \/ Worldview/);
  assert.match(globe, /© OpenStreetMap contributors/);
  const googleGlobe = renderToStaticMarkup(createElement(WorldGlobe, { ...common, basemap: { sourceId: "google", tiles: [], reliefExaggeration: 0, credits: [{ provider: "google-2d-satellite", text: "Google Maps · Imagery © Example", termsUrl: "https://cloud.google.com/maps-platform/terms" }] } }));
  assert.match(googleGlobe, /google-maps-logo-with-dark-outline\.svg/);
  assert.match(googleGlobe, /alt="Google Maps"/);
  assert.equal(calls, 0);
  } finally { globalThis.fetch = old; }
});

test("globe tile patches: mercator-correct placement, relief displacement, bounded meshes and disposal", async () => {
  const require = createRequire(realpathSync(resolve(root, "node_modules/vite/package.json")));
  const { buildSync } = require("esbuild");
  buildSync({ entryPoints: [resolve(root, "src/worldview-basemap-globe.tsx")], outfile: join(out, "basemap-globe.js"), bundle: true, format: "esm", platform: "node", jsx: "automatic", external: ["react", "react-dom"] });
  const g = await import(pathToFileURL(join(out, "basemap-globe.js")));
  const THREE = await import(pathToFileURL(join(out, "node_modules/three/build/three.module.js")));
  const tile = { key: "1/0/0", tile: { z: 1, x: 0, y: 0 } };
  const geom = g.tilePatchGeometry(tile, 0);
  const pos = geom.getAttribute("position");
  const normals = geom.getAttribute("normal");
  const mid = Math.floor(pos.count / 2);
  assert.ok(normals.getX(mid) * pos.getX(mid) + normals.getY(mid) * pos.getY(mid) + normals.getZ(mid) * pos.getZ(mid) > 0.9, "front faces point outward");
  const latLon = (i) => { const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), r = Math.hypot(x, y, z); return [Math.asin(y / r) * 180 / Math.PI, Math.atan2(x, z) * 180 / Math.PI, r]; };
  const [lat0, lon0, r0] = latLon(0);
  assert.ok(Math.abs(lat0 - 85.0511) < 1e-3 && Math.abs(Math.abs(lon0) - 180) < 1e-4 && Math.abs(r0 - 1.0025) < 1e-6);
  const [latEnd, lonEnd] = latLon(pos.count - 1);
  assert.ok(Math.abs(latEnd) < 1e-4 && Math.abs(lonEnd) < 1e-4);
  const heights = { width: 2, height: 2, heights: new Float32Array([6371, 6371, 6371, 6371]) };
  const raised = g.tilePatchGeometry({ ...tile, heights }, 10).getAttribute("position");
  assert.ok(Math.abs(Math.hypot(raised.getX(0), raised.getY(0), raised.getZ(0)) - (1.0025 + 0.01)) < 1e-6);
  const parent = new THREE.Group();
  const layer = g.createBasemapGlobeLayer(parent);
  const tiles = Array.from({ length: 80 }, (_, i) => ({ key: `4/${i % 16}/${Math.floor(i / 16)}`, tile: { z: 4, x: i % 16, y: Math.floor(i / 16) }, image: { width: 256, height: 256 } }));
  layer.sync({ sourceId: "a", tiles, reliefExaggeration: 0, credits: [] });
  assert.equal(layer.size, g.MAX_GLOBE_TILE_MESHES);
  layer.sync({ sourceId: "a", tiles: tiles.slice(0, 3), reliefExaggeration: 0, credits: [] });
  assert.equal(layer.size, 3);
  layer.sync({ sourceId: "b", tiles: [{ ...tiles[0], image: undefined, shade: new Uint8ClampedArray(256 * 256 * 4) }], reliefExaggeration: 0, credits: [] });
  assert.equal(layer.size, 1);
  layer.sync(null);
  assert.equal(layer.size, 0);
  layer.dispose();
  assert.equal(parent.children.length, 0);
});

test("height-only terrain tiles render a bounded neutral mesh", async () => {
  const require = createRequire(realpathSync(resolve(root, "node_modules/vite/package.json")));
  const { buildSync } = require("esbuild");
  buildSync({ entryPoints: [resolve(root, "src/worldview-basemap-globe.tsx")], outfile: join(out, "height-only-globe.js"), bundle: true, format: "esm", platform: "node", jsx: "automatic", external: ["react", "react-dom"] });
  const g = await import(pathToFileURL(join(out, "height-only-globe.js")));
  const THREE = await import(pathToFileURL(join(out, "node_modules/three/build/three.module.js")));
  const parent = new THREE.Group();
  const layer = g.createBasemapGlobeLayer(parent);
  layer.sync({ sourceId: "terrain", reliefExaggeration: 20, credits: [], tiles: [{ key: "2/1/1", tile: { z: 2, x: 1, y: 1 }, heights: { width: 2, height: 2, heights: new Float32Array([0, 500, 1000, 1500]) } }] });
  assert.equal(layer.size, 1);
  assert.equal(parent.children[0].children[0].children.length, 1, "height-only tile has a visible neutral mesh");
  const mesh = parent.children[0].children[0].children[0];
  assert.ok(mesh.geometry.getAttribute("position").count > 0);
  assert.equal(mesh.material.color.getHex(), 0x5c7f7a);
  layer.dispose();
});
