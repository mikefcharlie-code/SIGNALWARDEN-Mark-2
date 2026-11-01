import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
const here = dirname(fileURLToPath(import.meta.url))
const output = mkdtempSync(join(tmpdir(), 'observation-presentation-'))
writeFileSync(join(output, 'package.json'), '{"type":"module"}\n')
const compile = spawnSync(process.execPath, [resolve(here, '../node_modules/typescript/bin/tsc'), resolve(here, '../src/observation-presentation.ts'), '--target', 'ES2022', '--module', 'ESNext', '--skipLibCheck', '--outDir', output], { encoding: 'utf8', cwd: output })
if (compile.status !== 0) throw new Error(`${compile.stdout}\n${compile.stderr}`)
const { elapsedLabel, receiptVerification } = await import(pathToFileURL(join(output, 'observation-presentation.js')).href)
test.after(() => rmSync(output, { recursive: true, force: true }))
const stamp = '2026-10-22T15:00:00Z'
const now = Date.parse(stamp)
test('receipt and source ages advance without changing original timestamps', () => {
  assert.equal(elapsedLabel(stamp, now + 3000), '3s old')
  assert.equal(elapsedLabel(stamp, now + 65000), '1m 5s old')
  assert.equal(elapsedLabel(stamp, now + 3660000), '1h 1m old')
  assert.equal(elapsedLabel(stamp, now + 90000000), '1d 1h old')
})
test('unknown and future timestamps never report a fresh zero age', () => {
  assert.equal(elapsedLabel(undefined, now), 'Age unknown')
  assert.equal(elapsedLabel('bad', now), 'Age unknown')
  assert.equal(elapsedLabel(stamp, now - 1), 'Future timestamp · check clock')
})
test('offline, error and refresh never claim a verified retained snapshot', () => {
  assert.equal(receiptVerification(false, 'ready', true), 'Unverified · browser offline')
  assert.equal(receiptVerification(true, 'error', true), 'Unverified · API read failed')
  assert.equal(receiptVerification(true, 'loading', true), 'Unverified · refresh in progress')
  assert.equal(receiptVerification(true, 'error', false), 'No accepted snapshot')
  assert.equal(receiptVerification(true, 'ready', true), 'API receipt verified · source not live')
})
test('display brand is consistent while package identity is unchanged', () => {
  const main = readFileSync(resolve(here, '../src/main.tsx'), 'utf8')
  assert.match(main, /<strong>SignalWarden AI<\/strong>/)
  assert.match(main, /id: 'ai' as Page/)
  assert.match(readFileSync(resolve(here, '../index.html'), 'utf8'), /<title>SignalWarden AI/)
  assert.equal(JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf8')).name, 'ucas-management-ui')
})
