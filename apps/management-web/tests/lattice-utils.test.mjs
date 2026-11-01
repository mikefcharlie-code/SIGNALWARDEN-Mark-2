import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
const here = dirname(fileURLToPath(import.meta.url))
const source = resolve(here, '../src/lattice-utils.ts')
const output = mkdtempSync(join(tmpdir(), 'lattice-utils-'))
writeFileSync(join(output, 'package.json'), '{"type":"module"}\n')
const tsc = resolve(here, '../node_modules/typescript/bin/tsc')
const compile = spawnSync(process.execPath, [tsc, source, '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--skipLibCheck', '--outDir', output], { encoding: 'utf8', cwd: output })
if (compile.status !== 0) throw new Error(`${compile.stdout}\n${compile.stderr}`)
const utils = await import(`${pathToFileURL(join(output, 'lattice-utils.js')).href}?test=${Date.now()}`)
const air = { entityId: 'air-1', aliases: { name: 'Synthetic aircraft' }, catalogId: 'autonomous-air-like', ontology: { platformType: 'UAV' }, location: { position: { latitudeDegrees: 0, longitudeDegrees: 1, altitudeHaeMeters: 120 } }, health: { connectionStatus: 'CONNECTION_STATUS_ONLINE', healthStatus: 'HEALTH_STATUS_HEALTHY' }, sensors: { sensors: [{ sensorId: 'cam-1', sensorType: 'SENSOR_TYPE_CAMERA', operationalState: 'OPERATIONAL' }] }, freshness: 'current', synthetic: true, provenance: { sourceUpdateTime: '2025-01-01T00:00:00Z' } }
test('normalizes entity, sensor, health, and exact HAE reference', () => { const item = utils.normalizePlatform(air); assert.equal(item.name, 'Synthetic aircraft'); assert.equal(item.altitudeReference, 'HAE'); assert.equal(utils.formatAltitude(item), '120 m HAE'); assert.equal(item.sensors[0].sensorId, 'cam-1'); assert.equal(item.connection, 'online') })
test('preserves unknown altitude reference instead of guessing', () => { const item = utils.normalizePlatform({ entityId: 'x', location: { position: { latitudeDegrees: 1 } } }); assert.equal(item.altitudeReference, 'unknown'); assert.equal(utils.formatAltitude(item), 'Not reported · reference unknown') })
test('filters by multiword query, category, and freshness', () => { const items = [utils.normalizePlatform(air), utils.normalizePlatform({ ...air, entityId: 'ground-1', aliases: { name: 'Ground record' }, catalogId: 'autonomous-ground-like', ontology: {}, freshness: 'stale' })]; assert.deepEqual(utils.filterPlatforms(items, ' synthetic aircraft ', 'all', 'current').map((x) => x.entityId), ['air-1']); assert.deepEqual(utils.filterPlatforms(items, '', 'autonomous-ground-like', 'all').map((x) => x.entityId), ['ground-1']) })
test('maps capability maturity tones without implying implementation', () => { assert.equal(utils.capabilityTone('local-demo'), 'green'); assert.equal(utils.capabilityTone('design-only'), 'blue'); assert.equal(utils.capabilityTone('excluded'), 'red') })
test.after(() => rmSync(output, { recursive: true, force: true }))

test('shows all altitude references independently without conversion', () => {
  const item = utils.normalizePlatform({ entityId: 'multi-altitude', location: { position: { altitudeHaeMeters: 120, altitudeAglMeters: 40, altitudeAsfMeters: 80, pressureDepthMeters: 3 } } })
  assert.equal(utils.formatAltitude(item), '120 m HAE · 40 m AGL · 80 m ASF · 3 m depth')
})
test('ignores malformed altitude values without hiding another valid reference', () => {
  const item = utils.normalizePlatform({ entityId: 'bad-altitude', location: { position: { altitudeHaeMeters: 'invalid', altitudeAglMeters: 0 } } })
  assert.equal(utils.formatAltitude(item), '0 m AGL')
})
