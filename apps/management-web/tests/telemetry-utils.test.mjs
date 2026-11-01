import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const output = mkdtempSync(join(tmpdir(), 'telemetry-utils-'));
writeFileSync(join(output, 'package.json'), '{"type":"module"}\n');
const tsc = resolve(here, '../node_modules/typescript/bin/tsc');
const compile = spawnSync(process.execPath, [tsc, resolve(here, '../src/telemetry-utils.ts'), resolve(here, '../src/fleet-utils.ts'), '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--skipLibCheck', '--outDir', output], { encoding: 'utf8', cwd: output });
if (compile.status !== 0) throw new Error(`Unable to compile telemetry utilities with ${tsc}:\n${compile.stdout}\n${compile.stderr}`);
const utils = await import(`${pathToFileURL(join(output, 'telemetry-utils.js')).href}?test=${Date.now()}`);

const aircraft = (overrides = {}) => ({
  id: 'sim-ucas-001', name: 'Demo', type: 'Quad', environment: 'SIMULATED', status: 'Available',
  health: 95, battery: 80, link: 95, freshness: 'Fresh', sampleAgeSeconds: 10,
  source: 'Synthetic Feed', location: 'Lab North', ...overrides,
});

const event = (overrides = {}) => ({ id: 'e1', offsetSeconds: -20, outcome: 'accepted', sequence: 5, source: 'Feed', detail: 'Accepted sequence 5', ...overrides });

test('known fixtures are isolated, deterministic, and do not mutate aircraft or snapshots', () => {
  const first = aircraft();
  const before = structuredClone(first);
  const a = utils.buildTelemetrySnapshot(first, 'recorded');
  const b = utils.buildTelemetrySnapshot(aircraft({ id: 'sim-ucas-002', battery: 61, link: 72 }), 'recorded');
  assert.deepEqual(first, before);
  assert.equal(a.altitude, 124.6);
  assert.equal(a.groundSpeed, 18.2);
  assert.equal(a.heading, 42);
  assert.equal(b.altitude, null);
  assert.equal(b.groundSpeed, null);
  assert.equal(b.heading, null);
  assert.equal(b.battery, 61);
  assert.equal(b.link, 72);
  assert.equal(a.history.altitude.length, 31);
  assert.equal(b.history.altitude.length, 0);
  assert.equal(a.events.length, 5);
  assert.equal(b.events.length, 5);
  a.history.battery[0].value = -1;
  assert.notEqual(utils.buildTelemetrySnapshot(first, 'recorded').history.battery[0].value, -1);
});

test('baseline ages are preserved and lab/unknown remain empty', () => {
  assert.equal(utils.buildTelemetrySnapshot(aircraft({ sampleAgeSeconds: 301 }), 'recorded').sampleAgeSeconds, 301);
  for (const id of ['lab-ucas-007', 'other']) {
    const snapshot = utils.buildTelemetrySnapshot(aircraft({ id, environment: id.startsWith('lab') ? 'LAB' : 'SIMULATED', battery: 44, link: 33 }), 'recorded');
    assert.equal(snapshot.altitude, null);
    assert.equal(snapshot.sequence, null);
    assert.deepEqual(snapshot.history, { battery: [], link: [], altitude: [] });
    assert.deepEqual(snapshot.events, []);
    assert.equal(snapshot.battery, 44);
    assert.equal(snapshot.link, 33);
    assert.equal(snapshot.scenario, 'recorded');
  }
});

test('baseline events carry per-aircraft provenance for every outcome class', () => {
  for (const [id, sequence] of [['sim-ucas-001', 1842], ['sim-ucas-002', 921]]) {
    const snapshot = utils.buildTelemetrySnapshot(aircraft({ id }), 'recorded');
    assert.deepEqual(snapshot.events.map((item) => item.outcome), ['accepted', 'accepted', 'late', 'duplicate', 'rejected']);
    assert.deepEqual(snapshot.events.map((item) => item.offsetSeconds), [0, -30, -65, -90, -120]);
    for (const item of snapshot.events) {
      assert.equal(item.source, snapshot.source);
      assert.match(item.id, new RegExp(`^${id}-baseline-`));
      assert.match(item.detail, /Synthetic parser/);
      assert.match(item.detail, /sequence/);
    }
    assert.equal(snapshot.events[0].sequence, sequence);
    assert.equal(snapshot.events[0].sequence, snapshot.sequence);
  }
});

test('known histories stay bounded and retain a null gap', () => {
  for (const id of ['sim-ucas-001', 'sim-ucas-002']) {
    const snapshot = utils.buildTelemetrySnapshot(aircraft({ id, battery: 0, link: 99 }), 'recorded');
    for (const points of [snapshot.history.battery, snapshot.history.link]) {
      assert.equal(points[0].value === null || (points[0].value >= 0 && points[0].value <= 100), true);
      assert.equal(points.at(-1).value === null || (points.at(-1).value >= 0 && points.at(-1).value <= 100), true);
      assert.ok(points.some((point) => point.value === null));
    }
    assert.equal(snapshot.history.link.at(-1).value, 99);
  }
});

test('link-loss is a local what-if and recovery overlays baseline with consistent sequence and endpoint', () => {
  const loss = utils.buildTelemetrySnapshot(aircraft({ sampleAgeSeconds: 4 }), 'link-loss');
  assert.equal(loss.sampleAgeSeconds, 600);
  assert.equal(loss.link, null);
  assert.equal(loss.battery, 80);
  assert.equal(loss.events.length, 6);
  assert.equal(loss.events[0].offsetSeconds, -1);
  assert.equal(loss.events.at(-1).offsetSeconds, 0);
  assert.equal(loss.events.at(-1).outcome, 'rejected');
  assert.match(loss.events.at(-1).detail, /Synthetic link-loss observation: no new sample received; local what-if only/);
  assert.equal(loss.events.at(-1).sequence, null);
  const recovery = utils.buildTelemetrySnapshot(aircraft({ sampleAgeSeconds: 999 }), 'recovery');
  assert.equal(recovery.sampleAgeSeconds, 5);
  assert.equal(recovery.link, 96);
  assert.equal(recovery.events.length, 6);
  assert.equal(recovery.events[0].offsetSeconds, -1);
  assert.equal(recovery.sequence, recovery.events.at(-1).sequence);
  assert.equal(recovery.events.at(-1).outcome, 'accepted');
  assert.equal(recovery.history.link.at(-1).value, recovery.link);
  const missing = utils.buildTelemetrySnapshot(aircraft({ id: 'sim-ucas-002' }), 'recovery');
  assert.equal(missing.altitude, null);
  assert.equal(missing.events.length, 6);
  assert.equal(missing.sequence, missing.events.at(-1).sequence);
  for (const scenario of ['link-loss', 'recovery']) {
    const lab = utils.buildTelemetrySnapshot(aircraft({ id: 'lab-ucas-007', environment: 'LAB' }), scenario);
    assert.deepEqual(lab.history, { battery: [], link: [], altitude: [] });
    assert.deepEqual(lab.events, []);
    assert.equal(lab.scenario, 'recorded');
  }
});

test('visibleMeasurement suppresses stale and invalid readings but allows delayed readings', () => {
  assert.equal(utils.visibleMeasurement(12, 0), 12);
  assert.equal(utils.visibleMeasurement(12, 30), 12);
  assert.equal(utils.visibleMeasurement(12, 300), 12);
  for (const [value, age] of [[12, 300.01], [null, 1], [NaN, 1], [12, -1], [12, NaN], [12, Infinity]]) assert.equal(utils.visibleMeasurement(value, age), null);
});

test('historyWindow validates, sorts, preserves null gaps, and includes boundaries', () => {
  const points = [{ offsetSeconds: 0, value: 0 }, { offsetSeconds: -10, value: null }, { offsetSeconds: -5, value: 5 }, { offsetSeconds: -20, value: 20 }];
  const before = structuredClone(points);
  assert.deepEqual(utils.historyWindow(points, 10), [{ offsetSeconds: -10, value: null }, { offsetSeconds: -5, value: 5 }, { offsetSeconds: 0, value: 0 }]);
  assert.deepEqual(points, before);
  assert.deepEqual(utils.historyWindow(points, 0), []);
  assert.deepEqual(utils.historyWindow(points, Infinity), []);
  assert.deepEqual(utils.historyWindow([{ offsetSeconds: -2, value: 1 }, { offsetSeconds: -2, value: null }], 2), [{ offsetSeconds: -2, value: 1 }, { offsetSeconds: -2, value: null }]);
});

test('event filtering matches every query word, outcome, and deterministic newest/id order', () => {
  const events = [event({ id: 'b', offsetSeconds: -2, outcome: 'late', sequence: 8, detail: 'link delayed' }), event({ id: 'a', offsetSeconds: -2, outcome: 'accepted', sequence: 8, detail: 'link accepted' }), event({ id: 'c', offsetSeconds: -10, outcome: 'accepted', detail: 'other' })];
  const before = structuredClone(events);
  assert.deepEqual(utils.filterTelemetryEvents(events, 'all', 'LINK 8').map((x) => x.id), ['a', 'b']);
  assert.deepEqual(utils.filterTelemetryEvents(events, 'accepted', '').map((x) => x.id), ['a', 'c']);
  assert.deepEqual(utils.filterTelemetryEvents(events, 'rejected', ''), []);
  assert.deepEqual(events, before);
});

test.after(() => rmSync(output, { recursive: true, force: true }));
