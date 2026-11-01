import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = resolve(import.meta.dirname, "..");
const out = mkdtempSync(join(tmpdir(), "worldview-ais-"));
writeFileSync(join(out, "package.json"), '{"type":"module"}\n');
symlinkSync(resolve(root, "node_modules"), join(out, "node_modules"), "dir");
const compile = spawnSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), resolve(root, "src/worldview-ais.ts"), resolve(root, "src/worldview-core.ts"), "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--skipLibCheck", "--outDir", out], { encoding: "utf8", cwd: out });
if (compile.status !== 0) throw new Error(`Unable to compile worldview-ais.ts:\n${compile.stdout}\n${compile.stderr}`);
const ais = await import(`${pathToFileURL(join(out, "worldview-ais.js")).href}?${Date.now()}`);
const core = await import(`${pathToFileURL(join(out, "worldview-core.js")).href}?${Date.now()}`);
test.after(() => rmSync(out, { recursive: true, force: true }));

const NOW = Date.parse("2026-10-30T21:00:30Z");
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const vesselsBody = (overrides = {}) => ({
  provider: "kystverket", name: "Kystverket open AIS (raw NMEA)", source: "Kystverket open AIS", sourceUrl: "tcp://153.44.253.27:5631",
  attribution: "Contains data under the Norwegian licence for Open Government data (NLOD) distributed by the Norwegian Coastal Administration (Kystverket)",
  license: "NLOD 2.0", licenseUrl: "https://data.norge.no/nlod/en/2.0", termsUrl: "https://www.kystverket.no/en/sea-transport-and-ports/ais/access-to-ais-data",
  coverage: "Norwegian economic zone only", status: "live", configured: true, keyRequired: false, configEnv: ["UCAS_KYSTVERKET_AIS_ENABLED"],
  error: null, lastMessageAt: "2026-10-30T21:00:29Z", bbox: { south: 59.39, west: 3.82, north: 61.39, east: 6.82 },
  retrievedAt: "2026-10-30T21:00:30Z", vesselsInBox: 3, truncated: false,
  vessels: [
    { mmsi: 259000420, lat: 60.3913, lon: 5.3221, sogKn: 12.3, cogDeg: 187.5, headingDeg: 185, navStatus: 0, navStatusText: "Under way using engine", name: "NORDIC TEST", shipType: 70, shipTypeText: "Cargo", aisClass: "A", providerTimestamp: "2026-10-30T21:00:20Z", ageSeconds: 10, stale: false },
    { mmsi: 257999000, lat: 60.35, lon: 5.25, sogKn: null, cogDeg: null, headingDeg: null, navStatus: null, name: null, shipType: null, aisClass: "B", providerTimestamp: "2026-10-30T20:40:00Z", ageSeconds: 1230, stale: true },
    { mmsi: 1, lat: 99, lon: 5, providerTimestamp: "2026-10-30T21:00:00Z" },
    { mmsi: 2, lat: 60, lon: 5, providerTimestamp: "2026-10-31T21:00:00Z" },
  ],
  ...overrides,
});

test("bounding box is centred, capped and shifted instead of wrapping", () => {
  assert.deepEqual(ais.aisBBox({ lat: 60.39, lon: 5.32 }), { south: 59.39, west: 3.82, north: 61.39, east: 6.82 });
  const capped = ais.aisBBox({ lat: 0, lon: 0 }, 50, 50);
  assert.equal(capped.north - capped.south, ais.AIS_MAX_LAT_SPAN);
  assert.equal(capped.east - capped.west, ais.AIS_MAX_LON_SPAN);
  assert.deepEqual(ais.aisBBox({ lat: 89.5, lon: 179.5 }), { south: 88, west: 177, north: 90, east: 180 });
  assert.throws(() => ais.aisBBox({ lat: 91, lon: 0 }), /Invalid/);
});

test("vessels request goes only to the same-origin relay with the opt-in header and no key", async () => {
  let seen;
  const body = await ais.fetchAisVessels("kystverket", ais.aisBBox({ lat: 60.39, lon: 5.32 }), async (url, init) => { seen = { url, init }; return response(vesselsBody()); });
  const url = new URL(seen.url, "http://localhost");
  assert.equal(url.pathname, "/api/v1/public-ais/vessels");
  assert.deepEqual([...url.searchParams.keys()].sort(), ["east", "north", "provider", "south", "west"]);
  assert.equal(seen.init.headers["X-SignalWarden-AIS"], "enabled");
  assert.equal(seen.init.redirect, "error");
  assert.equal(seen.init.cache, "no-store");
  assert.doesNotMatch(seen.url, /key|token|secret/i);
  assert.equal(body.status, "live");
  await assert.rejects(ais.fetchAisVessels("marinetraffic", body.bbox, async () => response({})), /Unknown AIS provider/);
  await assert.rejects(ais.fetchAisVessels("aisstream", { south: 0, west: 0, north: 10, east: 10 }, async () => response({})), /cap/);
});

test("disabled relay, provider errors and malformed bodies are reported, never fabricated", async () => {
  await assert.rejects(ais.fetchAisStatus(async () => response({ error: { code: "public_ais_disabled", message: "off" } }, 404)), /UCAS_PUBLIC_AIS_ENABLED=1/);
  await assert.rejects(ais.fetchAisVessels("aisstream", ais.aisBBox({ lat: 0, lon: 0 }), async () => response({ error: { code: "ais_bbox_too_large", message: "capped" } }, 400)), /HTTP 400 ais_bbox_too_large/);
  await assert.rejects(ais.fetchAisVessels("aisstream", ais.aisBBox({ lat: 0, lon: 0 }), async () => response({ nope: true })), /unexpected shape/);
  const notConfigured = vesselsBody({ provider: "aisstream", source: "AISStream.io", status: "not_configured", configured: false, vessels: [], message: "Not configured: set UCAS_AISSTREAM_API_KEY on the Management API server" });
  assert.deepEqual(ais.aisObservations(notConfigured, NOW), []);
  assert.match(ais.aisStatusText(notConfigured), /NOT CONFIGURED — Not configured: set UCAS_AISSTREAM_API_KEY/);
  assert.match(ais.aisStatusText({ name: "AISStream.io", status: "error", error: "AISStream connection closed" }), /FAILED/);
});

test("observations are live vessels with provenance, freshness and the self-reported disclosure", () => {
  const obs = ais.aisObservations(vesselsBody(), NOW);
  assert.deepEqual(obs.map((o) => o.id), ["ais-kystverket-259000420", "ais-kystverket-257999000"]);  // invalid lat and future timestamp dropped
  for (const o of obs) assert.equal(core.validateObservation(o), true);
  const [a, b] = obs;
  assert.equal(a.layer, "vessels");
  assert.equal(a.freshness, "fresh");
  assert.equal(a.source, "Kystverket open AIS");
  assert.equal(a.label, "NORDIC TEST · AIS");
  assert.equal(a.observedAt, "2026-10-30T21:00:20.000Z");
  assert.equal(a.properties.retrievedAt, "2026-10-30T21:00:30.000Z");
  assert.equal(a.properties.sourceUrl, "tcp://153.44.253.27:5631");
  assert.match(a.properties.attribution, /NLOD/);
  assert.equal(a.properties.license, "NLOD 2.0");
  assert.match(a.properties.disclosure, /self-reported/);
  assert.equal(a.properties.synthetic, false);
  assert.equal(a.properties.live, true);
  assert.equal(a.properties.sogKn, 12.3);
  assert.equal(b.freshness, "stale");
  assert.equal(b.properties.live, false);
  assert.equal(b.label, "MMSI 257999000 · AIS");
  assert.equal(b.properties.shipType, null);
  for (const key of Object.keys(a.properties)) assert.doesNotMatch(key, /owner|crew|callsign|imo|destination|person/i);
  const stream = ais.aisObservations(vesselsBody({ status: "stale" }), NOW);
  assert.ok(stream.every((o) => o.freshness === "stale"), "a stale stream never yields fresh vessels");
  assert.ok(stream.every((o) => o.properties.live === false), "stale stream items cannot be labeled live");
});

test("observations age to stale without a new poll", () => {
  const obs = ais.aisObservations(vesselsBody(), NOW);
  const later = ais.ageAisObservations(obs, NOW + ais.AIS_STALE_MS + 1000);
  assert.ok(later.every((o) => o.freshness === "stale"));
  assert.ok(later.every((o) => o.properties.live === false));
  assert.equal(ais.ageAisObservations(obs, NOW)[0], obs[0]);
});

test("panel's initial render makes no requests and every control starts off", async () => {
  const require = createRequire(realpathSync(resolve(root, "node_modules/vite/package.json")));
  const { buildSync } = require("esbuild");
  buildSync({ entryPoints: [resolve(root, "src/WorldViewAis.tsx")], outfile: join(out, "ais-component.js"), bundle: true, format: "esm", platform: "node", jsx: "automatic", external: ["react", "react-dom"], loader: { ".css": "empty" } });
  const old = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error("unexpected network"); };
  try {
    const { default: Component } = await import(pathToFileURL(join(out, "ais-component.js")));
    const html = renderToStaticMarkup(createElement(Component, { center: { lat: 60.39, lon: 5.32 }, onObservations: () => { throw Error("no observations at render"); } }));
    assert.equal(calls, 0);
    assert.match(html, /Nothing has been requested/);
    assert.match(html, /SELF-REPORTED/);
    assert.match(html, /<button disabled="">Refresh vessels now<\/button>/);
    assert.doesNotMatch(html, /type="checkbox"[^>]*checked/);
  } finally { globalThis.fetch = old; }
});

test("browser code never holds provider credentials or opens provider connections", () => {
  const component = readFileSync(resolve(root, "src/WorldViewAis.tsx"), "utf8");
  assert.match(component, /active\?: boolean/);
  assert.match(component, /if \(active\) return;/, "inactive globe clears AIS state");
  assert.match(component, /requestGeneration !== generation\.current/, "late AIS results cannot commit");
  for (const file of ["src/worldview-ais.ts", "src/WorldViewAis.tsx"]) {
    const source = readFileSync(resolve(root, file), "utf8");
    assert.doesNotMatch(source, /aisstream\.io\/v0|153\.44\.253\.27|barentswatch\.no\/connect|new WebSocket|APIKey|import\.meta\.env/);
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|sendBeacon|command-gateway/);
  }
});
