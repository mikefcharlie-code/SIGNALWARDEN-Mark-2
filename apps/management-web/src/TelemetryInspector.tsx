import { useMemo, useState } from 'react'
import type { FleetAircraft } from './fleet-utils'
import { freshnessFor } from './fleet-utils'
import { buildTelemetrySnapshot, filterTelemetryEvents, historyWindow, metricConfig, visibleMeasurement } from './telemetry-utils'
import type { DemoScenario, MetricId, Outcome, TelemetryPoint } from './telemetry-utils'
import { TelemetryPlot } from './TelemetryPlot'
import './telemetry-inspector.css'

const scenarioLabels: Record<DemoScenario, string> = { recorded: 'Recorded fixture', 'link-loss': 'What-if: link loss', recovery: 'What-if: recovery' }
const tone = (value: string) => value === 'Fresh' || value === 'accepted' ? 'green' : value === 'Delayed' || value === 'late' ? 'orange' : value === 'duplicate' ? 'blue' : 'red'
function Pill({ value }: { value: string }) { return <span className={`status-pill ${tone(value)}`}><span className="status-dot" />{value}</span> }
function ageLabel(seconds: number) { return !Number.isFinite(seconds) || seconds < 0 ? 'Unknown' : seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m` }
function offsetLabel(seconds: number) { return seconds === 0 ? 'Snapshot' : `−${ageLabel(Math.abs(seconds))}` }

function HistoryFallback({ points, metric, seconds }: { points: TelemetryPoint[]; metric: MetricId; seconds: number }) {
  const config = metricConfig[metric]
  const [minimum, maximum] = config.domain
  let connected = false
  const path = points.map((point) => {
    if (point.value === null || !Number.isFinite(point.value)) { connected = false; return '' }
    const x = 45 + ((point.offsetSeconds + seconds) / seconds) * 600
    const y = 185 - ((point.value - minimum) / (maximum - minimum)) * 160
    const command = `${connected ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`
    connected = true
    return command
  }).join(' ')
  const available = points.filter((point) => point.value !== null && Number.isFinite(point.value))
  if (!available.length) return <div className="telemetry-chart-empty"><span className="eyebrow">No recorded values</span><h3>No {config.label.toLowerCase()} history for this article</h3><p>Missing measurements stay missing. Try a different metric or aircraft; no values are borrowed from another article.</p></div>
  return <svg className="telemetry-history-chart telemetry-history-chart-fallback" viewBox="0 0 670 220" role="img" aria-label={`${config.label} synthetic historical chart fallback, UTC fixture time. Missing values are gaps; a table follows.`}>
    {[0, .25, .5, .75, 1].map((fraction) => <g key={fraction}><line x1="45" x2="645" y1={185 - fraction * 160} y2={185 - fraction * 160} stroke="#ddd9d0" strokeDasharray="3 5" /><text x="35" y={189 - fraction * 160} textAnchor="end">{minimum + fraction * (maximum - minimum)}</text></g>)}
    <path d={path} fill="none" stroke="#d95d22" strokeWidth="2.5" strokeLinejoin="round" />
    {available.map((point) => <circle key={point.offsetSeconds} cx={45 + ((point.offsetSeconds + seconds) / seconds) * 600} cy={185 - ((point.value! - minimum) / (maximum - minimum)) * 160} r="2.6" fill="#d95d22" />)}
    <text x="45" y="210">−{seconds / 60} min</text><text x="345" y="210" textAnchor="middle">−{seconds / 120} min</text><text x="645" y="210" textAnchor="end">UTC fixture snapshot</text>
  </svg>
}

function HistoryChart({ points, metric, seconds, snapshotIso }: { points: TelemetryPoint[]; metric: MetricId; seconds: number; snapshotIso: string }) {
  const config = metricConfig[metric]
  return <>
    <TelemetryPlot points={points} metric={metric} seconds={seconds} snapshotIso={snapshotIso} fallback={<HistoryFallback points={points} metric={metric} seconds={seconds} />} />
    <details className="telemetry-chart-table"><summary>Show chart values ({points.length} samples)</summary><div className="telemetry-table-scroll"><table><caption>{config.label} · synthetic history · UTC · {config.unit}</caption><thead><tr><th scope="col">UTC fixture time</th><th scope="col">Relative to snapshot</th><th scope="col">Value ({config.unit})</th></tr></thead><tbody>{points.map((point) => <tr key={point.offsetSeconds}><td>{new Date(Date.parse(snapshotIso) + point.offsetSeconds * 1000).toISOString()}</td><td>{offsetLabel(point.offsetSeconds)}</td><td>{point.value === null || !Number.isFinite(point.value) ? 'Missing' : point.value.toFixed(1)}</td></tr>)}</tbody></table></div></details>
  </>
}
export function TelemetryInspector({ aircraft, items, setAircraft, goToFleet }: { aircraft: FleetAircraft; items: FleetAircraft[]; setAircraft: (item: FleetAircraft) => void; goToFleet: () => void }) {
  const [scenario, setScenario] = useState<DemoScenario>('recorded')
  const [metric, setMetric] = useState<MetricId>('battery')
  const [seconds, setSeconds] = useState(300)
  const [outcome, setOutcome] = useState<'all' | Outcome>('all')
  const [query, setQuery] = useState('')
  const [eventId, setEventId] = useState<string | null>(null)
  const snapshot = useMemo(() => buildTelemetrySnapshot(aircraft, scenario), [aircraft, scenario])
  const points = useMemo(() => historyWindow(snapshot.history[metric], seconds), [snapshot, metric, seconds])
  const events = useMemo(() => filterTelemetryEvents(snapshot.events, outcome, query), [snapshot, outcome, query])
  const event = events.find((item) => item.id === eventId) ?? events[0]
  const freshness = freshnessFor(snapshot.sampleAgeSeconds)
  const whatIfAllowed = aircraft.id === 'sim-ucas-001' || aircraft.id === 'sim-ucas-002'
  const measurement = (value: number | null, unit: string, decimals = 0) => {
    const shown = visibleMeasurement(value, snapshot.sampleAgeSeconds)
    return shown === null ? 'Unavailable' : `${shown.toFixed(decimals)}${unit}`
  }
  const reset = () => { setScenario('recorded'); setMetric('battery'); setSeconds(300); setOutcome('all'); setQuery(''); setEventId(null) }
  const counts = { accepted: snapshot.events.filter((item) => item.outcome === 'accepted').length, exceptions: snapshot.events.filter((item) => item.outcome !== 'accepted').length }
  return <div className="telemetry-inspector">
    <div className="sim-banner"><span className="sim-mark">S</span><div><strong>OFFLINE TELEMETRY DEMO</strong><span>Static synthetic fixtures only. No WebSocket, HTTP telemetry connection, aircraft, or command transport is active.</span></div><span className="banner-code">READ ONLY</span></div>
    <div className="section-heading"><div><span className="eyebrow">Operations / observation desk</span><h1>Telemetry inspector</h1><p>Understand the sample before you trust the number.</p></div><div className="heading-actions"><button className="button ghost" onClick={goToFleet}>← Fleet overview</button><button className="button ghost" onClick={reset}>Reset demo view</button></div></div>
    <section className="panel telemetry-context" aria-label="Telemetry context">
      <label><span>Watching aircraft</span><select value={aircraft.id} onChange={(change) => { const next = items.find((item) => item.id === change.target.value); if (next) setAircraft(next) }}>{items.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.environment}</option>)}</select></label>
      <label><span>Local demo scenario</span><select value={scenario} disabled={!whatIfAllowed} onChange={(change) => { setScenario(change.target.value as DemoScenario); setEventId(null) }}><option value="recorded">Recorded fixture</option><option value="link-loss">What-if: link loss</option><option value="recovery">What-if: recovery</option></select></label>
      <div className="telemetry-context-state"><Pill value={freshness} /><span>{ageLabel(snapshot.sampleAgeSeconds)} sample age · static</span></div>
      <div className="telemetry-offline"><span className="status-dot" />No live transport</div>
    </section>
    {scenario !== 'recorded' && <div className="telemetry-scenario-notice" role="status"><strong>{scenarioLabels[scenario]}</strong><span>This changes only a local synthetic view. No outage was detected and no real connection was recovered. Fleet records are unchanged.</span></div>}
    {freshness !== 'Fresh' && <div className={`telemetry-freshness-notice ${freshness === 'Delayed' ? 'delayed' : 'stale'}`} role="status"><strong>{freshness === 'Delayed' ? 'Delayed snapshot — last-known values' : 'No current measurements available'}</strong><span>{freshness === 'Delayed' ? 'Values below describe an older synthetic sample, not the current aircraft state.' : 'Measurements are suppressed when sample age exceeds 5 minutes or is unknown. Historical demo charts, when available, remain labeled as history.'}</span></div>}
    <div className="telemetry-summary-grid">
      <div><span>Sample sequence</span><strong>{snapshot.sequence === null ? 'Not recorded' : `#${snapshot.sequence}`}</strong><small>Per-aircraft synthetic fixture</small></div>
      <div><span>Sample quality</span><strong>{freshness}</strong><small>Fresh ≤ 30s · delayed ≤ 5m</small></div>
      <div><span>Accepted outcomes</span><strong>{counts.accepted}<small> / {snapshot.events.length}</small></strong><small>All fixture events, before filters</small></div>
      <div><span>Other outcomes</span><strong>{counts.exceptions}</strong><small>Late, duplicate or rejected</small></div>
    </div>
    <div className="telemetry-observation-grid">
      <section className="panel telemetry-history-panel" aria-label="Historical telemetry">
        <div className="panel-title"><div><span className="eyebrow">Historical / synthetic</span><h2>{metricConfig[metric].label} history</h2></div><span className="tag">{metricConfig[metric].unit}</span></div>
        <div className="telemetry-chart-controls"><label><span>Metric</span><select value={metric} onChange={(change) => setMetric(change.target.value as MetricId)}><option value="battery">Battery</option><option value="link">Link quality</option><option value="altitude">Altitude</option></select></label><fieldset><legend>History window</legend>{[60, 300, 900].map((value) => <button key={value} aria-pressed={seconds === value} onClick={() => setSeconds(value)}>{value / 60} min</button>)}</fieldset></div>
        <HistoryChart points={points} metric={metric} seconds={seconds} snapshotIso={snapshot.snapshotTimestamp} />
        <p className="telemetry-history-note">Fixed UTC axis · snapshot {snapshot.snapshotTimestamp} · gaps mean missing samples · window ends at the synthetic fixture snapshot, not now. Demo limits are not operational limits. Canvas chart powered by <a href="/offline-library-notices.txt">uPlot (offline library notices)</a>.</p>
      </section>
      <section className="panel telemetry-snapshot-panel" aria-label="Aircraft snapshot">
        <div className="panel-title"><div><span className="eyebrow">{freshness === 'Fresh' ? 'Fixture snapshot' : 'Last-known fixture / not current'}</span><h2>{aircraft.name}</h2></div><span className="tag">SYNTHETIC</span></div>
        <dl className="telemetry-measurements"><div><dt>Altitude · m AGL</dt><dd>{measurement(snapshot.altitude, ' m', 1)}</dd></div><div><dt>Ground speed</dt><dd>{measurement(snapshot.groundSpeed, ' m/s', 1)}</dd></div><div><dt>Heading</dt><dd>{measurement(snapshot.heading, '°')}</dd></div><div><dt>Battery</dt><dd>{measurement(snapshot.battery, '%')}</dd></div><div><dt>Link quality</dt><dd>{measurement(snapshot.link, '%')}</dd></div></dl>
        <div className="telemetry-provenance"><span className="eyebrow">Data provenance</span><code>{snapshot.aircraftId}</code><strong>{snapshot.source}</strong><p>{scenarioLabels[snapshot.scenario]} · fixture age {ageLabel(snapshot.sampleAgeSeconds)}. Unavailable means missing, invalid, or too old; it never means zero.</p></div>
      </section>
    </div>
    <section className="panel telemetry-event-panel" aria-label="Ingestion outcomes">
      <div className="panel-title"><div><span className="eyebrow">Ingestion / fixture evidence</span><h2>Inspect the outcomes</h2></div><span className="tag">{snapshot.events.length} FIXTURE EVENTS</span></div>
      <div className="telemetry-event-filters"><label><span>Search events</span><input type="search" placeholder="Sequence, source or reason…" value={query} onChange={(change) => { setQuery(change.target.value); setEventId(null) }} /></label><label><span>Outcome</span><select value={outcome} onChange={(change) => { setOutcome(change.target.value as 'all' | Outcome); setEventId(null) }}><option value="all">All outcomes</option>{(['accepted', 'late', 'duplicate', 'rejected'] as const).map((value) => <option key={value}>{value}</option>)}</select></label><span role="status" aria-live="polite">{events.length} of {snapshot.events.length} shown</span></div>
      <div className="telemetry-event-layout"><div className="telemetry-event-results">{events.map((item) => <button key={item.id} className={`telemetry-event-row ${item.id === event?.id ? 'selected' : ''}`} aria-pressed={item.id === event?.id} onClick={() => setEventId(item.id)}><span className="telemetry-event-row-top"><Pill value={item.outcome} /><strong>{item.sequence === null ? 'No sequence' : `Sequence ${item.sequence}`}</strong><span>{offsetLabel(item.offsetSeconds)}</span></span><span className="telemetry-event-reason">{item.detail}</span></button>)}{!events.length && <div className="telemetry-chart-empty"><h3>{snapshot.events.length ? 'No matching outcomes' : 'No events recorded'}</h3><p>{snapshot.events.length ? 'Try another outcome or a broader search.' : 'This article has no synthetic ingestion history. Nothing is inferred from another aircraft.'}</p>{snapshot.events.length > 0 && <button className="button ghost" onClick={() => { setOutcome('all'); setQuery('') }}>Clear event filters</button>}</div>}</div><aside className="telemetry-event-detail" aria-label="Selected event details"><span className="eyebrow">Selected outcome</span>{event ? <><Pill value={event.outcome} /><h3>{event.sequence === null ? 'No sequence recorded' : `Sequence ${event.sequence}`}</h3><p>{event.detail}</p><dl><div><dt>Event ID</dt><dd>{event.id}</dd></div><div><dt>Source</dt><dd>{event.source}</dd></div><div><dt>Relative time</dt><dd>{offsetLabel(event.offsetSeconds)}</dd></div><div><dt>Aircraft</dt><dd>{snapshot.aircraftId}</dd></div></dl></> : <p>Select an available event to inspect its provenance and disposition.</p>}</aside></div>
    </section>
    <div className="telemetry-boundary"><strong>Observation, not authorization.</strong><span>Every value, history and scenario is synthetic and local. No flight readiness, live connectivity, production access control or aircraft safety is established by this page.</span></div>
  </div>
}
