import { useEffect, useState } from 'react'
import { inferenceJob, inferenceStatus, startInference } from './local-ai-inference'
import type { InferenceJob, WardenFeatureWindow, WardenInferenceResult } from './local-ai-inference'

const scenarios = ['nominal', 'battery_sag', 'thermal_ramp', 'link_degradation', 'gps_jump', 'attitude_oscillation', 'stuck_sensor', 'unexpected_mode_change', 'low_presence'] as const
type Scenario = typeof scenarios[number]
type BaselineFinding = { subsystem: string; rule: string; evidence_channels: string; sequence_from: number | null; sequence_to: number | null; detected: boolean }
type EnduranceBand = { p10_minutes: number; p50_minutes: number; p90_minutes: number; method: string; calibration: string }
type Demo = {
  scenario: Scenario; seed: number; synthetic_only: true; airframe_class: string | null; fault_labels: string[]
  fault_onset_timestamp: string | null; window_start: string; window_end: string; window_seconds: number; window_steps: number
  field_presence_ratio: number; telemetry_trust: string; baseline: { status: string; findings: BaselineFinding[]; endurance_band: EnduranceBand | null; abstention_reasons: string[] }
  learned_inference: { status: string; reason: string }; inference_window: WardenFeatureWindow
  event_window: { start: string; end: string; start_index: number; end_index: number; fault_labels: string[] }
  advisory_events: Array<{ event_id: string; event_type: string; summary: string; attributes: Record<string, unknown> }>
  prototype_evaluation: { targets_met?: boolean; stream_recall_by_subsystem?: Record<string, number>; full_window_recall_by_subsystem?: Record<string, number>; median_detection_delay_seconds?: number; nominal_false_alarms_per_flight_hour?: number; endurance_p50_absolute_error_minutes?: number; endurance_p10_p90_coverage_percent?: number; low_presence_abstention_percent?: number }
  limitations: string[]
}

const time = (value: number | null | undefined) => value === null || value === undefined ? '—' : `${value.toFixed(1)} min`
const sequence = (from: number | null, to: number | null) => from === null || to === null ? 'sequence unavailable' : `seq ${from}–${to}`
const wait = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds))

async function fetchDemo(scenario: Scenario, seed: number, trust: string, signal: AbortSignal): Promise<Demo> {
  const query = new URLSearchParams({ scenario, seed: String(seed), trust })
  const response = await fetch(`/api/v1/warden/telemetry-health/demo?${query}`, { cache: 'no-store', signal, redirect: 'error' })
  const body = await response.json() as Demo | { error?: { message?: string } }
  if (!response.ok) throw new Error('error' in body ? body.error?.message ?? `Demo request failed (${response.status}).` : `Demo request failed (${response.status}).`)
  return body as Demo
}

function Band({ label, band, note }: { label: string; band: EnduranceBand | null; note: string }) {
  return <div className="warden-endurance"><span className="eyebrow">{label}</span>{band ? <><strong>{time(band.p50_minutes)} <small>median to 20%</small></strong><div className="warden-band-range"><span>p10 {time(band.p10_minutes)}</span><span>p90 {time(band.p90_minutes)}</span></div><small>{note}</small></> : <p>No estimate{note ? ` — ${note}` : ''}</p>}</div>
}

export function WardenThDemoPanel() {
  const [scenario, setScenario] = useState<Scenario>('battery_sag')
  const [seed, setSeed] = useState(7)
  const [trust, setTrust] = useState<'signature-verified' | 'untrusted'>('signature-verified')
  const [demo, setDemo] = useState<Demo | null>(null)
  const [loading, setLoading] = useState(true)
  const [demoError, setDemoError] = useState('')
  const [token, setToken] = useState('')
  const [model, setModel] = useState<WardenInferenceResult | null>(null)
  const [modelError, setModelError] = useState('')
  const [modelBusy, setModelBusy] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setDemoError(''); setModel(null); setModelError('')
    fetchDemo(scenario, seed, trust, controller.signal).then((value) => { if (!controller.signal.aborted) setDemo(value) })
      .catch((error: unknown) => { if (!controller.signal.aborted) setDemoError(error instanceof Error ? error.message : 'Synthetic demo could not be loaded.') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [scenario, seed, trust])

  const runModel = async () => {
    if (!demo || !token.trim() || modelBusy) return
    setModelBusy(true); setModel(null); setModelError('')
    try {
      const credential = token.trim()
      const status = await inferenceStatus(credential)
      const ready = status.groups.find((group) => group.group === 'telemetry-health')
      if (!ready?.ready) {
        setModelError(`No learned result was run. ${ready?.detail ?? 'Telemetry-health is not enabled.'} No automatic download or fallback is attempted.`)
        return
      }
      let job = await startInference(credential, { group: 'telemetry-health', device: 'cpu', window: demo.inference_window })
      for (let attempt = 0; (job.state === 'queued' || job.state === 'running') && attempt < 120; attempt += 1) {
        await wait(500)
        job = await inferenceJob(credential, job.id)
      }
      if (job.state !== 'succeeded' || !job.result || job.result.group !== 'telemetry-health') {
        const error = (job as InferenceJob).error
        setModelError(error ? `${error.code}: ${error.message}` : `Local ONNX job ended as ${job.state}; no learned output is available.`)
        return
      }
      setModel(job.result as WardenInferenceResult)
    } catch (error) {
      setModelError(error instanceof Error ? error.message : 'Local inference failed; no external fallback was attempted.')
    } finally { setModelBusy(false) }
  }

  return <section className="panel warden-th-panel" aria-label="Warden telemetry health synthetic demo">
    <div className="panel-title"><div><span className="eyebrow">Warden-TH / synthetic only</span><h2>Telemetry health & endurance</h2></div><span className="tag">ADVISORY · NO COMMAND PATH</span></div>
    <p className="warden-th-intro">Seeded 2 Hz telemetry shown in a fixed 120-second window. The deterministic baseline is always visible; the learned model runs only when explicitly requested and its local ONNX artifact is verified.</p>
    <div className="warden-th-controls">
      <label><span>Fault scenario</span><select value={scenario} onChange={(event) => setScenario(event.target.value as Scenario)}>{scenarios.map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></label>
      <label><span>Seed</span><input type="number" min={0} max={1000000} step={1} value={seed} onChange={(event) => { const parsed = Number(event.target.value); if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 1000000) setSeed(parsed) }} /></label>
      <label><span>Telemetry trust</span><select value={trust} onChange={(event) => setTrust(event.target.value as 'signature-verified' | 'untrusted')}><option value="signature-verified">Trusted</option><option value="untrusted">Untrusted</option></select></label>
    </div>
    {loading && <p role="status">Loading seeded synthetic window…</p>}
    {demoError && <div className="warden-th-error" role="alert">Synthetic demo unavailable: {demoError}</div>}
    {demo && <>
      {demo.prototype_evaluation && Object.keys(demo.prototype_evaluation).length > 0 && <div className={`warden-th-evaluation ${demo.prototype_evaluation.targets_met ? 'met' : 'not-met'}`} role="status"><strong>Held-out synthetic evaluation: targets {demo.prototype_evaluation.targets_met ? 'met' : 'not met'}</strong><span>5-second replay recall — {Object.entries(demo.prototype_evaluation.stream_recall_by_subsystem ?? {}).map(([name, value]) => `${name} ${(value * 100).toFixed(1)}%`).join(' · ')}. Median delay {demo.prototype_evaluation.median_detection_delay_seconds ?? '—'}s; false alarms {demo.prototype_evaluation.nominal_false_alarms_per_flight_hour ?? '—'}/hour; endurance p50 error {demo.prototype_evaluation.endurance_p50_absolute_error_minutes ?? '—'} min; p10–p90 coverage {demo.prototype_evaluation.endurance_p10_p90_coverage_percent ?? '—'}%; low-presence abstention {demo.prototype_evaluation.low_presence_abstention_percent ?? '—'}%.</span><small>Development measurements on seeded synthetic data only; not flight, SITL, or field validation.</small></div>}
      <div className="warden-window-summary"><div><span>Window</span><strong>{demo.window_seconds}s · {demo.window_steps} steps · 2 Hz</strong><small>{demo.window_start} → {demo.window_end}</small></div><div><span>Fault onset</span><strong>{demo.fault_onset_timestamp ? new Date(demo.fault_onset_timestamp).toISOString() : 'None injected'}</strong><small>{demo.fault_labels.length ? demo.fault_labels.join(', ') : 'Nominal synthetic fixture'}</small></div><div><span>Presence / trust</span><strong>{(demo.field_presence_ratio * 100).toFixed(1)}% · {demo.telemetry_trust}</strong><small>Below 60% presence, the model abstains.</small></div></div>
      <div className="warden-window-track" role="img" aria-label={`120-second evidence window; injected fault begins at step ${demo.event_window.start_index} of ${demo.window_steps}`}><span className="warden-window-track-label">0 s</span><span className="warden-window-track-fill" /><span className="warden-window-onset" style={{ left: `${Math.max(0, Math.min(100, demo.event_window.start_index / Math.max(1, demo.window_steps) * 100))}%` }} /><span className="warden-window-track-end">120 s</span></div>
      <div className="warden-th-results">
        <section aria-label="Deterministic baseline results"><div className="warden-th-subhead"><h3>Deterministic baseline</h3><span>{demo.baseline.status.replaceAll('_', ' ')}</span></div>
          {demo.baseline.abstention_reasons.length > 0 && <p className="warden-th-abstain">Abstains: {demo.baseline.abstention_reasons.join(', ')}</p>}
          {demo.baseline.findings.length ? <ul className="warden-finding-list">{demo.baseline.findings.map((finding, index) => <li key={`${finding.subsystem}-${finding.rule}-${index}`}><strong>{finding.subsystem}</strong><span>{finding.rule.replaceAll('_', ' ')}</span><small>{finding.evidence_channels} · {sequence(finding.sequence_from, finding.sequence_to)}</small></li>)}</ul> : <p className="warden-th-empty">No deterministic rule fired. This is not proof that the telemetry is healthy.</p>}
          <Band label="Heuristic baseline endurance" band={demo.baseline.endurance_band} note="Heuristic only; not flight-calibrated." />
          <p className="warden-th-event-note">{demo.advisory_events.length} advisory event(s), linked to the synthetic evidence window; not stored as canonical observations.</p>
        </section>
        <section aria-label="Learned ONNX results"><div className="warden-th-subhead"><h3>Learned local ONNX</h3><span>{model?.status ?? 'not requested'}</span></div>
          <label className="warden-token-label"><span>Local inference admin token (not saved)</span><input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} /></label>
          <button className="button primary" onClick={runModel} disabled={!demo || !token.trim() || modelBusy}>{modelBusy ? 'Running local CPU inference…' : 'Run verified local model'}</button>
          {modelError && <p className="warden-th-error" role="alert">{modelError}</p>}
          {model?.abstention_reasons?.length ? <p className="warden-th-abstain">Abstained: {model.abstention_reasons.join(', ')}</p> : null}
          {model && !model.abstention_reasons?.length && <>
            <p className="warden-th-hash">Model SHA-256: <code>{model.model_hash ?? 'unavailable'}</code></p>
            <ul className="warden-finding-list">{model.subsystem_findings.filter((finding) => finding.detected).map((finding) => <li key={finding.subsystem}><strong>{finding.subsystem}</strong><span>Model anomaly flag · nominal percentile {finding.nominal_percentile ?? '—'}</span><small>{finding.evidence_channels} · {sequence(finding.sequence_from, finding.sequence_to)}</small></li>)}</ul>
            {!model.subsystem_findings.some((finding) => finding.detected) && <p className="warden-th-empty">No subsystem flag from this model. This is not proof that the telemetry is healthy.</p>}
            <Band label="Learned endurance band" band={model.endurance_band} note={model.endurance_band?.calibration ?? 'No estimate available.'} />
            {model.advisory_events?.length > 0 && <div className="warden-th-event-note">{model.advisory_events.length} evidence-linked advisory event(s) returned. They are not persisted or routed to commands.</div>}
            {model.limitations?.map((limitation) => <small className="warden-th-limitation" key={limitation}>{limitation}</small>)}
          </>}
          {!model && !modelError && <p className="warden-th-empty">No learned inference has been requested. The baseline is not silently substituted for model output.</p>}
        </section>
      </div>
      <div className="warden-th-boundary"><strong>Synthetic, advisory only.</strong><span>No live telemetry is read. Findings are response-only projections; no records are changed. The Warden-TH result cannot command, plan, upload a mission, arm, or actuate anything.</span></div>
    </>}
  </section>
}
