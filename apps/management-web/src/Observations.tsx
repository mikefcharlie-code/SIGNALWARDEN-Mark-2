import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { capabilityTone, effectiveFreshness, filterPlatforms, formatAltitude, formatSourceTime, normalizePlatform } from './lattice-utils'
import type { ApiState, Capability, CatalogItem, Overview } from './lattice-utils'
import { getObservationJson } from './observation-network'
import { beginRead, finishRead, validateAssistance, validateCapabilities, validateCatalog, validateOverview } from './observation-state'
import type { Assistance } from './observation-state'
import { ObservationAssistance } from './ObservationAssistance'
import { EvidenceCopilot } from './EvidenceCopilot'
import { assertEvidenceReceipt, emptyRecoveryState, reconcileEvidence, type RecoveryDigest, type RecoveryState } from './observation-recovery'
import './observations.css'
import './workspace-welcome.css'
import { elapsedLabel, receiptVerification } from './observation-presentation'

const initial = <T,>(): ApiState<T> => ({ status: 'loading', data: null, error: null })
function Status({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: string }) { return <span className={`ob-status ${tone}`}><i />{children}</span> }
function EmptyState({ title, detail }: { title: string; detail: string }) { return <div className="ob-empty"><span className="ob-empty-mark">—</span><strong>{title}</strong><p>{detail}</p></div> }

export function Observations() {
  const [overview, setOverview] = useState<ApiState<Overview>>(initial)
  const [capabilities, setCapabilities] = useState<ApiState<Capability[]>>(initial)
  const [catalog, setCatalog] = useState<ApiState<CatalogItem[]>>(initial)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [freshness, setFreshness] = useState('all')
  const [assistance, setAssistance] = useState<ApiState<Assistance>>(initial)
  const [browserOnline, setBrowserOnline] = useState(navigator.onLine)
  const [clock, setClock] = useState(() => Date.now())
  const outageBaseline = useRef<RecoveryState | null>(null)
  const hadSuccessfulOverview = useRef(false)
  const lastOverview = useRef<Overview | null>(null)
  const activeRead = useRef<AbortController | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const recovery = useRef<RecoveryState>(emptyRecoveryState())
  const [recoveryDigest, setRecoveryDigest] = useState<RecoveryDigest | null>(null)
  const load = useCallback(async () => {
    activeRead.current?.abort()
    const controller = new AbortController()
    activeRead.current = controller
    setRefreshing(true)
    setOverview(beginRead)
    setCapabilities(beginRead)
    setCatalog(beginRead)
    setAssistance(beginRead)
    const read = (url: string) => getObservationJson<unknown>(url, { signal: controller.signal })
    const settle = async <T,>(request: Promise<T>, publish: React.Dispatch<React.SetStateAction<ApiState<T>>>, after?: (value: T) => void, isOverview = false) => {
      const result = await request.then(
        (value): PromiseSettledResult<T> => ({ status: 'fulfilled', value }),
        (reason): PromiseSettledResult<T> => ({ status: 'rejected', reason }),
      )
      if (controller.signal.aborted || activeRead.current !== controller) return
      if (result.status === 'fulfilled') after?.(result.value)
      const receiptTime = Date.now()
      setClock((previous) => Math.max(previous, receiptTime))
      publish((state) => finishRead(state, result, new Date(receiptTime).toISOString()))
      if (result.status === 'rejected' && isOverview && !outageBaseline.current) outageBaseline.current = recovery.current
    }
    await Promise.all([
      settle(read('/api/v1/lattice/overview').then(validateOverview).then((value) => {
        if (controller.signal.aborted || activeRead.current !== controller) throw new Error('Superseded overview read.')
        if (value.assessment) assertEvidenceReceipt(recovery.current, value.assessment.evidence, value.generatedAt, lastOverview.current?.generatedAt, value.assessment.snapshotId === lastOverview.current?.assessment?.snapshotId)
        return value
      }), setOverview, (value) => {
        const assessment = value.assessment
        if (!assessment) return
        const prior = outageBaseline.current ?? recovery.current
        const merged = reconcileEvidence(prior, assessment.evidence, Date.now())
        recovery.current = merged.state
        lastOverview.current = value
        if (outageBaseline.current && hadSuccessfulOverview.current) setRecoveryDigest(merged.digest)
        outageBaseline.current = null
        hadSuccessfulOverview.current = true
        // Keep the complete accepted assessment intact: its findings and exact citations are one unit.
      }, true),
      settle(read('/api/v1/lattice/capabilities?limit=100').then(validateCapabilities), setCapabilities),
      settle(read('/api/v1/lattice/catalog?limit=100').then(validateCatalog), setCatalog),
      settle(getObservationJson<unknown>('/api/v1/lattice/assistance', {
        signal: controller.signal, timeoutMs: 60_000, maxAttempts: 1,
      }).then(validateAssistance), setAssistance),
    ])
    if (controller.signal.aborted || activeRead.current !== controller) return
    setRefreshing(false)
  }, [])
  useEffect(() => {
    void load()
    const online = () => { setBrowserOnline(true); if (!outageBaseline.current) outageBaseline.current = recovery.current; void load() }
    const offline = () => { setBrowserOnline(false); if (!outageBaseline.current) outageBaseline.current = recovery.current }
    window.addEventListener('online', online)
    window.addEventListener('offline', offline)
    return () => { activeRead.current?.abort(); window.removeEventListener('online', online); window.removeEventListener('offline', offline) }
  }, [load])
  const verified = browserOnline && overview.status === 'ready'
  const effectiveClock = Math.max(clock, Date.parse(overview.data?.generatedAt ?? '') + Math.max(0, clock - Date.parse(overview.receivedAt ?? ''))) || clock
  const platforms = useMemo(() => (overview.data?.platforms ?? []).map(normalizePlatform).map((item) => ({ ...item, freshness: effectiveFreshness(item.sourceUpdateTime, effectiveClock, verified) })), [overview.data, effectiveClock, verified])
  const visible = useMemo(() => filterPlatforms(platforms, query, category, freshness), [platforms, query, category, freshness])
  const selected = platforms.find((item) => item.entityId === selectedId) ?? visible[0] ?? platforms[0]
  const categories = Array.from(new Set(platforms.map((item) => item.category))).sort()
  const categoryLabel = (value: string) => catalog.data?.find((item) => item.catalogId === value || item.category === value)?.label ?? value.replaceAll('-', ' ')
  const summary = overview.data?.summary
  const freshnessCounts = platforms.reduce((counts, item) => ({ ...counts, [item.freshness]: counts[item.freshness] + 1 }), { current: 0, stale: 0, future: 0, unknown: 0 })
  const failed = overview.status === 'error'
  useEffect(() => { const id = window.setInterval(() => setClock((previous) => Math.max(previous, Date.now())), 1000); return () => window.clearInterval(id) }, [])
  return <div className="ob-workspace">
    <div className="ob-offline-banner"><span className="ob-banner-mark">O</span><div><strong>OBSERVATION WORKSPACE · OFFLINE / SYNTHETIC</strong><span>Read-only context from static fixtures. No live transport, device access, mesh, commands, tasking, targeting, or engagement path is present.</span></div><Status tone="orange">SOURCE DISCONNECTED</Status></div>
    <div className="section-heading ob-heading"><div><span className="eyebrow">Operations / cross-domain context</span><h1>Observation workspace</h1><p>One calm surface for synthetic entities, source health, and provenance — without implying a live operational picture.</p></div><button className="button ghost" onClick={() => void load()} disabled={refreshing}>{refreshing ? 'Refreshing snapshot…' : 'Refresh snapshot'}</button></div>
    <nav className="workspace-jumps" aria-label="Observation sections"><a href="#ob-inventory">Inventory</a><a href="#ob-sources">Source diagnostics</a><a href="#ob-evidence">Evidence & citations</a><a href="#ob-advisory">Advisory status</a><a href="/reports">Reports & documents ↗</a><a href="/ai">Local AI & media setup ↗</a><a href="#ob-boundaries">Capability boundaries</a></nav>
    <div className="ob-connectivity-cards" aria-label="Connectivity and snapshot status">
      <div className={!verified ? 'is-warning' : ''}><span>Snapshot verification</span><strong>{receiptVerification(browserOnline, overview.status, !!overview.data)}</strong><small>Successful HTTP receipt is not source validation.</small></div>
      <div><span>Retained API receipt age</span><strong>{elapsedLabel(overview.receivedAt, clock)}</strong><small>Receipt {formatSourceTime(overview.receivedAt ?? null)} · memory only; reload clears it.</small></div>
      <div className="is-warning"><span>Original source age</span><strong>{elapsedLabel(overview.data?.diagnostics.lastSourceUpdateTime, clock)}</strong><small>No live source connected. Refresh never renews source timestamps.</small></div>
      <div><span>Evidence conflicts / recovery</span><strong>{overview.data ? `${overview.data.assessment?.findings.filter((f) => f.kind === 'conflict').length ?? 0} conflicts · ${recoveryDigest ? 'return compared' : 'no return comparison'}` : 'Not assessed'}</strong><small>Unresolved conflicts remain evidence, not consensus. No redundant transport or mesh.</small></div>
    </div>
    <div className="ob-transport-strip" role="status"><strong>Workspace API · {refreshing ? 'reading / bounded retries' : failed ? 'unavailable' : overview.status === 'ready' ? 'last read succeeded' : 'not verified'}</strong><span>Browser: {browserOnline ? 'reports online (not proof of API reachability)' : 'reports offline'}</span><span>Last successful receipt: {formatSourceTime(overview.receivedAt ?? null)}</span><small>Local API reads only · no mesh, redundant links, or platform failover · memory-only retention</small></div>
    {recoveryDigest && <details className="ob-recovery-digest" open><summary><strong>Browser outage digest · baseline compared on return</strong> <span>{recoveryDigest.added.length} added · {recoveryDigest.changed.length} changed · {recoveryDigest.missing.length} missing · {recoveryDigest.recovered.length} recovered</span></summary><span>{recoveryDigest.stillStale.length} not fresh (stale, undated, future, or synthetic) · {recoveryDigest.stillUntrusted.length} still untrusted · {recoveryDigest.conflicts.length} equal-time conflicts held</span>{(['added','changed','missing','recovered'] as const).map((kind) => <div key={kind}><strong>{kind}</strong>{recoveryDigest[kind].map((r) => <code key={r.id}>{r.id} · {r.field} · {r.observedAt ?? 'timestamp unknown'}</code>)}</div>)}<small>Memory-only comparison; this does not declare a source connected. Retained aged evidence is never shown as current.</small></details>}
    {failed && <div className="ob-error" role="alert"><strong>{overview.data ? 'Retained snapshot · NOT CURRENTLY VERIFIED' : 'Snapshot unavailable'}</strong><span>{overview.error} {overview.data ? 'The last successful snapshot remains visible for reference only. Source timestamps are unchanged.' : 'No replacement fixture data was inserted.'}</span><button className="text-button" disabled={refreshing} onClick={() => void load()}>Try again</button></div>}
    {refreshing && overview.status === 'loading' && overview.data && <p className="ob-retained-note" role="status">Showing the previous snapshot while a new read is in progress; it is not verified by this refresh yet.</p>}
    {overview.status === 'loading' && !overview.data && <div className="ob-loading"><span className="spinner" /><strong>Loading observation snapshot</strong><p>Requesting read-only overview and diagnostics.</p></div>}
    {overview.data && <>
      <div className="ob-summary-grid"><div className="ob-stat orange"><span>Observation entities</span><strong>{summary?.platformCount ?? platforms.length}</strong><small>Across the static overview</small></div><div className="ob-stat blue"><span>Sensor channels</span><strong>{summary?.sensorCount ?? platforms.reduce((n, p) => n + p.sensors.length, 0)}</strong><small>Inventory metadata only</small></div><div className="ob-stat green"><span>Located records</span><strong>{summary?.locatedCount ?? platforms.filter((p) => p.latitude !== undefined).length}</strong><small>Coordinate list, not a live map</small></div><div className="ob-stat"><span>Source mode</span><strong className="ob-mono">{overview.data.mode.toUpperCase()}</strong><small>Generated {formatSourceTime(overview.data.generatedAt)}</small></div></div>
      <div className="ob-freshness-strip"><span className="eyebrow">Freshness distribution</span>{(['current', 'stale', 'future', 'unknown'] as const).map((key) => <span key={key}><i className={`ob-fresh-dot ${key}`} />{key} <b>{freshnessCounts[key]}</b></span>)}<span className="ob-strip-note">Ages advance with the browser clock; offline records are unverified immediately.</span></div>
      <div className="ob-main-grid"><section id="ob-inventory" className="panel ob-inventory ob-section-anchor"><div className="panel-title"><div><span className="eyebrow">Entity inventory / synthetic</span><h2>Cross-domain observations</h2></div><span className="tag">GET ONLY</span></div><div className="ob-filters"><label className="ob-search"><span>Search inventory</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, ID, sensor, domain…" /></label><label><span>Domain / type</span><select value={category} onChange={(event) => setCategory(event.target.value)}><option value="all">All categories</option>{categories.map((item) => <option value={item} key={item}>{categoryLabel(item)}</option>)}</select></label><label><span>Freshness</span><select value={freshness} onChange={(event) => setFreshness(event.target.value)}><option value="all">All states</option><option value="current">Current</option><option value="stale">Stale</option><option value="future">Future</option><option value="unknown">Unknown</option></select></label></div><div className="ob-results-meta"><span>{visible.length} of {platforms.length} records shown</span><span>Selected: {selected?.entityId ?? 'none'}</span></div><div className="ob-entity-list">{visible.map((item) => <button key={item.entityId} className={`ob-entity ${selected?.entityId === item.entityId ? 'selected' : ''}`} onClick={() => setSelectedId(item.entityId)}><span className="ob-entity-symbol">{item.name.slice(0, 1).toUpperCase()}</span><span className="ob-entity-copy"><strong>{item.name}</strong><small>{item.entityId} · {categoryLabel(item.category)}</small><small>{item.sensors.length} sensor{item.sensors.length === 1 ? '' : 's'} · reported {item.connection} · reported {item.health}</small></span><Status tone={item.freshness === 'current' ? 'green' : item.freshness === 'stale' ? 'orange' : item.freshness === 'unknown' ? 'neutral' : 'blue'}>{item.freshness}</Status></button>)}{visible.length === 0 && <EmptyState title={platforms.length === 0 ? 'No observations configured' : 'No matching observations'} detail={platforms.length === 0 ? 'Offline mode has no source observations. The category and capability catalogs remain informational.' : 'Broaden the search or clear the filters. An empty result is kept explicit.'} />}</div></section><aside className="panel ob-detail"><div className="panel-title"><div><span className="eyebrow">Selected observation</span><h2>{selected?.name ?? 'No selection'}</h2></div>{selected && <Status tone={selected.freshness === 'current' ? 'green' : 'orange'}>{selected.freshness}</Status>}</div>{selected ? <><div className="ob-detail-identity"><strong>{categoryLabel(selected.category)}</strong><code>{selected.entityId}</code><span>{selected.synthetic ? 'Synthetic fixture' : 'Classification not reported'}</span></div><dl className="ob-detail-grid"><div><dt>Reported connection</dt><dd>{selected.connection}</dd></div><div><dt>Reported health</dt><dd>{selected.health}</dd></div><div><dt>Latitude</dt><dd>{selected.latitude === undefined ? 'Not reported' : `${selected.latitude}°`}</dd></div><div><dt>Longitude</dt><dd>{selected.longitude === undefined ? 'Not reported' : `${selected.longitude}°`}</dd></div><div className="wide"><dt>Altitude reference</dt><dd>{formatAltitude(selected)}</dd></div></dl><div className="ob-source-block"><span className="eyebrow">Provenance</span><strong>{formatSourceTime(selected.sourceUpdateTime)}</strong><p>Reported health and connection are historical source labels, not a heartbeat, readiness signal, or recommendation. Static source metadata; manual refresh does not change this source timestamp.</p></div><div className="ob-sensors"><span className="eyebrow">Sensor inventory</span>{selected.sensors.length ? selected.sensors.map((sensor) => <div key={sensor.sensorId}><span>{sensor.sensorType}</span><strong>{sensor.sensorId}</strong><small>{sensor.operationalState}</small></div>) : <p>No sensor channels reported.</p>}</div></> : <EmptyState title="Select an entity" detail="Choose a record from the inventory to inspect source and location context." />}</aside></div>
      <div className="ob-lower-grid"><section className="panel ob-attention"><div className="panel-title"><div><span className="eyebrow">Operator insights / informational</span><h2>Attention</h2></div><span className="tag">NO RECOMMENDATIONS</span></div>{overview.data.attention.length ? overview.data.attention.map((item) => <button className={`ob-attention-row ${item.severity}`} key={item.id} onClick={() => setSelectedId(item.entityId)}><span className="ob-attention-icon">{item.severity === 'warning' ? '!' : 'i'}</span><span><strong>{item.title}</strong><small>{item.detail}</small><code>{item.code} · {item.entityId}</code></span><span>→</span></button>) : <EmptyState title="No attention items" detail="The snapshot contains no informational attention records." />}</section><section id="ob-sources" className="panel ob-diagnostics ob-section-anchor"><div className="panel-title"><div><span className="eyebrow">Source diagnostics</span><h2>Connection boundary</h2></div><Status tone="red">No live source</Status></div><div className="ob-diagnostic-list"><div><span>Transport</span><strong>{overview.data.diagnostics.transport}</strong></div><div><span>Network access</span><strong>{overview.data.diagnostics.networkAccess ? 'Available' : 'Disabled'}</strong></div><div><span>Device access</span><strong>{overview.data.diagnostics.deviceAccess ? 'Available' : 'Disabled'}</strong></div><div><span>Resilient mesh</span><strong>{overview.data.diagnostics.meshAvailable ? 'Available' : 'Not implemented'}</strong></div><div><span>Source</span><strong>{overview.data.diagnostics.source}</strong></div><div><span>Last source update</span><strong>{formatSourceTime(overview.data.diagnostics.lastSourceUpdateTime)}</strong></div></div><ul>{overview.data.diagnostics.notes.map((note) => <li key={note}>{note}</li>)}</ul></section></div>
      </>}
    <div id="ob-evidence" className="ob-section-anchor"><EvidenceCopilot overview={overview.data?.assessment} assistance={assistance.status === 'ready' && verified ? assistance.data ?? undefined : undefined} now={effectiveClock} verified={verified} /></div>
    <div id="ob-advisory" className="ob-section-anchor"><ObservationAssistance state={assistance} snapshotId={overview.data?.assessment?.snapshotId} verified={verified} /></div>
    <section id="ob-boundaries" className="ob-capabilities ob-section-anchor"><div className="section-heading"><div><span className="eyebrow">Capability boundary / reference</span><h2>What this workspace does — and does not — represent</h2></div></div>{capabilities.status === 'error' ? <div className="ob-inline-error">Capability catalog unavailable: {capabilities.error}</div> : <div className="ob-capability-grid">{(capabilities.data ?? []).map((item) => <article className="ob-capability" key={item.id}><div><span className={`ob-capability-mark ${capabilityTone(item.implementation)}`} /> <span className="ob-capability-theme">{item.theme}</span><Status tone={capabilityTone(item.implementation)}>{item.implementation}</Status></div><h3>{item.title}</h3><p>{item.description}</p><small><b>Boundary:</b> {item.boundary}</small></article>)}</div>}</section>
    {catalog.status === 'ready' && <div className="ob-catalog-note"><span className="eyebrow">Catalog metadata loaded</span><strong>{catalog.data?.length ?? 0} category entries</strong><span>Weapon and effector categories remain informational inventory metadata only.</span></div>}
  </div>
}
