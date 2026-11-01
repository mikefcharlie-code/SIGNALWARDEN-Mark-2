import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const root = fileURLToPath(new URL("..", import.meta.url));
const out = mkdtempSync(join(tmpdir(), "sar-autorefresh-"));
const compiled = spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), join(root, "src/worldview-globe-viewport.ts"), join(root, "src/worldview-sar-autorefresh.ts"), "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--skipLibCheck", "--outDir", out], { encoding: "utf8" });
assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
const { ViewportRefreshController, SAR_VIEWPORT_DEBOUNCE_MS, SAR_VIEWPORT_MIN_INTERVAL_MS, SAR_VIEWPORT_CADENCE_MS } = await import(pathToFileURL(join(out, "worldview-sar-autorefresh.js")));
test.after(() => rmSync(out, { recursive: true, force: true }));

class FakeClock {
  time = 0;
  nextId = 1;
  jobs = new Map();
  now = () => this.time;
  setTimeout = (fn, delay) => { const id = this.nextId++; this.jobs.set(id, { at: this.time + delay, fn }); return id; };
  clearTimeout = (id) => this.jobs.delete(id);
  async advance(ms) {
    const end = this.time + ms;
    while (true) {
      const next = [...this.jobs.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      this.jobs.delete(next[0]); this.time = next[1].at; next[1].fn();
      await Promise.resolve(); await Promise.resolve();
    }
    this.time = end;
    await Promise.resolve(); await Promise.resolve();
  }
}
const box = (west = -80) => [{ west, south: 30, east: west + 2, north: 42 }];
const config = (overrides = {}) => ({ enabled: true, sourceSelected: true, active: true, bounds: box(), ...overrides });

 test("no request occurs without explicit preference, selected source, active globe or viewport debounce", async () => {
  const clock = new FakeClock(); let calls = 0; const states = [];
  const controller = new ViewportRefreshController({ clock, refresh: async () => { calls++; return "updated"; }, onState: state => states.push(state), clear: () => {} });
  controller.configure(config({ enabled: false }));
  controller.configure(config({ sourceSelected: false }));
  controller.configure(config({ active: false }));
  await clock.advance(120_000);
  assert.equal(calls, 0);
  controller.configure(config({ bounds: [] }));
  await clock.advance(10_000);
  assert.equal(calls, 0);
  controller.configure(config());
  await clock.advance(SAR_VIEWPORT_DEBOUNCE_MS - 1);
  assert.equal(calls, 0);
  await clock.advance(1);
  assert.equal(calls, 1);
  assert.ok(states.includes("loading"));
  assert.ok(states.includes("updated"));
  controller.dispose();
});

test("viewport changes cancel the old request, coalesce and respect the one-per-minute cap", async () => {
  const clock = new FakeClock(); const signals = []; let calls = 0;
  const controller = new ViewportRefreshController({ clock, refresh: (_bounds, signal) => { calls++; signals.push(signal); return new Promise(() => {}); }, onState: () => {}, clear: () => {} });
  controller.configure(config());
  await clock.advance(SAR_VIEWPORT_DEBOUNCE_MS);
  assert.equal(calls, 1);
  controller.configure(config({ bounds: box(-70) }));
  assert.equal(signals[0].aborted, true);
  controller.configure(config({ bounds: box(-60) }));
  await clock.advance(SAR_VIEWPORT_MIN_INTERVAL_MS - 1);
  assert.equal(calls, 1);
  await clock.advance(1);
  assert.equal(calls, 2);
  assert.equal(signals[1].aborted, false);
  controller.dispose();
  assert.equal(signals[1].aborted, true);
});

test("no-coverage and provider failures remain visible until cadence, with bounded 15-minute refresh", async () => {
  const clock = new FakeClock(); const states = []; let calls = 0;
  const controller = new ViewportRefreshController({ clock, refresh: async () => { calls++; if (calls === 1) return "no-coverage"; throw Error("mock provider outage"); }, onState: (state, error) => states.push([state, error?.message]), clear: () => {} });
  controller.configure(config());
  await clock.advance(SAR_VIEWPORT_DEBOUNCE_MS);
  assert.equal(states.at(-1)[0], "no-coverage");
  await clock.advance(SAR_VIEWPORT_CADENCE_MS - 1);
  assert.equal(calls, 1);
  await clock.advance(1);
  assert.equal(calls, 2);
  assert.ok(states.some(([state, message]) => state === "failed" && message === "mock provider outage"));
  controller.dispose();
});

test("opting out or leaving the globe aborts reads, clears overlays and stops timers", async () => {
  const clock = new FakeClock(); const signals = []; let clears = 0; let calls = 0;
  const controller = new ViewportRefreshController({ clock, refresh: (_bounds, signal) => { calls++; signals.push(signal); return new Promise(() => {}); }, onState: () => {}, clear: () => { clears++; } });
  controller.configure(config());
  await clock.advance(SAR_VIEWPORT_DEBOUNCE_MS);
  controller.configure(config({ enabled: false }));
  assert.equal(signals[0].aborted, true);
  assert.equal(clears, 1);
  await clock.advance(SAR_VIEWPORT_CADENCE_MS * 2);
  assert.equal(calls, 1);
  controller.dispose();
  assert.equal(clears, 1);
});

test("leaving the visible globe cancels and clears; quick re-entry still respects the global request-start limit", async () => {
  const clock = new FakeClock(); const signals = []; let clears = 0; let calls = 0;
  const controller = new ViewportRefreshController({ clock, refresh: (_bounds, signal) => { calls++; signals.push(signal); return new Promise(() => {}); }, onState: () => {}, clear: () => { clears++; } });
  controller.configure(config());
  await clock.advance(SAR_VIEWPORT_DEBOUNCE_MS);
  controller.configure(config({ active: false }));
  assert.equal(signals[0].aborted, true);
  assert.equal(clears, 1);
  await clock.advance(10_000);
  assert.equal(calls, 1);
  controller.configure(config({ active: true }));
  await clock.advance(SAR_VIEWPORT_MIN_INTERVAL_MS - 10_000 - 1);
  assert.equal(calls, 1);
  await clock.advance(1);
  assert.equal(calls, 2);
  controller.dispose();
  assert.equal(clears, 2);
});
