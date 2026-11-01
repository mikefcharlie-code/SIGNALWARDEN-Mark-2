import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = resolve(import.meta.dirname, "..");
const out = mkdtempSync(join(tmpdir(), "worldview-public-traffic-"));
writeFileSync(join(out, "package.json"), '{"type":"module"}\n');
symlinkSync(resolve(root, "node_modules"), join(out, "node_modules"), "dir");
const compile = spawnSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), resolve(root, "src/worldview-public-traffic.ts"), "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--skipLibCheck", "--outDir", out], { encoding: "utf8", cwd: out });
if (compile.status !== 0) throw new Error(`Unable to compile worldview-public-traffic.ts:\n${compile.stdout}\n${compile.stderr}`);
const target = join(out, "worldview-public-traffic.js");
writeFileSync(target, readFileSync(target, "utf8").replace(/(['"])\.\/worldview-core\1/g, '"./worldview-core.js"'));
const pt = await import(`${pathToFileURL(join(out, "worldview-public-traffic.js")).href}?${Date.now()}`);
const core = await import(`${pathToFileURL(join(out, "worldview-core.js")).href}?${Date.now()}`);
test.after(() => rmSync(out, { recursive: true, force: true }));

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const NOW = Date.parse("2026-10-30T22:00:00Z");
const catalogBody = {
  provider: "caltrans", providerName: "Caltrans CCTV", authority: "California Department of Transportation (Caltrans)",
  attribution: "Caltrans — cwwp2.dot.ca.gov (courtesy)", license: "Public Caltrans CWWP2 data", termsUrl: "https://cwwp2.dot.ca.gov/documentation/cctv/cctv.htm",
  verified: "catalog and snapshot verified live 2026-10-30", snapshotMode: "relay", status: "ok", totalInArea: 2, truncated: false,
  retrievedAt: "2026-10-30T21:58:00Z", providerUpdatedAt: "2026-10-29T22:04:00Z", sourceUrl: "https://cwwp2.dot.ca.gov/data/d4/cctv/cctvStatusD04.json",
  cameras: [
    { id: "D04:tv102", name: "TV102 -- I-580 : West of SR-24", road: "I-580", direction: "West", lat: 37.82539, lon: -122.27291, authority: "Caltrans", snapshotUrl: "https://cwwp2.dot.ca.gov/data/d4/cctv/image/tv102/tv102.jpg", providerUpdatedAt: "2026-01-23T22:19:48Z" },
    { id: "bad", name: "no coords", lat: "x", lon: 1 },
  ],
};

test("areaBounds builds a clamped square bbox and rejects bad input", () => {
  const b = pt.areaBounds({ lat: 37.8, lon: -122.3 }, 25);
  assert.ok(b.west < -122.3 && b.east > -122.3 && b.south < 37.8 && b.north > 37.8);
  assert.ok(Math.abs((b.north - b.south) - 50 / 111.32) < 1e-3);
  assert.throws(() => pt.areaBounds({ lat: 37, lon: -122 }, 0), /Radius/);
  assert.throws(() => pt.areaBounds({ lat: 37, lon: -122 }, 151), /Radius/);
  assert.throws(() => pt.areaBounds({ lat: 95, lon: 0 }, 10), /centre/);
  const edge = pt.areaBounds({ lat: 0, lon: 179.9 }, 50);
  assert.equal(edge.east, 180);
});

test("relay calls are same-origin, header-tagged and never carry keys or provider URLs", async () => {
  const seen = [];
  const fetcher = async (url, init) => { seen.push({ url, init }); return json(catalogBody); };
  const bbox = { west: -122.4, south: 37.7, east: -122.2, north: 37.9 };
  const result = await pt.fetchCatalog("caltrans", bbox, fetcher);
  const url = new URL(seen[0].url, "http://ui.local");
  assert.equal(url.pathname, "/api/v1/public-traffic/cameras/catalog");
  assert.deepEqual([...url.searchParams.keys()].sort(), ["east", "north", "provider", "south", "west"]);
  assert.equal(seen[0].init.headers["X-SignalWarden-Traffic"], "enabled");
  assert.equal(seen[0].init.redirect, "error");
  assert.equal(seen[0].init.referrerPolicy, "no-referrer");
  assert.doesNotMatch(seen[0].url, /key|token|https?:/i);
  assert.equal(result.cameras.length, 1);
  assert.equal(result.cameras[0].providerUpdatedAt, "2026-01-23T22:19:48.000Z");
});

test("not_configured and disabled relay errors surface their codes; nothing is fabricated", async () => {
  const notConfigured = async () => json({ error: { code: "not_configured", message: "WSDOT highway cameras needs UCAS_WSDOT_ACCESS_CODE on the server; no data is shown" } }, 503);
  await assert.rejects(pt.fetchCatalog("wsdot", { west: -122.5, south: 47.5, east: -122.2, north: 47.8 }, notConfigured), (e) => e instanceof pt.RelayError && e.code === "not_configured" && e.status === 503);
  const disabled = async () => json({ error: { code: "public_traffic_disabled", message: "disabled" } }, 404);
  await assert.rejects(pt.fetchProviders(disabled), (e) => e.code === "public_traffic_disabled");
  const html = async () => new Response("<html>", { status: 502 });
  await assert.rejects(pt.fetchTomTom({ west: -74, south: 40.7, east: -73.9, north: 40.8 }, html), (e) => e.code === "relay_invalid_json");
  const wrongProvider = async () => json({ ...catalogBody, provider: "tfl" });
  await assert.rejects(pt.fetchCatalog("caltrans", { west: -1, south: -1, east: 1, north: 1 }, wrongProvider), /Unexpected camera catalog/);
});

test("provider listing parses status, key env names and verification", async () => {
  const body = {
    cameraProviders: [
      { id: "caltrans", name: "Caltrans CCTV", authority: "Caltrans", region: "California, US", coverage: [-124.5, 32.4, -114.3, 42.2], status: "available", keyEnv: null, keyUrl: null, keyFree: null, snapshotMode: "relay", attribution: "Caltrans", license: "public", termsUrl: "https://cwwp2.dot.ca.gov/", verified: "verified", notes: "" },
      { id: "wsdot", name: "WSDOT", authority: "WSDOT", region: "Washington, US", coverage: [-124.9, 45.5, -116.9, 49.1], status: "not_configured", keyEnv: "UCAS_WSDOT_ACCESS_CODE", keyUrl: "https://wsdot.wa.gov/traffic/api/", keyFree: true, snapshotMode: "relay", attribution: "WSDOT", license: "terms", termsUrl: "https://wsdot.wa.gov/traffic/api/", verified: "unverified", notes: "" },
      { id: "broken", status: "available" },
    ],
    traffic: { name: "TomTom", status: "not_configured", keyEnv: "UCAS_TOMTOM_API_KEY", keyUrl: "https://developer.tomtom.com/user/register", attribution: "Traffic data © TomTom", license: "TomTom", termsUrl: "https://developer.tomtom.com/terms-and-conditions", verified: "unverified" },
  };
  const listing = await pt.fetchProviders(async () => json(body));
  assert.deepEqual(listing.cameraProviders.map((p) => [p.id, p.status, p.keyEnv]), [["caltrans", "available", null], ["wsdot", "not_configured", "UCAS_WSDOT_ACCESS_CODE"]]);
  assert.equal(listing.traffic.status, "not_configured");
  assert.ok(pt.coverageIncludes(listing.cameraProviders[0], { west: -122.4, south: 37.7, east: -122.2, north: 37.9 }));
  assert.ok(!pt.coverageIncludes(listing.cameraProviders[0], { west: 0, south: 51, east: 1, north: 52 }));
});

test("snapshot decodes relayed bytes and keeps image time separate from retrieval time", async () => {
  const jpeg = Uint8Array.from([255, 216, 255, 224, 0, 0, 255, 217]);
  const body = { provider: "tfl", cameraId: "JamCams_1", cameraName: "A406", mime: "image/jpeg", bytes: 8, dataBase64: Buffer.from(jpeg).toString("base64"), imageTime: "2026-10-30T21:47:54Z", imageTimeSource: "http-last-modified", retrievedAt: "2026-10-30T21:58:00Z", sourceUrl: "https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/1.jpg", attribution: "Powered by TfL Open Data" };
  const snap = await pt.fetchSnapshot("tfl", "JamCams_1", async () => json(body));
  assert.deepEqual([...snap.bytes], [...jpeg]);
  assert.equal(snap.imageTime, "2026-10-30T21:47:54.000Z");
  const age = pt.ageFreshness(snap.imageTime, pt.SNAPSHOT_STALE_MS, NOW);
  assert.equal(age.freshness, "stale");
  assert.equal(pt.formatAge(age.ageSeconds), "12 min old");
  assert.equal(pt.ageFreshness(null, 1000, NOW).freshness, "unknown");
  assert.equal(pt.ageFreshness("2027-01-01T00:00:00Z", 1000, NOW).freshness, "unknown");
  await assert.rejects(pt.fetchSnapshot("tfl", "JamCams_1", async () => json({ ...body, mime: "text/html" })), /Unexpected snapshot/);
});

test("hotlink is limited to the provider's pinned frame host", () => {
  const nsw = { id: "nsw", snapshotMode: "hotlink" };
  const cam = (snapshotUrl) => ({ id: "x", name: "x", lat: -34, lon: 151, authority: "", road: null, direction: null, providerUpdatedAt: null, snapshotUrl });
  assert.equal(pt.hotlinkUrl(nsw, cam("https://webcams.transport.nsw.gov.au/livetraffic-webcams/cameras/a.jpeg")), "https://webcams.transport.nsw.gov.au/livetraffic-webcams/cameras/a.jpeg");
  assert.equal(pt.hotlinkUrl(nsw, cam("https://evil.example/livetraffic-webcams/cameras/a.jpeg")), null);
  assert.equal(pt.hotlinkUrl({ id: "caltrans", snapshotMode: "relay" }, cam("https://cwwp2.dot.ca.gov/x.jpg")), null);
});

test("camera observations are valid live records with provenance and go stale with age", async () => {
  const catalog = await pt.fetchCatalog("caltrans", { west: -122.4, south: 37.7, east: -122.2, north: 37.9 }, async () => json(catalogBody));
  const [o] = pt.cameraObservations(catalog, NOW);
  assert.ok(core.validateObservation(o));
  assert.equal(o.layer, "cameras");
  assert.equal(o.freshness, "fresh");
  assert.ok(o.id.startsWith(pt.OBSERVATION_PREFIX.cameras));
  for (const k of ["provider", "sourceUrl", "retrievedAt", "providerTimestamp", "attribution", "license", "termsUrl", "pose", "disclosure"]) assert.ok(k in o.properties, k);
  assert.match(o.properties.disclosure, /no plate\/face recognition/);
  assert.doesNotMatch(o.source, /synthetic/i);
  const later = pt.cameraObservations(catalog, NOW + 20 * 60_000)[0];
  assert.equal(later.freshness, "stale");
  assert.equal(later.stale, true);
});

test("TomTom incidents and flow become aggregate traffic observations", async () => {
  const body = {
    provider: "tomtom", attribution: "Traffic data © TomTom", license: "TomTom developer terms", termsUrl: "https://developer.tomtom.com/terms-and-conditions", verified: "unverified",
    retrievedAt: "2026-10-30T21:59:00Z", truncated: false, flowError: null, sourceUrl: "https://api.tomtom.com/traffic/services/5/incidentDetails?bbox=x", flowSourceUrl: "https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json?point=x",
    incidents: [{ id: "inc-1", lat: 40.75, lon: -73.95, category: "Jam", description: "Stationary traffic", delaySeconds: 240, magnitudeOfDelay: 2, lengthMeters: 1200, from: "A", to: "B", roadNumbers: "I-495", startTime: "2026-10-30T20:00:00Z", endTime: null, lastReportTime: "2026-10-30T21:40:00Z" }, { id: "bad" }],
    flow: { lat: 40.751, lon: -73.949, currentSpeedKmh: 31, freeFlowSpeedKmh: 56, currentTravelTimeSeconds: 120, freeFlowTravelTimeSeconds: 66, confidence: 0.95, roadClosure: false, functionalRoadClass: "FRC2" },
  };
  const result = await pt.fetchTomTom({ west: -74, south: 40.7, east: -73.9, north: 40.8 }, async () => json(body));
  const obs = pt.trafficObservations(result, NOW);
  assert.equal(obs.length, 2);
  for (const o of obs) { assert.ok(core.validateObservation(o)); assert.equal(o.layer, "traffic"); assert.equal(o.source, "TomTom Traffic"); assert.doesNotMatch(JSON.stringify(o), /key=/); }
  assert.equal(obs[0].observedAt, "2026-10-30T21:40:00.000Z");
  assert.equal(obs[0].freshness, "fresh");
  assert.match(obs[1].label, /31\/56 km\/h/);
  assert.equal(obs[1].confidence, 0.95);
  assert.match(obs[1].properties.disclosure, /not individual vehicle/);
});

test("panel import and initial render make no requests; WorldView mounts it lazily", async () => {
  const require = createRequire(realpathSync(resolve(root, "node_modules/vite/package.json")));
  const { buildSync } = require("esbuild");
  buildSync({ entryPoints: [resolve(root, "src/WorldViewPublicTraffic.tsx")], outfile: join(out, "pt-component.js"), bundle: true, format: "esm", platform: "node", jsx: "automatic", external: ["react", "react-dom"], loader: { ".css": "empty" } });
  const old = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error("unexpected network"); };
  try {
    const { default: Panel } = await import(pathToFileURL(join(out, "pt-component.js")));
    const html = renderToStaticMarkup(createElement(Panel, { center: { lat: 37.8, lon: -122.3 }, network: false }));
    assert.match(html, /No relay or provider requests have been made/);
    assert.match(html, /no plate reading, face recognition, image analysis or tracking across cameras/);
    assert.match(html, /UCAS_PUBLIC_TRAFFIC_ENABLED=1/);
    assert.doesNotMatch(html, /<img/);
  } finally { globalThis.fetch = old; }
  assert.equal(calls, 0);
  const worldview = readFileSync(resolve(root, "src/WorldView.tsx"), "utf8");
  assert.match(worldview, /lazy\(\(\) => import\("\.\/WorldViewPublicTraffic"\)\)/);
  const source = readFileSync(resolve(root, "src/worldview-public-traffic.ts"), "utf8") + readFileSync(resolve(root, "src/WorldViewPublicTraffic.tsx"), "utf8");
  assert.match(source, /active\?: boolean/);
  assert.match(source, /if \(active && network\) return;/, "inactive or network opt-out clears fetched state");
  assert.match(source, /generation\.current \+= 1/);
  assert.match(source, /requestGeneration !== generation\.current/, "late traffic results cannot commit");
  assert.match(source, /emit\.current\?\.\(OBSERVATION_PREFIX\.cameras, \[\]\)/, "opt-out clears camera records");
  assert.doesNotMatch(source, /UCAS_TOMTOM_API_KEY\s*=|api\.tomtom\.com\/traffic\/services\/\d+\/[a-zA-Z]+\?key/);
  assert.doesNotMatch(source, /getImageData|tesseract|faceapi|ocr\(/i);
});
