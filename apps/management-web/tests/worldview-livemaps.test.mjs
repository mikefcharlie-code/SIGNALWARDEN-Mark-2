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
const fixtures = resolve(root, "tests/fixtures/livemaps");
const out = mkdtempSync(join(tmpdir(), "worldview-livemaps-"));
writeFileSync(join(out, "package.json"), '{"type":"module"}\n');
symlinkSync(resolve(root, "node_modules"), join(out, "node_modules"), "dir");
const compile = spawnSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), resolve(root, "src/worldview-livemaps.ts"), resolve(root, "src/worldview-basemap.ts"), "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--skipLibCheck", "--lib", "ES2022,DOM,DOM.Iterable", "--outDir", out], { encoding: "utf8", cwd: out });
if (compile.status !== 0) throw new Error(`Unable to compile worldview-livemaps.ts:\n${compile.stdout}\n${compile.stderr}`);
const target = join(out, "worldview-livemaps.js");
writeFileSync(target, readFileSync(target, "utf8").replace(/(['"])\.\/worldview-basemap\1/g, '"./worldview-basemap.js"'));

const realFetch = globalThis.fetch;
let importCalls = 0;
globalThis.fetch = async () => { importCalls++; throw new Error("unexpected network"); };
const L = await import(`${pathToFileURL(target).href}?${Date.now()}`);
const B = await import(pathToFileURL(join(out, "worldview-basemap.js")).href);
globalThis.fetch = realFetch;
test.after(() => rmSync(out, { recursive: true, force: true }));

const NOW = Date.UTC(2026, 9, 31, 21, 10, 0);
const RV = JSON.parse(readFileSync(join(fixtures, "rainviewer-weather-maps.json"), "utf8"));
const IEM = JSON.parse(readFileSync(join(fixtures, "iem-radar-list.json"), "utf8"));
const GIBS_XML = readFileSync(join(fixtures, "gibs-describe-domains.xml"), "utf8");
const textResponse = (text, status = 200, headers = {}) => {
  const bytes = new TextEncoder().encode(text);
  return new Response(bytes, { status, headers: { "content-length": String(bytes.byteLength), ...headers } });
};
const png = () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const mockFetch = (handler) => { const calls = []; const f = async (url, init) => { calls.push({ url, init }); return handler(url, init); }; f.calls = calls; return f; };

test("importing the module makes no network request", () => assert.equal(importCalls, 0));

test("RainViewer weather-maps.json: frames, host and generation time parsed from the real v2 shape", () => {
  const parsed = L.parseRainViewer(RV, NOW);
  assert.equal(parsed.frames.length, 13);
  assert.equal(parsed.host, "https://tilecache.rainviewer.com");
  assert.equal(parsed.frames.at(-1).timeMs, Date.UTC(2026, 9, 31, 21, 0));
  assert.equal(parsed.frames[0].timeMs, Date.UTC(2026, 9, 31, 19, 0));
  assert.ok(parsed.frames.every((f) => f.kind === "observed" && f.locator.startsWith("/v2/radar/")));
  assert.equal(Date.parse(parsed.providerTime), (RV.generated) * 1000);
  // A labelled nowcast frame is kept if the provider ever sends one again.
  const withNowcast = L.parseRainViewer({ ...RV, radar: { past: RV.radar.past, nowcast: [{ time: RV.radar.past.at(-1).time + 600, path: "/v2/radar/nc1" }] } }, NOW);
  assert.equal(withNowcast.frames.at(-1).kind, "nowcast");
  assert.throws(() => L.parseRainViewer({ ...RV, host: "https://evil.example" }, NOW), /tile host/);
  const bad = L.parseRainViewer({ ...RV, radar: { past: [{ time: 1, path: "/v2/radar/x" }, { time: RV.radar.past[0].time, path: "/../../etc" }, { time: RV.radar.past[0].time, path: "/v2/radar/ok" }] } }, NOW);
  assert.deepEqual(bad.frames.map((f) => f.id), ["ok"]);
});

test("IEM scan list parses YYYY-MM-DDTHH:MMZ stamps; pickFrames keeps newest and spans ~2 h", () => {
  const frames = L.parseIemScans(IEM, NOW);
  assert.equal(frames.length, 27);
  assert.equal(frames.at(-1).locator, "202610312110");
  const picked = L.pickFrames(frames);
  assert.equal(picked.length, L.MAX_FRAMES);
  assert.equal(picked.at(-1).locator, "202610312110", "always keeps the newest frame");
  assert.ok(picked.at(-1).timeMs - picked[0].timeMs >= 105 * 60_000, "evenly spaced across the 2 h window");
  assert.ok(picked.every((f, i) => i === 0 || f.timeMs > picked[i - 1].timeMs));
  assert.throws(() => L.parseIemScans({}, NOW), /scan list/);
  assert.deepEqual(L.parseIemScans({ scans: [{ ts: "garbage" }, { ts: "2099-01-01T00:00Z" }] }, NOW), []);
  assert.deepEqual(L.parseIemScans({ scans: [{ ts: "2026-10-32T21:10Z" }, { ts: "2026-02-29T21:10Z" }, { ts: "2026-10-31T24:00Z" }, { ts: "2026-10-31T21:60Z" }] }, NOW), [], "impossible UTC calendar values must not normalize into valid frames");
});

test("GIBS DescribeDomains intervals expand to 10-minute frames, honouring gaps and the window", () => {
  const frames = L.parseGibsDomains(GIBS_XML, Date.UTC(2026, 9, 31, 18, 30), Date.UTC(2026, 9, 31, 21, 15));
  const hhmm = frames.map((f) => new Date(f.timeMs).toISOString().slice(11, 16));
  assert.deepEqual(hhmm, ["18:30", "18:40", "18:50", "19:00", "19:10", "19:30", "19:50", "20:00", "20:10", "20:20", "20:30"]);
  assert.match(frames[0].locator, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
  assert.throws(() => L.parseGibsDomains("<ExceptionReport><Exception/></ExceptionReport>", 0, NOW), /exception/);
  assert.throws(() => L.parseGibsDomains("<Domains/>", 0, NOW), /no time domain/);
});

test("frame-list fetches are opt-in, allowlisted, credential-free and bounded", async () => {
  await assert.rejects(L.fetchFrameList("rainviewer-radar", { network: false, now: NOW }), /opt-in/);
  await assert.rejects(L.fetchLiveText("https://example.com/weather-maps.json", { network: true, fetcher: async () => textResponse("{}") }), /allowlist/);
  await assert.rejects(L.fetchLiveText(`${L.IEM_ORIGIN}/json/other.py`, { network: true, fetcher: async () => textResponse("{}") }), /allowlist/);

  const rv = mockFetch(() => textResponse(JSON.stringify(RV)));
  const rvList = await L.fetchFrameList("rainviewer-radar", { network: true, fetcher: rv, now: NOW });
  assert.equal(rv.calls.length, 1);
  assert.equal(rv.calls[0].url, "https://api.rainviewer.com/public/weather-maps.json");
  assert.equal(rv.calls[0].init.credentials, "omit");
  assert.equal(rv.calls[0].init.redirect, "error");
  assert.equal(rv.calls[0].init.referrerPolicy, "no-referrer");
  assert.equal(rvList.frames.length, L.MAX_FRAMES, "13 provider frames trimmed to 12, newest kept");
  assert.equal(rvList.frames.at(-1).timeMs, Date.UTC(2026, 9, 31, 21, 0));
  assert.equal(Date.parse(rvList.retrievedAt), NOW);

  const iem = mockFetch(() => textResponse(JSON.stringify(IEM)));
  const iemList = await L.fetchFrameList("iem-nexrad-n0q", { network: true, fetcher: iem, now: NOW });
  const iemUrl = new URL(iem.calls[0].url);
  assert.equal(iemUrl.origin + iemUrl.pathname, "https://mesonet.agron.iastate.edu/json/radar.py");
  assert.equal(iemUrl.searchParams.get("product"), "N0Q");
  assert.equal(iemUrl.searchParams.get("radar"), "USCOMP");
  assert.match(iemUrl.searchParams.get("start"), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/);
  assert.equal(iemList.frames.at(-1).locator, "202610312110");
  assert.ok(iemList.providerTime);

  const gibs = mockFetch(() => textResponse(GIBS_XML, 200, { "content-type": "text/xml" }));
  const gibsList = await L.fetchFrameList("gibs-goes-east-ir", { network: true, fetcher: gibs, now: NOW });
  const gUrl = new URL(gibs.calls[0].url);
  assert.equal(gUrl.searchParams.get("REQUEST"), "DescribeDomains");
  assert.equal(gUrl.searchParams.get("LAYER"), "GOES-East_ABI_Band13_Clean_Infrared");
  assert.equal(gUrl.searchParams.get("TILEMATRIXSET"), "GoogleMapsCompatible_Level6");
  assert.ok(gibsList.frames.length > 0 && gibsList.frames.length <= L.MAX_FRAMES);
  assert.equal(gibsList.frames.at(-1).timeMs, Date.UTC(2026, 9, 31, 20, 30));

  await assert.rejects(L.fetchFrameList("rainviewer-radar", { network: true, fetcher: async () => textResponse("x".repeat(300_000)), now: NOW }), /256 KiB/);
  await assert.rejects(L.fetchFrameList("rainviewer-radar", { network: true, fetcher: async () => textResponse("nope", 503), now: NOW }), /HTTP 503/);
  await assert.rejects(L.fetchFrameList("rainviewer-radar", { network: true, fetcher: async () => textResponse("<html>"), now: NOW }), /not valid JSON/);
  await assert.rejects(L.fetchFrameList("iem-nexrad-n0q", { network: true, fetcher: async () => textResponse(JSON.stringify({ scans: [{ ts: "malformed" }, { ts: "2026-10-32T21:10Z" }] })), now: NOW }), /Invalid frame-list payload: no valid frames/);
});

test("tile URLs follow each provider's documented template and zoom limits", () => {
  const rv = L.parseRainViewer(RV, NOW).frames.at(-1);
  assert.equal(L.liveTileUrl("rainviewer-radar", rv, { z: 3, x: 2, y: 3 }), `https://tilecache.rainviewer.com${rv.locator}/256/3/2/3/2/1_1.png`);
  assert.throws(() => L.liveTileUrl("rainviewer-radar", rv, { z: 8, x: 0, y: 0 }), /out of range/, "RainViewer max zoom is 7");
  const iem = L.parseIemScans(IEM, NOW).at(-1);
  assert.equal(L.liveTileUrl("iem-nexrad-n0q", iem, { z: 4, x: 3, y: 6 }), "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/ridge::USCOMP-N0Q-202610312110/4/3/6.png");
  const g = L.parseGibsDomains(GIBS_XML, 0, NOW).at(-1);
  assert.equal(L.liveTileUrl("gibs-himawari-ir", g, { z: 3, x: 7, y: 2 }), `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/Himawari_AHI_Band13_Clean_Infrared/default/${g.locator}/GoogleMapsCompatible_Level6/3/2/7.png`);
  assert.throws(() => L.liveTileUrl("gibs-goes-east-ir", g, { z: 7, x: 0, y: 0 }), /out of range/, "Level6 matrix set");
  assert.throws(() => L.liveTileUrl("iem-nexrad-n0q", { ...iem, locator: "../x" }, { z: 1, x: 0, y: 0 }), /stamp/);
});

test("frames load through the shared TileLoader: allowlisted hosts, no credentials, per-provider throttle", async () => {
  const fetcher = mockFetch(() => new Response(png(), { headers: { "content-type": "image/png" } }));
  const loader = new B.TileLoader({ network: true, fetcher, decode: async (blob) => blob.size, now: () => NOW });
  const frame = L.parseRainViewer(RV, NOW).frames.at(-1);
  const tiles = B.tilesForBounds([{ west: -180, east: 180, south: -85, north: 85 }], 3, { lat: 0, lon: 0 }, L.MAX_TILES_PER_FRAME);
  assert.equal(tiles.length, L.MAX_TILES_PER_FRAME);
  const res = await loader.load(L.liveFrameSource("rainviewer-radar", frame), tiles);
  assert.equal(res.loaded.length, 16);
  assert.ok(fetcher.calls.every((c) => c.url.startsWith("https://tilecache.rainviewer.com/v2/radar/") && c.init.credentials === "omit" && c.init.redirect === "error"));
  assert.equal(res.loaded[0].live, true);
  assert.equal(res.loaded[0].attribution, L.LIVE_LAYERS["rainviewer-radar"].attribution);
  // RainViewer allows 100 requests/IP/min; the adapter stays at 60/min.
  const frames = L.parseRainViewer(RV, NOW).frames;
  let throttled = 0;
  for (const f of frames.slice(0, 4)) throttled += (await loader.load(L.liveFrameSource("rainviewer-radar", f), tiles)).throttled;
  assert.ok(fetcher.calls.length <= 60, `fetched ${fetcher.calls.length}`);
  assert.ok(throttled > 0);
  // Cached frame tiles are reused without a second request.
  const before = fetcher.calls.length;
  const again = await loader.load(L.liveFrameSource("rainviewer-radar", frame), tiles);
  assert.equal(again.fromCache, 16);
  assert.equal(fetcher.calls.length, before);

  const g = L.parseGibsDomains(GIBS_XML, 0, NOW).at(-1);
  const gf = mockFetch(() => new Response(png(), { headers: { "content-type": "image/png" } }));
  const gl = new B.TileLoader({ network: true, fetcher: gf, decode: async () => 1, now: () => NOW });
  assert.equal((await gl.load(L.liveFrameSource("gibs-goes-west-geocolor", g), tiles.slice(0, 2))).loaded.length, 2);
  const iem = L.parseIemScans(IEM, NOW).at(-1);
  assert.equal((await gl.load(L.liveFrameSource("iem-nexrad-n0q", iem), tiles.slice(0, 2))).loaded.length, 2);
  const off = new B.TileLoader({ network: false, decode: async () => 1 });
  assert.equal((await off.load(L.liveFrameSource("iem-nexrad-n0q", iem), tiles.slice(0, 2))).failed.length, 2);
});

test("freshness badges and auto-refresh cadence never run faster than the provider", () => {
  const rv = L.LIVE_LAYERS["rainviewer-radar"], iem = L.LIVE_LAYERS["iem-nexrad-n0q"], goes = L.LIVE_LAYERS["gibs-goes-east-ir"];
  assert.equal(L.layerFreshness(rv, NOW - 10 * 60_000, NOW).status, "live");
  assert.equal(L.layerFreshness(rv, NOW - 40 * 60_000, NOW).status, "delayed");
  assert.equal(L.layerFreshness(rv, NOW - 3 * 3_600_000, NOW).status, "stale");
  assert.equal(L.layerFreshness(goes, NOW - 50 * 60_000, NOW).status, "live", "GIBS NRT latency is ~20-60 min");
  assert.equal(L.layerFreshness(iem, null, NOW).status, "unknown");
  assert.equal(L.layerFreshness(iem, NOW + 3_600_000, NOW).status, "unknown");
  assert.equal(L.clampRefreshMs(iem, 1_000), 5 * 60_000);
  assert.equal(L.clampRefreshMs(rv, 1_000), 10 * 60_000);
  assert.equal(L.clampRefreshMs(goes, Number.NaN), 10 * 60_000);
  assert.ok(Object.values(L.LIVE_LAYERS).every((l) => L.refreshChoices(l).every((ms) => ms >= l.cadenceMs)));
});

test("loop controller: merged timeline, nearest-earlier frame, wraparound stepping, reduced motion", () => {
  const a = [{ id: "a1", timeMs: 100 }, { id: "a2", timeMs: 200 }];
  const b = [{ id: "b1", timeMs: 150 }, { id: "b2", timeMs: 200 }];
  assert.deepEqual(L.mergeTimeline([a, b]), [100, 150, 200]);
  assert.equal(L.frameAt(a, 150).id, "a1");
  assert.equal(L.frameAt(b, 120).id, "b1", "falls back to earliest when nothing is earlier");
  assert.equal(L.frameAt([], 1), null);
  assert.equal(L.stepIndex(2, 3, 1), 0);
  assert.equal(L.stepIndex(0, 3, -1), 2);
  assert.equal(L.playDelayMs(0, 5, false), L.PLAY_INTERVAL_MS);
  assert.equal(L.playDelayMs(4, 5, false), L.LAST_FRAME_DWELL_MS);
  assert.ok(L.playDelayMs(0, 5, true) > L.PLAY_INTERVAL_MS);
  assert.deepEqual(L.loadOrder(a).map((f) => f.id), ["a2", "a1"]);
  assert.equal(L.formatUtc(Date.UTC(2026, 9, 31, 21, 5)), `${new Date(Date.UTC(2026, 9, 31, 21, 5)).toISOString().slice(0, 16).replace("T", " ")} UTC`);
  assert.match(L.formatLocal(Date.UTC(2026, 9, 31, 21, 5), "en-US", "America/New_York"), /5:05/);
  assert.equal(L.prefersReducedMotion(), false);
});

test("live data strip summarizes existing provider state, skipping synthetic/imported rows and duplicates", () => {
  const iso = (ms) => new Date(ms).toISOString();
  const rows = L.summarizeLiveFeeds({
    providerResults: {
      "usgs-earthquakes": { providerId: "usgs-earthquakes", retrievedAt: iso(NOW - 2 * 60_000), freshness: "fresh", observations: [{ id: "eq1" }] },
      "nasa-firms": { providerId: "nasa-firms", retrievedAt: iso(NOW - 60_000), freshness: "failed", error: "HTTP 503", observations: [] },
    },
    records: [
      { id: "eq1", source: "USGS", observedAt: iso(NOW), properties: { provider: "USGS", retrievedAt: iso(NOW) } },
      { id: "w1", source: "Open-Meteo", observedAt: iso(NOW), properties: { provider: "Open-Meteo GFS", retrievedAt: iso(NOW - 20 * 60_000) } },
      { id: "w2", source: "Open-Meteo", observedAt: iso(NOW), properties: { provider: "Open-Meteo GFS", retrievedAt: iso(NOW - 3 * 60_000) } },
      { id: "s1", source: "SignalWarden synthetic demo", observedAt: iso(NOW), freshness: "synthetic" },
      { id: "p1", source: "imported pack", observedAt: iso(NOW) },
    ],
    imagery: { s1: { key: "s1", provider: "ASF Sentinel-1", retrievedAt: iso(NOW), acquisitionStart: iso(NOW - 26 * 3_600_000), freshness: "stale" } },
    basemap: { sourceId: "x", credits: [{ provider: "gibs-viirs-truecolor", text: "NASA" }] },
    liveChannels: [{ layerId: "iem-nexrad-n0q", latestFrameMs: NOW - 6 * 60_000, framesReady: 3, framesTotal: 12 }],
  }, NOW);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId["provider:usgs-earthquakes"].status, "live");
  assert.equal(byId["provider:nasa-firms"].status, "failed");
  assert.equal(byId["records:Open-Meteo GFS"].status, "live");
  assert.equal(byId["records:Open-Meteo GFS"].ageMs, 3 * 60_000, "age of the newest retrieval");
  assert.equal(byId["records:USGS"], undefined, "records already covered by a provider result are not double counted");
  assert.ok(!rows.some((r) => /synthetic|imported/i.test(r.label)));
  assert.equal(byId["imagery:s1"].status, "stale");
  assert.equal(byId["basemap"].kind, "basemap");
  assert.equal(byId["live:iem-nexrad-n0q"].status, "live");
  assert.match(byId["live:iem-nexrad-n0q"].detail, /3\/12 frames/);
  assert.deepEqual(L.summarizeLiveFeeds({}, NOW), []);
});

test("attribution, terms and honest limits are present for every live layer", () => {
  for (const l of Object.values(L.LIVE_LAYERS)) {
    assert.ok(l.attribution && l.termsUrl.startsWith("https://") && l.licenseNote && l.coverageNote && l.timeNote, l.id);
    assert.ok(l.cadenceMs >= 5 * 60_000 && l.perMinute <= 240 && l.concurrency <= 4, l.id);
  }
  assert.match(L.LIVE_LAYERS["rainviewer-radar"].attribution, /RainViewer/);
  assert.match(L.LIVE_LAYERS["rainviewer-radar"].licenseNote, /personal\/educational/);
  assert.equal(L.LIVE_LAYERS["rainviewer-radar"].requiresUseAcknowledgement, true);
  assert.ok(L.LIVE_LAYERS["rainviewer-radar"].perMinute < 100, "below RainViewer's 100 req/IP/min");
  assert.ok(!Object.keys(L.LIVE_LAYERS).some((k) => /meteosat/i.test(k)), "no Meteosat layer exists in GIBS");
});

test("panel renders opt-in controls with no request; globe shows live credit only with an overlay", async () => {
  const require = createRequire(realpathSync(resolve(root, "node_modules/vite/package.json")));
  const { buildSync } = require("esbuild");
  buildSync({ entryPoints: [resolve(root, "src/WorldViewLiveMaps.tsx")], outfile: join(out, "livemaps-panel.js"), bundle: true, format: "esm", platform: "node", jsx: "automatic", external: ["react", "react-dom"], loader: { ".css": "empty" } });
  buildSync({ entryPoints: [resolve(root, "src/WorldGlobe.tsx")], outfile: join(out, "globe.js"), bundle: true, format: "esm", platform: "node", jsx: "automatic", external: ["react", "react-dom"], loader: { ".css": "empty" } });
  const old = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("unexpected network"); };
  try {
    const { default: Panel } = await import(pathToFileURL(join(out, "livemaps-panel.js")));
    const html = renderToStaticMarkup(createElement(Panel, { bounds: [], center: { lat: 38, lon: -77 }, zoom: 1, onOverlay: () => {} }));
    assert.match(html, /LIVE DATA/);
    assert.match(html, /No live layers or feeds active/);
    assert.match(html, /Live map requests are off\. Nothing has been requested\./);
    assert.doesNotMatch(html, /type="checkbox"[^>]*checked/);
    assert.match(html, /aria-label="Frame time"/);
    assert.doesNotMatch(html, /<img|<iframe/);
    const withFeeds = renderToStaticMarkup(createElement(Panel, { bounds: [], center: { lat: 0, lon: 0 }, zoom: 1, onOverlay: () => {}, feeds: { providerResults: { x: { providerId: "usgs-earthquakes", retrievedAt: new Date().toISOString(), freshness: "fresh", observations: [] } } } }));
    assert.match(withFeeds, /usgs-earthquakes · LIVE/);
    const { WorldGlobe } = await import(pathToFileURL(join(out, "globe.js")));
    const common = { records: [], center: { lat: 38, lon: -77 }, selectedId: null, onSelect: () => {}, onCenter: () => {}, style: "Standard", detection: false, tilt: false, zoom: 1 };
    assert.doesNotMatch(renderToStaticMarkup(createElement(WorldGlobe, common)), /globe-live-credit/);
    const overlay = { channels: [{ channel: "radar", layerId: "rainviewer-radar", frameKey: "k", frameTime: new Date(NOW).toISOString(), tiles: [], opacity: 0.7, credit: { text: "Weather data by RainViewer (rainviewer.com)", termsUrl: "https://www.rainviewer.com/api.html" }, freshness: "live" }] };
    const globe = renderToStaticMarkup(createElement(WorldGlobe, { ...common, liveOverlay: overlay }));
    assert.match(globe, /globe-live-credit/);
    assert.match(globe, /Weather data by RainViewer/);
    assert.match(globe, /RADAR · FEED LIVE/);
    assert.match(globe, /displayed frame 2026-10-31 21:10 UTC/);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = old; }
});

test("globe overlay: bounded meshes, frame swap reuses meshes, layer change and dispose release GPU objects", async () => {
  const require = createRequire(realpathSync(resolve(root, "node_modules/vite/package.json")));
  const { buildSync } = require("esbuild");
  buildSync({ entryPoints: [resolve(root, "src/worldview-livemaps-globe.tsx")], outfile: join(out, "livemaps-globe.js"), bundle: true, format: "esm", platform: "node", jsx: "automatic", external: ["react", "react-dom"] });
  const g = await import(pathToFileURL(join(out, "livemaps-globe.js")));
  const THREE = await import(pathToFileURL(join(out, "node_modules/three/build/three.module.js")));
  const parent = new THREE.Group();
  const layer = g.createLiveOverlayGlobeLayer(parent);
  const tiles = Array.from({ length: 40 }, (_, i) => ({ key: `4/${i % 16}/${Math.floor(i / 16)}`, tile: { z: 4, x: i % 16, y: Math.floor(i / 16) }, image: { width: 256, height: 256 } }));
  const ch = (frameKey, extra = {}) => ({ channel: "radar", layerId: "rainviewer-radar", frameKey, frameTime: "", tiles, opacity: 0.7, credit: { text: "", termsUrl: "" }, freshness: "live", ...extra });
  layer.sync({ channels: [ch("f1")] });
  assert.equal(layer.meshCount, g.MAX_LIVE_TILE_MESHES);
  layer.sync({ channels: [ch("f2")] });
  assert.equal(layer.meshCount, g.MAX_LIVE_TILE_MESHES, "frame swap reuses tile meshes");
  assert.equal(layer.textureCount, 2 * g.MAX_LIVE_TILE_MESHES);
  layer.sync({ channels: [ch("f1")] });
  assert.equal(layer.textureCount, 2 * g.MAX_LIVE_TILE_MESHES, "returning to a loaded frame does not re-create textures");
  layer.sync({ channels: [ch("s1", { channel: "satellite", layerId: "gibs-goes-east-ir", tiles: tiles.slice(0, 4) }), ch("f1")] });
  assert.equal(layer.meshCount, g.MAX_LIVE_TILE_MESHES + 4);
  const r = parent.getObjectByName("live-map-overlays");
  const radarMesh = r.getObjectByName("live-radar").children[0];
  const p = radarMesh.geometry.getAttribute("position");
  assert.ok(Math.abs(Math.hypot(p.getX(0), p.getY(0), p.getZ(0)) - g.LIVE_OVERLAY_RADIUS.radar) < 1e-6);
  assert.ok(g.LIVE_OVERLAY_RADIUS.radar > g.LIVE_OVERLAY_RADIUS.satellite && g.LIVE_OVERLAY_RADIUS.satellite > 1.0025);
  layer.sync({ channels: [ch("i1", { layerId: "iem-nexrad-n0q", tiles: tiles.slice(0, 2) })] });
  assert.equal(layer.meshCount, 2, "layer change and removed channel are cleared");
  layer.sync(null);
  assert.equal(layer.meshCount, 0);
  layer.dispose();
  assert.equal(parent.children.length, 0);
});

test("sources carry no keys, env reads, or flight-control surface; WorldView mount is a minimal edit", () => {
  for (const file of ["src/worldview-livemaps.ts", "src/WorldViewLiveMaps.tsx", "src/worldview-livemaps-globe.tsx"]) {
    const text = readFileSync(resolve(root, file), "utf8");
    assert.doesNotMatch(text, /[?&](key|token|access_token|apikey)=/i, file);
    assert.doesNotMatch(text, /process\.env|import\.meta\.env|localStorage/, file);
    assert.doesNotMatch(text, /mavlink|\barm\(|takeoff|setMode\(|flightMode|method: "POST"/i, file);
  }
  const view = readFileSync(resolve(root, "src/WorldView.tsx"), "utf8");
  assert.match(view, /liveMapsOpen && <Suspense/);
  assert.match(view, /<WorldViewLiveMaps active=\{globeActive\} bounds=\{viewportBounds\} center=\{center\} zoom=\{zoom\} onOverlay=\{setLiveOverlay\} feeds=\{liveFeedInput\} \/>/);
  assert.match(view, /liveOverlay=\{liveOverlay\}/);
  const globe = readFileSync(resolve(root, "src/WorldGlobe.tsx"), "utf8");
  assert.match(globe, /liveOverlayLayer\.sync\(p\.liveOverlay\)/);
  assert.match(globe, /liveOverlayLayer\.dispose\(\)/);
});
