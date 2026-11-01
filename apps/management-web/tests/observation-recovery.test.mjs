import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'observation-recovery-'));
writeFileSync(join(out, 'package.json'), '{"type":"module"}\n');
const tsc = resolve(here, '../node_modules/typescript/bin/tsc');
const source = resolve(here, '../src/observation-recovery.ts');
const result = spawnSync(process.execPath, [tsc, source, '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--skipLibCheck', '--outDir', out], { cwd: out, encoding: 'utf8' });
if (result.status) throw new Error(result.stderr);
const u = await import(`${pathToFileURL(join(out, 'observation-recovery.js')).href}?${Date.now()}`);
const rec = (overrides = {}) => ({ id: 'citation-a', entityId: 'e1', subjectId: 's1', sourceId: 'source-a', field: 'health', value: 'ok', observedAt: '2026-01-01T00:00:00Z', trust: 'trusted', freshness: 'current', synthetic: false, ...overrides });
const state = (records) => ({ records, highWater: {}, tombstones: {} });
test.after(() => rmSync(out, { recursive: true, force: true }));
test('offline return classifies added changed missing and recovered evidence', () => {
  const old = rec({ value: 'unknown', trust: 'unknown', freshness: 'stale' });
  const next = [rec({ value: 'ok', observedAt: '2026-01-02T00:00:00Z' }), rec({ id: 'citation-b', field: 'mode' })];
  const { digest } = u.reconcileEvidence(state([old]), next, Date.parse('2026-01-02T00:01:00Z'));
  assert.deepEqual(Object.fromEntries(Object.entries(digest).map(([k,v]) => [k, v.length])), { added: 1, changed: 1, missing: 0, recovered: 1, stillStale: 1, stillUntrusted: 0, conflicts: 0 });
});
test('same timestamp values never replace trusted evidence and duplicate receipts dedupe', () => {
  const old = rec({ value: 'trusted-value' });
  const { state: merged, digest } = u.reconcileEvidence(state([old]), [rec({ value: 'different' }), rec({ value: 'different' })]);
  assert.equal(merged.records.length, 0); assert.equal(digest.conflicts.length, 1);
});
test('removed records stay tombstoned and old API snapshots cannot resurrect them', () => {
  const old = rec();
  const first = u.reconcileEvidence(state([old]), []);
  assert.equal(first.state.records.length, 0);
  const stale = u.reconcileEvidence(first.state, [rec({ observedAt: '2025-12-31T00:00:00Z' })]);
  assert.equal(stale.state.records.length, 0);
  const newer = u.reconcileEvidence(first.state, [rec({ observedAt: '2026-01-02T00:00:00Z' })]);
  assert.equal(newer.state.records.length, 1);
});
test('undated evidence is retained only as an explicit current receipt and never establishes a high water mark', () => {
  const { state: next } = u.reconcileEvidence(u.emptyRecoveryState(), [rec({ observedAt: null, freshness: 'unknown', trust: 'unknown' })]);
  assert.equal(next.records.length, 1); assert.equal(Object.keys(next.highWater).length, 0);
});

test('equal timestamp tombstone cannot resurrect; only strictly newer evidence may return', () => {
  const first = u.reconcileEvidence(state([rec()]), [], Date.parse('2026-01-01T00:01:00Z'));
  assert.throws(() => u.assertEvidenceReceipt(first.state, [rec()], '2026-01-01T00:02:00Z'), /removed source/);
  assert.equal(u.reconcileEvidence(first.state, [rec()]).state.records.length, 0);
  const newer = rec({ observedAt: '2026-01-01T00:03:00Z' });
  u.assertEvidenceReceipt(first.state, [newer], '2026-01-01T00:04:00Z');
  assert.equal(u.reconcileEvidence(first.state, [newer], Date.parse('2026-01-01T00:04:00Z')).digest.recovered.length, 1);
});

test('whole old API receipt is rejected before inventory or citations can be published', () => {
  const first = u.reconcileEvidence(u.emptyRecoveryState(), [rec({ observedAt: '2026-01-02T00:00:00Z' })]);
  assert.throws(() => u.assertEvidenceReceipt(first.state, [rec()], '2026-01-03T00:00:00Z'), /Regressed/);
  assert.throws(() => u.assertEvidenceReceipt(first.state, first.state.records, '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'), /Older API/);
  assert.equal(first.state.records[0].observedAt, '2026-01-02T00:00:00Z');
});

test('source trust and source age remain independent and cannot establish false recovery', () => {
  const now = Date.parse('2026-01-02T00:01:00Z');
  const old = rec({ trust: 'unknown', freshness: 'stale' });
  const newer = rec({ observedAt: '2026-01-02T00:00:00Z' });
  assert.equal(u.reconcileEvidence(state([old]), [newer], now).digest.recovered.length, 1);
  for (const overrides of [{ trust: 'untrusted' }, { synthetic: true }, { freshness: 'stale' }, { observedAt: '2026-01-02T00:02:00Z', freshness: 'future' }, { observedAt: null, freshness: 'unknown' }]) {
    assert.equal(u.reconcileEvidence(state([old]), [rec({ ...newer, ...overrides })], now).digest.recovered.length, 0);
  }
  const unknownTrust = u.reconcileEvidence(u.emptyRecoveryState(), [rec({ ...newer, trust: 'unknown' })], now).digest;
  assert.equal(unknownTrust.stillStale.length, 0);
  assert.equal(unknownTrust.stillUntrusted.length, 1);
});

test('equal-time provenance downgrades apply but cannot count as recovery', () => {
  const old = rec();
  const next = rec({ trust: 'untrusted', freshness: 'stale' });
  const result = u.reconcileEvidence(state([old]), [next], Date.parse('2026-01-01T00:01:00Z'));
  assert.equal(result.state.records[0].trust, 'untrusted');
  assert.equal(result.digest.changed.length, 1);
  assert.equal(result.digest.recovered.length, 0);
  assert.throws(() => u.assertEvidenceReceipt(state([old]), [rec({ value: 'different' })], '2026-01-01T00:02:00Z'), /Same-source/);
});

test('canonical object deduplication ignores property order and repeated receipts', () => {
  const old = rec({ value: { healthStatus: 'ok', connectionStatus: 'online' } });
  const next = rec({ value: { connectionStatus: 'online', healthStatus: 'ok' } });
  const first = u.reconcileEvidence(state([old]), [next, next], Date.parse('2026-01-01T00:01:00Z'));
  assert.equal(first.state.records.length, 1);
  assert.equal(first.digest.changed.length, 0);
  assert.equal(first.digest.added.length, 0);
  assert.equal(first.digest.conflicts.length, 0);
});

test('retained current evidence ages at exact boundary without modifying original records', () => {
  const original = rec(); const stamp = Date.parse(original.observedAt);
  assert.equal(u.effectiveEvidenceFreshness(original, stamp + 300_000, true), 'current');
  assert.equal(u.effectiveEvidenceFreshness(original, stamp + 300_001, true), 'stale');
  assert.equal(u.effectiveEvidenceFreshness(original, stamp + 1000, false), 'unknown');
  assert.equal(u.effectiveEvidenceFreshness(rec({ freshness: 'stale' }), stamp, true), 'stale');
  assert.equal(u.effectiveEvidenceFreshness(rec({ freshness: 'future' }), stamp + 1000, true), 'future');
  assert.equal(original.freshness, 'current');
  assert.equal(original.observedAt, '2026-01-01T00:00:00Z');
});

test('undated replacements cannot downgrade previously timestamped source versions', () => {
  const first = u.reconcileEvidence(u.emptyRecoveryState(), [rec()]);
  const undated = rec({ observedAt: null, trust: 'unknown', freshness: 'unknown' });
  assert.throws(() => u.assertEvidenceReceipt(first.state, [undated], '2026-01-02T00:00:00Z'), /Regressed/);
  assert.equal(u.reconcileEvidence(first.state, [undated]).state.records.length, 0);
});
