import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const out = mkdtempSync(join(tmpdir(), "umbra-raster-"));
writeFileSync(join(out, "package.json"), '{"type":"module"}');
symlinkSync(resolve(here, "../node_modules"), join(out, "node_modules"), "junction");
const compiled = spawnSync(process.execPath, [resolve(here, "../node_modules/typescript/bin/tsc"), resolve(here, "../src/worldview-umbra-raster.ts"), "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--skipLibCheck", "--outDir", out], { encoding: "utf8" });
if (compiled.status !== 0) throw Error(compiled.stdout + compiled.stderr);
const { previewUmbraRaster } = await import(pathToFileURL(join(out, "worldview-umbra-raster.js")).href);
test.after(() => rmSync(out, { recursive: true, force: true }));

function putEntry(view, at, tag, type, count, value) {
  view.setUint16(at, tag, true); view.setUint16(at + 2, type, true); view.setUint32(at + 4, count, true);
  if (type === 3 && count === 1) view.setUint16(at + 8, value, true); else view.setUint32(at + 8, value, true);
}
function fixture() {
  const bytes = new Uint8Array(2048), view = new DataView(bytes.buffer);
  view.setUint16(0, 0x4949, false); view.setUint16(2, 42, true); view.setUint32(4, 8, true);
  view.setUint16(8, 9, true);
  const e0 = 10;
  putEntry(view, e0, 256, 3, 1, 1600); putEntry(view, e0 + 12, 257, 3, 1, 1600); putEntry(view, e0 + 24, 258, 3, 1, 8); putEntry(view, e0 + 36, 259, 3, 1, 1); putEntry(view, e0 + 48, 262, 3, 1, 1); putEntry(view, e0 + 60, 273, 4, 1, 248); putEntry(view, e0 + 72, 278, 4, 1, 1600); putEntry(view, e0 + 84, 279, 4, 1, 1); putEntry(view, e0 + 96, 277, 3, 1, 1); view.setUint32(118, 122, true);
  view.setUint16(122, 10, true); const e1 = 124;
  putEntry(view, e1, 254, 4, 1, 1); putEntry(view, e1 + 12, 256, 3, 1, 4); putEntry(view, e1 + 24, 257, 3, 1, 4); putEntry(view, e1 + 36, 258, 3, 1, 8); putEntry(view, e1 + 48, 259, 3, 1, 1); putEntry(view, e1 + 60, 262, 3, 1, 1); putEntry(view, e1 + 72, 273, 4, 1, 248); putEntry(view, e1 + 84, 278, 4, 1, 4); putEntry(view, e1 + 96, 279, 4, 1, 16); putEntry(view, e1 + 108, 277, 3, 1, 1); view.setUint32(244, 0, true); bytes.set([0, 64, 128, 255, 255, 128, 64, 0, 10, 20, 30, 40, 50, 60, 70, 80], 248);
  return bytes;
}
function rangeFetcher(data, mode = "ok") {
  const calls = [];
  const fetcher = async function (_url, init = {}) {
    assert.equal(this, undefined, "fetch must not inherit the range-source receiver (native browser fetch rejects it)");
    calls.push({ range: init.headers.Range, signal: init.signal });
    if (mode === "full") return new Response(data, { status: 200 });
    const match = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range);
    assert.ok(match);
    const start = Number(match[1]), end = Number(match[2]);
    if (mode === "short") return new Response(data.slice(start, end), { status: 206 });
    return new Response(data.slice(start, end + 1), { status: 206 });
  };
  return { fetcher, calls };
}
const URL = "https://umbra-open-data-catalog.s3.us-west-2.amazonaws.com/sar-data/tasks/Bingham%20Copper%20Mine/example_GEC.tif";

test("decodes a test-only bounded TIFF overview through 206 byte ranges", async () => {
  const data = fixture(); const { fetcher, calls } = rangeFetcher(data);
  const result = await previewUmbraRaster(URL, data.byteLength, undefined, fetcher);
  assert.equal(result.width, 4); assert.equal(result.height, 4); assert.equal(result.sourceWidth, 1600); assert.equal(result.sourceHeight, 1600); assert.equal(result.overviewIndex, 1); assert.equal(result.rgba.length, 64); assert.equal(result.rgba[3], 255); assert.equal(result.stretch, "log1p,2-98percentile"); assert.ok(result.requestCount >= 3); assert.equal(result.requestCount, calls.length); assert.ok(calls.every((call) => call.range.startsWith("bytes=")));
});

test("rejects invalid allowlist URLs before network", async () => {
  let calls = 0; const fetcher = async () => { calls++; throw Error("network"); };
  for (const bad of ["http://" + URL.slice(8), URL.replace(".tif", ".CSI.tif"), URL + "?x=1", URL.replace("example_GEC", "../example_GEC"), "https://user:pass@" + URL.slice(8), URL.replace(".com/", ".com:443/")]) await assert.rejects(() => previewUmbraRaster(bad, 264, undefined, fetcher), /object URL|allowlisted|HTTPS Umbra/);
  assert.equal(calls, 0);
});

test("requires exact 206 body length and never accepts a full download", async () => {
  const data = fixture();
  await assert.rejects(() => previewUmbraRaster(URL, data.byteLength, undefined, rangeFetcher(data, "full").fetcher), /full object/);
  await assert.rejects(() => previewUmbraRaster(URL, data.byteLength, undefined, rangeFetcher(data, "short").fetcher), /body length/);
});

test("enforces the listed-size and range budget", async () => {
  const data = fixture();
  await assert.rejects(() => previewUmbraRaster(URL, 8, undefined, rangeFetcher(data).fetcher), /range|safety|file/i);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => previewUmbraRaster(URL, data.byteLength, controller.signal, rangeFetcher(data).fetcher), /cancel/i);
});

test("a later invalid IFD fails rather than silently accepting an incomplete overview list", async () => {
  const data = fixture();
  new DataView(data.buffer).setUint32(244, data.length + 1000, true);
  await assert.rejects(() => previewUmbraRaster(URL, data.byteLength, undefined, rangeFetcher(data).fetcher), /range|safety/i);
});

test("a streaming oversized 206 body is cancelled before full buffering", { timeout: 2000 }, async () => {
  let cancelled = false;
  const fetcher = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  }), { status: 206 });
  await assert.rejects(() => previewUmbraRaster(URL, 2048, undefined, fetcher), /exceeds the requested range/);
  assert.equal(cancelled, true);
});


test("caller cancellation interrupts even a stalled custom readable body", { timeout: 2000 }, async () => {
  const controller = new AbortController(); let cancelled = false;
  const fetcher = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 206 });
  const timer = setTimeout(() => controller.abort(), 5);
  try { await assert.rejects(() => previewUmbraRaster(URL, 2048, controller.signal, fetcher), /cancel/i); }
  finally { clearTimeout(timer); }
  assert.equal(cancelled, true);
});
