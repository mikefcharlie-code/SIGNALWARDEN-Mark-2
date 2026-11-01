import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = resolve(here, '../src/observation-network.ts')
const output = mkdtempSync(join(tmpdir(), 'observation-network-'))
writeFileSync(join(output, 'package.json'), '{"type":"module"}\n')
const tsc = resolve(here, '../node_modules/typescript/bin/tsc')
const compile = spawnSync(process.execPath, [tsc, source, '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--lib', 'ES2022,DOM', '--skipLibCheck', '--outDir', output], { encoding: 'utf8', cwd: output })
if (compile.status !== 0) throw new Error(`${compile.stdout}\n${compile.stderr}`)
const network = await import(`${pathToFileURL(join(output, 'observation-network.js')).href}?test=${Date.now()}`)

const originalFetch = globalThis.fetch
const response = (body, status = 200, headers = {}) => new Response(body, { status, headers })
test.after(() => {
  globalThis.fetch = originalFetch
  rmSync(output, { recursive: true, force: true })
})

test('restricts requests to the same-origin lattice namespace and sends GET/no-store credentials', async () => {
  const calls = []
  globalThis.fetch = async (...args) => { calls.push(args); return response('{"ok":true}') }
  await assert.rejects(network.getObservationJson('/api/v1/other'), /same-origin/)
  await assert.rejects(network.getObservationJson('https://evil.example/api/v1/lattice/x'), /same-origin/)
  assert.deepEqual(await network.getObservationJson('/api/v1/lattice/overview'), { ok: true })
  assert.equal(calls[0][0], '/api/v1/lattice/overview')
  assert.deepEqual(calls[0][1], { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: calls[0][1].signal })
})

test('retries network failures and reports each attempt, capped at three', async () => {
  let calls = 0
  const attempts = []
  globalThis.fetch = async () => { calls += 1; if (calls < 3) throw new TypeError('offline'); return response('{"ready":true}') }
  const value = await network.getObservationJson('/api/v1/lattice/x', { onAttempt: (attempt) => attempts.push(attempt), timeoutMs: 100 })
  assert.deepEqual(value, { ready: true })
  assert.equal(calls, 3)
  assert.deepEqual(attempts, [1, 2, 3])
})

test('retries retryable statuses but never ordinary 4xx or malformed JSON', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls += 1; return response('', 400, {}) }
  await assert.rejects(network.getObservationJson('/api/v1/lattice/x'), /400/)
  assert.equal(calls, 1)
  calls = 0
  globalThis.fetch = async () => { calls += 1; return response('{not-json') }
  await assert.rejects(network.getObservationJson('/api/v1/lattice/x'), /valid JSON/)
  assert.equal(calls, 1)
})

test('bounds Retry-After and retries a 503 without waiting beyond the client bound', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls += 1; return calls === 1 ? response('', 503, { 'Retry-After': '999999' }) : response('{"ok":1}') }
  const started = Date.now()
  const value = await network.getObservationJson('/api/v1/lattice/x')
  assert.deepEqual(value, { ok: 1 })
  assert.equal(calls, 2)
  assert.ok(Date.now() - started < 2500)
})

test('timeout includes a hanging response body and retries, then exhausts', async () => {
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return { ok: true, status: 200, statusText: 'OK', headers: new Headers(), json: () => new Promise(() => {}) }
  }
  await assert.rejects(network.getObservationJson('/api/v1/lattice/x', { timeoutMs: 15, maxAttempts: 2 }), /timed out/)
  assert.equal(calls, 2)
})

test('caller cancellation stops retries and is distinguishable as AbortError', async () => {
  const controller = new AbortController()
  let calls = 0
  globalThis.fetch = async () => { calls += 1; throw new TypeError('offline') }
  const pending = network.getObservationJson('/api/v1/lattice/x', { signal: controller.signal, timeoutMs: 100 })
  setTimeout(() => controller.abort(), 5)
  await assert.rejects(pending, (error) => error?.name === 'AbortError')
  assert.ok(calls <= 1)
})

test('caller cancellation interrupts a hanging body even when fetch ignores its signal', async () => {
  const controller = new AbortController()
  globalThis.fetch = async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) })
  const pending = network.getObservationJson('/api/v1/lattice/assistance', { signal: controller.signal, timeoutMs: 60_000, maxAttempts: 1 })
  setTimeout(() => controller.abort(), 5)
  await assert.rejects(pending, (error) => error?.name === 'AbortError')
})
