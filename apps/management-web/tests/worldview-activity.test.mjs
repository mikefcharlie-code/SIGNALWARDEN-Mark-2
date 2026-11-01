import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

test('all public-provider panels receive the measured visible-globe gate', () => {
  const view = source('WorldView.tsx');
  assert.match(view, /\[globeActive, setGlobeActive\] = useState\(false\)/);
  assert.match(view, /document\.visibilityState !== "hidden"/);
  assert.match(view, /addEventListener\("visibilitychange", update\)/);
  assert.match(view, /removeEventListener\("visibilitychange", update\)/);
  for (const panel of ['Basemap', 'Ocean', 'WindAir', 'LiveMaps', 'Ais', 'PublicTraffic', 'Hazards', 'Mobility', 'Weather', 'Space']) {
    assert.match(view, new RegExp(`<WorldView${panel} active=\\{globeActive\\}`), panel);
  }
  assert.match(view, /WorldViewSar[^>]*globeActive=\{globeActive\}/);
});

test('point-weather consent and activity revocation aborts work and clears emitted records', () => {
  const panel = source('WorldViewWeather.tsx');
  assert.match(panel, /active = false/);
  assert.match(panel, /if \(!active \|\| !optIn \|\| busy\) return/);
  assert.match(panel, /if \(active && optIn\) return/);
  assert.match(panel, /abort\.current\?\.abort\(\); abort\.current = null/);
  assert.match(panel, /records\.filter\(\(record\) => !ids\.has\(record\.id\)\)/);
  assert.match(panel, /if \(!controller\.signal\.aborted\) setRelay\(result\)/);
  assert.match(panel, /openMeteoTermsConfirmed: commercialOpenMeteo \|\| freeTierConsent/);
});
