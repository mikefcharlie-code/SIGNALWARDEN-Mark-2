import { useMemo, useState } from 'react'
import {
  approveMission,
  advanceMission,
  buildDebrief,
  correlateObservations,
  createMission,
  degradeAsset,
  exportMission,
  pauseMission,
  planMission,
  startMission,
  templates,
} from './mission-autonomy'
import type { Asset, MissionState, MissionTemplate, Task } from './mission-autonomy'
import './mission-autonomy.css'

const templateIds = Object.keys(templates) as MissionTemplate[]

function statusTone(value: string) {
  if (/unavailable|blocked|stale|degraded|paused|unknown|invalid/i.test(value)) return 'warn'
  if (/complete|eligible|available|ready|corroborated|running/i.test(value)) return 'good'
  if (/blocked|stale|degraded|paused/i.test(value)) return 'warn'
  return 'quiet'
}

function download(filename: string, content: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function taskStatus(task: Task) {
  return <span className={`ma-pill ${statusTone(task.status)}`}>{task.status}</span>
}

function resourceStatus(asset: Asset) {
  if (!asset.available) return 'Unavailable'
  if (asset.battery === null || asset.link === null) return 'Unknown resources'
  if (![asset.battery, asset.link, asset.ageSeconds].every(Number.isFinite) || asset.battery > 100 || asset.link > 100 || asset.ageSeconds < 0) return 'Invalid resources'
  if (asset.battery < 30) return 'Battery below gate'
  if (asset.link < 60) return 'Link below gate'
  if (asset.ageSeconds > 30) return 'Telemetry stale'
  return 'Eligible'
}

export function MissionAutonomy() {
  const [template, setTemplate] = useState<MissionTemplate>('area-survey')
  const [state, setState] = useState<MissionState>(() => createMission('area-survey'))
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const correlated = useMemo(() => correlateObservations(state.observations), [state.observations])
  const completed = state.tasks.filter((task) => task.status === 'complete').length
  const canPlan = state.phase === 'draft' || state.phase === 'paused' || state.phase === 'review'
  const canApprove = state.phase === 'review' && state.tasks.length > 0 && !state.tasks.some((task) => task.status === 'blocked')
  const canStart = state.phase === 'review' && state.approvedRevision === state.revision && !state.tasks.some((task) => task.status === 'blocked')
  const canAdvance = state.phase === 'running' && !state.tasks.some((task) => task.status === 'blocked')

  const safe = (action: (current: MissionState) => MissionState, message: string) => {
    try {
      setError('')
      const next = action(state)
      setState(next)
      setNotice(message)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Local workflow action failed. No state was changed.')
      setNotice('')
    }
  }

  const chooseTemplate = (next: MissionTemplate) => {
    try {
      setError('')
      setTemplate(next)
      setState(createMission(next))
      setNotice(`Started a new ${templates[next].label.toLowerCase()} draft.`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not create a mission draft.')
    }
  }

  const reset = () => {
    if (!window.confirm('Reset this local rehearsal and discard its unsaved plan?')) return
    chooseTemplate(template)
  }

  const degrade = (id: string) => safe((current) => degradeAsset(current, id), 'Degraded asset injected. Replan and approve the revised allocation before starting again.')
  const exportFile = (kind: 'json' | 'markdown') => {
    try {
      setError('')
      download(kind === 'json' ? 'synthetic-mission-plan.json' : 'synthetic-mission-debrief.md', kind === 'json' ? exportMission(state) : buildDebrief(state), kind === 'json' ? 'application/json' : 'text/markdown')
      setNotice(`Downloaded local ${kind} export.`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The local export could not be created.')
    }
  }

  return <div className="mission-autonomy-workspace">
    <div className="ma-banner" role="note"><strong>SYNTHETIC REHEARSAL · NO AIRCRAFT CONTROL</strong><span>This workspace plans and replays local, synthetic multi-domain scenarios only. It does not command hardware, connect to Anduril, or provide an operational control path.</span></div>
    <header className="section-heading ma-heading"><div><span className="eyebrow">Mission autonomy / local rehearsal</span><h1>Plan, rehearse, debrief</h1><p>Human-gated task orchestration across reference air, land and sea simulation domains.</p></div><span className="tag">LOCAL · SYNTHETIC</span></header>

    <section className="ma-template-grid" aria-label="Mission templates">
      {templateIds.map((id) => <button key={id} className={`ma-template ${template === id ? 'selected' : ''}`} onClick={() => chooseTemplate(id)} aria-pressed={template === id}><span className="eyebrow">Template 0{templateIds.indexOf(id) + 1}</span><strong>{templates[id].label}</strong><span>{templates[id].intent}</span></button>)}
    </section>

    <div className="ma-lifecycle" aria-label="Mission lifecycle"><span className="eyebrow">Lifecycle gate</span>{(['draft', 'review', 'running', 'paused', 'completed'] as MissionState['phase'][]).map((phase, index) => <span key={phase} className={state.phase === phase ? 'current' : state.phase === 'completed' || (['draft', 'review', 'running', 'paused'].indexOf(state.phase) > index) ? 'done' : ''}><b>{index + 1}</b>{phase}</span>)}</div>

    {error && <div className="ma-error" role="alert"><strong>Action not accepted.</strong> {error}</div>}
    {notice && !error && <div className="ma-notice" role="status" aria-live="polite">{notice}</div>}

    <section className="ma-commandbar panel" aria-label="Mission actions"><div><span className="eyebrow">Current phase / revision</span><strong>{state.phase} · r{state.revision}{state.approvedRevision === state.revision ? ' · approved' : ''}</strong></div><div className="ma-actions"><button className="button orange" onClick={() => safe(planMission, 'Tasks compiled and resources allocated locally.')} disabled={!canPlan}>Compile & allocate</button><button className="button ghost" onClick={() => safe(approveMission, 'Revision approved by local human workflow.')} disabled={!canApprove}>Approve revision</button><button className="button ghost" onClick={() => safe(startMission, 'Synthetic rehearsal started.')} disabled={!canStart}>Start rehearsal</button><button className="button ghost" onClick={() => safe(pauseMission, 'Rehearsal paused for review.')} disabled={state.phase !== 'running'}>Pause</button><button className="button ghost" onClick={() => safe(advanceMission, 'Advanced one task in the synthetic rehearsal.')} disabled={!canAdvance}>Step task</button><button className="button text-button" onClick={reset}>Reset draft</button></div></section>

    <div className="ma-layout">
      <div className="ma-main">
        <section className="panel ma-panel" aria-labelledby="plan-title"><div className="panel-title"><div><span className="eyebrow">Execution plan / allocation</span><h2 id="plan-title">{templates[state.template].label}</h2></div><span className={`ma-pill ${statusTone(state.phase)}`}>{state.phase}</span></div><p className="ma-intent">{state.intent}</p><div className="ma-progress"><span style={{ width: `${state.tasks.length ? (completed / state.tasks.length) * 100 : 0}%` }} /></div><div className="ma-task-list">{state.tasks.length === 0 && <p className="ma-muted">Compile the selected template to review tasks and proposed resource assignments.</p>}{state.tasks.map((task, index) => <article className={`ma-task ${task.status}`} key={task.id}><div className="ma-task-index">{String(index + 1).padStart(2, '0')}</div><div className="ma-task-copy"><strong>{task.label}</strong><span>{task.domain.toUpperCase()} · requires {task.capability}</span><small>{task.reason}</small></div><div className="ma-task-right">{taskStatus(task)}<code>{task.assetId ?? 'unallocated'}</code></div></article>)}</div></section>

        <section className="panel ma-panel" aria-labelledby="observations-title"><div className="panel-title"><div><span className="eyebrow">Evidence context / explicit correlation</span><h2 id="observations-title">Observation register</h2></div><span className="tag">NOT SENSOR FUSION</span></div><p className="ma-muted">Correlations below are deterministic groupings of synthetic records by subject; they are not an AI sensor-fusion claim.</p><div className="ma-observations">{correlated.map((item) => <div className="ma-observation" key={item.subjectId}><div><strong>{item.subjectId}</strong><span>{item.summary}</span></div><div><span className={`ma-pill ${statusTone(item.status)}`}>{item.status}</span><small>{Math.round(item.confidence * 100)}% · {item.sensors.join(' + ')}</small><small>Sources: {item.sourceIds.join(', ')}</small></div></div>)}</div></section>
      </div>

      <aside className="ma-side">
        <section className="panel ma-panel" aria-labelledby="resources-title"><div className="panel-title"><div><span className="eyebrow">Roster / synthetic resources</span><h2 id="resources-title">Asset readiness</h2></div></div><div className="ma-assets">{state.assets.map((asset) => <article key={asset.id} aria-label={asset.name} className={!asset.available ? 'degraded' : ''}><div className="ma-asset-head"><strong>{asset.name}</strong><span className={`ma-pill ${statusTone(resourceStatus(asset))}`}>{resourceStatus(asset)}</span></div><small>{asset.domain.toUpperCase()} · {asset.autopilot} · {asset.capabilities.join(', ')}</small><div className="ma-metrics"><span><b>{asset.battery === null ? '—' : `${asset.battery}%`}</b> battery</span><span><b>{asset.link === null ? '—' : `${asset.link}%`}</b> link</span><span><b>{asset.ageSeconds}s</b> freshness</span></div>{asset.available && <button className="ma-degrade" onClick={() => degrade(asset.id)} disabled={state.phase === 'completed'}>Inject degraded asset</button>}</article>)}</div><p className="ma-footnote">Eligibility gates: battery ≥ 30 · link ≥ 60 · freshness ≤ 30s. One asset may satisfy one task. Gates are illustrative, not flight-safety limits. Human approval is a local workflow, not authenticated authority.</p></section>

        <section className="panel ma-panel" aria-labelledby="audit-title"><div className="panel-title"><div><span className="eyebrow">Audit / local event stream</span><h2 id="audit-title">Rehearsal record</h2></div></div><ol className="ma-events">{state.events.slice().reverse().map((event) => <li key={event.sequence}><code>#{String(event.sequence).padStart(2, '0')}</code><div><strong>{event.kind}</strong><span>{event.detail}</span></div></li>)}</ol></section>
      </aside>
    </div>

    <section className="panel ma-export"><div><span className="eyebrow">Artifacts / session-local</span><h2>Export the rehearsal record</h2><p>Downloads are generated in this browser and are not persisted or uploaded.</p></div><div className="ma-actions"><button className="button ghost" onClick={() => exportFile('json')}>Download plan JSON</button><button className="button ghost" onClick={() => exportFile('markdown')}>Download Markdown debrief</button></div></section>
    <footer className="ma-footer">Reference patterns adapted from <a href="https://www.anduril.com/lattice/mission-autonomy" target="_blank" rel="noreferrer">Anduril public mission autonomy material</a>; not licensed, integrated, endorsed, or connected. PX4 quad, ArduPilot fixed-wing, sea and land entries are reference simulations only.</footer>
  </div>
}
