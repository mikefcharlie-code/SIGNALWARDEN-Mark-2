export type Freshness = 'current' | 'stale' | 'future' | 'unknown'
export type Implementation = 'local-demo' | 'design-only' | 'excluded'
export type LatticePlatform = {
  entityId: string
  name: string
  catalogId?: string
  category: string
  synthetic: boolean
  latitude?: number
  longitude?: number
  altitude?: number
  altitudeReadings?: Array<{ value: number; reference: string }>
  altitudeReference?: 'HAE' | 'AGL' | 'ASF' | 'depth' | 'unknown'
  connection: string
  health: string
  freshness: Freshness
  sourceUpdateTime: string | null
  sensors: Array<{ sensorId: string; sensorType: string; operationalState: string }>
}
export type Overview = {
  mode: string; synthetic: boolean; readOnly: boolean; connected: boolean; generatedAt: string
  summary: { platformCount: number; sensorCount: number; locatedCount: number; freshness: Record<Freshness, number> }
  platforms: unknown[]
  attention: Array<{ id: string; entityId: string; severity: 'warning' | 'info'; code: string; title: string; detail: string }>
  diagnostics: { transport: string; networkAccess: boolean; deviceAccess: boolean; meshAvailable: boolean; source: string; lastSourceUpdateTime: string | null; notes: string[] }
  assessment?: import('./observation-state').Assessment
}
export type Capability = { id: string; title: string; theme: string; implementation: Implementation; description: string; boundary: string }
export type CatalogItem = { catalogId: string; category: string; sensorType?: string; mobility?: string; label: string; description?: string }
export type ApiState<T> = { status: 'loading' | 'ready' | 'error'; data: T | null; error: string | null; receivedAt?: string }

const asString = (value: unknown) => typeof value === 'string' ? value : ''
const asNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined
export function normalizePlatform(raw: unknown): LatticePlatform {
  const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const location = item.location && typeof item.location === 'object' ? item.location as Record<string, unknown> : {}
  const position = location.position && typeof location.position === 'object' ? location.position as Record<string, unknown> : {}
  const ontology = item.ontology && typeof item.ontology === 'object' ? item.ontology as Record<string, unknown> : {}
  const health = item.health && typeof item.health === 'object' ? item.health as Record<string, unknown> : {}
  const provenance = item.provenance && typeof item.provenance === 'object' ? item.provenance as Record<string, unknown> : {}
  const aliases = item.aliases && typeof item.aliases === 'object' ? item.aliases as Record<string, unknown> : {}
  const sensorsObject = item.sensors && typeof item.sensors === 'object' ? item.sensors as Record<string, unknown> : {}
  const sensors = Array.isArray(sensorsObject.sensors) ? sensorsObject.sensors.map((sensor) => {
    const value = sensor && typeof sensor === 'object' ? sensor as Record<string, unknown> : {}
    return { sensorId: asString(value.sensorId) || 'unknown-sensor', sensorType: asString(value.sensorType) || 'unknown', operationalState: asString(value.operationalState) || 'unknown' }
  }) : []
  const ref = position.altitudeHaeMeters !== undefined ? 'HAE' : position.altitudeAglMeters !== undefined ? 'AGL' : position.altitudeAsfMeters !== undefined ? 'ASF' : position.pressureDepthMeters !== undefined ? 'depth' : 'unknown'
  const altitude = ref === 'HAE' ? asNumber(position.altitudeHaeMeters) : ref === 'AGL' ? asNumber(position.altitudeAglMeters) : ref === 'ASF' ? asNumber(position.altitudeAsfMeters) : asNumber(position.pressureDepthMeters)
  const freshness = ['current', 'stale', 'future', 'unknown'].includes(asString(item.freshness)) ? asString(item.freshness) as Freshness : 'unknown'
  const altitudeReadings = Object.entries({ altitudeHaeMeters: 'HAE', altitudeAglMeters: 'AGL', altitudeAsfMeters: 'ASF', pressureDepthMeters: 'depth' }).flatMap(([key, reference]) => {
    const value = asNumber(position[key])
    return value === undefined ? [] : [{ value, reference }]
  })
  return { entityId: asString(item.entityId) || 'unknown-entity', name: asString(aliases.name) || asString(item.entityId) || 'Unnamed observation', catalogId: asString(item.catalogId) || undefined, category: asString(ontology.platformType) || asString(item.catalogId) || 'Observation record', synthetic: item.synthetic === true, latitude: asNumber(position.latitudeDegrees), longitude: asNumber(position.longitudeDegrees), altitude, altitudeReadings, altitudeReference: ref, connection: asString(health.connectionStatus).replace('CONNECTION_STATUS_', '').toLowerCase() || 'unknown', health: asString(health.healthStatus).replace('HEALTH_STATUS_', '').toLowerCase() || 'unknown', freshness, sourceUpdateTime: asString(provenance.sourceUpdateTime) || null, sensors }
}
export function filterPlatforms(items: LatticePlatform[], query: string, category: string, freshness: string): LatticePlatform[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return items.filter((item) => {
    const text = [item.entityId, item.name, item.category, item.catalogId, item.connection, item.health, ...item.sensors.map((sensor) => `${sensor.sensorId} ${sensor.sensorType}`)].join(' ').toLocaleLowerCase()
    return words.every((word) => text.includes(word)) && (category === 'all' || item.category === category || item.catalogId === category) && (freshness === 'all' || item.freshness === freshness)
  })
}
export function formatAltitude(platform: LatticePlatform): string {
  if (platform.altitudeReadings?.length) return platform.altitudeReadings.map(({ value, reference }) => `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} m ${reference}`).join(' · ')
  if (platform.altitude === undefined) return 'Not reported · reference unknown'
  const reference = platform.altitudeReference === 'depth' ? 'depth' : platform.altitudeReference === 'unknown' ? 'reference unknown' : platform.altitudeReference
  return `${platform.altitude.toLocaleString(undefined, { maximumFractionDigits: 1 })} m ${reference}`
}
export function formatSourceTime(value: string | null): string { return value ? value.replace('T', ' ').replace('Z', ' UTC') : 'No source timestamp' }
export function capabilityTone(value: Implementation): string { return value === 'local-demo' ? 'green' : value === 'design-only' ? 'blue' : 'red' }

export function effectiveFreshness(sourceUpdateTime: string | null, now = Date.now(), online = true): Freshness {
  if (!online || !sourceUpdateTime) return 'unknown'
  const stamp = Date.parse(sourceUpdateTime); if (!Number.isFinite(stamp)) return 'unknown'
  if (stamp > now) return 'future'; return now - stamp <= 300_000 ? 'current' : 'stale'
}
