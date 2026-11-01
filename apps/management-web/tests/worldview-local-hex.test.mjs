import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(join(tmpdir(), "worldview-local-hex-"));
const out = join(temp, "out");
try {
  writeFileSync(join(temp, "package.json"), '{"type":"module"}\n');
  symlinkSync(join(app, "node_modules"), join(temp, "node_modules"), "dir");
  execFileSync(
    join(app, "node_modules", ".bin", "tsc"),
    [
      "--target",
      "ES2022",
      "--module",
      "ESNext",
      "--moduleResolution",
      "Bundler",
      "--skipLibCheck",
      "--outDir",
      out,
      join(app, "src", "worldview-core.ts"),
      join(app, "src", "worldview-local-hex.ts"),
    ],
    { stdio: "inherit" },
  );
  // The app uses bundler-style extension-free imports; Node's ESM loader needs .js.
  const modulePath = join(out, "worldview-local-hex.js");
  const source = (await import("node:fs/promises")).readFile(modulePath, "utf8");
  await (await import("node:fs/promises")).writeFile(
    modulePath,
    (await source).replace(/["']\.\/worldview-core["']/, '"./worldview-core.js"'),
  );

  const { aggregateLocalObservations } = await import(pathToFileURL(modulePath));
  const observation = (id, lat, lon, observedAt, source = "field") => ({
    id,
    layer: "cameras",
    point: { lat, lon },
    observedAt,
    source,
    label: "local observation",
  });

  test("maps the official H3 vector and conserves points", () => {
    const result = aggregateLocalObservations(
      [
        observation("a", 37.3615593, -122.0553238, "2026-01-02T00:00:00Z"),
        observation("b", 37.3615593, -122.0553238, "2026-01-01T00:00:00Z", "lab"),
      ],
      7,
      "user-supplied",
    );
    assert.equal(result.cells[0].id, "87283472bffffff");
    assert.equal(result.cells[0].count, 2);
    assert.equal(result.pointCount, 2);
    assert.equal(result.cells.reduce((sum, cell) => sum + cell.count, 0), 2);
    assert.deepEqual(result.cells[0].sources, ["field", "lab"]);
    assert.equal(result.cells[0].firstObservedAt, "2026-01-01T00:00:00Z");
    assert.equal(result.cells[0].lastObservedAt, "2026-01-02T00:00:00Z");
    assert.ok(result.cells[0].areaKm2 > 0);
    assert.equal(result.coverageKm2, result.cells[0].areaKm2);
  });

  test("orders cells deterministically by count then H3 id", () => {
    const result = aggregateLocalObservations(
      [
        observation("a", 37.3615593, -122.0553238, "2026-01-01T00:00:00Z"),
        observation("b", 37.3615593, -122.0553238, "2026-01-02T00:00:00Z"),
        observation("c", 40.689247, -74.044502, "2026-01-03T00:00:00Z"),
      ],
      7,
      "synthetic",
    );
    assert.deepEqual(result.cells.map((cell) => cell.count), [2, 1]);
    assert.equal(result.resolution, 7);
    assert.equal(result.provenance, "synthetic");
  });

  test("all explicit resolutions conserve local counts without network", () => {
    const previousFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = () => { requests++; throw new Error("network forbidden"); };
    try {
      const points = Array.from({ length: 24 }, (_, i) => observation(String(i), 37 + i / 100, -122 + i / 100, "2026-01-01T00:00:00Z"));
      for (let resolution = 0; resolution <= 10; resolution++) {
        const result = aggregateLocalObservations(points, resolution, "user-supplied");
        assert.equal(result.resolution, resolution);
        assert.equal(result.pointCount, 24);
        assert.equal(result.cells.reduce((n, c) => n + c.count, 0), 24);
        assert.ok(result.cells.every(c => c.boundary.length >= 5));
      }
      assert.equal(requests, 0);
    } finally { globalThis.fetch = previousFetch; }
  });

  test("rejects invalid values and the hard input limit", () => {
    assert.throws(() => aggregateLocalObservations([observation("bad", 91, 0, "2026-01-01")], 7, "user-supplied"));
    assert.throws(() => aggregateLocalObservations([], 7.5, "user-supplied"));
    assert.throws(() => aggregateLocalObservations([], 11, "user-supplied"));
    assert.throws(() => aggregateLocalObservations([], 7, "remote"));
    assert.throws(() => aggregateLocalObservations(Array.from({ length: 5001 }, (_, i) => observation(String(i), 0, 0, "2026-01-01")), 7, "synthetic"));
  });
} finally {
  rmSync(temp, { recursive: true, force: true });
}
