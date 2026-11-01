import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, realpathSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const here = dirname(fileURLToPath(import.meta.url));
const text = name => readFileSync(resolve(here, name), "utf8");
const out = mkdtempSync(join(tmpdir(), "sar-ui-"));
writeFileSync(join(out, "package.json"), '{"type":"module"}\n');
symlinkSync(resolve(here, "../node_modules"), join(out, "node_modules"), "dir");
const compiled = spawnSync(process.execPath, [resolve(here, "../node_modules/typescript/bin/tsc"), resolve(here, "../src/worldview-sar-status.ts"), "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--skipLibCheck", "--outDir", out], { encoding: "utf8" });
assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
const { sarFreshness, SAR_CATALOG_MAX_AGE_MS, SAR_ACQUISITION_MAX_AGE_MS } = await import(pathToFileURL(join(out, "worldview-sar-status.js")));
test.after(() => rmSync(out, { recursive: true, force: true }));

test("real React initial render and module import issue no requests; controls remain opt-in", async () => {
  const require = createRequire(realpathSync(resolve(here, "../node_modules/vite/package.json")));
  const { buildSync } = require("esbuild");
  buildSync({ entryPoints: [resolve(here, "../src/WorldViewSar.tsx")], outfile: join(out, "sar-component.js"), bundle: true, format: "esm", platform: "node", jsx: "automatic", external: ["react", "react-dom"], loader: { ".css": "empty" } });
  const old = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error("unexpected network"); };
  try {
    const { default: Component } = await import(pathToFileURL(join(out, "sar-component.js")));
    const html = renderToStaticMarkup(createElement(Component));
    assert.equal(calls, 0);
    assert.match(html, /<button disabled="">Search \/ refresh SAR<\/button>/);
    assert.match(html, /Disabled\. No public imagery requests have been made/);
    assert.doesNotMatch(html, /<img|<iframe|<link[^>]+(?:preconnect|prefetch)/);
    assert.doesNotMatch(html, /type="checkbox"[^>]*checked/);
  } finally { globalThis.fetch = old; }
});

test("catalog retrieval and acquisition freshness have separate thresholds; invalid/future is unknown", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  assert.equal(sarFreshness(new Date(now - SAR_CATALOG_MAX_AGE_MS).toISOString(), SAR_CATALOG_MAX_AGE_MS, now), "recent");
  assert.equal(sarFreshness(new Date(now - SAR_CATALOG_MAX_AGE_MS - 1).toISOString(), SAR_CATALOG_MAX_AGE_MS, now), "stale");
  assert.equal(sarFreshness(new Date(now - SAR_ACQUISITION_MAX_AGE_MS).toISOString(), SAR_ACQUISITION_MAX_AGE_MS, now), "recent");
  assert.equal(sarFreshness("2020-01-01", SAR_ACQUISITION_MAX_AGE_MS, now), "stale");
  for (const value of [undefined, "", "invalid", "2026-10-24T12:00:00Z"]) assert.equal(sarFreshness(value, SAR_CATALOG_MAX_AGE_MS, now), "unknown");
});

test("SAR workflow remains isolated from observations, hardware, persistence, and auto-fetch effects", () => {
  const ui = text("../src/WorldViewSar.tsx");
  assert.match(ui, /useState\(false\)/);
  assert.match(ui, /if \(!enabled\) return/);
  assert.match(ui, /if \(!enabled \|\| !selected\?\.browseUrl\) return/);
  const effect = ui.slice(ui.indexOf("useEffect(() =>"), ui.indexOf("const selected ="));
  assert.doesNotMatch(effect, /searchSar\(|fetchSarBrowse\(|fetch\(/);
  assert.doesNotMatch(ui, /\b(?:localStorage|sessionStorage|indexedDB|WebSocket|sendBeacon|FormData)\b|command-gateway|WorldObservation|createDemoObservations/);
  assert.match(ui, /request\.current\?\.abort\(\)/);
  assert.match(ui, /generation\.current\+\+/);
  assert.match(ui, /URL\.revokeObjectURL/);
  assert.match(ui, /<img src=\{image\.url\}/);
  assert.doesNotMatch(ui, /<img[^>]*src=\{selected\./);
  assert.match(ui, /Search \/ refresh SAR/);
  assert.match(ui, /Load selected SAR preview/);
  assert.match(ui, /No fallback/);
  assert.match(ui, /RETAINED \/ REFRESH FAILED OR CANCELLED/);
});

test("metadata, licensing, interpretation limits, and no-false-georeferencing notices remain visible", () => {
  const ui = text("../src/WorldViewSar.tsx");
  for (const field of ["acquisitionStart", "acquisitionEnd", "processingTime", "publicationTime", "platform", "sensor", "mode", "polarization", "absoluteOrbit", "relativeOrbit", "direction", "productType", "resolution", "pixelSpacing", "footprint", "attribution", "license"]) assert.ok(ui.includes(`selected.${field}`), field);
  for (const phrase of ["NOT LIVE VIDEO", "Not provided by catalog", "Footprint-only map layer", "NOT stretched over footprints", "Speckle", "look/incidence angle", "layover", "archive latency", "Earthdata Login", "not georeferenced or ground truth"]) assert.ok(ui.includes(phrase), phrase);
  const pkg = JSON.parse(text("../package.json"));
  for (const version of Object.values({ ...pkg.dependencies, ...pkg.devDependencies })) assert.match(version, /^\d+\.\d+\.\d+$/);
  const notices = text("../public/worldview-sar-notices.txt");
  assert.match(notices, /Copernicus/);
  assert.match(notices, /https:\/\//);
});
