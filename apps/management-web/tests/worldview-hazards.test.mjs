import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const out = mkdtempSync(join(tmpdir(), "worldview-hazards-"));
writeFileSync(join(out, "package.json"), '{"type":"module"}\n');
symlinkSync(resolve(root, "node_modules"), join(out, "node_modules"), "dir");
const compile = spawnSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), resolve(root, "src/worldview-hazards.ts"), "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--skipLibCheck", "--outDir", out], { encoding: "utf8", cwd: out });
if (compile.status !== 0) throw new Error(`Unable to compile worldview-hazards.ts:\n${compile.stdout}\n${compile.stderr}`);
const hzPath = join(out, "worldview-hazards.js");
writeFileSync(hzPath, readFileSync(hzPath, "utf8").replace('from "./worldview-draped-raster"', 'from "./worldview-draped-raster.js"'));
const hz = await import(`${pathToFileURL(hzPath).href}?${Date.now()}`);
const raster = await import(`${pathToFileURL(join(out, "worldview-draped-raster.js")).href}?${Date.now()}`);
test.after(() => rmSync(out, { recursive: true, force: true }));
test.beforeEach(() => hz.resetHazardState());

const bbox = { west: -122, south: 39, east: -119, north: 42 };
const json = (body, status = 200, headers = { "content-type": "application/json" }) => new Response(JSON.stringify(body), { status, headers });
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const recorder = (responder) => { const calls = []; const f = async (url, init) => { calls.push({ url, init }); return responder(url, init); }; f.calls = calls; return f; };

test("nothing is requested without explicit network opt-in", async () => {
  const f = recorder(() => json({}));
  for (const r of [await hz.refreshFirms(bbox, {}, {}, f), await hz.refreshWfigs(bbox, {}, f), await hz.refreshNhc({}, f)]) {
    assert.equal(r.freshness, "failed"); assert.match(r.error, /opt-in/);
  }
  const eonet = await hz.refreshEonet(bbox, {}, {}, f);
  assert.equal(eonet.freshness, "failed"); assert.match(eonet.error, /opt-in/i);
  await assert.rejects(hz.loadNowCoastOverlay("radar", bbox, {}, f), /opt-in/);
  assert.equal(f.calls.length, 0);
});

test("bbox validation caps span and rejects wraps before any request", async () => {
  const f = recorder(() => json({}));
  for (const bad of [{ ...bbox, east: -130 }, { ...bbox, west: -150 }, { ...bbox, north: 95 }, { ...bbox, south: Number.NaN }]) {
    const r = await hz.refreshFirms(bad, {}, { network: true }, f);
    assert.equal(r.freshness, "failed");
  }
  assert.equal(f.calls.length, 0);
  assert.deepEqual(hz.boundedBboxFrom({ west: -150, south: 0, east: -50, north: 60 }), { west: -110, south: 20, east: -90, north: 40 });
});

test("EONET date ranges and categories are allowlisted before network access", async () => {
  const f = recorder(() => json({}));
  for (const options of [{ days: 0 }, { days: 31 }, { days: 1.5 }, { category: "untrusted-category" }]) {
    const result = await hz.refreshEonet(bbox, options, { network: true }, f);
    assert.equal(result.freshness, "failed");
  }
  assert.equal(f.calls.length, 0);
});

test("FIRMS goes only through the same-origin relay with the opt-in header and labels thermal anomalies", async () => {
  const f = recorder(() => json({ provider: "nasa-firms", mode: "map_key_area_api", keyStatus: "configured", sourceUrl: "https://firms.modaps.eosdis.nasa.gov/api/area/csv/[MAP_KEY]/VIIRS_NOAA20_NRT/-122,39,-119,42/1", retrievedAt: iso(0), truncated: false,
    detections: [{ lat: 40.5, lon: -120.25, acquiredAt: iso(3600_000), confidence: "nominal", frpMw: 3.06, satellite: "NOAA-20", instrument: "VIIRS", dayNight: "night" },
      { lat: 40.6, lon: -120.3, acquiredAt: iso(10 * 3600_000), confidence: "high", frpMw: 12.5, satellite: "NOAA-20", instrument: "VIIRS", dayNight: "day" },
      { lat: 40.7, lon: -120.3, acquiredAt: iso(-3600_000 * 5) }, { lat: 200, lon: 0, acquiredAt: iso(0) }] }));
  const r = await hz.refreshFirms(bbox, { source: "VIIRS_NOAA20_NRT", days: 1 }, { network: true }, f);
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.match(url, /^\/api\/v1\/public-imagery\/hazards\/firms\?bbox=-122%2C39%2C-119%2C42&source=VIIRS_NOAA20_NRT&days=1$/);
  assert.doesNotMatch(url, /key|token/i);
  assert.equal(init.headers["X-SignalWarden-Hazards"], "enabled");
  assert.equal(init.credentials, "omit"); assert.equal(init.redirect, "error");
  assert.equal(r.observations.length, 2, "future and out-of-range rows dropped");
  const [a, b] = r.observations;
  assert.equal(a.layer, "fires"); assert.match(a.label, /thermal anomaly \(not a confirmed fire\)/);
  assert.equal(a.freshness, "fresh"); assert.equal(b.freshness, "stale"); assert.equal(r.freshness, "stale");
  for (const k of ["provider", "sourceUrl", "retrievedAt", "providerTimestamp", "ageMinutesAtRetrieval", "attribution", "license", "confidence", "frpMw", "satellite", "dayNight", "acquisitionTimeUtc"]) assert.ok(k in a.properties, k);
  assert.equal(a.properties.live, true);
  assert.equal(b.properties.live, false, "stale detection cannot be labeled live");
  assert.equal(r.keyStatus, "configured");
});

test("FIRMS not_configured is surfaced, never fabricated; leaked key URLs are rejected", async () => {
  const f = recorder(() => json({ error: { code: "firms_not_configured", message: "UCAS_NASA_FIRMS_MAP_KEY is not configured" } }, 503));
  const r = await hz.refreshFirms(bbox, {}, { network: true }, f);
  assert.equal(r.freshness, "failed"); assert.equal(r.keyStatus, "not_configured"); assert.equal(r.observations.length, 0);
  assert.match(r.error, /firms_not_configured/);
  hz.resetHazardState();
  const leak = recorder(() => json({ provider: "nasa-firms", sourceUrl: "https://firms.modaps.eosdis.nasa.gov/api/area/csv/abcdef0123456789/MODIS_NRT/0,0,1,1/1", detections: [] }));
  const r2 = await hz.refreshFirms(bbox, {}, { network: true }, leak);
  assert.equal(r2.freshness, "failed"); assert.match(r2.error, /credential/);
});

test("relay status distinguishes disabled relay from missing key", async () => {
  assert.equal((await hz.fetchHazardRelayStatus({ network: true }, async () => json({ error: { code: "hazard_relay_disabled", message: "disabled" } }, 404))).state, "disabled");
  const s = await hz.fetchHazardRelayStatus({ network: true }, async () => json({ enabled: true, firms: { keyStatus: "not_configured" } }));
  assert.equal(s.firmsKey, "not_configured"); assert.match(s.message, /not_configured/);
});

test("throttle returns cached data as stale within 60s", async () => {
  const f = recorder(() => json({ provider: "nasa-firms", detections: [], retrievedAt: iso(0), sourceUrl: "https://firms.modaps.eosdis.nasa.gov/data/active_fire/x.csv" }));
  await hz.refreshFirms(bbox, {}, { network: true }, f);
  const again = await hz.refreshFirms(bbox, {}, { network: true }, f);
  assert.equal(f.calls.length, 1); assert.equal(again.freshness, "stale"); assert.match(again.error, /throttled/);
});

test("empty hazard snapshots are unknown, never an assurance of live safety", async () => {
  const results = [
    await hz.refreshFirms(bbox, {}, { network: true }, async () => json({ provider: "nasa-firms", detections: [], retrievedAt: iso(0) })),
    await hz.refreshWfigs(bbox, { network: true }, async () => json({ type: "FeatureCollection", features: [] })),
    await hz.refreshNhc({ network: true }, async () => json({ provider: "noaa-nhc", storms: [], retrievedAt: iso(0) })),
  ];
  for (const result of results) {
    assert.equal(result.observations.length, 0);
    assert.equal(result.freshness, "unknown");
    assert.match(result.error, /unknown.*not confirmation of safety/);
  }
});

test("malformed-only, future-only and out-of-area hazard records fail closed", async () => {
  const results = [
    await hz.refreshFirms(bbox, {}, { network: true }, async () => json({ provider: "nasa-firms", detections: [{ lat: 0, lon: 0, acquiredAt: iso(0) }, { lat: 40, lon: -120, acquiredAt: iso(-3600_000) }], retrievedAt: iso(0) })),
    await hz.refreshWfigs(bbox, { network: true }, async () => json({ features: [{ geometry: null, properties: {} }] })),
    await hz.refreshNhc({ network: true }, async () => json({ provider: "noaa-nhc", storms: [{ id: "al052026", lat: 999, lon: -70, lastUpdate: iso(0) }], retrievedAt: iso(0) })),
  ];
  for (const result of results) {
    assert.equal(result.observations.length, 0);
    assert.equal(result.freshness, "failed");
    assert.match(result.error, /no usable timestamped/);
  }
});

test("EONET requests only event/source metadata after opt-in and retains provider geometry times and individual source links", async () => {
  const pointAt = iso(60 * 60_000), polygonAt = iso(3 * 24 * 3600_000);
  const f = recorder((url) => url.includes("/sources") ? json({ sources: [
    { id: "IRWIN", title: "Integrated Reporting of Wildfire Information", source: "https://irwin.doi.gov/observer/", link: "https://eonet.gsfc.nasa.gov/api/v3/events?source=IRWIN" },
    { id: "EO", title: "Earth Observatory", source: "https://earthobservatory.nasa.gov/", link: "https://eonet.gsfc.nasa.gov/api/v3/events?source=EO" },
  ] }) : json({ events: [{ id: "EONET_123", title: "Test event", link: "https://eonet.gsfc.nasa.gov/api/v3/events/EONET_123", closed: null,
    categories: [{ id: "wildfires", title: "Wildfires" }],
    sources: [{ id: "IRWIN", url: "https://irwin.doi.gov/observer/incidents/test" }, { id: "EO", url: "https://earthobservatory.nasa.gov/images/test" }],
    geometry: [{ date: pointAt, type: "Point", coordinates: [-120.25, 40.5] }, { date: polygonAt, type: "Polygon", coordinates: [[[-121, 40], [-120, 40], [-120, 41], [-121, 40]]] }] }] }));
  const r = await hz.refreshEonet(bbox, { days: 7, category: "wildfires" }, { network: true }, f);
  assert.equal(f.calls.length, 2, "event metadata and NASA source catalog only");
  const eventRequest = new URL(f.calls.find((c) => c.url.includes("/events?")).url);
  assert.equal(eventRequest.origin, "https://eonet.gsfc.nasa.gov");
  assert.equal(eventRequest.searchParams.get("bbox"), "-122,42,-119,39");
  assert.equal(eventRequest.searchParams.get("days"), "7");
  assert.equal(eventRequest.searchParams.get("category"), "wildfires");
  assert.equal(eventRequest.searchParams.get("limit"), "100");
  assert.ok(f.calls.every((c) => !/layers|wms|wmts|image|tile/i.test(c.url)), "linked imagery endpoints are never requested");
  assert.equal(r.providerId, "nasa-eonet");
  assert.equal(r.observations.length, 2);
  assert.ok(r.observations.every((observation) => observation.layer === "events"));
  assert.equal(r.freshness, "stale", "old event geometry is retained but not labeled live");
  assert.equal(r.observations[0].observedAt, pointAt);
  assert.equal(r.observations[0].properties.providerTimestamp, pointAt);
  assert.equal(r.observations[0].properties.live, true);
  assert.equal(r.observations[1].properties.live, false);
  assert.equal(r.observations[0].properties.eventUrl, "https://eonet.gsfc.nasa.gov/api/v3/events/EONET_123");
  const event = r.eonetEvents[0];
  assert.deepEqual(event.geometryTimes, [pointAt, polygonAt]);
  assert.deepEqual(event.geometryTypes, ["Point", "Polygon"]);
  assert.equal(event.sources[0].name, "Integrated Reporting of Wildfire Information");
  assert.equal(event.sources[0].homepageUrl, "https://irwin.doi.gov/observer/");
  assert.equal(event.sources[0].eventUrl, "https://irwin.doi.gov/observer/incidents/test");
  assert.equal(event.sources[1].name, "Earth Observatory");
  assert.equal(event.sources[1].eventUrl, "https://earthobservatory.nasa.gov/images/test");
});

test("EONET malformed, future and out-of-box-only events fail rather than becoming live", async () => {
  const f = recorder((url) => url.includes("/sources") ? json({ sources: [{ id: "EO", title: "Earth Observatory", source: "https://earthobservatory.nasa.gov/" }] })
    : json({ events: [{ id: "EONET_BAD", title: "Bad event", sources: [{ id: "EO", url: "https://earthobservatory.nasa.gov/" }], geometry: [
      { date: "not-a-date", type: "Point", coordinates: [-120, 40] },
      { date: "2026-02-30T12:00:00Z", type: "Point", coordinates: [-120, 40] },
      { date: iso(-60_000), type: "Point", coordinates: [-120, 40] },
      { date: iso(0), type: "Point", coordinates: [0, 0] },
    ] }] }));
  const r = await hz.refreshEonet(bbox, {}, { network: true }, f);
  assert.equal(f.calls.length, 2);
  assert.equal(r.freshness, "failed");
  assert.equal(r.observations.length, 0);
  assert.match(r.error, /no usable timestamped event geometry/i);
});

test("EONET API/source errors are failed and cached prior events are explicitly stale", async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  const good = recorder((url) => url.includes("/sources") ? json({ sources: [{ id: "IRWIN", title: "IRWIN", source: "https://irwin.doi.gov/" }] })
    : json({ events: [{ id: "EONET_OLD", title: "Cached event", sources: [{ id: "IRWIN", url: "https://irwin.doi.gov/event" }], geometry: [{ date: new Date(now - 3600_000).toISOString(), type: "Point", coordinates: [-120, 40] }] }] }));
  try {
    const first = await hz.refreshEonet(bbox, { days: 7 }, { network: true }, good);
    assert.equal(first.freshness, "fresh");
    now += 61_000;
    const failure = await hz.refreshEonet(bbox, { days: 7 }, { network: true }, async () => new Response("upstream unavailable", { status: 503 }));
    assert.equal(failure.freshness, "stale");
    assert.equal(failure.observations.length, 1);
    assert.match(failure.error, /showing last successful snapshot as stale/i);
    assert.equal(failure.observations[0].observedAt, first.observations[0].observedAt, "original geometry timestamp is preserved, not rewritten");
    assert.equal(failure.observations[0].freshness, "stale");
    assert.equal(failure.observations[0].properties.live, false);
  } finally { Date.now = realNow; }
});

test("WFIGS perimeters are bbox-bounded, simplified and outlined", async () => {
  const ring = Array.from({ length: 500 }, (_, i) => [-120 + Math.cos(i / 80) * 0.1, 40 + Math.sin(i / 80) * 0.1]);
  const f = recorder(() => json({ type: "FeatureCollection", properties: { exceededTransferLimit: true }, features: [
    { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: { poly_IncidentName: "Deep", poly_GISAcres: 404.13, poly_DateCurrent: Date.now() - 3600_000, poly_PolygonDateTime: Date.now() - 7200_000, attr_IncidentTypeCategory: "WF", attr_PercentContained: 100, attr_UniqueFireIdentifier: "2026-OR953S-000489", poly_MapMethod: "IR Image Interpretation", attr_POOState: "US-OR" } },
    { type: "Feature", geometry: null, properties: {} }] }));
  const r = await hz.refreshWfigs(bbox, { network: true }, f);
  const u = new URL(f.calls[0].url);
  assert.equal(u.hostname, "services3.arcgis.com");
  assert.equal(u.searchParams.get("geometry"), "-122,39,-119,42");
  assert.equal(u.searchParams.get("resultRecordCount"), "200");
  assert.equal(r.observations.length, 1); assert.equal(r.truncated, true);
  const o = r.observations[0];
  assert.match(o.label, /Wildfire perimeter: Deep/); assert.equal(o.properties.percentContained, 100);
  assert.equal(o.properties.live, true);
  assert.ok(r.outlines[0].ring.length <= 201);
  const layer = hz.outlineLayer(r.outlines[0]);
  assert.equal(layer.provider, "NIFC WFIGS"); assert.equal(layer.imageUrl, undefined);
});

test("NHC relay output becomes advisory and forecast observations plus a cone outline", async () => {
  const f = recorder(() => json({ provider: "noaa-nhc", retrievedAt: iso(0), gisSourceUrl: "https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer", storms: [
    { id: "al052026", binNumber: "AT5", name: "Testy", classification: "HU", intensityKt: 90, pressureMb: 970, lat: 25.5, lon: -70.1, lastUpdate: iso(3600_000), publicAdvisoryUrl: "https://www.nhc.noaa.gov/text/MIATCPAT5.shtml",
      forecast: { points: [{ type: "Point", coordinates: [-70.1, 25.5], properties: { tau: 0 } }, { type: "Point", coordinates: [-71, 26.5], properties: { tau: 12, maxwind: 95 } }], track: [], cone: [{ type: "Polygon", coordinates: [[[-70, 25], [-72, 27], [-69, 28], [-70, 25]]] }] } }] }));
  const r = await hz.refreshNhc({ network: true }, f);
  assert.equal(f.calls[0].url, "/api/v1/public-imagery/hazards/nhc");
  assert.equal(r.observations.length, 2);
  assert.match(r.observations[0].label, /Hurricane Testy \(advisory position\)/);
  assert.match(r.observations[1].label, /\+12h \(forecast, not observed\)/);
  assert.ok(r.observations.every((o) => o.properties.live === true));
  assert.equal(r.outlines.length, 1); assert.match(r.outlines[0].label, /cone/);
});

test("nowCOAST overlay uses the capabilities' exact time, lat/lon axis order and PNG-only bounded image", async () => {
  const validTime = new Date(Date.now() - 6 * 60_000).toISOString();
  const caps = `<WMS_Capabilities><Capability><Layer><Layer><Name>conus_base_reflectivity_mosaic</Name><Dimension name="time" default="${validTime}" units="ISO8601">${validTime}</Dimension></Layer></Layer></Capability></WMS_Capabilities>`;
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const f = recorder((url) => url.includes("GetCapabilities") ? new Response(caps, { headers: { "content-type": "text/xml" } }) : new Response(png, { headers: { "content-type": "image/png" } }));
  const r = await hz.loadNowCoastOverlay("radar", bbox, { network: true }, f);
  assert.equal(f.calls.length, 2);
  const map = new URL(f.calls[1].url);
  assert.equal(map.origin, "https://nowcoast.noaa.gov");
  assert.equal(map.searchParams.get("bbox"), "39,-122,42,-119");
  assert.equal(map.searchParams.get("time"), validTime);
  assert.equal(map.searchParams.get("crs"), "EPSG:4326");
  assert.equal(r.validTime, validTime); assert.equal(r.layer.provider, "NOAA nowCOAST");
  assert.match(r.layer.productId, /valid .* UTC/); assert.equal(r.layer.freshness, "recent");
  assert.equal(r.blob.type, "image/png");
  const exception = recorder((url) => url.includes("GetCapabilities") ? new Response(caps) : new Response("<ServiceExceptionReport/>", { headers: { "content-type": "application/vnd.ogc.se_xml" } }));
  await assert.rejects(hz.loadNowCoastOverlay("radar", bbox, { network: true }, exception), /non-PNG/);
  const noTime = recorder(() => new Response("<WMS_Capabilities/>"));
  await assert.rejects(hz.loadNowCoastOverlay("goesVisible", bbox, { network: true }, noTime), /exact product time/);
  assert.equal(noTime.calls.length, 1);
});

test("nowCOAST WMS pixels use the exact north-up WGS84 bbox and clip to the imagery AOI", () => {
  const rgba = Uint8ClampedArray.from([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 0, 255,
  ]);
  const surface = hz.buildNowCoastSurface(2, 2, rgba, bbox);
  assert.equal(surface.crs, "EPSG:4326");
  assert.deepEqual(surface.transform, { crs: "EPSG:4326", originX: -122, originY: 42, pixelWidth: 1.5, pixelHeight: -1.5 });
  assert.deepEqual(surface.grid[0], [-122, 42]);
  assert.deepEqual(surface.grid[2], [-119, 42]);
  assert.deepEqual(surface.grid[6], [-122, 39]);
  const imageryAoi = [[-122, 40], [-120, 40], [-120, 43], [-122, 43], [-122, 40]];
  const clipped = raster.maskSurfaceToRing(surface, imageryAoi);
  assert.equal(clipped[3], 255, "north-west WMS texel remains inside the imagery AOI");
  assert.equal(clipped[7], 0, "north-east texel outside the imagery AOI is transparent");
  assert.equal(clipped[11], 0, "south-west texel outside the imagery AOI is transparent");
  assert.equal(surface.rgba[7], 255, "the source surface is immutable; masking returns a clipped copy");
});

test("oversized responses are rejected", async () => {
  const f = async () => new Response("{}", { headers: { "content-length": String(5_000_000) } });
  const r = await hz.refreshWfigs(bbox, { network: true }, f);
  assert.equal(r.freshness, "failed"); assert.match(r.error, /size limit/);
});

test("panel renders opt-in controls without making requests", async () => {
  const require = createRequire(realpathSync(resolve(root, "node_modules/vite/package.json")));
  const { buildSync } = require("esbuild");
  buildSync({ entryPoints: [resolve(root, "src/WorldViewHazards.tsx")], outfile: join(out, "hazards-component.js"), bundle: true, format: "esm", platform: "node", jsx: "automatic", external: ["react", "react-dom"], loader: { ".css": "empty" } });
  const old = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error("unexpected network"); };
  try {
    const { default: Component } = await import(pathToFileURL(join(out, "hazards-component.js")));
    const html = renderToStaticMarkup(createElement(Component, { active: false, network: false }));
    assert.equal(calls, 0);
    assert.match(html, /No hazard provider requests have been made/);
    assert.match(html, /not confirmed fires/);
    assert.match(html, /NASA EONET curated event metadata/);
    assert.match(html, /Fetch EONET event metadata/);
    assert.match(html, /event-specific source link/);
    assert.match(html, /Linked third-party imagery and EONET imagery\/layers are never requested or displayed/);
    assert.match(html, /<button disabled="">Fetch EONET event metadata/);
    assert.match(html, /<button disabled="">Fetch FIRMS detections/);
    assert.doesNotMatch(html, /<img|<iframe/);
    assert.doesNotMatch(html, /UCAS_NASA_FIRMS_MAP_KEY=[A-Za-z0-9]/);
  } finally { globalThis.fetch = old; }
});

test("client source contains no credential and no direct FIRMS API call", () => {
  const src = readFileSync(resolve(root, "src/worldview-hazards.ts"), "utf8") + readFileSync(resolve(root, "src/WorldViewHazards.tsx"), "utf8");
  assert.doesNotMatch(src, /firms\.modaps\.eosdis\.nasa\.gov\/api\/area\/csv\/(?!\[MAP_KEY\])[A-Za-z0-9]/);
  assert.doesNotMatch(src, /import\.meta\.env|process\.env/);
});
