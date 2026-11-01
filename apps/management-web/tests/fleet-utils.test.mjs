import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../src/fleet-utils.ts');
const output = mkdtempSync(join(tmpdir(), 'fleet-utils-'));
writeFileSync(join(output, 'package.json'), '{"type":"module"}\n');
const tsc = resolve(here, '../node_modules/typescript/bin/tsc');
const compile = spawnSync(process.execPath, [tsc, source, '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--skipLibCheck', '--outDir', output], { encoding: 'utf8', cwd: output });
if (compile.status !== 0) {
  throw new Error(`Unable to compile fleet-utils.ts with ${tsc}:\n${compile.stdout}\n${compile.stderr}`);
}
const utils = await import(`${pathToFileURL(join(output, 'fleet-utils.js')).href}?test=${Date.now()}`);

const aircraft = (overrides = {}) => ({
  id: 'AC-1', name: 'Drone 2', type: 'Quad', environment: 'SIMULATED', status: 'Available',
  health: 95, battery: 80, link: 95, freshness: 'Fresh', sampleAgeSeconds: 10,
  source: 'Synthetic Feed', location: 'Lab North', ...overrides,
});
const filters = (overrides = {}) => ({
  query: '', status: 'all', environment: 'all', attentionOnly: false, sort: 'name', ...overrides,
});

test('freshnessFor handles exact thresholds and invalid ages', () => {
  assert.equal(utils.freshnessFor(0), 'Fresh');
  assert.equal(utils.freshnessFor(30), 'Fresh');
  assert.equal(utils.freshnessFor(30.01), 'Delayed');
  assert.equal(utils.freshnessFor(300), 'Delayed');
  assert.equal(utils.freshnessFor(300.01), 'Stale');
  assert.equal(utils.freshnessFor(-1), 'Unknown');
  assert.equal(utils.freshnessFor(Number.NaN), 'Unknown');
  assert.equal(utils.freshnessFor(Number.POSITIVE_INFINITY), 'Unknown');
});

test('needsAttention checks status, freshness, battery, and link', () => {
  assert.equal(utils.needsAttention(aircraft()), false);
  for (const change of [
    { status: 'Maintenance' }, { sampleAgeSeconds: 31 }, { battery: 29 }, { link: 79 },
  ]) assert.equal(utils.needsAttention(aircraft(change)), true);
});

test('filterAircraft combines multi-word query, status, environment, and attention', () => {
  const items = [
    aircraft({ id: 'SIM-1', name: 'Alpha 1', source: 'Telemetry West', location: 'Hangar A' }),
    aircraft({ id: 'LAB-2', name: 'Bravo 2', environment: 'LAB', status: 'Maintenance', battery: 20 }),
    aircraft({ id: 'SIM-3', name: 'Charlie 3', source: 'Telemetry East', location: 'Hangar B' }),
  ];
  const result = utils.filterAircraft(items, filters({ query: ' telemetry   west ', environment: 'SIMULATED', attentionOnly: false }));
  assert.deepEqual(result.map((item) => item.id), ['SIM-1']);
  assert.deepEqual(utils.filterAircraft(items, filters({ status: 'Maintenance', attentionOnly: true })).map((item) => item.id), ['LAB-2']);
});

test('filterAircraft does not mutate input and sorts all modes deterministically', () => {
  const items = [
    aircraft({ id: 'b', name: 'Drone 10', battery: 50, sampleAgeSeconds: 40 }),
    aircraft({ id: 'a', name: 'Drone 2', battery: 20, sampleAgeSeconds: 301 }),
    aircraft({ id: 'c', name: 'Drone 1', battery: 20, sampleAgeSeconds: Number.NaN }),
    aircraft({ id: 'd', name: 'Drone 3', battery: 90, sampleAgeSeconds: 100 }),
  ];
  const before = structuredClone(items);
  assert.deepEqual(utils.filterAircraft(items, filters({ sort: 'name' })).map((x) => x.name), ['Drone 1', 'Drone 2', 'Drone 3', 'Drone 10']);
  assert.deepEqual(utils.filterAircraft(items, filters({ sort: 'battery' })).map((x) => x.id), ['c', 'a', 'b', 'd']);
  assert.deepEqual(utils.filterAircraft(items, filters({ sort: 'freshness' })).map((x) => x.id), ['c', 'a', 'd', 'b']);
  assert.deepEqual(items, before);
});

test('fleetSummary counts total, freshness, attention, and environments', () => {
  const items = [aircraft(), aircraft({ id: '2', environment: 'LAB', sampleAgeSeconds: 31 }), aircraft({ id: '3', status: 'Suspended', environment: 'LAB', sampleAgeSeconds: 301 })];
  assert.deepEqual(utils.fleetSummary(items), { total: 3, fresh: 1, attention: 2, simulated: 1, lab: 2 });
});

test('aircraftCsv quotes every field, uses CRLF, classification, and formula protection', () => {
  const csv = utils.aircraftCsv([aircraft({
    id: '=BAD', name: 'A, "quoted"\nname', source: '  +unsafe', location: '\t@danger', sampleAgeSeconds: 31,
  })]);
  assert.match(csv, /^"id","name","type","environment","status","health_percent","battery_percent","link_percent","sample_age_seconds","freshness","source","location","data_classification"\r\n/);
  assert.match(csv, /"'=BAD"/);
  assert.match(csv, /"A, ""quoted""\nname"/);
  assert.match(csv, /"'  \+unsafe"/);
  assert.match(csv, /"'\t@danger"/);
  assert.match(csv, /"Delayed","'  \+unsafe","'\t@danger","SYNTHETIC DEMO"\r\n$/);
  assert.ok(csv.endsWith('\r\n'));
});

test.after(() => rmSync(output, { recursive: true, force: true }));
