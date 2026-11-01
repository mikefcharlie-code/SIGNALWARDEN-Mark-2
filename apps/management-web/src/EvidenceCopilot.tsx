import { useEffect, useRef, useState } from 'react'
import type { Assessment, Assistance } from './observation-state'
import { effectiveEvidenceFreshness } from './observation-recovery'
import './evidence-copilot.css'

const displayValue = (value: unknown) => value === null ? 'not reported (explicit gap)' : typeof value === 'string' ? value : JSON.stringify(value, null, 2)
const priority: Record<string, number> = { conflict: 0, missing: 1, future: 2, stale: 3, untrusted: 4, limitation: 5 }
export function EvidenceCopilot({ overview, assistance, now = Date.now(), verified = false }: { overview?: Assessment; assistance?: Assistance; now?: number; verified?: boolean }) {
  const [selected, setSelected] = useState<string | null>(null)
  const detailRef = useRef<HTMLDivElement>(null)
  useEffect(() => { if (selected) { detailRef.current?.focus(); detailRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) } }, [selected])
  if (!overview) return <section className="panel evidence-copilot"><div className="panel-title"><h2>Evidence assessment unavailable</h2><span className="tag">NO ASSESSMENT</span></div><p>No authoritative overview assessment is available. No explanation was invented.</p></section>
  const evidence = new Map(overview.evidence.map((item) => [item.id, item]))
  const matching = assistance?.assessment?.snapshotId === overview.snapshotId ? assistance : undefined
  const modelRan = matching?.modelStatus === 'available' && ['local-model', 'external-model'].includes(matching.engine)
  const findings = [...overview.findings].sort((a, b) => (priority[a.kind] ?? 9) - (priority[b.kind] ?? 9) || a.id.localeCompare(b.id))
  const kinds = Array.from(new Set(findings.map((f) => f.kind))).map((kind) => [kind, findings.filter((f) => f.kind === kind).length] as const)
  const links = (ids: string[]) => ids.filter((id) => evidence.has(id)).map((id) => <button key={id} className="evidence-link" onClick={() => setSelected(id)} aria-label={`Open evidence ${id}`}>{id} · {evidence.get(id)!.field}</button>)
  const findingCard = (finding: Assessment['findings'][number]) => <article key={finding.id}><div><span className="copilot-kind">{finding.kind}</span><h3>{finding.title}</h3></div><p>{finding.detail}</p><div className="copilot-links">{links(finding.evidenceIds)}</div></article>
  const chosen = selected ? evidence.get(selected) : undefined
  return <section className="panel evidence-copilot" aria-labelledby="evidence-copilot-title">
    <div className="panel-title"><div><span className="eyebrow">Confidence-aware / source-grounded</span><h2 id="evidence-copilot-title">Evidence copilot</h2></div><span className="tag">READ ONLY</span></div>
    <p className="copilot-boundary">Reported evidence, not physical-world certainty. This advisory view cannot make operational decisions or route commands. Human interpretation is required.</p>
    {!verified && <p className="copilot-warning" role="status">RETAINED EVIDENCE · NOT CURRENTLY VERIFIED. Original timestamps are unchanged; current labels are withheld.</p>}
    <div className="copilot-meta"><span>Snapshot <code>{overview.snapshotId}</code></span><span>Assessed {overview.generatedAt}</span><span>{overview.evidence.length} evidence records</span></div>
    <div className="copilot-summary"><strong>{overview.summary}</strong><small>Assessment-time findings below remain historical; evidence details also show current age. Absence of evidence is not evidence of absence.</small></div>
    {matching && <div className="copilot-assist"><strong>{modelRan ? 'AI-assisted highlights · constrained to cited evidence' : 'Deterministic evidence summary · no model inference'}</strong><span>{matching.disclosure}</span></div>}
    {assistance?.assessment && !matching && <p className="copilot-warning" role="status">Assistance describes another snapshot and is withheld.</p>}
    {modelRan && <div className="copilot-findings">{matching!.insights.slice(0, 3).map((item) => <article key={item.id}><h3>{item.title}</h3><p>{item.detail}</p><div className="copilot-links">{links(item.evidence)}</div></article>)}</div>}
    <div className="copilot-kind-summary" aria-label="Finding summary">{kinds.map(([kind, count]) => <span key={kind}><b>{count}</b> {kind}</span>)}</div>
    <div className="copilot-findings">{findings.slice(0, 3).map(findingCard)}</div>
    {findings.length > 3 && <details className="copilot-findings"><summary>All {findings.length} deterministic findings and citations</summary>{findings.slice(3).map(findingCard)}</details>}
    {chosen && <div className="evidence-detail" id="evidence-detail" ref={detailRef} tabIndex={-1}><div className="panel-title"><h3>Evidence detail</h3><button className="text-button" onClick={() => setSelected(null)}>Close evidence</button></div><dl><div><dt>Citation / subject / entity</dt><dd>{chosen.id} · {chosen.subjectId} · {chosen.entityId}</dd></div><div><dt>Field / projected value</dt><dd><code>{chosen.field}</code><pre>{displayValue(chosen.value)}</pre></dd></div><div><dt>Source / original observation time</dt><dd>{chosen.sourceId} · {chosen.observedAt ?? 'timestamp unknown'}</dd></div><div><dt>Provenance trust</dt><dd>{chosen.trust} (declared provenance, not proof of truth)</dd></div><div><dt>Freshness now / at assessment</dt><dd>{effectiveEvidenceFreshness(chosen, now, verified)} / {chosen.freshness}{!verified ? ' · API unverified' : ''}</dd></div><div><dt>Record class</dt><dd>{chosen.synthetic ? 'SYNTHETIC · not physical-world evidence' : 'Not declared synthetic'}</dd></div></dl></div>}
    <details><summary>Browse all {overview.evidence.length} exact evidence records</summary><div className="copilot-links">{links(overview.evidence.map((row) => row.id))}</div></details>
    <ul className="copilot-limitations">{overview.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
    <div className="egress-disclosure"><strong>{assistance ? `${assistance.mode.toUpperCase()} ASSISTANCE · ${assistance.dataLeavesSystem ? 'DATA LEAVES SYSTEM' : 'NO EXTERNAL DATA EGRESS'}` : 'ASSISTANCE NOT VERIFIED'}</strong><span>{assistance?.disclosure ?? 'Review the provider/status disclosure below. No model result is applied to this view.'}</span></div>
  </section>
}
