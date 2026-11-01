import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../src/mission-autonomy.ts');
const output = mkdtempSync(join(tmpdir(), 'mission-autonomy-'));
writeFileSync(join(output, 'package.json'), '{"type":"module"}\n');
const tsc = resolve(here, '../node_modules/typescript/bin/tsc');
const compile = spawnSync(process.execPath, [tsc, source, '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--skipLibCheck', '--outDir', output], { encoding: 'utf8', cwd: output });
if (compile.status !== 0) throw new Error(`Unable to compile mission-autonomy.ts:\n${compile.stdout}\n${compile.stderr}`);
const mission = await import(`${pathToFileURL(join(output, 'mission-autonomy.js')).href}?test=${Date.now()}`);

test('creates a synthetic draft with both autopilot stacks, reference nodes, and seeded observations', () => {
  const state = mission.createMission('area-survey');
  assert.equal(state.environment, 'synthetic');
  assert.equal(state.controlEnabled, false);
  assert.deepEqual(state.assets.map((asset) => asset.autopilot), ['PX4', 'ArduPilot', 'None', 'None']);
  assert.equal(state.observations.length >= 4, true);
  assert.equal(new Set(state.observations.map((observation) => observation.subjectId)).size >= 2, true);
  assert.equal(state.phase, 'draft');
});

test('rejects inherited template keys', () => assert.throws(() => mission.createMission('toString'), /Unknown mission template/));

test('plans deterministically, allocates one asset per task, and does not mutate input', () => {
  const draft = mission.createMission('infrastructure-inspection');
  const before = structuredClone(draft);
  const planned = mission.planMission(draft);
  assert.deepEqual(draft, before);
  assert.equal(planned.phase, 'review');
  assert.equal(planned.tasks.length, 3);
  assert.equal(new Set(planned.tasks.filter((task) => task.assetId).map((task) => task.assetId)).size, 3);
  assert.equal(planned.tasks.some((task) => task.status === 'blocked'), false);
});

test('approval and explicit start/advance reject bad transitions and complete sequentially', () => {
  const draft = mission.createMission('area-survey');
  assert.throws(() => mission.approveMission(draft), /planned|review/i);
  const planned = mission.planMission(draft);
  const approved = mission.approveMission(planned);
  const running = mission.startMission(approved);
  assert.equal(running.tasks.every((task) => task.status === 'active'), true);
  const first = mission.advanceMission(running);
  assert.equal(first.phase, 'running');
  assert.equal(first.tasks.filter((task) => task.status === 'complete').length, 1);
  assert.equal(first.tasks.filter((task) => task.status === 'active').length, 2);
  const second = mission.advanceMission(first);
  const completed = mission.advanceMission(second);
  assert.equal(completed.phase, 'completed');
  assert.equal(completed.tasks.every((task) => task.status === 'complete'), true);
  assert.throws(() => mission.pauseMission(completed), /running/);
  assert.throws(() => mission.startMission(planned), /approval/);
});

test('missing data, invalid percentages, and degradation invalidate assignments and approval', () => {
  const draft = mission.createMission('search-and-assess');
  draft.assets[0].battery = null;
  draft.assets[0].link = null;
  draft.assets[1].battery = null;
  draft.assets[1].link = null;
  const planned = mission.planMission(draft);
  assert.equal(planned.tasks.filter((task) => task.status === 'blocked').length, 1);
  assert.throws(() => mission.approveMission(planned), /blocked|unassigned/);

  const invalid = mission.createMission('area-survey');
  invalid.assets[0].battery = 101;
  invalid.assets[1].battery = 101;
  assert.equal(mission.planMission(invalid).tasks.some((task) => task.domain === 'air' && task.status === 'blocked'), true);

  const approved = mission.approveMission(mission.planMission(mission.createMission('area-survey')));
  const degraded = mission.degradeAsset(approved, 'SYN-AIR-AP');
  assert.equal(degraded.phase, 'review');
  assert.equal(degraded.approvedRevision, null);
  assert.equal(degraded.tasks.find((task) => task.assetId === 'SYN-AIR-AP').status, 'blocked');
  assert.throws(() => mission.startMission(degraded), /approval|blocked|unassigned/);
});

test('pause explicitly clears approval', () => {
  const running = mission.startMission(mission.approveMission(mission.planMission(mission.createMission('area-survey'))));
  const paused = mission.pauseMission(running);
  assert.equal(paused.approvedRevision, null);
});

test('correlation uses only fresh clamped confidence, deduplicates sources, and marks stale observations', () => {
  const result = mission.correlateObservations([
    { id: '1', subjectId: 's', sensor: 'camera', sourceId: 'a', ageSeconds: 4, confidence: 0.4, summary: 'first' },
    { id: '2', subjectId: 's', sensor: 'camera', sourceId: 'b', ageSeconds: 5, confidence: 0.9, summary: 'second' },
    { id: '3', subjectId: 's', sensor: 'radar', sourceId: 'c', ageSeconds: 31, confidence: 1, summary: 'old high confidence' },
    { id: '4', subjectId: 'old', sensor: 'radar', sourceId: 'a', ageSeconds: 31, confidence: 4, summary: 'old' },
  ]);
  const current = result.find((item) => item.subjectId === 's');
  const stale = result.find((item) => item.subjectId === 'old');
  assert.equal(current.status, 'corroborated');
  assert.deepEqual(current.sourceIds, ['a', 'b', 'c']);
  assert.equal(current.confidence, 0.9);
  assert.equal(stale.status, 'stale');
  assert.equal(stale.confidence, 0);
});

test('debrief is structured Markdown and export states limitations and audit events', () => {
  const state = mission.planMission(mission.createMission('search-and-assess'));
  const exported = JSON.parse(mission.exportMission(state));
  assert.equal(exported.environment, 'synthetic');
  assert.equal(exported.controlEnabled, false);
  assert.match(exported.limitations, /No transport\/API\/fetch\/hardware\/weapons/);
  const debrief = mission.buildDebrief(state);
  assert.match(debrief, /^# Synthetic mission debrief/m);
  assert.match(debrief, /## Tasks/);
  assert.match(debrief, /## Audit events/);
  assert.match(debrief, /## Limitations/);
  assert.match(debrief, /- #1/);
});

test.after(() => rmSync(output, { recursive: true, force: true }));
