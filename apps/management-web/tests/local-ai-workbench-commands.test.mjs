import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const output = mkdtempSync(join(tmpdir(), 'local-ai-workbench-'));
writeFileSync(join(output, 'package.json'), '{"type":"module"}\n');
const source = resolve('src/local-ai-workbench-commands.ts');
const tsc = resolve('node_modules/typescript/bin/tsc');
const compile = spawnSync(process.execPath, [tsc, source, '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--skipLibCheck', '--outDir', output], { encoding: 'utf8' });
if (compile.status !== 0) throw new Error(`${compile.stdout}\n${compile.stderr}`);
const commands = await import(`${pathToFileURL(join(output, 'local-ai-workbench-commands.js')).href}?test=${Date.now()}`);
test('registry commands precede setup and smoke follows the selected device', () => {
  assert.match(commands.commandFor('.', 'llm', 'cpu', 'plan'), /local_ai_setup.py plan --group llm$/);
  assert.match(commands.registryStatusCommand('.'), /local_ai_setup.py doctor$/);
  assert.match(commands.smokeCommand('.', 'image-classification', 'cuda'), /--device cuda/);
  assert.match(commands.smokeCommand('.', 'video-generation', 'cuda'), /--device cuda/);
});
test('video generation cannot be assigned CPU and external handoff is shell-only', () => {
  assert.equal(commands.deviceForGroup('video-generation', 'cpu'), 'cuda');
  assert.match(commands.externalConfiguration('ignored'), /export UCAS_AI_EXTERNAL_MODEL=\"\${UCAS_CHOSEN_EXTERNAL_MODEL:\?Set a provider-supported model in trusted shell}\"/);
  assert.match(commands.externalConfiguration('ignored'), /export UCAS_AI_MODE=external UCAS_AI_EXTERNAL_PROVIDER=openai UCAS_AI_EXTERNAL_CONSENT=true/);
  assert.match(commands.externalConfiguration('model'), /UCAS_AI_EXTERNAL_API_KEY.*trusted server shell/);
});
