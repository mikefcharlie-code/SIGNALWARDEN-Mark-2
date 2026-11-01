import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const output = mkdtempSync(join(tmpdir(), 'local-ai-installer-'));
writeFileSync(join(output, 'package.json'), '{"type":"module"}\n');
const compile = spawnSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), resolve('src/local-ai-installer.ts'), '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--skipLibCheck', '--outDir', output], { encoding: 'utf8' });
if (compile.status !== 0) throw new Error(`${compile.stdout}\n${compile.stderr}`);
const api = await import(pathToFileURL(join(output, 'local-ai-installer.js')).href);
const originalFetch = global.fetch;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
test.afterEach(() => { global.fetch = originalFetch; });
test('only queued and running jobs block new work', () => {
  assert.equal(api.activeJob(null), false);
  for (const state of ['queued', 'running']) assert.equal(api.activeJob({ state }), true);
  for (const state of ['succeeded', 'failed', 'cancelled']) assert.equal(api.activeJob({ state }), false);
});
test('launch uses fixed same-origin endpoint, bearer header and explicit license consent', async () => {
  global.fetch = async (url, init) => {
    assert.equal(url, '/api/v1/local-ai/jobs');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, 'Bearer test-admin');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.redirect, 'error');
    assert.deepEqual(JSON.parse(init.body), { group: 'llm', device: 'cpu', action: 'install-download', acceptLicense: true });
    return json({ id: 'job-1', state: 'queued' }, 202);
  };
  assert.equal((await api.startInstall('test-admin', 'llm', 'cpu', 'install-download', true)).state, 'queued');
});
test('status refresh never starts installation', async () => {
  global.fetch = async (url, init) => {
    assert.equal(url, '/api/v1/local-ai/status'); assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined); return json({ enabled: true, groups: [], job: null });
  };
  assert.equal((await api.installerRequest('test-admin', 'status')).job, null);
});
test('untrusted error body is not echoed, and POST is never retried', async () => {
  let calls = 0;
  global.fetch = async () => { calls += 1; return new Response('secret token server traceback', { status: 403 }); };
  await assert.rejects(api.startInstall('test-admin', 'llm', 'cpu', 'download', false), /disabled or this browser origin/);
  assert.equal(calls, 1);
});
test('HTML fallback is detected instead of misreported as a connected API', async () => {
  global.fetch = async () => new Response('<html>app shell</html>', { headers: { 'content-type': 'text/html' } });
  await assert.rejects(api.installerRequest('test-admin', 'status'), /proxy configuration/);
});
test('ambiguous network errors ask for reconnect rather than another mutation', async () => {
  let calls = 0;
  global.fetch = async () => { calls += 1; throw new TypeError('Failed to fetch'); };
  await assert.rejects(api.startInstall('test-admin', 'llm', 'cpu', 'install', false), /Reconnect to check job state/);
  assert.equal(calls, 1);
});
test('authentication and conflict failures are actionable', async () => {
  global.fetch = async () => json({}, 401);
  await assert.rejects(api.installerRequest('bad', 'status'), /token rejected/);
  global.fetch = async () => json({}, 409);
  await assert.rejects(api.startInstall('test-admin', 'llm', 'cpu', 'install', false), /Another job is active/);
});
