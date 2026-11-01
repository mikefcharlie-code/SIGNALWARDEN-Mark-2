import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const root = fileURLToPath(new URL("..", import.meta.url));
const out = mkdtempSync(join(tmpdir(), "sar-autofetch-"));
const require = createRequire(realpathSync(resolve(root, "node_modules/vite/package.json")));
require("esbuild").buildSync({ entryPoints: [resolve(root, "src/worldview-sar-autofetch.ts")], outfile: join(out, "worldview-sar-autofetch.js"), bundle: true, format: "esm", platform: "node", target: "es2022" });
const { searchSarViewport, fetchSarViewportPreview } = await import(pathToFileURL(join(out, "worldview-sar-autofetch.js")));
test.after(() => rmSync(out, { recursive: true, force: true }));
const timestamp = Date.UTC(2026, 9, 23, 13);
const bounds = [{ west: 170, south: -20, east: 180, north: 20 }, { west: -180, south: -20, east: -170, north: 20 }];
const scene = (id, acquisitionStart, browseUrl) => ({ id, acquisitionStart, productType: "GRD_HD", footprint: [[170, 0], [171, 0], [171, 1], [170, 0]], attribution: "ASF/Copernicus attribution", license: "Copernicus open data", ...(browseUrl ? { browseUrl } : {}) });
const result = (scenes, fetchedAt = "2026-10-23T13:00:00.000Z") => ({ scenes, fetchedAt, queryUrl: "https://asf.example/query", skipped: 0, possiblyTruncated: false });

test("sends only one or two visible WGS84 boxes and rolling UTC dates; deduplicates and chooses newest", async () => {
  const seen = []; const old = scene("older", "2026-10-19T10:00:00Z"); const fresh = scene("newer", "2026-10-22T10:00:00Z", "https://datapool.asf.alaska.edu/BROWSE/SA/S1_ABC.jpg");
  const loaded = await searchSarViewport(bounds, new AbortController().signal, async (query) => { seen.push(query); return result(query.west === 170 ? [old, fresh] : [fresh]); }, () => timestamp);
  assert.equal(seen.length, 2);
  assert.deepEqual(Object.keys(seen[0]).sort(), ["east", "end", "north", "south", "start", "west"]);
  assert.deepEqual(seen.map(({ west, south, east, north }) => ({ west, south, east, north })), bounds);
  assert.ok(seen.every((q) => q.start === "2026-09-23T00:00:00Z" && q.end === "2026-10-23T23:59:59Z"));
  assert.equal(loaded.latest.id, "newer");
  assert.equal(loaded.scenes.length, 2);
  assert.deepEqual(loaded.queryBoxes, bounds);
  assert.equal(loaded.fetchedAt, "2026-10-23T13:00:00.000Z");
});

test("invalid/empty bounds fail closed and no coverage stays explicit", async () => {
  await assert.rejects(searchSarViewport([], new AbortController().signal, async () => result([]), () => timestamp), /Invalid or empty visible-globe bounds/);
  await assert.rejects(searchSarViewport([{ west: -181, south: -5, east: 0, north: 5 }], new AbortController().signal, async () => result([]), () => timestamp), /Invalid or empty visible-globe bounds/);
  const loaded = await searchSarViewport(bounds.slice(0, 1), new AbortController().signal, async () => result([]), () => timestamp);
  assert.equal(loaded.latest, null);
  assert.deepEqual(loaded.scenes, []);
});

test("fetches only the newest returned browse asset, never a fallback; honors cancellation and failure", async () => {
  const chosen = scene("newer", "2026-10-22T10:00:00Z", "https://datapool.asf.alaska.edu/BROWSE/SA/S1_ABC.jpg");
  const requested = []; const blob = new Blob(["actual test preview"], { type: "image/jpeg" });
  assert.equal(await fetchSarViewportPreview(scene("no-browse", "2026-10-22T10:00:00Z"), new AbortController().signal, async () => { throw Error("must not be called"); }), null);
  assert.equal(await fetchSarViewportPreview(chosen, new AbortController().signal, async (url) => { requested.push(url); return blob; }), blob);
  assert.deepEqual(requested, [chosen.browseUrl]);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(fetchSarViewportPreview(chosen, aborted.signal, async () => blob), { name: "AbortError" });
  await assert.rejects(fetchSarViewportPreview(chosen, new AbortController().signal, async () => { throw Error("mock relay outage"); }), /mock relay outage/);
});
