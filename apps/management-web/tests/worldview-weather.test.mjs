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
const out = mkdtempSync(join(tmpdir(), "worldview-weather-"));
writeFileSync(join(out, "package.json"), '{"type":"module"}\n');
symlinkSync(resolve(here, "../node_modules"), join(out, "node_modules"), "dir");
const compiled = spawnSync(process.execPath, [
  resolve(here, "../node_modules/typescript/bin/tsc"), resolve(here, "../src/worldview-weather.ts"),
  "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--skipLibCheck", "--outDir", out,
], { encoding: "utf8" });
assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
const target = join(out, "worldview-weather.js");
writeFileSync(target, readFileSync(target, "utf8").replace(/(['"])\.\/worldview-core\1/g, '"./worldview-core.js"'));
const W = await import(pathToFileURL(target).href);
test.after(() => rmSync(out, { recursive: true, force: true }));

const NOW = Date.parse("2026-10-30T21:30:00Z");
const json = (value, status = 200) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return { ok: status >= 200 && status < 300, status, headers: new Headers({ "content-length": String(bytes.byteLength) }),
    body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }) };
};
const FORECAST = {
  latitude: 38.91, longitude: -76.99,
  hourly_units: { time: "iso8601", wind_speed_10m: "m/s", wind_speed_80m: "m/s", wind_speed_120m: "m/s" },
  hourly: { time: ["2026-10-30T21:00", "2026-10-30T22:00"], temperature_2m: [23, 20], wind_speed_10m: [3.85, 4.34], wind_direction_10m: [311, 347],
    wind_speed_80m: [6.23, 8.5], wind_direction_80m: [313, 346], wind_speed_120m: [8.49, 8.21], wind_direction_120m: [333, 339],
    wind_gusts_10m: [7.7, 10.5], cloud_cover: [0, 0], precipitation: [0, 0] },
};
const AQ = { latitude: 38.9, longitude: -77, hourly_units: { us_aqi: "USAQI" }, hourly: { time: ["2026-10-30T21:00"], pm2_5: [4.2], pm10: [4.5], ozone: [91], nitrogen_dioxide: [4.4], us_aqi: [44] } };
const META = { last_run_initialisation_time: 1793361600 };
const opts = (fetcher, extra = {}) => ({ network: true, openMeteoTermsConfirmed: true, fetcher, now: () => NOW, ...extra });
test.beforeEach(() => W.resetWeatherState());

test("nothing is requested without explicit opt-in", async () => {
  let calls = 0;
  const fetcher = async () => { calls++; throw Error("must not call"); };
  for (const r of [
    await W.refreshOpenMeteoForecast({ lat: 1, lon: 2 }, "gfs_seamless", { fetcher }),
    await W.refreshOpenMeteoAirQuality({ lat: 1, lon: 2 }, { fetcher }),
    await W.refreshOpenAq({ lat: 1, lon: 2 }, { fetcher }),
    await W.refreshOpenSky(W.bboxAround({ lat: 1, lon: 2 }, 1), { fetcher }),
  ]) { assert.equal(r.status, "failed"); assert.match(r.error, /opt-in/); }
  await assert.rejects(W.lookupAircraftType("aa2b21", { fetcher }), /opt-in/);
  assert.equal(calls, 0);
});

test("Open-Meteo requires explicit terms consent even when network is enabled", async () => {
  let calls = 0;
  const options = { network: true, fetcher: async () => { calls++; throw Error("must not call"); } };
  for (const result of [await W.refreshOpenMeteoForecast({ lat: 1, lon: 2 }, "gfs_seamless", options), await W.refreshOpenMeteoAirQuality({ lat: 1, lon: 2 }, options)]) {
    assert.equal(result.status, "failed"); assert.match(result.error, /non-commercial terms/);
  }
  assert.equal(calls, 0);
});

test("direct GFS forecast: bounded keyless URL, model run, provenance on the observation", async () => {
  const urls = [];
  const fetcher = async (url, init) => { urls.push({ url, init }); return json(url.includes("meta.json") ? META : FORECAST); };
  const r = await W.refreshOpenMeteoForecast({ lat: 38.912345, lon: -77 }, "gfs_seamless", opts(fetcher));
  const u = new URL(urls[0].url);
  assert.equal(u.origin, "https://api.open-meteo.com");
  assert.equal(u.searchParams.get("models"), "gfs_seamless");
  assert.equal(u.searchParams.get("forecast_hours"), "48");
  assert.equal(u.searchParams.get("latitude"), "38.9123");
  for (const v of ["wind_speed_80m", "wind_direction_120m", "wind_gusts_10m", "cloud_cover", "precipitation"]) assert.match(u.searchParams.get("hourly"), new RegExp(v));
  assert.equal(u.searchParams.get("apikey"), null);
  assert.equal(urls[0].init.credentials, "omit");
  assert.equal(urls[0].init.redirect, "error");
  assert.match(urls[1].url, /\/data\/ncep_gfs025\/static\/meta\.json$/);
  assert.equal(r.status, "live"); assert.equal(r.freshness, "fresh"); assert.equal(r.route, "direct");
  assert.equal(r.series.length, 2); assert.equal(r.modelRun, "2026-10-30T12:00:00.000Z");
  const o = r.observations[0];
  assert.equal(o.layer, "weather"); assert.equal(o.observedAt, r.modelRun);
  assert.equal(o.source, "Open-Meteo model · NOAA GFS");
  assert.equal(o.properties.wind_speed_120m, 8.49);
  for (const k of ["provider", "sourceUrl", "retrievedAt", "providerTimestamp", "ageSeconds", "attribution", "termsUrl", "licenseUrl"]) assert.ok(o.properties[k] != null, k);
  assert.match(o.properties.attribution, /Open-Meteo\.com/); assert.match(o.properties.attribution, /NOAA Global Forecast System/);
  assert.match(o.properties.dataKind, /not an observation/);
  const again = await W.refreshOpenMeteoForecast({ lat: 1, lon: 1 }, "gfs_seamless", opts(fetcher));
  assert.equal(again.status, "throttled"); assert.equal(urls.length, 2);
});

test("ECMWF attribution statement; stale model run and uncovered hour are not claimed live", async () => {
  const fetcher = async (url) => json(url.includes("meta.json") ? { last_run_initialisation_time: 1793361600 - 86400 } : FORECAST);
  const r = await W.refreshOpenMeteoForecast({ lat: 38.9, lon: -77 }, "ecmwf_ifs025", opts(fetcher));
  assert.match(r.attribution, /© ECMWF/); assert.match(r.attribution, /CC BY 4\.0/); assert.match(r.attribution, /liability/); assert.match(r.attribution, /modified/);
  assert.equal(r.freshness, "stale"); assert.equal(r.status, "stale");
  W.resetWeatherState();
  const late = await W.refreshOpenMeteoForecast({ lat: 38.9, lon: -77 }, "icon_seamless", opts(fetcher, { now: () => NOW + 5 * 3600_000 }));
  assert.equal(late.observations.length, 0); assert.match(late.error, /current hour/);
});

test("a current-hour forecast without a validated model-run timestamp is unknown, not live", async () => {
  const fetcher = async (url) => json(url.includes("meta.json") ? {} : FORECAST);
  const result = await W.refreshOpenMeteoForecast({ lat: 38.9, lon: -77 }, "gfs_seamless", opts(fetcher));
  assert.equal(result.freshness, "unknown");
  assert.equal(result.status, "unknown");
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].freshness, "unknown");
  assert.equal(result.modelRun, undefined);
});

test("modelled air quality is labelled modelled; oversize and provider errors fail closed", async () => {
  const r = await W.refreshOpenMeteoAirQuality({ lat: 38.9, lon: -77 }, opts(async () => json(AQ)));
  assert.equal(r.status, "unknown");
  assert.match(r.error, /model-run timestamp unavailable/);
  const o = r.observations[0];
  assert.equal(o.properties.dataKind, "modelled"); assert.match(o.label, /MODELLED/); assert.equal(o.properties.us_aqi, 44);
  assert.match(o.properties.attribution, /CAMS/);
  W.resetWeatherState();
  const big = await W.refreshOpenMeteoAirQuality({ lat: 1, lon: 1 }, opts(async () => ({ ok: true, status: 200, headers: new Headers({ "content-length": "2000000" }), body: null })));
  assert.equal(big.status, "failed"); assert.match(big.error, /1 MB/);
  W.resetWeatherState();
  const quota = await W.refreshOpenMeteoAirQuality({ lat: 1, lon: 1 }, opts(async () => json({ error: true, reason: "Daily API request limit exceeded." }, 429)));
  assert.equal(quota.status, "throttled"); assert.match(quota.error, /Daily API request limit/);
});

test("commercial Open-Meteo goes through the same-origin relay; no key exists client-side", async () => {
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url, init }); return json({ sourceUrl: "https://customer-api.open-meteo.com/v1/forecast?latitude=1", tier: "commercial", modelRun: "2026-10-30T12:00:00Z", data: FORECAST }); };
  const r = await W.refreshOpenMeteoForecast({ lat: 38.9, lon: -77 }, "gfs_seamless", opts(fetcher, { relay: true }));
  assert.match(calls[0].url, /^\/api\/v1\/worldview-weather\/open-meteo\/forecast\?lat=38\.9&lon=-77&model=gfs_seamless$/);
  assert.equal(calls[0].init.headers["X-SignalWarden-Weather"], "enabled");
  assert.equal(r.route, "relay"); assert.equal(r.observations[0].properties.tier, "commercial");
  const source = readFileSync(resolve(here, "../src/worldview-weather.ts"), "utf8") + readFileSync(resolve(here, "../src/WorldViewWeather.tsx"), "utf8");
  assert.doesNotMatch(source, /import\.meta\.env|apikey=|X-API-Key|client_secret|Authorization:/);
});

test("relay states: disabled and OpenAQ not_configured are explicit, never fabricated", async () => {
  const disabled = await W.refreshOpenAq({ lat: 1, lon: 1 }, opts(async () => json({ error: { code: "weather_relay_disabled", message: "disabled" } }, 404)));
  assert.equal(disabled.status, "disabled"); assert.match(disabled.error, /UCAS_WORLDVIEW_WEATHER_ENABLED=1/); assert.equal(disabled.observations.length, 0);
  const missing = await W.refreshOpenAq({ lat: 1, lon: 1 }, opts(async () => json({ error: { code: "not_configured", message: "OpenAQ is not configured; set UCAS_OPENAQ_API_KEY on the API server" } }, 503)));
  assert.equal(missing.status, "not_configured"); assert.match(missing.error, /UCAS_OPENAQ_API_KEY/); assert.equal(missing.observations.length, 0);
  const status = await W.fetchWeatherRelayStatus(opts(async () => json({ error: { code: "weather_relay_disabled" } }, 404)));
  assert.equal(status.enabled, false);
});

test("OpenAQ measured stations carry per-station provenance and measured label", async () => {
  const license = { id: 10, name: "CC BY 4.0", sourceUrl: "https://creativecommons.org/licenses/by/4.0/", attribution: "AirNow",
    commercialUseAllowed: true, attributionRequired: true, shareAlikeRequired: false, modificationAllowed: true, redistributionAllowed: true,
    dateFrom: "2020-01-01", dateTo: "" };
  const body = { sourceUrl: "https://api.openaq.org/v3/locations?coordinates=35.1,-106.6&radius=25000&limit=10", retrievedAt: "2026-10-30T21:30:00Z", stations: [
    { locationId: 2178, label: "Del Norte", isMonitor: true, dataProvider: "AirNow", lat: 35.1353, lon: -106.5847, sourceUrl: "https://explore.openaq.org/locations/2178",
      licenses: [license],
      measurements: [{ parameter: "pm25", units: "µg/m³", value: 4.4, datetimeUtc: "2026-10-30T21:00:00Z", licenseId: 10 }, { parameter: "o3", units: "ppm", value: 0.031, datetimeUtc: "2026-10-30T21:00:00Z", licenseId: 10 }] },
    { locationId: 9, label: "old", lat: 35.2, lon: -106.6, licenses: [license], measurements: [{ parameter: "pm25", value: 1, datetimeUtc: "2026-10-29T00:00:00Z", licenseId: 10 }] },
    { locationId: 10, label: "future", lat: 1, lon: 1, measurements: [{ parameter: "pm25", value: 1, datetimeUtc: "2030-01-01T00:00:00Z" }] },
  ] };
  const r = await W.refreshOpenAq({ lat: 35.1, lon: -106.6 }, opts(async () => json(body)));
  assert.equal(r.observations.length, 2);
  const [fresh, old] = r.observations;
  assert.equal(fresh.properties.dataKind, "measured"); assert.match(fresh.label, /MEASURED/); assert.equal(fresh.freshness, "fresh");
  assert.equal(fresh.properties.pm25, 4.4); assert.equal(fresh.properties.sourceUrl, "https://explore.openaq.org/locations/2178");
  assert.match(fresh.properties.attribution, /CC BY 4.0/);
  assert.equal(old.freshness, "stale"); assert.equal(r.status, "stale");
});

test("OpenSky aircraft: identity fields never copied, future positions dropped, bbox bounded", async () => {
  let url = "";
  const body = { mode: "anonymous", providerTime: "2026-10-30T21:29:58Z", sourceUrl: "https://opensky-network.org/api/states/all?lamin=38", states: [
    { icao24: "aa2b21", lat: 38.945, lon: -77.47, baroAltitudeM: 1440, velocityMs: 112, timePosition: NOW / 1000 - 6, callsign: "RPA3583", squawk: "7147", originCountry: "United States", registration: "N1" },
    { icao24: "a33332", lat: 38.57, lon: -77.46, timePosition: NOW / 1000 + 600 },
    { icao24: "BAD", lat: 1, lon: 1, timePosition: NOW / 1000 },
  ] };
  const r = await W.refreshOpenSky(W.bboxAround({ lat: 38.9, lon: -77.1 }, 1), opts(async (u) => { url = u; return json(body); }));
  assert.match(url, /^\/api\/v1\/worldview-weather\/opensky\/states\?lamin=37\.9&lomin=-78\.1&lamax=39\.9&lomax=-76\.1$/);
  assert.equal(r.observations.length, 1);
  const o = r.observations[0];
  assert.equal(o.id, "opensky-aa2b21"); assert.equal(o.layer, "aircraft"); assert.equal(o.properties.opaqueContactHex, "aa2b21");
  assert.doesNotMatch(JSON.stringify(r), /RPA3583|7147|United States|N1"/);
  assert.equal(o.properties.attribution, "The OpenSky Network, https://opensky-network.org");
  const tooBig = await W.refreshOpenSky({ lamin: 0, lomin: 0, lamax: 6, lomax: 1 }, opts(async () => { throw Error("no"); }));
  assert.equal(tooBig.status, "failed");
  assert.deepEqual(W.bboxAround({ lat: 89.5, lon: 179.5 }, 9), { lamin: 87, lamax: 90, lomin: 177, lomax: 180 });
});

test("adsbdb: single selected aircraft, TYPE only, cached", async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return json({ icao24: "aa2b21", found: true, type: "ERJ 170-200 LR", icaoType: "E75L", manufacturer: "Embraer", registration: "N754YX", registeredOwner: "Republic Airways", sourceUrl: "https://api.adsbdb.com/v0/aircraft/aa2b21" }); };
  const t = await W.lookupAircraftType("aa2b21", opts(fetcher));
  assert.deepEqual(Object.keys(t).sort(), ["attribution", "found", "icao24", "icaoType", "manufacturer", "retrievedAt", "sourceUrl", "type"]);
  assert.equal(t.type, "ERJ 170-200 LR"); assert.doesNotMatch(JSON.stringify(t), /N754YX|Republic/);
  await W.lookupAircraftType("aa2b21", opts(fetcher));
  assert.equal(calls, 1);
  await assert.rejects(W.lookupAircraftType("N754YX", opts(fetcher)), /transponder hex/);
  assert.equal(calls, 1);
});

test("merge replaces only that provider; failures keep the snapshot but mark it stale", () => {
  const records = [{ id: "a", source: "OpenSky Network", layer: "aircraft", point: { lat: 0, lon: 0 }, observedAt: "2026-10-30T21:00:00Z", label: "x", freshness: "fresh" },
    { id: "b", source: "USGS", layer: "earthquakes", point: { lat: 0, lon: 0 }, observedAt: "2026-10-30T21:00:00Z", label: "y", freshness: "fresh" }];
  const failed = W.mergeProviderObservations(records, { providerId: "opensky", observations: [], status: "failed", error: "x", freshness: "failed" }, "OpenSky");
  assert.equal(failed[0].freshness, "stale"); assert.equal(failed[0].stale, true); assert.equal(failed[1].freshness, "fresh");
  const live = W.mergeProviderObservations(records, { providerId: "opensky", observations: [{ ...records[0], id: "c" }], status: "live", freshness: "fresh" }, "OpenSky");
  assert.deepEqual(live.map((r) => r.id), ["b", "c"]);
});

test("panel render issues no requests and every control starts disabled", async () => {
  const require = createRequire(realpathSync(resolve(here, "../node_modules/vite/package.json")));
  const { buildSync } = require("esbuild");
  buildSync({ entryPoints: [resolve(here, "../src/WorldViewWeather.tsx")], outfile: join(out, "weather-component.js"), bundle: true, format: "esm", platform: "node", jsx: "automatic", external: ["react", "react-dom"], loader: { ".css": "empty" } });
  const old = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error("unexpected network"); };
  try {
    const { WorldViewWeather } = await import(pathToFileURL(join(out, "weather-component.js")));
    const html = renderToStaticMarkup(createElement(WorldViewWeather, { center: { lat: 38.9, lon: -77 }, selected: null }));
    assert.equal(calls, 0);
    assert.doesNotMatch(html, /type="checkbox"[^>]*checked/);
    for (const label of ["Check local relay", "Refresh model forecast", "Refresh modelled AQ (CAMS)", "Refresh measured AQ (OpenAQ · relay)", "Refresh OpenSky aircraft (relay)", "Select an aircraft to look up its type"])
      assert.match(html, new RegExp(`<button disabled="">${label.replace(/[().]/g, "\\$&")}</button>`));
    assert.match(html, /Weather data by Open-Meteo\.com/); assert.match(html, /non-commercial/);
    assert.doesNotMatch(html, /<img|<iframe/);
  } finally { globalThis.fetch = old; }
});

test("WorldView mounts the panel with a minimal edit and no flight-control surface", () => {
  const view = readFileSync(resolve(here, "../src/WorldView.tsx"), "utf8");
  assert.match(view, /<WorldViewWeather active=\{globeActive\} center=\{center\} selected=\{selected\?\.raw \?\? null\} onRecords=\{setRecords\} \/>/);
  const panel = readFileSync(resolve(here, "../src/WorldViewWeather.tsx"), "utf8") + readFileSync(resolve(here, "../src/worldview-weather.ts"), "utf8");
  assert.doesNotMatch(panel, /mavlink|\barm\(|takeoff|setMode\(|flightMode|method: "POST"/i);
});
