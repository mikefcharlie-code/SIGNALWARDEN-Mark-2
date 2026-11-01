import test from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const here = dirname(fileURLToPath(import.meta.url)),
  out = mkdtempSync(join(tmpdir(), "open-feeds-"));
writeFileSync(join(out, "package.json"), '‎{"type":"module"}'.replace("‎", ""));
const compiled = spawnSync(
  process.execPath,
  [
    resolve(here, "../node_modules/typescript/bin/tsc"),
    resolve(here, "../src/worldview-open-feeds.ts"),
    "--target",
    "ES2022",
    "--module",
    "ESNext",
    "--moduleResolution",
    "Bundler",
    "--skipLibCheck",
    "--outDir",
    out,
  ],
  { encoding: "utf8" },
);
if (compiled.status !== 0) throw Error(compiled.stdout + compiled.stderr);
const target = join(out, "worldview-open-feeds.js");
writeFileSync(
  target,
  readFileSync(target, "utf8").replace(
    /(['"])\.\/worldview-core\1/g,
    '"./worldview-core.js"',
  ),
);
const { refreshAdsb, refreshWildfires, OPEN_FEED_INFO } = await import(
  pathToFileURL(target).href
);
test.after(() => rmSync(out, { recursive: true, force: true }));

const originalFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

function response(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-length": String(bytes.byteLength) }),
    body: new ReadableStream({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    }),
  };
}

test("network is opt-in and does not call fetch by default", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("must not call");
  };
  const result = await refreshAdsb({ lat: 1, lon: 2 });
  assert.equal(calls, 0);
  assert.equal(result.freshness, "failed");
  assert.match(result.error, /opt-in/);
});

test("adsb point is bounded and output excludes identity fields", async () => {
  let url = "";
  globalThis.fetch = async (request) => {
    url = String(request);
    return response({
      now: Date.now() - 1000,
      ac: [
        {
          seen_pos: 0,
          hex: "ABC123",
          lat: 1,
          lon: 2,
          reg: "N12345",
          flight: "SECRET",
          owner: "Person",
          alt_baro: 1000,
          now: Date.now(),
        },
      ],
    });
  };
  const result = await refreshAdsb(
    { lat: 1, lon: 2 },
    { network: true, radiusNm: 20 },
  );
  assert.match(url, /\/v2\/point\/1\/2\/20$/);
  assert.equal(result.observations.length, 1);
  const observation = result.observations[0];
  assert.equal(observation.label, "Reported aircraft");
  assert.deepEqual(Object.keys(observation.properties).sort(), [
    "attribution",
    "disclosure",
    "opaqueContactHex",
  ]);
  assert.equal(observation.properties.opaqueContactHex, "abc123");
  assert.equal(observation.properties.reg, undefined);
  const tooWide = await refreshAdsb(
    { lat: 1, lon: 2 },
    { network: true, radiusNm: 101 },
  );
  assert.match(tooWide.error, /<=100/);
});

test("EONET live adapter is explicitly disabled while source licenses vary", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return response({ events: [] });
  };
  const result = await refreshWildfires({ network: true });
  assert.equal(calls, 0);
  assert.equal(result.freshness, "failed");
  assert.match(result.error, /license review/);
});

test("provider metadata exposes attribution and terms review links", () => {
  assert.match(OPEN_FEED_INFO.adsbLol.licenseUrl, /odbl/);
  assert.match(OPEN_FEED_INFO.nasaEonet.reviewUrl, /event-curation/);
});
