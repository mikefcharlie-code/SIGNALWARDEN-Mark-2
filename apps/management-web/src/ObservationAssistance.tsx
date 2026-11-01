import type { ApiState } from './lattice-utils'
import { formatSourceTime } from './lattice-utils'
import type { Assistance } from './observation-state'
import './observation-assistance.css'

export function ObservationAssistance({ state, snapshotId, verified = false }: { state: ApiState<Assistance>; snapshotId?: string; verified?: boolean }) {
  const data = state.data
  const matches = verified && state.status === 'ready' && !!snapshotId && data?.assessment?.snapshotId === snapshotId
  return <section className="panel ob-assistance" aria-labelledby="ob-assistance-title">
    <div className="panel-title"><div><span className="eyebrow">Local-first assistance / data quality only</span><h2 id="ob-assistance-title">Advisory review</h2></div><span className="tag">HUMAN REVIEW REQUIRED</span></div>
    <p>Source-grounded explanations, not operational decisions. This panel cannot issue vehicle, sensor, or effector commands.</p>
    {state.status === 'loading' && <p role="status">{data ? 'Previous assistance retained while rechecking; not verified by this refresh.' : 'Checking local assistance configuration…'}</p>}
    {state.status === 'error' && <div className="ob-inline-error" role="alert">Assistance unavailable: {state.error} {data ? 'Retained assistance below is NOT CURRENTLY VERIFIED.' : 'No generated explanation was substituted.'}</div>}
    {data && <>
      <dl className="ob-ai-config"><div><dt>Mode / provider</dt><dd>{data.mode} / {data.provider}</dd></div><div><dt>Engine / model status</dt><dd>{data.engine} / {data.modelStatus}</dd></div><div><dt>Assistance snapshot</dt><dd>{formatSourceTime(data.generatedAt)}</dd></div><div><dt>Last successful receipt</dt><dd>{formatSourceTime(state.receivedAt ?? null)}</dd></div></dl>
      <div className={`ob-ai-disclosure ${data.mode === 'external' ? 'external' : ''}`}><strong>{data.mode === 'external' ? data.dataLeavesSystem ? 'EXTERNAL AI OPT-IN · DATA LEAVES THIS SYSTEM' : 'EXTERNAL MODE SELECTED · PROVIDER NOT ENABLED' : 'LOCAL MODE · NO EXTERNAL AI FALLBACK'}</strong><p>{data.disclosure}</p></div>
      {matches ? <details><summary>Grounded explanation · {data.engine === 'rules' ? 'deterministic, not an LLM' : 'model-assisted fixed statements'}</summary><p className="ob-ai-summary">{data.summary}</p><div className="ob-ai-insights">{data.insights.map((item) => <article key={item.id}><h3>{item.title}</h3><p>{item.detail}</p><small>Exact local evidence IDs: {item.evidence.join(' · ') || 'Aggregate only; no individual citation'}</small></article>)}</div></details> : <p role="status">Explanation withheld: its evidence snapshot is different, still loading, or not currently verified. Provider configuration and egress disclosure remain visible.</p>}
      <ul className="ob-ai-limitations">{data.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
    </>}
    <small>Runtime/provider configuration is server-side only. External mode requires a separate explicit provider selection and data-export opt-in. Credentials never belong in browser settings.</small>
  </section>
}
