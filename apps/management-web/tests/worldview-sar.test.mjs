import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
const root = resolve(import.meta.dirname, "..");
const out = mkdtempSync(join(tmpdir(), "worldview-sar-"));
writeFileSync(join(out, "package.json"), '{"type":"module"}\n');
const compile = spawnSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), resolve(root, "src/worldview-sar.ts"), "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--skipLibCheck", "--outDir", out], { encoding: "utf8", cwd: out });
if (compile.status !== 0) throw new Error(`Unable to compile worldview-sar.ts:\n${compile.stdout}\n${compile.stderr}`);
const sar = await import(`${pathToFileURL(join(out, "worldview-sar.js")).href}?${Date.now()}`);
test.after(() => rmSync(out, { recursive: true, force: true }));
const query = { west: -122, south: 37, east: -121, north: 38, start: "2025-01-01T00:00:00Z", end: "2025-01-10T00:00:00Z" };
const feature = (id, start, extra = {}) => ({ type: "Feature", geometry: { type: "Polygon", coordinates: [[[-122, 37], [-121, 37], [-121, 38], [-122, 37]]] }, properties: { fileID: id, startTime: start, stopTime: start, processingLevel: "GRD_HD", browse: [`https://datapool.asf.alaska.edu/BROWSE/SA/${id}.jpg`], ...extra } });
const collection = features => ({ type: "FeatureCollection", features });
const response = (body, headers = { "content-type": "application/geo+json" }, status = 200) => new Response(body instanceof Uint8Array ? body : (typeof body === "string" ? body : JSON.stringify(body)), { status, headers });
const jpeg = Uint8Array.from([255,216,255,192,0,17,8,0,1,0,1,3,1,17,0,2,17,0,3,17,0,255,217]);
const browse = "https://datapool.asf.alaska.edu/BROWSE/SD/S1D_IW_GRDH_1SDV_20261021T230634_20261021T230659_005120_009B33_6409.jpg";

test("search builds only ASF GRD_HD filters and preserves acquisition/provenance, not guessed publication", async () => {
  let seen;
  const result = await sar.searchSar(query, undefined, async (url, init) => { seen = { url, init }; return response(collection([feature("old", "2025-01-02T00:00:00Z"), feature("new", "2025-01-08T00:00:00Z", { platform: "Sentinel-1A", sensor: "C-SAR", beamModeType: "IW", polarization: "VV+VH", orbit: 3, pathNumber: 42, flightDirection: "DESCENDING", processingDate: "2025-01-08T01:00:00Z", pixelSpacing: "10 m (provider test metadata)" }), { bad: true }])); });
  const url = new URL(seen.url);
  assert.equal(url.origin, "https://api.daac.asf.alaska.edu");
  assert.deepEqual([...url.searchParams.keys()].sort(), ["platform", "processingLevel", "bbox", "start", "end", "output", "maxresults"].sort());
  assert.equal(url.searchParams.get("processingLevel"), "GRD_HD");
  assert.equal(seen.init.credentials, "omit"); assert.equal(seen.init.referrerPolicy, "no-referrer"); assert.equal(seen.init.redirect, "error"); assert.equal(seen.init.cache, "no-store");
  assert.deepEqual(result.scenes.map(s => s.id), ["new", "old"]); assert.equal(result.skipped, 1); assert.equal(result.possiblyTruncated, false);
  const scene = result.scenes[0];
  assert.equal(scene.relativeOrbit, 42); assert.equal(scene.absoluteOrbit, 3); assert.equal(scene.direction, "DESCENDING");
  assert.equal(scene.processingTime, "2025-01-08T01:00:00.000Z"); assert.equal(scene.acquisitionStart, "2025-01-08T00:00:00.000Z");
  assert.equal(scene.publicationTime, undefined); assert.equal(scene.resolution, undefined); assert.equal(scene.pixelSpacing, "10 m (provider test metadata)");
  assert.match(scene.attribution, /Contains modified Copernicus Sentinel data 2025/); assert.match(scene.license, /Legal Notice/);
});

test("rejects invalid bounds and dates before network", async () => {
  let calls = 0; const fetcher = async () => { calls++; return response({}); };
  for (const invalid of [{ west: 1, east: 1 }, { west: 170, east: -170 }, { north: 91 }, { south: NaN }, { west: -181 }, { start: "invalid" }, { start: "2025-02-01", end: "2025-01-01" }]) await assert.rejects(sar.searchSar({ ...query, ...invalid }, undefined, fetcher), /bounding box|date range/);
  assert.equal(calls, 0);
});

test("unsafe or missing browse URL does not discard source footprint or invent an image", async () => {
  const result = await sar.searchSar(query, undefined, async () => response(collection([feature("x", "2025-01-01T00:00:00Z", { browse: ["https://evil.example/x.jpg"], url: "https://evil.example/raw.zip" })])));
  assert.equal(result.scenes[0].browseUrl, undefined); assert.equal(result.scenes[0].sourceUrl, undefined); assert.equal(result.scenes[0].footprint.length, 4);
});

test("browse uses only fixed same-origin relay with selected product id, no cookies/referrer and explicit header", async () => {
  let seen;
  const blob = await sar.fetchSarBrowse(browse, undefined, async (url, init) => { seen = { url, init }; return response(jpeg, { "content-type": "image/jpeg" }); });
  assert.match(seen.url, /^\/api\/v1\/public-imagery\/sar\/browse\?product=S1D_/);
  assert.doesNotMatch(seen.url, /https|Signature|token/);
  assert.equal(seen.init.headers["X-SignalWarden-SAR"], "enabled");
  assert.equal(blob.type, "image/jpeg"); assert.equal(blob.size, 23); assert.equal(seen.init.credentials, "omit"); assert.equal(seen.init.referrerPolicy, "no-referrer"); assert.equal(seen.init.redirect, "error");
});

test("malicious image URL, credentials, port, protocol, path, and query fail before request", async () => {
  let calls = 0; const fetcher = async () => { calls++; return response(jpeg, { "content-type": "image/jpeg" }); };
  for (const url of ["https://evil.example/x.jpg", browse.replace("https:", "http:"), browse.replace("datapool.asf.alaska.edu", "user:pass@datapool.asf.alaska.edu"), browse.replace(".edu/", ".edu:444/"), browse + "?token=x", browse + "#x", "https://datapool.asf.alaska.edu/BROWSE/SA/../x.jpg"]) await assert.rejects(sar.fetchSarBrowse(url, undefined, fetcher), /allowlisted/);
  assert.equal(calls, 0);
});

test("browse errors, wrong MIME, oversized bytes, corrupt image and excessive dimensions fail visibly", async () => {
  await assert.rejects(sar.fetchSarBrowse(browse, undefined, async () => response("disabled", {}, 503)), /UCAS_PUBLIC_SAR_ENABLED/);
  await assert.rejects(sar.fetchSarBrowse(browse, undefined, async () => response("bad", {}, 502)), /502/);
  await assert.rejects(sar.fetchSarBrowse(browse, undefined, async () => response("x", { "content-type": "text/html" })), /not an image/);
  await assert.rejects(sar.fetchSarBrowse(browse, undefined, async () => response(new Uint8Array(10), { "content-type": "image/jpeg", "content-length": "9000000" })), /8 MiB/);
  await assert.rejects(sar.fetchSarBrowse(browse, undefined, async () => response(new Uint8Array(8 * 1024 * 1024 + 1), { "content-type": "image/jpeg" })), /byte limit/);
  await assert.rejects(sar.fetchSarBrowse(browse, undefined, async () => response("not a JPEG", { "content-type": "image/jpeg" })), /dimensions/);
  const huge = jpeg.slice(); huge[7] = 127; huge[8] = 255;
  await assert.rejects(sar.fetchSarBrowse(browse, undefined, async () => response(huge, { "content-type": "image/jpeg" })), /dimensions/);
});

test("catalog outages and malformed payloads never become successful empty responses", async () => {
  for (const body of ["not json", {}, { type: "Feature", features: [] }, { type: "FeatureCollection", features: null }]) await assert.rejects(sar.searchSar(query, undefined, async () => response(body)), /malformed|FeatureCollection/);
  await assert.rejects(sar.searchSar(query, undefined, async () => response("unavailable", {}, 503)), /503/);
  const empty = await sar.searchSar(query, undefined, async () => response(collection([])));
  assert.equal(empty.scenes.length, 0);
});

test("catalog size/feature limits and truncation are explicit", async () => {
  await assert.rejects(sar.searchSar(query, undefined, async () => response("{}", { "content-length": String(4 * 1024 * 1024 + 1) })), /byte limit/);
  await assert.rejects(sar.searchSar(query, undefined, async () => response(collection(Array.from({ length: 51 }, () => feature("x", "2025-01-01"))))), /50-result/);
  const result = await sar.searchSar(query, undefined, async () => response(collection(Array.from({ length: 50 }, (_, i) => feature(`id${i}`, "2025-01-01")))));
  assert.equal(result.possiblyTruncated, true);
});

test("caller abort signal is passed into both network operations", async () => {
  const controller = new AbortController(); controller.abort();
  const aborted = async (_url, init) => { assert.equal(init.signal.aborted, true); throw new DOMException("aborted", "AbortError"); };
  await assert.rejects(sar.searchSar(query, controller.signal, aborted), /aborted/);
  await assert.rejects(sar.fetchSarBrowse(browse, controller.signal, aborted), /aborted/);
});

test("20-second deadline aborts a stalled provider rather than polling or retrying", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const pending = sar.searchSar(query, undefined, (_url, init) => new Promise((_resolve, reject) => { calls++; init.signal.addEventListener("abort", () => reject(new DOMException("deadline aborted", "AbortError"))); }));
  const assertion = assert.rejects(pending, /deadline aborted/);
  t.mock.timers.tick(20_000);
  await assertion;
  assert.equal(calls, 1);
});
