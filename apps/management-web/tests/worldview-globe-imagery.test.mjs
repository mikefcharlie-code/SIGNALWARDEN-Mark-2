import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const root = resolve(import.meta.dirname, "..");
const out = mkdtempSync(join(tmpdir(), "globe-imagery-"));
symlinkSync(resolve(root, "node_modules"), join(out, "node_modules"), "dir");
const require = createRequire(realpathSync(resolve(root, "node_modules/vite/package.json")));
require("esbuild").buildSync({ entryPoints: [resolve(root, "src/WorldGlobe.tsx")], outfile: join(out, "WorldGlobe.js"), bundle: true, format: "esm", platform: "node", jsx: "automatic", external: ["react", "react-dom" ] });
test.after(() => rmSync(out, { recursive: true, force: true }));
const { WorldGlobe } = await import(pathToFileURL(join(out, "WorldGlobe.js")));
const common = { records: [], center: { lat: 38, lon: -77 }, selectedId: null, onSelect: () => {}, onCenter: () => {}, style: "Standard", detection: false, tilt: false, zoom: 1, now: Date.parse("2026-10-23T12:00:00Z") };

test("globe cards show original source, acquisition/retrieval age, coverage and attribution; stale data is explicit", () => {
  const html = renderToStaticMarkup(createElement(WorldGlobe, { ...common, imageryLayers: [{ key: "sar", provider: "ASF Sentinel-1", productId: "S1_TEST", imageUrl: "blob:test", acquisitionStart: "2026-10-01T12:00:00Z", retrievedAt: "2026-10-23T11:00:00.000Z", footprint: [[-78, 38], [-77, 38], [-77, 39], [-78, 38]], attribution: "Copernicus Sentinel data; retrieved from ASF DAAC", license: "Copernicus Sentinel Data Legal Notice", freshness: "stale", refreshState: "current", coverageNote: "Returned footprint intersects the requested visible viewport.", registrationNote: "Genuine browse thumbnail; not georeferenced or draped." }] }));
  for (const text of ["ASF Sentinel-1", "S1_TEST", "Acquired", "22d old", "Coverage:", "Retrieved 2026-10-23T11:00:00.000Z", "Copernicus Sentinel data; retrieved from ASF DAAC", "Genuine browse thumbnail; not georeferenced or draped.", "HISTORICAL / STALE ACQUISITION"]) assert.ok(html.includes(text), text);
  assert.match(html, /src="blob:test"/);
});

test("provider errors are visible and footprint-only metadata never invents an image", () => {
  const html = renderToStaticMarkup(createElement(WorldGlobe, { ...common, imageryLayers: [{ key: "failed", provider: "Umbra Open Data", productId: "UM_TEST", acquisitionStart: null, retrievedAt: "2026-10-23T11:00:00.000Z", footprint: [[-78, 38], [-77, 38], [-77, 39], [-78, 38]], attribution: "Umbra Open Data", license: "unknown", freshness: "unknown", refreshState: "retained-failed", coverageNote: "Footprint from selected metadata.", registrationNote: "Overview not registered." }], imageryStatus: { provider: "ASF Sentinel-1", title: "Refresh failed", detail: "No fallback or fabricated image was used.", tone: "error" } }));
  assert.match(html, /UM_TEST/);
  assert.match(html, /RETAINED AFTER REFRESH FAILURE/);
  assert.match(html, /ACQUISITION AGE UNKNOWN/);
  assert.match(html, /No fallback or fabricated image was used/);
  assert.doesNotMatch(html, /<img /);
});
