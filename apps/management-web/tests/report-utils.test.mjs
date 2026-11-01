import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
const here = dirname(fileURLToPath(import.meta.url))
const output = mkdtempSync(join(tmpdir(), 'platform-report-ui-'))
writeFileSync(join(output, 'package.json'), '{"type":"module"}\n')
const compile = spawnSync(process.execPath, [resolve(here, '../node_modules/typescript/bin/tsc'), resolve(here, '../src/report-utils.ts'), '--target', 'ES2022', '--module', 'ESNext', '--skipLibCheck', '--outDir', output], { encoding: 'utf8', cwd: output })
if (compile.status !== 0) throw new Error(`${compile.stdout}\n${compile.stderr}`)
const { reportRequest, validateReport, validateReportOptions, reportDownload, evidenceAnchor } = await import(pathToFileURL(join(output, 'report-utils.js')).href)
test.after(() => rmSync(output, { recursive: true, force: true }))
const defaults = { type: 'platform-status', start: '', end: '', platform: '', sensor: '', engine: 'template' }
const evidence = { id: 'ev-1', entityId: 'platform-1', subjectId: 'sensor-1', sourceId: 'source-1', observedAt: '2025-01-01T00:00:00Z', field: 'sensor.type', value: 'EO', trust: 'untrusted', freshness: 'stale', synthetic: true }
const report = { id: 'report-1', title: 'Synthetic sensor report', type: 'sensor-isr', generatedAt: '2026-10-22T00:00:00Z', synthetic: true, engine: 'template', modelStatus: 'not-requested', markdown: '# Synthetic report\n', evidence: [evidence], coverageGaps: ['No sensor collection payloads.'], limitations: ['Human review required.'], sections: [{ title: 'Sensor metadata', claims: [{ text: 'Reported EO metadata', evidenceIds: ['ev-1'] }] }] }
test('default request selects whole platform dataset without a model', () => {
  assert.deepEqual(reportRequest(defaults), { type: 'platform-status', engine: 'template', platformIds: [], sensorIds: [] })
})
test('filters retain actual IDs and normalize time zone for UTC exports', () => {
  const result = reportRequest({ ...defaults, platform: 'p-1', sensor: 's-1', start: '2025-01-01T01:00:00+01:00', end: '2025-01-01T01:00:00Z' })
  assert.equal(result.start, '2025-01-01T00:00:00.000Z')
  assert.deepEqual(result.platformIds, ['p-1'])
  assert.deepEqual(result.sensorIds, ['s-1'])
})
test('bad ranges and external engines are rejected before request', () => {
  assert.throws(() => reportRequest({ ...defaults, start: 'bad' }))
  assert.throws(() => reportRequest({ ...defaults, start: '2026-01-02', end: '2026-01-01' }))
  assert.throws(() => reportRequest({ ...defaults, engine: 'external' }))
})
test('empty report is accepted only with explicit typed report structure', () => {
  assert.equal(validateReport({ ...report, evidence: [], sections: [], coverageGaps: ['No observations available.'] }).evidence.length, 0)
  assert.throws(() => validateReport({ ...report, evidence: [] }), /citations/)
})
test('stale and untrusted records are retained verbatim without promotion', () => {
  const result = validateReport(report)
  assert.equal(result.evidence[0].trust, 'untrusted')
  assert.equal(result.evidence[0].freshness, 'stale')
  assert.equal(result.evidence[0].observedAt, evidence.observedAt)
  assert.equal(result.synthetic, true)
})
test('every material claim must resolve to accepted unique evidence IDs', () => {
  assert.throws(() => validateReport({ ...report, sections: [{ title: 'x', claims: [{ text: 'Claim', evidenceIds: [] }] }] }))
  assert.throws(() => validateReport({ ...report, sections: [{ title: 'x', claims: [{ text: 'Claim', evidenceIds: ['unknown'] }] }] }))
  assert.throws(() => validateReport({ ...report, evidence: [evidence, evidence] }), /duplicate/)
  const conflicting = { ...evidence, id: 'ev-2', sourceId: 'source-2', value: 'IR' }
  assert.equal(validateReport({ ...report, evidence: [evidence, conflicting], sections: [{ title: 'Conflict', claims: [{ text: 'Sources disagree', evidenceIds: ['ev-1', 'ev-2'] }] }] }).evidence.length, 2)
})
test('local-model unavailable fallback remains a valid deterministic artifact', () => {
  assert.equal(validateReport({ ...report, engine: 'local-fallback', modelStatus: 'unavailable' }).engine, 'local-fallback')
})
test('download content preserves provenance and safe filenames; anchors are encoded', () => {
  assert.equal(reportDownload(report, 'markdown').content, report.markdown)
  assert.deepEqual(JSON.parse(reportDownload(report, 'json').content), report)
  assert.match(reportDownload({ ...report, id: '../unsafe' }, 'json').filename, /^signalwarden-sensor-isr----unsafe.json$/)
  assert.equal(evidenceAnchor('ev <unsafe>'), 'report-source-ev%20%3Cunsafe%3E')
})
test('options and navigation expose only a report workspace, not source mutation', () => {
  assert.equal(validateReportOptions({ types: [{ id: 'sensor-isr', label: 'Sensor ISR' }], platforms: [], sensors: [] }).types.length, 1)
  assert.throws(() => validateReportOptions({ types: ['sensor-isr'], platforms: [], sensors: [] }))
  const main = readFileSync(resolve(here, '../src/main.tsx'), 'utf8')
  assert.match(main, /if \(page === 'reports'\) return <Reports \/>/)
  const source = readFileSync(resolve(here, '../src/Reports.tsx'), 'utf8')
  assert.match(source, /\/api\/v1\/reports\/generate/)
  assert.match(source, /Download Markdown/)
  assert.match(source, /Download JSON/)
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/)
})

test('synthetic records cannot be promoted or external model output accepted', () => {
  assert.throws(() => validateReport({ ...report, evidence: [{ ...evidence, trust: 'trusted' }] }), /Synthetic/)
  assert.throws(() => validateReport({ ...report, evidence: [{ ...evidence, freshness: 'current' }] }), /Synthetic/)
  assert.throws(() => validateReport({ ...report, engine: 'external-model' }), /Unsupported/)
  assert.throws(() => validateReport({ ...report, evidence: [{ ...evidence, observedAt: 'invalid' }] }), /timestamp/)
})
