import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
test('selected offline libraries are exact-pinned and no redundant globe stack is added', () => {
  const { dependencies } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  for (const name of ['@turf/distance', '@turf/helpers', '@turf/boolean-intersects']) assert.equal(dependencies[name], '7.4.0');
  assert.equal(dependencies.uplot, '1.6.32');
  for (const name of ['@turf/turf', 'cesium', 'deck.gl', '@deck.gl/core', 'maplibre-gl']) assert.equal(dependencies[name], undefined);
});
test('full local notices match the installed selected dependency closure', () => {
  const result = spawnSync(process.execPath, ['scripts/library-notices.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const notices = readFileSync(resolve(root, 'public/offline-library-notices.txt'), 'utf8');
  assert.match(notices, /uplot@1\.6\.32/);
  assert.match(notices, /@turf\/boolean-intersects@7\.4\.0/);
  assert.match(notices, /Copyright \(c\) 2022 Leon Sorokin/);
  assert.match(notices, /THE SOFTWARE IS PROVIDED/);
});
