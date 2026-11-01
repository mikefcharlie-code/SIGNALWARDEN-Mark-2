import { useEffect, useRef, useState, type ReactNode } from 'react'
import type uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import type { MetricId, TelemetryPoint } from './telemetry-utils'
import { buildTelemetryPlotData, telemetryPlotOptions } from './telemetry-plot'

type Props = { points: TelemetryPoint[]; metric: MetricId; seconds: number; snapshotIso: string; fallback: ReactNode }

export function TelemetryPlot({ points, metric, seconds, snapshotIso, fallback }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let active = true
    let failed = false
    let instance: uPlot | undefined
    let observer: ResizeObserver | undefined
    const target = host.current
    setReady(false)
    const dispose = () => {
      observer?.disconnect()
      observer = undefined
      const previous = instance
      instance = undefined
      try { previous?.destroy() } catch { /* Retain the accessible fallback even if disposal fails. */ }
      target?.replaceChildren()
    }
    const fail = () => { failed = true; dispose(); if (active) setReady(false) }
    const mount = async () => {
      try {
        if (!target || !document.createElement('canvas').getContext('2d')) return
        const { data } = buildTelemetryPlotData(points, snapshotIso, seconds)
        if (!data[1].some(value => value !== null)) return
        const loaded = await import('uplot')
        if (!active) return
        const resize = () => {
          if (!active || failed) return
          try {
            const width = Math.floor(target.clientWidth)
            if (width <= 0) return
            if (!instance) {
              instance = new loaded.default(telemetryPlotOptions(metric, width, 260), data, target)
              setReady(true)
            } else if (instance.width !== width) instance.setSize({ width, height: 260 })
          } catch { fail() }
        }
        resize()
        if (failed) return
        // Observing the parent catches a previously hidden chart becoming visible, too.
        observer = new ResizeObserver(resize)
        observer.observe(target)
      } catch { fail() }
    }
    void mount()
    return () => { active = false; dispose() }
  }, [points, metric, seconds, snapshotIso])
  return <div className="telemetry-uplot" role="img" aria-label="UTC synthetic telemetry chart; missing samples are gaps">
    <div ref={host} />
    {!ready && fallback}
  </div>
}
