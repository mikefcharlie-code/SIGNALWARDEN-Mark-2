import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
const here = dirname(fileURLToPath(import.meta.url))
const output = mkdtempSync(join(tmpdir(), 'observation-state-'))
writeFileSync(join(output, 'package.json'), '{"type":"module"}\n')
const compile = spawnSync(process.execPath, [resolve(here, '../node_modules/typescript/bin/tsc'), resolve(here, '../src/observation-state.ts'), '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--skipLibCheck', '--outDir', output], { encoding: 'utf8', cwd: output })
if (compile.status !== 0) throw new Error(`${compile.stdout}\n${compile.stderr}`)
const utils = await import(pathToFileURL(join(output, 'observation-state.js')).href)
test.after(() => rmSync(output, { recursive: true, force: true }))
const time = '2026-10-22T15:30:00Z'
test('refresh keeps old data and receipt time until new success', () => {
  const previous = { status: 'ready', data: { marker: 1 }, error: null, receivedAt: time }
  assert.deepEqual(utils.beginRead(previous), { ...previous, status: 'loading' })
  const failed = utils.finishRead(utils.beginRead(previous), { status: 'rejected', reason: new Error('API unreachable') }, 'later')
  assert.equal(failed.status, 'error')
  assert.equal(failed.data, previous.data)
  assert.equal(failed.receivedAt, time)
  assert.equal(failed.error, 'API unreachable')
})
test('first failure never fabricates fallback data', () => {
  const failed = utils.finishRead({ status: 'loading', data: null, error: null }, { status: 'rejected', reason: 'failure' }, time)
  assert.equal(failed.data, null)
  assert.equal(failed.receivedAt, undefined)
})
test('success replaces retained data and clears an error independently per endpoint', () => {
  const next = utils.finishRead({ status: 'error', data: 1, error: 'outage', receivedAt: 'old' }, { status: 'fulfilled', value: 2 }, time)
  assert.deepEqual(next, { status: 'ready', data: 2, error: null, receivedAt: time })
})
test('validates catalogs rather than silently turning bad payloads into empty arrays', () => {
  assert.deepEqual(utils.validateCatalog({ items: [] }), [])
  assert.deepEqual(utils.validateCapabilities({ items: [] }), [])
  for (const invalid of [null, {}, { items: null }, { items: [{}] }]) {
    assert.throws(() => utils.validateCatalog(invalid), /Invalid observation/)
    assert.throws(() => utils.validateCapabilities(invalid), /Invalid observation/)
  }
})
test('validates offline read-only overview boundary', () => {
  const value = { mode: 'offline', readOnly: true, synthetic: false, connected: false, generatedAt: time, platforms: [], attention: [], summary: { platformCount: 0, sensorCount: 0, locatedCount: 0, freshness: { current: 0, stale: 0, future: 0, unknown: 0 } }, diagnostics: { transport: 'none', notes: [] } }
  assert.equal(utils.validateOverview(value), value)
  for (const patch of [{ mode: 'live' }, { readOnly: false }, { connected: true }, { platforms: null }, { attention: [{}] }, { diagnostics: {} }]) assert.throws(() => utils.validateOverview({ ...value, ...patch }))
})
test('AI configuration must disclose mode, provider, data export, and evidence', () => {
  const value = { mode: 'local', engine: 'rules', provider: 'none', modelStatus: 'disabled', generatedAt: time, summary: 'No observations.', insights: [], limitations: ['Human review required.'], disclosure: 'No external provider is used.', dataLeavesSystem: false, readOnly: true, synthetic: false }
  assert.equal(utils.validateAssistance(value), value)
  assert.equal(utils.validateAssistance({ ...value, mode: 'external', provider: 'openai', dataLeavesSystem: true }).mode, 'external')
  for (const patch of [{ mode: 'auto' }, { disclosure: null }, { dataLeavesSystem: undefined }, { readOnly: false }, { insights: [{ id: 'x', title: 'x', detail: 'x', evidence: 'unverified' }] }]) assert.throws(() => utils.validateAssistance({ ...value, ...patch }))
})

test('assessment schema rejects invalid timestamps, missing values, duplicate ids, and dangling citations', () => {
  const evidence = { id: 'e1', entityId: 'x', subjectId: 's', sourceId: 'src', field: 'status', value: { b: 2, a: 1 }, observedAt: null, trust: 'unknown', freshness: 'unknown', synthetic: false }
  const base = { generatedAt: time, snapshotId: 'snap', summary: 'x', limitations: [], findings: [{ id: 'f1', kind: 'fact', title: 't', detail: 'd', evidenceIds: ['e1'] }], evidence: [evidence] }
  assert.equal(utils.validateAssessment(base), base)
  for (const patch of [{ evidence: [{ ...evidence, observedAt: 'not-time' }] }, { evidence: [{ ...evidence, value: undefined }] }, { findings: [{ ...base.findings[0], evidenceIds: ['missing'] }] }, { findings: [base.findings[0], { ...base.findings[0] }] }]) assert.throws(() => utils.validateAssessment({ ...base, ...patch }), /Invalid observation/)
})
