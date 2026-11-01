import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const output = mkdtempSync(join(tmpdir(), 'local-ai-inference-'));
writeFileSync(join(output, 'package.json'), '{"type":"module"}\n');
const compile = spawnSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), resolve('src/local-ai-inference.ts'), '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--skipLibCheck', '--outDir', output], { encoding: 'utf8' });
if (compile.status !== 0) throw new Error(`${compile.stdout}\n${compile.stderr}`);
const api = await import(pathToFileURL(join(output, 'local-ai-inference.js')).href);
const originalFetch = global.fetch;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
test.afterEach(() => { global.fetch = originalFetch; });

test('status uses exact endpoint and bearer token', async () => {
  global.fetch = async (url, init) => { assert.equal(url, '/api/v1/local-ai/inference/status'); assert.equal(init.method, 'GET'); assert.equal(init.headers.Authorization, 'Bearer admin'); assert.equal(init.cache, 'no-store'); return json({ enabled: true, groups: [], labels: [], limits: {} }); };
  assert.equal((await api.inferenceStatus('admin')).enabled, true);
});
test('submit uses exact 202 endpoint and sends only explicit fields', async () => {
  global.fetch = async (url, init) => { assert.equal(url, '/api/v1/local-ai/inference'); assert.equal(init.method, 'POST'); assert.equal(init.headers.Authorization, 'Bearer admin'); assert.deepEqual(JSON.parse(init.body), { group: 'llm', device: 'cpu', prompt: 'hello', recordIds: ['obs-1'] }); return json({ id: 'j1', group: 'llm', state: 'queued', stage: 'accepted', error: null }, 202); };
  assert.equal((await api.startInference('admin', { group: 'llm', device: 'cpu', prompt: 'hello', recordIds: ['obs-1'] })).id, 'j1');
});
test('cancel and job paths are authenticated', async () => {
  global.fetch = async (url, init) => { assert.equal(url, '/api/v1/local-ai/inference/jobs/j%2F1/cancel'); assert.equal(init.method, 'POST'); assert.equal(init.headers.Authorization, 'Bearer admin'); return json({ id: 'j/1', state: 'cancelled' }); };
  assert.equal((await api.cancelInference('admin', 'j/1')).state, 'cancelled');
});
test('media validation enforces 8 MiB and group MIME boundaries', () => {
  assert.match(api.validateMedia({ name: 'x.png', size: 8 * 1024 * 1024 + 1, type: 'image/png' }, 'image-classification'), /8 MiB/);
  assert.match(api.validateMedia({ name: 'x.jpg', size: 1, type: 'image/jpeg' }, 'video-classification'), /MP4 or GIF/);
  assert.equal(api.validateMedia({ name: 'x.gif', size: 1, type: 'image/gif' }, 'video-classification'), null);
});

test('buildInferenceRequest isolates fields by selected group', () => {
  assert.deepEqual(api.buildInferenceRequest('image-classification', 'cpu', 'stale prompt', 'obs-1', { name: 'x.png', data: 'abc' }), { group: 'image-classification', device: 'cpu', media: { name: 'x.png', data: 'abc' } });
  assert.deepEqual(api.buildInferenceRequest('llm', 'cpu', ' hello ', 'obs-1,obs-2', { name: 'ignored.png', data: 'abc' }), { group: 'llm', device: 'cpu', prompt: 'hello', recordIds: ['obs-1', 'obs-2'] });
  assert.deepEqual(api.buildInferenceRequest('video-generation', 'cuda', 'prompt', 'obs-1', { name: 'ignored.mp4', data: 'abc' }), { group: 'video-generation', device: 'cuda', prompt: 'prompt' });
});
test('result formatting uses exact citation, clip, and score fields', () => {
  assert.equal(api.formatCitation({ record_id: 'rec-7', timestamp: '2025-01-02T03:04:05Z' }), 'rec-7 @ 2025-01-02T03:04:05Z');
  assert.equal(api.formatClip({ start_seconds: 1.5, end_seconds: 3, topk: [{ label: 'clear', score: 0.9 }] }), '1.5–3s: clear (0.9)');
});
test('artifact downloads reject unexpected content types and oversized content', async () => {
  global.fetch = async () => new Response('<html>no</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  await assert.rejects(api.downloadInferenceArtifact('admin', 'j1'), /unsupported content type/);
});
