import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const output = mkdtempSync(join(tmpdir(), 'telemetry-plot-'))
writeFileSync(join(output, 'package.json'), '{"type":"module"}\n')
symlinkSync(resolve(here, '../node_modules'), join(output, 'node_modules'), 'dir')
const tsc = resolve(here, '../node_modules/typescript/bin/tsc')
const compile = spawnSync(process.execPath, [tsc, resolve(here, '../src/telemetry-utils.ts'), resolve(here, '../src/telemetry-plot.ts'), resolve(here, '../src/fleet-utils.ts'), '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--skipLibCheck', '--outDir', output], { encoding: 'utf8', cwd: output })
if (compile.status !== 0) throw new Error(`Unable to compile telemetry plot adapter:\n${compile.stdout}\n${compile.stderr}`)
for (const file of ['telemetry-plot.js', 'telemetry-utils.js', 'fleet-utils.js']) {
  const path = join(output, file)
  writeFileSync(path, readFileSync(path, 'utf8').replaceAll("from './telemetry-utils'", "from './telemetry-utils.js'").replaceAll("from './fleet-utils'", "from './fleet-utils.js'"))
}
const plot = await import(`${pathToFileURL(join(output, 'telemetry-plot.js')).href}?test=${Date.now()}`)
const snapshot = '2025-01-01T12:00:00.000Z'

test('converts relative fixture offsets to exact UTC Unix seconds and preserves null gaps', () => {
  const result = plot.buildTelemetryPlotData([{ offsetSeconds: -60, value: 2 }, { offsetSeconds: -30, value: null }, { offsetSeconds: 0, value: 4 }], snapshot, 60)
  assert.deepEqual(result.data, [[1735732740, 1735732770, 1735732800], [2, null, 4]])
})

test('sorts and deduplicates deterministically, retaining the later duplicate', () => {
  const points = [{ offsetSeconds: 0, value: 1 }, { offsetSeconds: -30, value: 2 }, { offsetSeconds: -30, value: 3 }]
  const before = structuredClone(points)
  assert.deepEqual(plot.buildTelemetryPlotData(points, snapshot, 60).data, [[1735732770, 1735732800], [3, 1]])
  assert.deepEqual(points, before)
})

test('turns absent 30 second cadence samples into explicit null gaps and rejects nonfinite values', () => {
  const result = plot.buildTelemetryPlotData([{ offsetSeconds: -90, value: 1 }, { offsetSeconds: 0, value: NaN }], snapshot, 120)
  assert.deepEqual(result.data, [[1735732710, 1735732770, 1735732800], [1, null, null]])
})

test('uses one null sentinel for any gap over cadence without expanding irregular spacing', () => {
  const result = plot.buildTelemetryPlotData([{ offsetSeconds: -90, value: 1 }, { offsetSeconds: -45, value: 2 }, { offsetSeconds: 0, value: 3 }], snapshot, 120)
  assert.equal(result.data[0].length, 5)
  assert.deepEqual(result.data[1], [1, null, 2, null, 3])
  assert.ok(result.data[0].every((value, index, values) => index === 0 || value > values[index - 1]))
})

test('rejects invalid offset types and date overflow, and caps input/output', () => {
  assert.deepEqual(plot.buildTelemetryPlotData([{ offsetSeconds: '0', value: 1 }], snapshot, 60).data, [[], []])
  assert.deepEqual(plot.buildTelemetryPlotData([{ offsetSeconds: 0, value: 1 }], '2025-02-30T12:00:00.000Z', 60).data, [[], []])
  assert.deepEqual(plot.buildTelemetryPlotData([{ offsetSeconds: -1e100, value: 1 }], snapshot, 1e101).data, [[], []])
  const points = Array.from({ length: 2500 }, (_, index) => ({ offsetSeconds: -index, value: index }))
  const result = plot.buildTelemetryPlotData(points, snapshot)
  assert.ok(result.data[0].length <= 2000)
})

test('normalizes the complete bounded input before capping, retaining newest samples', () => {
  const old = Array.from({ length: 2100 }, (_, index) => ({ offsetSeconds: -10000 - index, value: 1 }))
  const recent = [{ offsetSeconds: -30, value: 2 }, { offsetSeconds: 0, value: 3 }]
  const result = plot.buildTelemetryPlotData([...old, ...recent], snapshot, 60)
  assert.deepEqual(result.data, [[1735732770, 1735732800], [2, 3]])
  assert.equal(result.dropped, old.length)
  const capped = plot.buildTelemetryPlotData(Array.from({ length: 2500 }, (_, index) => ({ offsetSeconds: index - 2499, value: index })), snapshot, 3000)
  assert.equal(capped.data[0].length, 2000)
  assert.equal(capped.data[1].at(-1), 2499)
  assert.equal(capped.dropped, 500)
  assert.throws(() => plot.buildTelemetryPlotData(Array.from({ length: 5001 }, () => ({ offsetSeconds: 0, value: 1 })), snapshot), /at most 5000/)
})

test('invalid timestamps and empty data are bounded empty results', () => {
  assert.deepEqual(plot.buildTelemetryPlotData([{ offsetSeconds: 0, value: 1 }], 'not-a-date', 60).data, [[], []])
  assert.deepEqual(plot.buildTelemetryPlotData([], snapshot, 60).data, [[], []])
})

test('uPlot options use UTC labels, legend, and spanGaps false', () => {
  const options = plot.telemetryPlotOptions('battery', 500, 260)
  assert.equal(options.series[1].spanGaps, false)
  assert.equal(options.legend.show, true)
  assert.equal(options.scales.x.time, true)
  assert.equal(options.scales.x.distr, undefined)
  assert.equal(options.axes[0].values(null, [0])[0], '00:00:00Z')
  assert.equal(options.series[0].value(null, 1735732800), snapshot)
  assert.equal(options.series[0].value(null, null), 'No sample')
})

test('adapter is typed against uPlot declarations rather than a local constructor/options shape', () => {
  const source = readFileSync(resolve(here, '../src/telemetry-plot.ts'), 'utf8')
  assert.match(source, /uPlot\.Options/)
  assert.match(readFileSync(resolve(here, '../src/TelemetryPlot.tsx'), 'utf8'), /new loaded\.default\(/)
})

test.after(() => rmSync(output, { recursive: true, force: true }))
