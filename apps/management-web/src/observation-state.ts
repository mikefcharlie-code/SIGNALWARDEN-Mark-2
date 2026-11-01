import type { ApiState, Capability, CatalogItem, Overview } from './lattice-utils'

export type AssessmentEvidence = { id: string; entityId: string; subjectId: string; sourceId: string; field: string; value: unknown; observedAt: string | null; trust: 'trusted' | 'untrusted' | 'unknown'; freshness: 'current' | 'stale' | 'future' | 'unknown'; synthetic: boolean }
export type AssessmentFinding = { id: string; kind: string; title: string; detail: string; evidenceIds: string[] }
export type Assessment = { generatedAt: string; snapshotId: string; summary: string; findings: AssessmentFinding[]; evidence: AssessmentEvidence[]; limitations: string[] }

export type Assistance = {
  mode: 'local' | 'external'
  engine: string
  provider: string
  modelStatus: string
  generatedAt: string
  summary: string
  insights: Array<{ id: string; title: string; detail: string; evidence: string[] }>
  limitations: string[]
  disclosure: string
  dataLeavesSystem: boolean
  readOnly: boolean
  synthetic: boolean
  assessment?: Assessment
}

export function beginRead<T>(state: ApiState<T>): ApiState<T> {
  return { ...state, status: 'loading', error: null }
}
export function finishRead<T>(state: ApiState<T>, result: PromiseSettledResult<T>, receivedAt: string): ApiState<T> {
  if (result.status === 'fulfilled') return { status: 'ready', data: result.value, error: null, receivedAt }
  return { ...state, status: 'error', error: result.reason instanceof Error ? result.reason.message : 'Read failed.' }
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')
function requireShape(condition: boolean): asserts condition {
  if (!condition) throw new Error('Invalid observation response. The last successful snapshot, if any, is retained as unverified.')
}
export function validateOverview(value: unknown): Overview {
  requireShape(record(value) && ['mock', 'offline'].includes(String(value.mode)) && value.readOnly === true && value.connected === false && typeof value.generatedAt === 'string' && Array.isArray(value.platforms) && value.platforms.every(record) && Array.isArray(value.attention) && value.attention.every((item) => record(item) && ['id', 'entityId', 'severity', 'code', 'title', 'detail'].every((key) => typeof item[key] === 'string')) && record(value.summary) && record(value.summary.freshness) && ['platformCount', 'sensorCount', 'locatedCount'].every((key) => typeof (value.summary as Record<string, unknown>)[key] === 'number') && record(value.diagnostics) && strings(value.diagnostics.notes) && typeof value.diagnostics.transport === 'string')
  if (record(value) && value.assessment !== undefined) validateAssessment(value.assessment)
  return value as unknown as Overview
}
export function validateCapabilities(value: unknown): Capability[] {
  requireShape(record(value) && Array.isArray(value.items) && value.items.every((item) => record(item) && ['id', 'title', 'theme', 'description', 'boundary'].every((key) => typeof item[key] === 'string') && ['local-demo', 'design-only', 'excluded'].includes(String(item.implementation))))
  return value.items as Capability[]
}
export function validateCatalog(value: unknown): CatalogItem[] {
  requireShape(record(value) && Array.isArray(value.items) && value.items.every((item) => record(item) && ['catalogId', 'category', 'label'].every((key) => typeof item[key] === 'string')))
  return value.items as CatalogItem[]
}
export function validateAssistance(value: unknown): Assistance {
  requireShape(record(value) && ['local', 'external'].includes(String(value.mode)) && ['engine', 'provider', 'modelStatus', 'generatedAt', 'summary', 'disclosure'].every((key) => typeof value[key] === 'string') && value.readOnly === true && typeof value.dataLeavesSystem === 'boolean' && strings(value.limitations) && Array.isArray(value.insights) && value.insights.every((item) => record(item) && ['id', 'title', 'detail'].every((key) => typeof item[key] === 'string') && strings(item.evidence)))
  if (record(value) && value.assessment !== undefined) validateAssessment(value.assessment)
  return value as unknown as Assistance
}

export function validateAssessment(value: unknown): Assessment {
  requireShape(record(value) && typeof value.generatedAt === 'string' && Number.isFinite(Date.parse(value.generatedAt)) && typeof value.snapshotId === 'string' && value.snapshotId.length > 0 && typeof value.summary === 'string' && strings(value.limitations) && Array.isArray(value.findings) && Array.isArray(value.evidence))
  const findings = value.findings as unknown[]; const evidence = value.evidence as unknown[]
  const ids = (items: unknown[]) => items.map((item) => record(item) ? item.id : undefined)
  requireShape(findings.every((item) => record(item) && ['id', 'kind', 'title', 'detail'].every((key) => typeof item[key] === 'string') && strings(item.evidenceIds)) && new Set(ids(findings)).size === findings.length)
  requireShape(evidence.every((item) => record(item) && ['id', 'entityId', 'subjectId', 'sourceId', 'field', 'trust', 'freshness'].every((key) => typeof item[key] === 'string') && Object.prototype.hasOwnProperty.call(item, 'value') && item.value !== undefined && typeof item.synthetic === 'boolean' && (item.observedAt === null || (typeof item.observedAt === 'string' && Number.isFinite(Date.parse(item.observedAt)))) && ['trusted', 'untrusted', 'unknown'].includes(item.trust as string) && ['current', 'stale', 'future', 'unknown'].includes(item.freshness as string)) && new Set(ids(evidence)).size === evidence.length)
  const evidenceIds = new Set(ids(evidence) as string[])
  requireShape(findings.every((item) => (item as Record<string, unknown>).evidenceIds instanceof Array && ((item as Record<string, unknown>).evidenceIds as unknown[]).every((id) => typeof id === 'string' && evidenceIds.has(id))))
  return value as Assessment
}
