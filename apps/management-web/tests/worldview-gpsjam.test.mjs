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
const fixtures = resolve(root, "tests/fixtures/gpsjam");
const out = mkdtempSync(join(tmpdir(), "worldview-gpsjam-"));
writeFileSync(join(out, "package.json"), '{"type":"module"}\n');
symlinkSync(resolve(root, "node_modules"), join(out, "node_modules"), "dir");
const require = createRequire(realpathSync(resolve(root, "node_modules/vite/package.json")));
const { buildSync } = require("esbuild");
const build = (entry, file, extra = {}) => buildSync({ entryPoints: [resolve(root, entry)], outfile: join(out, file), bundle: true, format: "esm", platform: "node", jsx: "automatic", external: ["react", "react-dom"], loader: { ".css": "empty" }, logLevel: "silent", ...extra });
const compile = spawnSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), resolve(root, "src/worldview-gpsjam.ts"), "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--skipLibCheck", "--lib", "ES2022,DOM,DOM.Iterable", "--outDir", out], { encoding: "utf8", cwd: out });
if (compile.status !== 0) throw new Error(`Unable to compile worldview-gpsjam.ts:\n${compile.stdout}\n${compile.stderr}`);

const realFetch = globalThis.fetch;
let importCalls = 0;
globalThis.fetch = async () => { importCalls++; throw new Error("unexpected network"); };
const G = await import(`${pathToFileURL(join(out, "worldview-gpsjam.js")).href}?${Date.now()}`);
globalThis.fetch = realFetch;
test.after(() => rmSync(out, { recursive: true, force: true }));

const MANIFEST = JSON.parse(readFileSync(join(fixtures, "relay-manifest.json"), "utf8"));
const DAY = JSON.parse(readFileSync(join(fixtures, "relay-day-2026-10-30.json"), "utf8"));
const NOW = Date.parse("2026-11-01T00:30:00Z");
const json = (body, status = 200) => { const t = JSON.stringify(body); return new Response(t, { status, headers: { "content-type": "application/json", "content-length": String(new TextEncoder().encode(t).byteLength) } }); };
const mockFetch = (handler) => { const calls = []; const f = async (url, init) => { calls.push({ url, init }); return handler(url, init); }; f.calls = calls; return f; };
const relay = () => mockFetch((url) => url.endsWith("/manifest") ? json(MANIFEST) : url.includes("/day?date=2026-10-30") ? json(DAY) : json({ error: { code: "date_not_in_manifest", message: "GPSJAM has no data for that date" } }, 404));
const WORLD = [];
const BALTIC = [{ west: 10, south: 50, east: 30, north: 62 }];

test("importing makes no request; thresholds follow GPSJAM's formula", () => {
  assert.equal(importCalls, 0);
  assert.equal(G.percentBad(40, 30).toFixed(2), (100 * 29 / 70).toFixed(2));
  assert.equal(G.percentBad(300, 0), 0, "negative (bad − 1) clamps to 0");
  assert.equal(G.classify(300, 0), "good");
  assert.equal(G.classify(200, 3), "good", "2/203 < 2 %");
  assert.equal(G.classify(10, 2), "medium", "1/12 = 8.3 %");
  assert.equal(G.classify(90, 5), "medium");
  assert.equal(G.classify(50, 9), "bad", "8/59 = 13.6 %");
  assert.equal(G.classify(98, 3), "good", "2/101 = 1.98 %");
  assert.equal(G.classify(97, 3), "medium", "exactly 2 % is medium (strict < 0.02 for low)");
  assert.equal(G.classify(89, 11), "bad", "exactly 10 % is high");
  assert.deepEqual(G.GPSJAM_LEVELS.bad.color, [0xff, 0x33, 0x33]);
});

test("network is opt-in and only allowlisted relay paths are requested", async () => {
  const f = relay();
  await assert.rejects(new G.GpsJamClient({ network: false, fetcher: f }).manifest(), /opt-in/);
  assert.equal(f.calls.length, 0);
  assert.ok(G.allowedGpsJamUrl("/api/v1/worldview-gpsjam/day?date=2026-10-30"));
  for (const bad of ["/api/v1/worldview-gpsjam/day?date=2026-02-30", "/api/v1/worldview-gpsjam/day?date=../x", "https://gpsjam.org/data/manifest.csv", "/api/v1/worldview-gpsjam/day?date=2026-10-30&x=1"])
    assert.equal(G.allowedGpsJamUrl(bad), false, bad);
  await assert.rejects(new G.GpsJamClient({ network: true, fetcher: f }).day("2026-1-1"), /YYYY-MM-DD/);
  assert.equal(f.calls.length, 0);
});

test("manifest parse drops invalid rows; relay header, same-origin, no credentials", async () => {
  const f = relay();
  const c = new G.GpsJamClient({ network: true, fetcher: f, now: () => NOW });
  const m = await c.manifest();
  assert.deepEqual(m.dates.map((d) => d.date), ["2026-10-27", "2026-10-28", "2026-10-30"]);
  assert.equal(m.latest, "2026-10-30");
  assert.equal(m.dates[1].suspect, true);
  const init = f.calls[0].init;
  assert.equal(init.headers["X-SignalWarden-GpsJam"], "enabled");
  assert.equal(init.mode, "same-origin"); assert.equal(init.credentials, "omit"); assert.equal(init.redirect, "error"); assert.equal(init.method, "GET");
  await c.manifest();
  assert.equal(f.calls.length, 1, "manifest cached");
});

test("day parse validates cells, caches per date (LRU) and dedupes in-flight requests", async () => {
  const f = relay();
  const c = new G.GpsJamClient({ network: true, fetcher: f, now: () => NOW });
  const [a, b] = await Promise.all([c.day("2026-10-30"), c.day("2026-10-30")]);
  assert.equal(a, b);
  assert.equal(f.calls.length, 1);
  assert.equal(a.cells.length, 9);
  assert.equal(a.day.skippedRows, 5, "wrong resolution, duplicate, malformed, negative and zero-aircraft rows dropped");
  assert.deepEqual(a.counts, { good: 4, medium: 2, bad: 3 });
  assert.equal(a.day.sourceUrl, "https://gpsjam.org/data/merged/2026-10-30-h3_4.csv");
  assert.match(a.day.attribution, /John Wiseman/); assert.match(a.day.attribution, /ADS-B Exchange/);
  await c.day("2026-10-30");
  assert.equal(f.calls.length, 1, "cached per date");
  assert.throws(() => G.parseDayBody({ ...DAY, date: "2026-10-29" }, "2026-10-30"), /different date/);
  assert.throws(() => G.parseDayBody({ provider: "other", date: "2026-10-30", cells: [] }), /Invalid/);
  assert.equal(G.parseDayBody({ ...DAY, sourceUrl: "https://evil.example/x" }).sourceUrl, "https://gpsjam.org/");
});

test("relay errors are explained without leaking internals", async () => {
  const disabled = mockFetch(() => json({ error: { code: "gpsjam_relay_disabled", message: "WorldView GPSJAM relay is disabled" } }, 404));
  const err = await new G.GpsJamClient({ network: true, fetcher: disabled }).manifest().catch((e) => e);
  assert.match(G.describeError(err), /UCAS_WORLDVIEW_GPSJAM_ENABLED=1/);
  const throttled = mockFetch(() => json({ error: { code: "relay_throttled", message: "x", details: { retryAfterSeconds: 60 } } }, 429));
  const t = await new G.GpsJamClient({ network: true, fetcher: throttled }).manifest().catch((e) => e);
  assert.match(G.describeError(t), /retry in 60s/);
  const huge = mockFetch(() => new Response("x", { headers: { "content-length": String(G.MAX_RESPONSE_BYTES + 1) } }));
  await assert.rejects(new G.GpsJamClient({ network: true, fetcher: huge }).manifest(), /size limit/);
  const missing = relay();
  const c = new G.GpsJamClient({ network: true, fetcher: missing });
  assert.match(G.describeError(await c.day("2026-10-01").catch((e) => e)), /no file for that date/);
});

test("viewport filter, min-aircraft filter and hard cap keep interference cells first", async () => {
  const p = G.prepareDay(G.parseDayBody(DAY));
  const all = G.selectCells(p, WORLD);
  assert.equal(all.inView, 8, "single-aircraft cell hidden by GPSJAM's default (>1 aircraft)");
  assert.deepEqual(all.drawn.slice(0, 3).map((c) => c.level), ["bad", "bad", "bad"]);
  assert.equal(all.drawn[0].hex, "841f725ffffffff", "highest share first");
  const baltic = G.selectCells(p, BALTIC);
  assert.deepEqual(baltic.drawn.map((c) => c.hex).sort(), ["84089b1ffffffff", "841f607ffffffff", "841f725ffffffff"]);
  assert.deepEqual(baltic.inViewCounts, { good: 1, medium: 1, bad: 1 });
  const noLow = G.selectCells(p, WORLD, { showLow: false });
  assert.ok(noLow.drawn.every((c) => c.level !== "good"));
  const capped = G.selectCells(p, WORLD, { cap: 2 });
  assert.equal(capped.drawn.length, 2); assert.equal(capped.truncated, true);
  assert.ok(capped.drawn.every((c) => c.level === "bad"));
  assert.equal(G.selectCells(p, WORLD, { cap: 1e9 }).drawn.length <= G.MAX_DRAWN_CELLS, true);
  assert.equal(G.selectCells(p, WORLD, { minAircraft: 25 }).inView, 5);
  // Antimeridian bounds split into two boxes still find the 179.99°E cell.
  assert.ok(G.selectCells(p, [{ west: 170, south: 40, east: 180, north: 60 }, { west: -180, south: 40, east: -170, north: 60 }]).drawn.some((c) => c.hex === "841659bffffffff"));
});

test("freshness: newest daily day is 'latest' (not live), old newest is stale, other days historical", () => {
  const m = G.parseManifestBody(MANIFEST);
  const f = G.dayFreshness("2026-10-30", m, NOW);
  assert.equal(f.status, "latest"); assert.equal(f.label, "LATEST DAILY");
  assert.equal(f.ageMs, 24.5 * 3_600_000, "day ended at 2026-10-31T00:00Z");
  assert.match(f.detail, /not real time/);
  assert.equal(G.dayFreshness("2026-10-30", m, NOW + 3 * 86_400_000).status, "stale");
  const h = G.dayFreshness("2026-10-28", m, NOW);
  assert.equal(h.status, "historical"); assert.equal(h.incomplete, true);
  assert.equal(G.dayFreshness("2026-10-30", null, NOW).status, "unknown");
  const row = G.liveRowFor("2026-10-30", f, 12);
  assert.equal(row.status, "delayed", "daily aggregate never claims LIVE");
  assert.equal(row.id, "live:gpsjam");
});

test("globe state carries boundaries, provenance and a tooltip picker; tooltip text is honest", () => {
  const p = G.prepareDay(G.parseDayBody(DAY));
  const s = G.buildGlobeState(p, G.selectCells(p, WORLD), G.parseManifestBody(MANIFEST), { opacity: 0.5, now: NOW });
  assert.equal(s.cells.length, 8);
  const pent = s.cells.find((c) => c.hex === "8408001ffffffff");
  assert.equal(pent.boundary.length, 10, "pentagon has 5 vertices");
  assert.equal(s.cells.find((c) => c.hex === "841f725ffffffff").boundary.length, 12);
  const tip = s.pick(54.35, 18.65);
  assert.deepEqual([tip.bad, tip.good, tip.total, tip.level], [30, 40, 70, "bad"]);
  assert.equal(s.pick(0, 0), null);
  assert.equal(s.pick(Number.NaN, 0), null);
  const text = G.tooltipText(tip);
  assert.match(text, /30 reporting low accuracy · 40 good · 70 aircraft total/);
  assert.match(text, /not a jammer detection/);
  assert.match(s.credit.text, /John Wiseman/); assert.equal(s.credit.termsUrl, "https://gpsjam.org/faq/");
  assert.equal(s.liveRow.status, "delayed");
  assert.match(G.GPSJAM_DISCLOSURE, /not a detection or location of jammers, not real time/);
  assert.match(G.GPSJAM_TERMS_NOTE, /unclear/);
});

test("globe layer: bounded merged mesh above other overlays, tooltip pick, opacity reuse, dispose", async () => {
  build("src/worldview-gpsjam-globe.tsx", "gpsjam-globe.js");
  const g = await import(pathToFileURL(join(out, "gpsjam-globe.js")));
  const src = readFileSync(join(out, "gpsjam-globe.js"), "utf8");
  assert.doesNotMatch(src, /h3-js|latLngToCell|libh3/, "globe chunk does not bundle h3-js");
  const THREE = await import(pathToFileURL(join(out, "node_modules/three/build/three.module.js")));
  const p = G.prepareDay(G.parseDayBody(DAY));
  const s = G.buildGlobeState(p, G.selectCells(p, WORLD), G.parseManifestBody(MANIFEST), { opacity: 0.5, now: NOW });
  const parent = new THREE.Group();
  const layer = g.createGpsJamGlobeLayer(parent, null);
  layer.sync(s);
  assert.equal(layer.cellCount, 8);
  assert.equal(layer.triangleCount, 7 * 6 + 5, "seven hexagons + one pentagon, fan-triangulated");
  const mesh = parent.getObjectByName("gpsjam-hexes").children[0];
  const pos = mesh.geometry.getAttribute("position");
  for (let i = 0; i < pos.count; i += 7) assert.ok(Math.abs(Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i)) - g.GPSJAM_RADIUS) < 1e-5);
  assert.ok(g.GPSJAM_RADIUS > 1.0042, "above basemap/ocean/live tile overlays");
  // Antimeridian cell: no vertex is stretched across the globe (all triangle edges are short).
  for (let i = 0; i < pos.count; i += 3) {
    const d = Math.hypot(pos.getX(i) - pos.getX(i + 1), pos.getY(i) - pos.getY(i + 1), pos.getZ(i) - pos.getZ(i + 1));
    assert.ok(d < 0.05, "no triangle spans the globe");
  }
  assert.deepEqual(layer.tooltipAt(54.35, 18.65)?.bad, 30);
  const { lat, lon } = g.latLonOf({ x: 0, y: Math.sin(Math.PI / 6), z: Math.cos(Math.PI / 6) });
  assert.ok(Math.abs(lat - 30) < 1e-9 && Math.abs(lon) < 1e-9);
  const cam = new THREE.PerspectiveCamera(38, 1, 0.05, 100);
  cam.position.set(...[0, 0, 3]); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
  parent.updateMatrixWorld();
  const centre = g.surfaceAt(0, 0, cam, parent);
  assert.ok(Math.abs(centre.lat) < 1e-6 && Math.abs(centre.lon) < 1e-6, "ray through screen centre hits 0,0");
  assert.equal(g.surfaceAt(0.99, 0.99, cam, parent), null, "corner ray misses the Earth");
  layer.sync({ ...s, opacity: 0.8, key: s.key });
  assert.equal(parent.getObjectByName("gpsjam-hexes").children[0], mesh, "opacity-only change reuses the mesh");
  assert.equal(mesh.material.opacity, 0.8);
  const many = { ...s, key: "many", cells: Array.from({ length: g.MAX_GLOBE_CELLS + 50 }, () => s.cells[0]) };
  layer.sync(many);
  assert.equal(layer.cellCount, g.MAX_GLOBE_CELLS, "hard cap on the globe too");
  layer.sync(null);
  assert.equal(layer.cellCount, 0);
  layer.dispose();
  assert.equal(parent.children.length, 0);
});

test("panel renders opt-in with zero requests; globe shows legend, badge and attribution only with a layer", async () => {
  build("src/WorldViewGpsJam.tsx", "gpsjam-panel.js");
  build("src/WorldGlobe.tsx", "globe.js");
  const old = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("unexpected network"); };
  try {
    const { default: Panel } = await import(pathToFileURL(join(out, "gpsjam-panel.js")));
    const html = renderToStaticMarkup(createElement(Panel, { bounds: [], onOverlay: () => {} }));
    assert.match(html, /GPSJAM requests are off\. Nothing has been requested\./);
    assert.doesNotMatch(html, /type="checkbox"[^>]*checked/);
    assert.match(html, /not a detection or location of jammers/);
    assert.match(html, /John Wiseman/); assert.match(html, /ADS-B Exchange/); assert.match(html, /https:\/\/gpsjam\.org\/faq\//);
    assert.match(html, /reuse terms are unclear/);
    assert.match(html, /no jammer location, targeting or source attribution/);
    assert.doesNotMatch(html, /<img|<iframe/);
    const { WorldGlobe } = await import(pathToFileURL(join(out, "globe.js")));
    const common = { records: [], center: { lat: 38, lon: -77 }, selectedId: null, onSelect: () => {}, onCenter: () => {}, style: "Standard", detection: false, tilt: false, zoom: 1 };
    assert.doesNotMatch(renderToStaticMarkup(createElement(WorldGlobe, common)), /globe-gpsjam-credit/);
    const p = G.prepareDay(G.parseDayBody(DAY));
    const s = G.buildGlobeState(p, G.selectCells(p, WORLD, { cap: 3 }), G.parseManifestBody(MANIFEST), { opacity: 0.5, now: NOW });
    const globe = renderToStaticMarkup(createElement(WorldGlobe, { ...common, gpsJam: s }));
    assert.match(globe, /globe-gpsjam-credit/);
    assert.match(globe, /GNSS interference · INFERRED · DAILY/);
    assert.match(globe, /LATEST DAILY/);
    assert.match(globe, /2026-10-30 \(UTC day\)/);
    assert.match(globe, /capped; 8 in view/);
    assert.match(globe, /not real time, not a jammer detection/);
    assert.match(globe, /GPSJAM by John Wiseman/);
    assert.match(globe, /Low 0–2 %.*Medium 2–&lt;10 %.*High ≥ 10 %/);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = old; }
});

test("live data strip lists GPSJAM as a daily (delayed) layer via extraRows", async () => {
  const compileL = spawnSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), resolve(root, "src/worldview-livemaps.ts"), "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--skipLibCheck", "--lib", "ES2022,DOM,DOM.Iterable", "--outDir", join(out, "lm")], { encoding: "utf8", cwd: out });
  assert.equal(compileL.status, 0, compileL.stdout);
  writeFileSync(join(out, "lm/package.json"), '{"type":"module"}\n');
  const lmFile = join(out, "lm/worldview-livemaps.js");
  writeFileSync(lmFile, readFileSync(lmFile, "utf8").replace(/(['"])\.\/worldview-basemap\1/g, '"./worldview-basemap.js"'));
  const L = await import(pathToFileURL(lmFile));
  const row = G.liveRowFor("2026-10-30", G.dayFreshness("2026-10-30", G.parseManifestBody(MANIFEST), NOW), 8);
  const rows = L.summarizeLiveFeeds({ extraRows: [row] }, NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "GPSJAM GNSS interference (daily)");
  assert.equal(rows[0].status, "delayed");
});

test("sources: no keys, env reads, storage or control surface; WorldView/WorldGlobe edits are minimal", () => {
  for (const file of ["src/worldview-gpsjam.ts", "src/WorldViewGpsJam.tsx", "src/worldview-gpsjam-globe.tsx"]) {
    const text = readFileSync(resolve(root, file), "utf8");
    assert.doesNotMatch(text, /[?&](key|token|access_token|apikey)=/i, file);
    assert.doesNotMatch(text, /process\.env|import\.meta\.env|localStorage|sessionStorage|innerHTML/, file);
    assert.doesNotMatch(text, /mavlink|\barm\(|takeoff|setMode\(|flightMode|method: "POST"/i, file);
    assert.doesNotMatch(text, /https:\/\/gpsjam\.org\/data\/[^"`]*\.csv["`]\s*,?\s*\{/, `${file} never fetches gpsjam.org directly`);
  }
  const view = readFileSync(resolve(root, "src/WorldView.tsx"), "utf8");
  assert.match(view, /const WorldViewGpsJam = lazy\(\(\) => import\("\.\/WorldViewGpsJam"\)\);/);
  assert.match(view, /<WorldViewGpsJam bounds=\{viewportBounds\} onOverlay=\{setGpsJam\} \/>/);
  assert.match(view, /gpsJam=\{gpsJam\}/);
  const globe = readFileSync(resolve(root, "src/WorldGlobe.tsx"), "utf8");
  assert.match(globe, /gpsJamLayer\.sync\(p\.gpsJam, camera\)/);
  assert.match(globe, /gpsJamLayer\.dispose\(\)/);
  assert.match(globe, /import type \{ GpsJamGlobeState \} from "\.\/worldview-gpsjam";/, "type-only import keeps h3-js out of the globe chunk");
});
