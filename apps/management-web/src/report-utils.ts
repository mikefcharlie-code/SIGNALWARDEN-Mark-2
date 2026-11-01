export type ReportOptions = {
  types: { id: string; label: string }[]
  platforms: { id: string; label: string }[]
  sensors: { id: string; label: string }[]
}
export type ReportEvidence = {
  id: string; entityId: string; subjectId: string; sourceId: string; observedAt: string | null
  field: string; value: unknown; trust: string; freshness: string; confidence?: string; synthetic: boolean
}
export type PlatformReport = {
  id: string; title: string; type: string; generatedAt: string; synthetic: boolean
  engine: string; modelStatus: string; markdown: string; evidence: ReportEvidence[]
  coverageGaps: string[]; limitations: string[]
  sections: { title: string; claims: { text: string; evidenceIds: string[] }[] }[]
}
export type ReportFilters = { type: string; start: string; end: string; platform: string; sensor: string; engine: string }
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')
export function validateReportOptions(value: unknown): ReportOptions {
  if (!isObject(value)) throw new Error('Invalid report options response.')
  for (const key of ['types', 'platforms', 'sensors']) {
    if (!Array.isArray(value[key]) || !(value[key] as unknown[]).every((row) => isObject(row) && typeof row.id === 'string' && typeof row.label === 'string')) throw new Error('Invalid report filter options.')
  }
  return value as ReportOptions
}
export function validateReport(value: unknown): PlatformReport {
  if (!isObject(value) || !['id', 'title', 'type', 'generatedAt', 'engine', 'modelStatus', 'markdown'].every((key) => typeof value[key] === 'string') || typeof value.synthetic !== 'boolean' || !strings(value.coverageGaps) || !strings(value.limitations) || !Array.isArray(value.evidence) || !Array.isArray(value.sections)) throw new Error('Invalid report response; no document accepted.')
  const ids = new Set<string>()
  for (const row of value.evidence) {
    if (!isObject(row) || !['id', 'entityId', 'subjectId', 'sourceId', 'field', 'trust', 'freshness'].every((key) => typeof row[key] === 'string') || !(row.observedAt === null || typeof row.observedAt === 'string') || typeof row.synthetic !== 'boolean' || ids.has(row.id as string)) throw new Error('Invalid or duplicate report evidence.')
    if (!['trusted', 'untrusted', 'unknown'].includes(row.trust as string) || !['current', 'stale', 'future', 'unknown'].includes(row.freshness as string)) throw new Error('Invalid report provenance labels.')
    if (row.observedAt !== null && (!/^\d{4}-\d{2}-\d{2}T/.test(row.observedAt as string) || !Number.isFinite(Date.parse(row.observedAt as string)))) throw new Error('Invalid report observation timestamp.')
    if (row.synthetic && (row.trust === 'trusted' || row.freshness === 'current')) throw new Error('Synthetic evidence cannot be current or trusted.')
    ids.add(row.id as string)
  }
  if (!['template', 'local-model', 'local-fallback'].includes(value.engine as string)) throw new Error('Unsupported report engine; external results are not accepted.')
  for (const section of value.sections) {
    if (!isObject(section) || typeof section.title !== 'string' || !Array.isArray(section.claims)) throw new Error('Invalid report section.')
    for (const claim of section.claims) {
      if (!isObject(claim) || typeof claim.text !== 'string' || !strings(claim.evidenceIds) || claim.evidenceIds.length === 0 || claim.evidenceIds.some((id) => !ids.has(id))) throw new Error('Report claim has missing or unresolved citations.')
    }
  }
  return value as PlatformReport
}
export function reportRequest(filters: ReportFilters) {
  const stamp = (text: string) => {
    if (!text) return undefined
    const parsed = new Date(text)
    if (!Number.isFinite(parsed.getTime())) throw new Error('Choose a valid time range.')
    return parsed.toISOString()
  }
  const start = stamp(filters.start), end = stamp(filters.end)
  if (start && end && Date.parse(start) > Date.parse(end)) throw new Error('Start time must not be after end time.')
  if (!['template', 'local'].includes(filters.engine)) throw new Error('Only deterministic templates or explicitly selected local assistance are supported.')
  return { type: filters.type, ...(start ? { start } : {}), ...(end ? { end } : {}), platformIds: filters.platform ? [filters.platform] : [], sensorIds: filters.sensor ? [filters.sensor] : [], engine: filters.engine }
}
export function reportDownload(report: PlatformReport, format: 'markdown' | 'json') {
  return { content: format === 'markdown' ? report.markdown : JSON.stringify(report, null, 2) + '\n', mime: format === 'markdown' ? 'text/markdown;charset=utf-8' : 'application/json;charset=utf-8', filename: `signalwarden-${report.type.replace(/[^a-z0-9-]/gi, '-')}-${report.id.replace(/[^a-z0-9-]/gi, '-')}.${format === 'markdown' ? 'md' : 'json'}` }
}
export const evidenceAnchor = (id: string) => `report-source-${encodeURIComponent(id)}`
