import type uPlot from 'uplot'
import type { MetricId, TelemetryPoint } from './telemetry-utils'
import { metricConfig } from './telemetry-utils'

export type TelemetryPlotData = [number[], Array<number | null>]
export type TelemetryPlotAdapterResult = { data: TelemetryPlotData; dropped: number }
export const telemetryPlotMaxSamples = 2000
export const telemetryPlotMaxInputSamples = 5000
export const telemetryPlotCadenceSeconds = 30
const DEFAULT_WINDOW_SECONDS = 900

function validTimestamp(snapshotIso: string): number | null {
  if (typeof snapshotIso !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(snapshotIso)) return null
  const parsed = Date.parse(snapshotIso)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === snapshotIso ? parsed / 1000 : null
}

/** Normalize the complete bounded input before retaining the most recent output samples.
 * Later input wins duplicate timestamps; a null sentinel breaks any absent fixture cadence.
 */
export function buildTelemetryPlotData(points: readonly TelemetryPoint[], snapshotIso: string, windowSeconds = DEFAULT_WINDOW_SECONDS): TelemetryPlotAdapterResult {
  if (points.length > telemetryPlotMaxInputSamples) throw new RangeError(`Telemetry chart accepts at most ${telemetryPlotMaxInputSamples} input samples`)
  const snapshotSeconds = validTimestamp(snapshotIso)
  if (snapshotSeconds === null || typeof windowSeconds !== 'number' || !Number.isFinite(windowSeconds) || windowSeconds <= 0) return { data: [[], []], dropped: points.length }
  const unique = new Map<number, number | null>()
  for (const point of points) {
    if (!point || typeof point.offsetSeconds !== 'number' || !Number.isFinite(point.offsetSeconds)) continue
    const timestamp = snapshotSeconds + point.offsetSeconds
    if (!Number.isFinite(timestamp) || Math.abs(timestamp) > 8.64e12 || timestamp < snapshotSeconds - windowSeconds || timestamp > snapshotSeconds) continue
    unique.set(timestamp, typeof point.value === 'number' && Number.isFinite(point.value) ? point.value : null)
  }
  const ordered = [...unique.entries()].sort((a, b) => a[0] - b[0])
  const x: number[] = []
  const y: Array<number | null> = []
  let retained = 0
  // Work backwards so a cap never discards the newest valid sample in favour of old input.
  for (let index = ordered.length - 1; index >= 0 && x.length < telemetryPlotMaxSamples; index -= 1) {
    const [timestamp, value] = ordered[index]
    if (index < ordered.length - 1 && ordered[index + 1][0] - timestamp > telemetryPlotCadenceSeconds) {
      // Reserve room for both the gap and the older point; an isolated leading gap is unhelpful.
      if (x.length + 2 > telemetryPlotMaxSamples) break
      x.push(ordered[index + 1][0] - telemetryPlotCadenceSeconds); y.push(null)
    }
    x.push(timestamp); y.push(value); retained += 1
  }
  return { data: [x.reverse(), y.reverse()], dropped: points.length - retained }
}

export function telemetryPlotOptions(metric: MetricId, width: number, height: number): uPlot.Options {
  const config = metricConfig[metric]
  return {
    width: Math.max(1, Math.floor(width)), height: Math.max(160, Math.floor(height)),
    cursor: { drag: { x: false, y: false } },
    scales: { x: { time: true }, y: { range: config.domain } },
    axes: [
      { space: 80, stroke: '#53636c', grid: { stroke: '#ddd9d0' }, ticks: { stroke: '#ddd9d0' }, values: (_u, splits) => splits.map(value => new Date(value * 1000).toISOString().slice(11, 19) + 'Z') },
      { scale: 'y', space: 45, stroke: '#53636c', grid: { stroke: '#ddd9d0' }, ticks: { stroke: '#ddd9d0' } },
    ],
    series: [
      { label: 'UTC fixture time', value: (_u, value) => value == null || !Number.isFinite(value) ? 'No sample' : new Date(value * 1000).toISOString() },
      { label: `${config.label} (${config.unit})`, spanGaps: false, stroke: '#d95d22', width: 2.5, points: { show: true }, value: (_u, value) => value == null || !Number.isFinite(value) ? 'Missing' : `${value.toFixed(1)} ${config.unit}` },
    ],
    legend: { show: true },
  }
}
