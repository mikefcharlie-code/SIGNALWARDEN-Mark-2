export type EvidenceRecord = {
  id: string; entityId: string; subjectId: string; sourceId: string; field: string; value: unknown
  observedAt: string | null; trust: string; freshness: string; synthetic: boolean
}
export type RecoveryDigest = { added: EvidenceRecord[]; changed: EvidenceRecord[]; missing: EvidenceRecord[]; recovered: EvidenceRecord[]; stillStale: EvidenceRecord[]; stillUntrusted: EvidenceRecord[]; conflicts: EvidenceRecord[] }
export type RecoveryState = { records: EvidenceRecord[]; highWater: Record<string, string>; tombstones: Record<string, string> }
export const keyOf = (r: EvidenceRecord) => JSON.stringify([r.sourceId, r.entityId, r.subjectId, r.field])
export const time = (r: EvidenceRecord) => r.observedAt ? Date.parse(r.observedAt) : Number.NaN
const validTime = (r: EvidenceRecord) => Number.isFinite(time(r))
const trusted = (r: EvidenceRecord) => r.trust === 'trusted' && !r.synthetic
export const fresh = (r: EvidenceRecord, now = Date.now()) => {
  const stamp = time(r)
  return !r.synthetic && Number.isFinite(stamp) && stamp <= now && now - stamp <= 300_000 && r.freshness === 'current'
}
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
}
export const sameValue = (a: EvidenceRecord, b: EvidenceRecord) => canonical(a.value) === canonical(b.value)

/** Reject regressed complete receipts before either inventory or citations are published. */
export function assertEvidenceReceipt(previous: RecoveryState, incoming: EvidenceRecord[], generation: string, lastGeneration?: string, sameSnapshot = false): void {
  if (lastGeneration && Date.parse(generation) < Date.parse(lastGeneration)) throw new Error('Older API snapshot rejected; the retained snapshot remains unverified.')
  const prior = new Map(previous.records.map((r) => [keyOf(r), r]))
  for (const record of incoming) {
    const key = keyOf(record); const stamp = time(record)
    const high = previous.highWater[key] ? Date.parse(previous.highWater[key]) : Number.NEGATIVE_INFINITY
    const removed = previous.tombstones[key] ? Date.parse(previous.tombstones[key]) : Number.NEGATIVE_INFINITY
    if ((Number.isFinite(high) && !Number.isFinite(stamp)) || stamp < high || stamp <= removed) throw new Error('Regressed or removed source evidence rejected; a new API receipt cannot renew old observations.')
    const old = prior.get(key)
    if (!sameSnapshot && old && Number.isFinite(stamp) && stamp === time(old) && !sameValue(old, record)) throw new Error('Same-source, same-time value conflict held for review; no version was promoted to current.')
  }
}

/** Reconcile a complete receipt in memory. No historical record is merged into a missing slot. */
export function reconcileEvidence(previous: RecoveryState, incoming: EvidenceRecord[], now = Date.now()): { state: RecoveryState; digest: RecoveryDigest } {
  const before = new Map(previous.records.map((r) => [keyOf(r), r]))
  const accepted = new Map<string, EvidenceRecord>()
  const conflicts = new Map<string, EvidenceRecord>()
  const highWater = { ...previous.highWater }; const tombstones = { ...previous.tombstones }
  for (const record of [...incoming].sort((a, b) => a.id.localeCompare(b.id))) {
    const key = keyOf(record); const stamp = time(record)
    const high = highWater[key] ? Date.parse(highWater[key]) : Number.NEGATIVE_INFINITY
    const removed = tombstones[key] ? Date.parse(tombstones[key]) : Number.NEGATIVE_INFINITY
    if ((Number.isFinite(high) && !validTime(record)) || stamp < high || stamp <= removed) continue
    const existing = accepted.get(key) ?? before.get(key)
    if (existing && validTime(record) && validTime(existing) && stamp < time(existing)) continue
    if (existing && validTime(record) && validTime(existing) && stamp === time(existing) && !sameValue(existing, record)) {
      conflicts.set(key, record)
      accepted.delete(key)
      continue
    }
    if (conflicts.has(key)) continue
    accepted.set(key, record)
    if (validTime(record) && (!highWater[key] || stamp > Date.parse(highWater[key]))) highWater[key] = record.observedAt!
  }
  const current = [...accepted.values()]; const currentKeys = new Set(current.map(keyOf))
  for (const old of before.values()) if (!currentKeys.has(keyOf(old)) && validTime(old)) tombstones[keyOf(old)] = old.observedAt!
  const added = current.filter((r) => !before.has(keyOf(r)))
  const changed = current.filter((r) => { const old = before.get(keyOf(r)); return old && (!sameValue(old, r) || old.trust !== r.trust || old.freshness !== r.freshness || old.synthetic !== r.synthetic || old.observedAt !== r.observedAt) })
  const missing = [...before.values()].filter((r) => !currentKeys.has(keyOf(r)))
  const recovered = current.filter((r) => {
    const old = before.get(keyOf(r)); const removed = previous.tombstones[keyOf(r)]
    const uncertain = old ? !fresh(old, now) || !trusted(old) : !!removed
    const priorTime = old ? time(old) : Date.parse(removed ?? '')
    return uncertain && fresh(r, now) && trusted(r) && time(r) > priorTime && !conflicts.has(keyOf(r))
  })
  const stillStale = current.filter((r) => !fresh(r, now))
  const stillUntrusted = current.filter((r) => !trusted(r))
  return { state: { records: current, highWater, tombstones }, digest: { added, changed, missing, recovered, stillStale, stillUntrusted, conflicts: [...conflicts.values()] } }
}
export const emptyRecoveryState = (): RecoveryState => ({ records: [], highWater: {}, tombstones: {} })

/** Display-only aging can demote evidence, never renew a server-declared stale/unknown record. */
export function effectiveEvidenceFreshness(record: EvidenceRecord, now: number, verified: boolean): string {
  const stamp = time(record)
  if (!Number.isFinite(stamp) || record.freshness === 'unknown') return 'unknown'
  if (record.freshness === 'future' || stamp > now) return 'future'
  if (record.synthetic || record.freshness === 'stale' || now - stamp > 300_000) return 'stale'
  return verified ? 'current' : 'unknown'
}
