import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, realpathSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const root = resolve(import.meta.dirname, "..");
const text = name => readFileSync(resolve(root, name), "utf8");
const out = mkdtempSync(join(tmpdir(), "umbra-ui-"));
writeFileSync(join(out, "package.json"), '{"type":"module"}\n');
symlinkSync(resolve(root, "node_modules"), join(out, "node_modules"), "dir");
const require = createRequire(realpathSync(resolve(root, "node_modules/vite/package.json")));
const { buildSync } = require("esbuild");
test.after(() => rmSync(out, { recursive: true, force: true }));

test("real Umbra and selector imports/SSR make no requests; source switch does not bypass opt-in", async () => {
  const old = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => { requests++; throw Error("unexpected provider fetch"); };
  try {
    for (const entry of ["WorldViewUmbra", "WorldViewSarSources"]) {
      buildSync({ entryPoints: [resolve(root, `src/${entry}.tsx`)], outfile: join(out, `${entry}.js`), bundle: true, format: "esm", platform: "node", jsx: "automatic", external: ["react", "react-dom"], loader: { ".css": "empty" } });
      const { default: Component } = await import(pathToFileURL(join(out, `${entry}.js`)));
      const html = renderToStaticMarkup(createElement(Component));
      assert.doesNotMatch(html, /<img|<iframe|<canvas|rel="(?:preconnect|prefetch)"/);
      assert.doesNotMatch(html, /type="checkbox"[^>]*checked/);
      if (entry === "WorldViewUmbra") {
        assert.match(html, /<button disabled="">Search \/ refresh Umbra directory<\/button>/);
        assert.match(html, /Disabled\. No Umbra requests have been made/);
      } else {
        assert.match(html, /aria-label="SAR imagery source"/);
        assert.match(html, /value="" selected="">Choose a source \(no provider selected\)/);
        assert.match(html, /ASF — Sentinel-1 acquisitions/);
        assert.match(html, /Enable automatic refresh of the selected ASF source/);
        assert.match(html, /Umbra directory discovery stays manual/);
        assert.match(html, /Select ASF Sentinel-1 or Umbra/);
      }
    }
    assert.equal(requests, 0);
  } finally { globalThis.fetch = old; }
});

test("source selection is explicit and stored separately from the one-time auto-refresh permission", () => {
  const source = text("src/WorldViewSarSources.tsx");
  assert.match(source, /source === "asf" \? <WorldViewSar key=\{`asf-\$\{props\.resetKey\}`\} onLayer=\{props\.onLayer\} \/> : source === "umbra"/);
  assert.doesNotMatch(source, /fetch\(|useEffect|indexedDB|WebSocket|sendBeacon|FormData/);
  assert.match(source, /localStorage\.setItem\(SOURCE_KEY, value\)/);
  assert.match(source, /autoRefresh: boolean/);
  assert.match(source, /no global spatial\/date search/);
  const ui = text("src/WorldViewUmbra.tsx");
  assert.match(ui, /useState\(false\)/);
  assert.match(ui, /generation\.current\+\+/);
  assert.match(ui, /request\.current\?\.abort\(\)/);
  assert.match(ui, /if \(!enabled\) return/);
  assert.doesNotMatch(ui, /\/api\/v1\/public-imagery|searchSar\(|fetchSarBrowse\(|localStorage|sessionStorage|indexedDB|WebSocket|sendBeacon|FormData|WorldObservation/);
});

test("Umbra separates source metadata, object modification and optional publication rather than inventing recency", () => {
  const ui = text("src/WorldViewUmbra.tsx");
  for (const field of ["id", "sourceUrl", "acquisitionStart", "acquisitionEnd", "processingTime", "publicationTime", "objectLastModified", "platform", "sensor", "mode", "polarization", "direction", "absoluteOrbit", "relativeOrbit", "productType", "rangeResolution", "azimuthResolution", "pixelSpacing", "footprint", "providerLicense", "attribution"]) assert.ok(ui.includes(`metadata.${field}`), field);
  for (const phrase of ["NOT LIVE VIDEO", "lexicographic, NOT newest-first", "No full-file fallback", "RETAINED / REQUEST FAILED OR CANCELLED", "OLDER ACQUISITION", "generic website terms", "CC BY 4.0", "Speckle", "dataset latency", "Footprint-only map layer"]) assert.ok(ui.includes(phrase), phrase);
  assert.match(ui, /snapshot\.truncated/); assert.match(ui, /Load next Umbra directory page/);
  assert.match(ui, /o\.kind === "raster" && stem\(o\.key\) === stem\(metadataSourceKey\)/);
});

test("pixel display occurs only after explicit range preview and has no remote image element", () => {
  const ui = text("src/WorldViewUmbra.tsx");
  assert.doesNotMatch(ui, /<img|<iframe|fromUrl\(/);
  assert.match(ui, /previewUmbraRaster\(imageObject\.url, imageObject\.size, signal\)/);
  assert.match(ui, /context\.putImageData/);
  assert.match(ui, /if \(!current\(\)\) return/);
  assert.match(ui, /not a calibrated measurement, generated image, or verified ground truth/);
  const effects = ui.slice(ui.indexOf("useEffect(() =>"), ui.indexOf("const perform ="));
  assert.doesNotMatch(effects, /fetch\(|listUmbra\(|loadUmbraMetadata\(|previewUmbraRaster\(/);
});
