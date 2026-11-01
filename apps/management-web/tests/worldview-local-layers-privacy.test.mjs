import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const text = path => readFileSync(new URL(path, import.meta.url), "utf8");

test("offline modules expose no network/upload/persistence API or ambient telemetry source", () => {
  for (const file of ["worldview-local-raster.ts", "worldview-local-hex.ts", "WorldViewLocalLayers.tsx"]) {
    const source = text(`../src/${file}`);
    assert.doesNotMatch(source, /\b(?:fetch|fromUrl|fromUrls|XMLHttpRequest|WebSocket|sendBeacon|FormData)\s*\(/);
    assert.doesNotMatch(source, /\b(?:localStorage|sessionStorage|indexedDB)\b/);
    assert.doesNotMatch(source, /refreshUsgs|refreshNoaa|refreshAdsb|aircraft_gateway|\/api\//);
  }
  assert.match(text("../src/worldview-local-raster.ts"), /fromBlob\(file\)/);
  const ui = text("../src/WorldViewLocalLayers.tsx");
  assert.match(ui, /feeds and telemetry are not included/);
  assert.match(ui, /sparse original first-band pixel samples/);
  assert.match(ui, /not sensor coverage/);
  assert.match(ui, /not authoritative terrain or current imagery/);
  assert.match(ui, /controller\.current\?\.abort/);
  assert.match(text("../src/WorldView.tsx"), /await module\.prepareLocalLayers\(\)/);
});

test("new direct dependencies are exact-pinned with distributable notices", () => {
  const pkg = JSON.parse(text("../package.json"));
  for (const [name, version] of Object.entries({ "h3-js": "4.5.0", geotiff: "3.0.5", proj4: "2.22.0" })) {
    assert.equal(pkg.dependencies[name], version);
  }
  const notices = text("../public/worldview-local-layers-notices.txt");
  for (const name of ["h3-js", "geotiff", "proj4", "float16", "lerc", "parse-headers"]) assert.ok(notices.includes(name));
  assert.ok(notices.includes("Apache License"));
  assert.ok(notices.includes("Permission is hereby granted"));
  assert.ok(notices.includes("NOTICE"));
});
