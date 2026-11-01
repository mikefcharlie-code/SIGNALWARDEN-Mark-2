import { useEffect, useMemo, useState } from 'react'
import { inferenceJob, inferenceStatus, startInference } from './local-ai-inference'
import type { InferenceJob, WardenNavInferenceResult } from './local-ai-inference'

type Scenario = 'nominal' | 'hard_negative_maneuver' | 'jamming_like' | 'spoofing_drag' | 'spoofing_jump' | 'replay_like' | 'estimator_reset' | 'compass_glitch' | 'baro_drift' | 'stuck_gnss' | 'low_presence' | 'stale' | 'untrusted_ingress'
type Trust = 'signature-verified' | 'transport-asserted' | 'untrusted' | 'unknown'
type Finding = { finding_id: string; subsystem: string; observed: number; threshold: number; units: string; evidence_channels: string; sequence_from: number | null; sequence_to: number | null }
type Trace = { timestamp: string; sequence: number | null; position_velocity_residual_5s_m: number | null; position_velocity_residual_15s_m: number | null; position_velocity_residual_30s_m: number | null; vertical_velocity_residual_m_s: number | null; heading_yaw_residual_deg: number | null; gps_age_seconds: number | null; position_age_seconds: number | null }
type Demo = {
  scenario: Scenario; scenario_label_synthetic_only: string; seed: number; synthetic_only: true; read_only: true; advisory_only: true
  telemetry_trust: string; airframe_class: string | null; window_seconds: number; sample_rate_hz: number; window_steps: number
  window_start: string; window_end: string; field_presence_ratio: number; navigation_presence_ratio: number; window_coverage_ratio: number
  assessment: { status: string; telemetry_trust: string; trust_interpretation: string; baseline_findings: Finding[]; abstention_reasons: string[]; limitations: string[]; window: { latest_ages_seconds?: { position?: number | null; gps?: number | null; attitude?: number | null }; autopilot_mode_presence_ratio?: number; armed_state_change_count?: number; custom_mode_change_count?: number; stale_fields?: string[]; unknown_age_fields?: string[]; [key: string]: unknown } }
  residual_traces: Trace[]; learned_inference: { status: string; model_id: string; detail: string }
  advisory_events: Array<{ event_id: string; event_type: string; summary: string; source: string; attributes: Record<string, unknown> }>; limitations: string[]
}
const scenarios: Scenario[] = ['nominal', 'hard_negative_maneuver', 'jamming_like', 'spoofing_drag', 'spoofing_jump', 'replay_like', 'estimator_reset', 'compass_glitch', 'baro_drift', 'stuck_gnss', 'low_presence', 'stale', 'untrusted_ingress']
const wait = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds))
const evidenceRange = (from: number | null | undefined, to: number | null | undefined) => from == null || to == null ? 'sequence range unavailable' : `sequence ${from}–${to}`
const displayAge = (value: number | null | undefined) => value == null ? 'Unknown' : `${value.toFixed(1)} s${value > 2 ? ' · stale' : ''}`

function ResidualChart({ traces }: { traces: Trace[] }) {
  const points = useMemo(() => traces.filter((trace) => Number.isFinite(trace.position_velocity_residual_5s_m)), [traces])
  if (points.length < 2) return <div className="warden-nav-chart-empty">No position-vs-integrated-velocity residual series is available.</div>
  const maxValue = Math.max(6, ...points.map((point) => point.position_velocity_residual_5s_m ?? 0))
  const upper = Math.ceil(maxValue / 5) * 5
  const polyline = points.map((point, index) => `${(38 + index / (points.length - 1) * 590).toFixed(1)},${(172 - (point.position_velocity_residual_5s_m ?? 0) / upper * 132).toFixed(1)}`).join(' ')
  const thresholdY = 172 - 5 / upper * 132
  return <svg className="warden-nav-chart" viewBox="0 0 650 210" role="img" aria-label={`Synthetic 5-second position versus integrated velocity residual, maximum ${maxValue.toFixed(1)} metres; development threshold 5 metres`}>
    {[0, .25, .5, .75, 1].map((fraction) => <g key={fraction}><line x1="38" x2="628" y1={172 - fraction * 132} y2={172 - fraction * 132} stroke="#ddd9d0" strokeDasharray="3 5" /><text x="30" y={176 - fraction * 132} textAnchor="end">{(upper * fraction).toFixed(0)}</text></g>)}
    <line x1="38" x2="628" y1={thresholdY} y2={thresholdY} stroke="#bd6b37" strokeDasharray="5 4" />
    <polyline points={polyline} fill="none" stroke="#256b7b" strokeWidth="2.5" strokeLinejoin="round" />
    <text x="38" y="198">{points[0]?.timestamp}</text><text x="628" y="198" textAnchor="end">{points[points.length - 1]?.timestamp}</text>
    <text x="44" y="18">5-second residual · metres · dashed = 5 m synthetic-development threshold</text>
  </svg>
}

async function fetchDemo(scenario: Scenario, seed: number, trust: Trust, airframe: string, signal: AbortSignal) {
  const query = new URLSearchParams({ scenario, seed: String(seed), trust, airframe_class: airframe })
  const response = await fetch(`/api/v1/warden/navigation-integrity/demo?${query}`, { cache: 'no-store', signal, redirect: 'error' })
  const body = await response.json() as Demo | { error?: { message?: string } }
  if (!response.ok) throw new Error('error' in body ? body.error?.message ?? `Demo request failed (${response.status}).` : `Demo request failed (${response.status}).`)
  return body as Demo
}

export function WardenNavDemoPanel() {
  const [scenario, setScenario] = useState<Scenario>('nominal')
  const [seed, setSeed] = useState(7)
  const [trust, setTrust] = useState<Trust>('signature-verified')
  const [airframe, setAirframe] = useState('multicopter-light')
  const [demo, setDemo] = useState<Demo | null>(null)
  const [loading, setLoading] = useState(true)
  const [demoError, setDemoError] = useState('')
  const [token, setToken] = useState('')
  const [model, setModel] = useState<WardenNavInferenceResult | null>(null)
  const [modelError, setModelError] = useState('')
  const [modelBusy, setModelBusy] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setDemoError(''); setModel(null); setModelError('')
    fetchDemo(scenario, seed, trust, airframe, controller.signal).then((value) => { if (!controller.signal.aborted) setDemo(value) })
      .catch((error: unknown) => { if (!controller.signal.aborted) setDemoError(error instanceof Error ? error.message : 'Synthetic NAV demo could not be loaded.') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [scenario, seed, trust, airframe])

  const runModel = async () => {
    if (!demo || !token.trim() || modelBusy) return
    setModelBusy(true); setModel(null); setModelError('')
    try {
      const credential = token.trim()
      const readiness = await inferenceStatus(credential)
      const group = readiness.groups.find((item) => item.group === 'navigation-integrity')
      if (!group?.ready) { setModelError(`No learned result was run. ${group?.detail ?? 'Warden-NAV local ONNX is not installed.'} No automatic download or fallback is attempted.`); return }
      let job = await startInference(credential, { group: 'navigation-integrity', device: 'cpu', scenario, seed, airframe_class: airframe === 'unknown' ? null : airframe, trust })
      for (let attempt = 0; (job.state === 'queued' || job.state === 'running') && attempt < 120; attempt += 1) { await wait(500); job = await inferenceJob(credential, job.id) }
      if (job.state !== 'succeeded' || !job.result || job.result.group !== 'navigation-integrity') {
        const error = (job as InferenceJob).error
        setModelError(error ? `${error.code}: ${error.message}` : `Local NAV inference ended as ${job.state}; no learned result is available.`)
        return
      }
      setModel(job.result as WardenNavInferenceResult)
    } catch (error) { setModelError(error instanceof Error ? error.message : 'Local NAV inference failed; no external fallback was attempted.') }
    finally { setModelBusy(false) }
  }

  return <section className="panel warden-th-panel warden-nav-panel" aria-label="Warden-NAV synthetic navigation-integrity demo">
    <div className="panel-title"><div><span className="eyebrow">Warden-NAV / synthetic only</span><h2>Navigation integrity advisory</h2></div><span className="tag">READ ONLY · NO COMMAND PATH</span></div>
    <p className="warden-th-intro">A fixed 120-second, 2 Hz window compares internal telemetry only: position against integrated velocity, altitude rate, heading/yaw, MSL-relative drift, and GPS state/age. Missingness, age, airframe class, and ingress trust remain explicit.</p>
    <div className="warden-th-controls">
      <label><span>Seeded scenario</span><select value={scenario} onChange={(event) => setScenario(event.target.value as Scenario)}>{scenarios.map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></label>
      <label><span>Seed</span><input type="number" min={0} max={1000000} step={1} value={seed} onChange={(event) => { const parsed = Number(event.target.value); if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 1000000) setSeed(parsed) }} /></label>
      <label><span>Airframe class</span><select value={airframe} onChange={(event) => setAirframe(event.target.value)}><option value="multicopter-light">Multicopter · light</option><option value="multicopter-heavy">Multicopter · heavy</option><option value="fixed-wing-lab">Fixed wing · lab</option><option value="unknown">Unknown</option></select></label>
      <label><span>Ingress trust</span><select value={trust} onChange={(event) => setTrust(event.target.value as Trust)}><option value="signature-verified">Signature verified</option><option value="transport-asserted">Transport asserted</option><option value="untrusted">Untrusted ingress</option><option value="unknown">Unknown</option></select></label>
    </div>
    {loading && <p role="status">Generating seeded synthetic navigation window…</p>}
    {demoError && <div className="warden-th-error" role="alert">Synthetic NAV demo unavailable: {demoError}</div>}
    {demo && <>
      <div className="warden-nav-scenario-notice"><strong>Synthetic scenario label: {demo.scenario_label_synthetic_only.replaceAll('_', ' ')}</strong><span>This is a generated development scenario, not an inference about an aircraft, interference source, or real-world cause.</span></div>
      <div className="warden-window-summary"><div><span>Fixed window</span><strong>{demo.window_seconds}s · {demo.window_steps} steps · {demo.sample_rate_hz} Hz</strong><small>{demo.window_start} → {demo.window_end}</small></div><div><span>Presence / coverage</span><strong>{(demo.field_presence_ratio * 100).toFixed(1)}% / {(demo.window_coverage_ratio * 100).toFixed(1)}%</strong><small>Feature presence and sample coverage are separate gates.</small></div><div><span>Trust / freshness</span><strong>{demo.telemetry_trust} · {demo.assessment.status.replaceAll('_', ' ')}</strong><small>{demo.assessment.abstention_reasons.length ? `Abstention notes: ${demo.assessment.abstention_reasons.join(', ')}` : `Navigation presence ${(demo.navigation_presence_ratio * 100).toFixed(1)}%`}</small></div></div>
      <div className="warden-nav-age-summary"><strong>Latest telemetry age</strong><span>Position {displayAge(demo.assessment.window.latest_ages_seconds?.position)} · GPS {displayAge(demo.assessment.window.latest_ages_seconds?.gps)} · attitude {displayAge(demo.assessment.window.latest_ages_seconds?.attitude)}</span><small>Missing fields: {((1 - demo.field_presence_ratio) * 100).toFixed(1)}% of required field-slots. Stale: {demo.assessment.window.stale_fields?.join(', ') || 'none'} · age unknown: {demo.assessment.window.unknown_age_fields?.join(', ') || 'none'}.</small><small>Autopilot mode-field presence: {((demo.assessment.window.autopilot_mode_presence_ratio ?? 0) * 100).toFixed(1)}%; armed-state changes: {demo.assessment.window.armed_state_change_count ?? 'unknown'}; custom-mode changes: {demo.assessment.window.custom_mode_change_count ?? 'unknown'}. Diagnostic only; mode changes do not trigger a finding by themselves.</small></div>
      <div className="warden-nav-chart-wrap"><ResidualChart traces={demo.residual_traces} /></div>
      <div className="warden-nav-results">
        <section aria-label="Deterministic NAV baseline"><div className="warden-th-subhead"><h3>Transparent deterministic baseline</h3><span>{demo.assessment.status.replaceAll('_', ' ')}</span></div>
          <p className="warden-nav-threshold-note">Development thresholds only: 5/15/30 s position residuals 5/12/20 m; vertical rate 0.25 m/s; MSL-relative drift 5 m; heading/yaw 45°. Not operational limits.</p>
          {demo.assessment.baseline_findings.length ? <ul className="warden-finding-list">{demo.assessment.baseline_findings.map((finding, index) => <li key={`${finding.finding_id}-${index}`}><strong>{finding.subsystem.replaceAll('_', ' ')}</strong><span>{finding.finding_id.replaceAll('_', ' ')} · {finding.observed} {finding.units}</span><small>{finding.evidence_channels} · {evidenceRange(finding.sequence_from, finding.sequence_to)}</small></li>)}</ul> : <p className="warden-th-empty">No deterministic threshold fired. That is not proof of healthy navigation.</p>}
          <p className="warden-th-event-note">{demo.advisory_events.length} response-only event(s) linked to sequence evidence. Untrusted ingress remains a provenance label and is never rewritten as a spoofing-like telemetry pattern.</p>
        </section>
        <section aria-label="Optional learned local ONNX result"><div className="warden-th-subhead"><h3>Optional learned local ONNX</h3><span>{model?.learned_inference.status ?? demo.learned_inference.status}</span></div>
          <label className="warden-token-label"><span>Local inference admin token (not saved)</span><input type="password" autoComplete="off" spellCheck={false} value={token} onChange={(event) => setToken(event.target.value)} /></label>
          <button type="button" className="button primary" onClick={() => void runModel()} disabled={!token.trim() || modelBusy}>{modelBusy ? 'Running local CPU inference…' : 'Run verified local ONNX'}</button>
          {modelError && <p className="warden-th-error" role="alert">{modelError}</p>}
          {!model && !modelError && <p className="warden-th-empty">No learned output has been requested. The baseline is never used as a learned-model fallback.</p>}
          {model && <>
            <p className="warden-th-hash">Model SHA-256: <code>{model.model_hash ?? model.learned_inference.model_hash ?? 'unavailable'}</code></p>
            {model.learned_inference.abstention_reasons?.length ? <p className="warden-th-abstain">Learned head abstained: {model.learned_inference.abstention_reasons.join(', ')}.</p> : model.learned_inference.pattern_label ? <p className="warden-nav-model-pattern">Advisory pattern resemblance: <strong>{model.learned_inference.pattern_label.replaceAll('_', ' ')}</strong>. No source or position is inferred.</p> : <p className="warden-th-empty">No class threshold exceeded. This is not proof of healthy navigation.</p>}
            {model.learned_inference.baseline_overlap !== undefined && <p className="warden-th-event-note">Baseline overlap: {model.learned_inference.baseline_overlap ? 'at least one deterministic residual finding' : 'no deterministic residual finding'}. Learned score semantics: {model.learned_inference.score_semantics ?? 'development threshold; not confidence'}.</p>}
            {model.advisory_events.length > 0 && <ul className="warden-finding-list">{model.advisory_events.map((event) => <li key={event.event_id}><strong>{event.event_type.replaceAll('_', ' ')}</strong><span>{event.summary}</span><small>evidence seq {String(event.attributes.sequence_from ?? '—')}–{String(event.attributes.sequence_to ?? '—')} · {String(event.attributes.evidence_channels ?? 'residual summary')}</small></li>)}</ul>}
            {model.limitations.map((limitation) => <small className="warden-th-limitation" key={limitation}>{limitation}</small>)}
          </>}
        </section>
      </div>
      <details className="warden-nav-trace-table"><summary>Inspect residual samples ({demo.residual_traces.length})</summary><div className="telemetry-table-scroll"><table><caption>Seeded synthetic NAV residuals · UTC · missing values remain missing · no absolute coordinates</caption><thead><tr><th>UTC</th><th>Sequence</th><th>5 s position residual (m)</th><th>15 s (m)</th><th>30 s (m)</th><th>Altitude-rate residual (m/s)</th><th>Heading/yaw residual (°)</th><th>GPS age (s)</th></tr></thead><tbody>{demo.residual_traces.filter((_, index) => index % 10 === 0 || index === demo.residual_traces.length - 1).map((trace) => <tr key={`${trace.timestamp}-${trace.sequence}`}><td>{trace.timestamp}</td><td>{trace.sequence ?? '—'}</td><td>{trace.position_velocity_residual_5s_m?.toFixed(2) ?? 'Missing'}</td><td>{trace.position_velocity_residual_15s_m?.toFixed(2) ?? 'Missing'}</td><td>{trace.position_velocity_residual_30s_m?.toFixed(2) ?? 'Missing'}</td><td>{trace.vertical_velocity_residual_m_s?.toFixed(3) ?? 'Missing'}</td><td>{trace.heading_yaw_residual_deg?.toFixed(1) ?? 'Missing'}</td><td>{trace.gps_age_seconds?.toFixed(1) ?? 'Unknown'}</td></tr>)}</tbody></table></div></details>
      <div className="warden-th-boundary"><strong>Advisory only; no navigation solution.</strong><span>No raw absolute coordinates, corrected position, source attribution/localization, target, command, control, mission-planning, or actuator output. This panel uses seeded synthetic rows only; no aircraft or stored operational telemetry is read.</span></div>
    </>}
  </section>
}
