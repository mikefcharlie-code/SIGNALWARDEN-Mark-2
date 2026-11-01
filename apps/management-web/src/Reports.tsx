import { useEffect, useRef, useState } from 'react'
import { evidenceAnchor, reportDownload, reportRequest, validateReport, validateReportOptions } from './report-utils'
import type { PlatformReport, ReportFilters, ReportOptions } from './report-utils'
import './reports.css'

const defaults: ReportFilters = { type: 'platform-status', start: '', end: '', platform: '', sensor: '', engine: 'template' }
export function Reports() {
  const [options, setOptions] = useState<ReportOptions | null>(null)
  const [filters, setFilters] = useState(defaults)
  const [report, setReport] = useState<PlatformReport | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [optionsError, setOptionsError] = useState('')
  const [read, setRead] = useState(0)
  const request = useRef<AbortController | null>(null)
  const version = useRef(0)
  useEffect(() => {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 15000)
    setOptionsError('')
    fetch('/api/v1/reports/options', { signal: controller.signal, cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error(`Report options unavailable (HTTP ${response.status}).`)
      return validateReportOptions(await response.json())
    }).then((value) => { if (!controller.signal.aborted) setOptions(value) }).catch((reason) => { setOptionsError(reason instanceof Error ? reason.message : 'Report options unavailable.') }).finally(() => window.clearTimeout(timeout))
    return () => { window.clearTimeout(timeout); controller.abort() }
  }, [read])
  useEffect(() => () => request.current?.abort(), [])
  const change = (key: keyof ReportFilters, value: string) => {
    version.current += 1
    request.current?.abort()
    setLoading(false)
    setFilters((previous) => ({ ...previous, [key]: value }))
    setReport(null)
    setError('')
  }
  const generate = async (event: React.FormEvent) => {
    event.preventDefault()
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    const currentVersion = ++version.current
    const timeout = window.setTimeout(() => controller.abort(), 65000)
    setLoading(true); setError(''); setReport(null)
    try {
      const body = reportRequest(filters)
      const response = await fetch('/api/v1/reports/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal, cache: 'no-store' })
      if (!response.ok) throw new Error(`Document generation unavailable (HTTP ${response.status}). No replacement data was inserted.`)
      const result = validateReport(await response.json())
      if (version.current === currentVersion) setReport(result)
    } catch (reason) {
      if (version.current === currentVersion) setError(controller.signal.aborted ? 'Generation timed out or was cancelled. No document accepted; try deterministic templates.' : reason instanceof Error ? reason.message : 'Report generation failed.')
    } finally {
      window.clearTimeout(timeout)
      if (version.current === currentVersion) setLoading(false)
    }
  }
  const download = (format: 'markdown' | 'json') => {
    if (!report) return
    const file = reportDownload(report, format)
    const url = URL.createObjectURL(new Blob([file.content], { type: file.mime }))
    const link = document.createElement('a')
    link.href = url; link.download = file.filename; document.body.appendChild(link); link.click(); link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <div className="reports-workspace">
    <div className="section-heading"><div><span className="eyebrow">Evidence / document workspace</span><h1>Reports & documents</h1><p>Turn the available platform dataset into reviewable, source-linked documents.</p></div><span className="tag">ADVISORY · HUMAN REVIEW</span></div>
    <div className="report-boundary"><strong>Evidence first. No invented observations.</strong><p>Reports describe stored sensor metadata, platform records and their limits—not targets or operational decisions. No commands, tasking or engagement functions. Documents are derived artifacts and are never inserted as verified source evidence.</p></div>
    <section className="panel report-config" aria-labelledby="report-config-title"><h2 id="report-config-title">Create a document</h2>
      <p>Default: all available platforms and source times. Decorative UI demo cards, synthetic camera artwork and training controls are not source data. Empty or filtered-out data remains an explicit gap.</p>
      {optionsError && <div role="alert" className="report-error">{optionsError} <button className="text-button" onClick={() => setRead((value) => value + 1)}>Retry options</button></div>}
      <form onSubmit={(event) => void generate(event)}><div className="report-form-grid">
        <label>Report type<select value={filters.type} onChange={(event) => change('type', event.target.value)} disabled={!options}>{(options?.types ?? [{ id: 'platform-status', label: 'Platform / fleet status' }]).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label>Platform<select value={filters.platform} onChange={(event) => change('platform', event.target.value)} disabled={!options}><option value="">All platforms · platform-wide</option>{options?.platforms.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.id}</option>)}</select></label>
        <label>Sensor / evidence subject<select value={filters.sensor} onChange={(event) => change('sensor', event.target.value)} disabled={!options}><option value="">All reported sensors</option>{options?.sensors.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.id}</option>)}</select></label>
        <label>Generation engine<select value={filters.engine} onChange={(event) => change('engine', event.target.value)}><option value="template">Deterministic templates · no model</option><option value="local">Local assistance · template fallback if unavailable</option></select></label>
        <label>Start time (your browser time zone)<input type="datetime-local" value={filters.start} onChange={(event) => change('start', event.target.value)} /></label>
        <label>End time (your browser time zone)<input type="datetime-local" value={filters.end} onChange={(event) => change('end', event.target.value)} /></label>
      </div><p className="report-help">Time boundaries are inclusive and exported in UTC. Unknown timestamps cannot establish time-range membership; exclusions are disclosed. Sensor filters match only sensor/subject IDs actually reported; missing sensor content is not reconstructed.</p><p className="report-help">No external AI is used, including as a fallback. Local assistance may only select fixed, evidence-linked highlights; it cannot supply facts or remove deterministic findings.</p>
      <button type="submit" className="button orange" disabled={loading || !options || !!optionsError}>{loading ? 'Generating grounded document…' : 'Generate preview'}</button>{loading && <button type="button" className="button ghost" onClick={() => { version.current += 1; request.current?.abort(); setLoading(false); setError('Generation cancelled. No document accepted.') }}>Cancel</button>}</form>
    </section>
    {error && <p role="alert" className="report-error">{error}</p>}
    {!report && !loading && <section className="panel report-empty"><h2>No document generated</h2><p>Select a report type and generate a preview. Nothing is saved to the source dataset.</p></section>}
    {report && <>
      <section className="panel report-preview" aria-labelledby="report-preview-title"><div className="panel-title"><div><span className="eyebrow">Derived document / not verified evidence</span><h2 id="report-preview-title">{report.title}</h2></div><div className="report-downloads"><button className="button ghost" onClick={() => download('markdown')}>Download Markdown</button><button className="button ghost" onClick={() => download('json')}>Download JSON</button></div></div>
        {report.synthetic && <p className="report-synthetic" role="status">SYNTHETIC DEMO DATASET · not real-world intelligence; missing observations are not reconstructed</p>}
        <dl className="report-metadata"><div><dt>Document</dt><dd>{report.id}</dd></div><div><dt>Generated</dt><dd>{report.generatedAt}</dd></div><div><dt>Engine / local model status</dt><dd>{report.engine} / {report.modelStatus}</dd></div><div><dt>Review</dt><dd>Human review required · physical-world confidence unknown</dd></div></dl>
        <p>Frozen snapshot: freshness and trust are recorded at generation time, not continuously verified. A successful API receipt does not establish source validity.</p>
        {report.sections.map((section, index) => <section key={`${section.title}-${index}`} className="report-section"><h3>{section.title}</h3>{section.claims.map((claim, claimIndex) => <article key={claimIndex}><p>{claim.text}</p><div className="report-citations">{claim.evidenceIds.map((id) => <a key={id} href={`#${evidenceAnchor(id)}`}>{id}</a>)}</div></article>)}</section>)}
        <h3>Coverage gaps & unknowns</h3><ul>{report.coverageGaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul>
        <h3>Limits & human review</h3><ul>{report.limitations.map((limit, index) => <li key={index}>{limit}</li>)}</ul>
        <details><summary>Exact Markdown export preview</summary><pre className="report-markdown">{report.markdown}</pre></details>
      </section>
      <section className="panel report-sources" aria-labelledby="report-sources-title"><h2 id="report-sources-title">Sources & observation records</h2><p>Each claim links to its exact report evidence record below. Source IDs and original timestamps are retained; unknown is not trusted. These records are copied into the export for provenance, not written back to the platform.</p>
        {report.evidence.map((row) => <article key={row.id} id={evidenceAnchor(row.id)} tabIndex={-1}><h3><code>{row.id}</code></h3><dl><div><dt>Platform / subject</dt><dd>{row.entityId} / {row.subjectId}</dd></div><div><dt>Source ID / original observation time</dt><dd>{row.sourceId} / {row.observedAt ?? 'timestamp unknown'}</dd></div><div><dt>Freshness / provenance trust / confidence</dt><dd>{row.freshness} / {row.trust} / {row.confidence ?? 'unknown (not physical-world confidence)'}</dd></div><div><dt>Field / record class</dt><dd>{row.field} / {row.synthetic ? 'SYNTHETIC DEMO' : 'not declared synthetic'}</dd></div></dl><pre>{row.value === null ? 'not reported · explicit coverage gap' : JSON.stringify(row.value, null, 2)}</pre></article>)}
      </section>
    </>}
  </div>
}
