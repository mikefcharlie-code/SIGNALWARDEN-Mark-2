import { useMemo, useState } from 'react'
import { aircraftCsv, filterAircraft, fleetSummary, freshnessFor, needsAttention } from './fleet-utils'
import type { FleetAircraft, FleetFilters } from './fleet-utils'
import './fleet-explorer.css'

const defaults: FleetFilters = { query: '', status: 'all', environment: 'all', attentionOnly: false, sort: 'name' }
const toneFor = (state: string) => state === 'Fresh' || state === 'Available' ? 'green' : state === 'Delayed' || state === 'Maintenance' ? 'orange' : 'red'
function Badge({ state }: { state: string }) { return <span className={`status-pill ${toneFor(state)}`}><span className="status-dot" />{state}</span> }

export function FleetExplorer({ items, selectedAircraft, setSelectedAircraft, openMonitor, openCameras }: {
  items: FleetAircraft[]; selectedAircraft: FleetAircraft; setSelectedAircraft: (item: FleetAircraft) => void; openMonitor: () => void; openCameras: () => void
}) {
  const [filters, setFilters] = useState<FleetFilters>(defaults)
  const [exportMessage, setExportMessage] = useState('')
  const visible = useMemo(() => filterAircraft(items, filters), [items, filters])
  const summary = useMemo(() => fleetSummary(items), [items])
  const filtered = filters.query !== '' || filters.status !== 'all' || filters.environment !== 'all' || filters.attentionOnly
  const selectionVisible = visible.some((item) => item.id === selectedAircraft.id)
  const update = <K extends keyof FleetFilters,>(key: K, value: FleetFilters[K]) => { setFilters((current) => ({ ...current, [key]: value })); setExportMessage('') }
  const reset = () => { setFilters(defaults); setExportMessage('') }
  const download = () => {
    let url: string | undefined
    try {
      url = URL.createObjectURL(new Blob(['\uFEFF', aircraftCsv(visible)], { type: 'text/csv;charset=utf-8;' }))
      const anchor = document.createElement('a')
      anchor.href = url; anchor.download = 'ucas-synthetic-fleet.csv'
      document.body.appendChild(anchor); anchor.click(); anchor.remove()
      setExportMessage(`CSV prepared: ${visible.length} synthetic ${visible.length === 1 ? 'record' : 'records'}.`)
    } catch { setExportMessage('Export could not be prepared. Please try again.') }
    finally { if (url) window.setTimeout(() => URL.revokeObjectURL(url!), 1000) }
  }
  const freshness = freshnessFor(selectedAircraft.sampleAgeSeconds)
  return <>
    <div className="sim-banner"><span className="sim-mark">S</span><div><strong>SIMULATION ENVIRONMENT</strong><span>Every record is synthetic, including lab-labeled articles. No aircraft control path is connected.</span></div><span className="banner-code">ENV / SIM-01</span></div>
    <div className="section-heading"><div><span className="eyebrow">Operations / fleet intelligence</span><h1>Fleet overview</h1><p>Find an article. Spot the exceptions. Keep the context.</p></div><div className="heading-actions"><button className="button ghost" onClick={openCameras}>Camera wall</button><button className="button orange" onClick={download} disabled={!visible.length}>↓ Export filtered CSV</button></div></div>
    <div className="metric-grid">
      <div className="metric-card orange"><div className="metric-head">Aircraft in demo scope</div><strong>{String(summary.total).padStart(2, '0')}</strong><small>{summary.simulated} simulated · {summary.lab} lab-labeled</small></div>
      <div className="metric-card green"><div className="metric-head">Fresh telemetry</div><strong>{summary.fresh}<span className="fleet-metric-denominator"> / {summary.total}</span></strong><small>Sample age ≤ 30 seconds</small></div>
      <div className="metric-card blue"><div className="metric-head">Needs attention</div><strong>{String(summary.attention).padStart(2, '0')}</strong><small>Status, freshness, battery or link</small></div>
      <div className="metric-card"><div className="metric-head">Connection boundary</div><strong className="fleet-readonly">READ ONLY</strong><small>Static demo snapshot · no live transport</small></div>
    </div>
    <section className="panel fleet-explorer" aria-label="Fleet explorer">
      <div className="panel-title"><div><span className="eyebrow">Authorized inventory / synthetic</span><h2>Explore your fleet</h2></div><span className="tag">DEMO SNAPSHOT</span></div>
      <div className="fleet-filters">
        <label className="fleet-search"><span>Search aircraft</span><input type="search" value={filters.query} placeholder="Name, ID, type or location…" onChange={(event) => update('query', event.target.value)} /></label>
        <label><span>Status</span><select value={filters.status} onChange={(event) => update('status', event.target.value as FleetFilters['status'])}><option value="all">All statuses</option><option>Available</option><option>Maintenance</option><option>Suspended</option></select></label>
        <label><span>Environment label</span><select value={filters.environment} onChange={(event) => update('environment', event.target.value as FleetFilters['environment'])}><option value="all">All environments</option><option value="SIMULATED">Simulated</option><option value="LAB">Lab article</option></select></label>
        <label><span>Sort by</span><select value={filters.sort} onChange={(event) => update('sort', event.target.value as FleetFilters['sort'])}><option value="name">Aircraft name</option><option value="battery">Lowest battery first</option><option value="freshness">Oldest sample first</option></select></label>
      </div>
      <div className="fleet-results-bar"><label className="fleet-attention-toggle"><input type="checkbox" checked={filters.attentionOnly} onChange={(event) => update('attentionOnly', event.target.checked)} />Needs attention only</label><span role="status" aria-live="polite">{visible.length} of {items.length} aircraft shown</span><button className="text-button" onClick={reset} disabled={!filtered && filters.sort === 'name'}>Reset view</button></div>
      <div className="fleet-explorer-layout">
        <div className="fleet-results" aria-label="Matching aircraft">
          {visible.map((item) => <button key={item.id} className={`fleet-result ${selectedAircraft.id === item.id ? 'selected' : ''}`} aria-pressed={selectedAircraft.id === item.id} onClick={() => setSelectedAircraft(item)}>
            <span className="fleet-result-top"><span className={`aircraft-avatar ${item.environment.toLowerCase()}`}>{item.id.slice(-3)}</span><span className="aircraft-info"><strong>{item.name}</strong><small>{item.type}</small></span><Badge state={item.status} /></span>
            <span className="fleet-result-meta"><span>{item.environment} · {item.location}</span><span>{item.battery}% battery · {item.link}% link</span></span>
            <span className="fleet-result-bottom"><Badge state={freshnessFor(item.sampleAgeSeconds)} /><span>{item.freshness} · {needsAttention(item) ? 'Review suggested' : 'No demo exceptions'}</span></span>
          </button>)}
          {!visible.length && <div className="fleet-empty"><span className="eyebrow">No matches</span><h3>No aircraft fit this view</h3><p>Try a broader search or reset the filters. Your selected article stays available alongside this view.</p><button className="button ghost" onClick={reset}>Reset filters</button></div>}
        </div>
        <aside className="fleet-inspector" aria-label="Selected aircraft details">
          <div className="panel-title"><div><span className="eyebrow">Selected article</span><h2>{selectedAircraft.name}</h2></div><span className="tag">{selectedAircraft.environment}</span></div>
          {!selectionVisible && <p className="fleet-selection-notice">Selected article is outside the current filters. Choose a result to change the selection, or reset the view.</p>}
          <div className="selected-aircraft-hero"><div className="drone-glyph" aria-hidden="true"><span /><span /><span /><span /><b /></div><div><strong>{selectedAircraft.type}</strong><p>{selectedAircraft.location}</p></div></div>
          <div className="fleet-inspector-state"><Badge state={selectedAircraft.status} /><Badge state={freshness} /></div>
          <dl className="fleet-detail-grid"><div><dt>Battery</dt><dd>{selectedAircraft.battery}%</dd></div><div><dt>Link quality</dt><dd>{selectedAircraft.link}%</dd></div><div><dt>Demo health score</dt><dd>{selectedAircraft.health}%</dd></div><div><dt>Sample age</dt><dd>{selectedAircraft.freshness}</dd></div></dl>
          <div className="fleet-source"><span className="eyebrow">Data provenance</span><strong>{selectedAircraft.source}</strong><code>{selectedAircraft.id}</code><p>Fresh ≤ 30s · delayed ≤ 5m · stale &gt; 5m. Ages are fixture values, not a running clock or flight-readiness assessment.</p></div>
          <div className="panel-footer"><span>Synthetic observation only</span><button className="text-button" onClick={openMonitor}>View telemetry →</button></div>
        </aside>
      </div>
      <div className="fleet-export-note"><span>CSV includes only the current results, in the displayed order. Every row is labeled SYNTHETIC DEMO.</span><span role="status" aria-live="polite">{exportMessage}</span></div>
    </section>
  </>
}
