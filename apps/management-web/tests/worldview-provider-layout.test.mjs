import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

test('provider controls are mounted in a bounded dock without changing activity gates', () => {
  const view = source('WorldView.tsx');
  const css = source('worldview-provider-layout.css');

  assert.match(view, /import "\.\/worldview-provider-layout\.css"/);
  assert.match(view, /className="wv-provider-dock"/);
  assert.match(view, /className="wv-provider-panels"/);
  assert.doesNotMatch(view.slice(0, view.indexOf('<div className="wv-layout">')), /wv-local-toggle|wv-sar-toggle/);
  assert.match(css, /\.worldview \.wv-provider-dock\s*\{[\s\S]*position:\s*fixed/);
  assert.match(css, /max-height:\s*calc\(100dvh - 174px\)/);
  assert.match(css, /\.worldview \.wv-provider-panels\s*\{[\s\S]*overflow-y:\s*auto/);
  assert.match(css, /overflow-x:\s*hidden/);
  assert.match(css, /\.worldview \.wv-stage\s*\{[\s\S]*position:\s*sticky/);

  assert.match(view, /intersectionRatio >= 0\.25/);
  assert.match(view, /document\.visibilityState !== "hidden"/);
  assert.match(view, /addEventListener\("visibilitychange", update\)/);
  assert.match(view, /removeEventListener\("visibilitychange", update\)/);
});

test('the dock retains every public-provider toggle and measured active prop', () => {
  const view = source('WorldView.tsx');
  for (const label of [
    'Open local offline layers',
    'Open public SAR satellite imagery controls',
    'Open imagery, basemaps and terrain',
    'Open ocean maps & marine data',
    'Open wind & air-quality maps',
    'Open animated rain radar & satellite loops',
    'Open read-only AIS vessel controls',
    'Open public traffic cameras and traffic',
    'Open fire and hazard feeds',
    'Open transit, street imagery and context',
  ]) assert.match(view, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  for (const panel of ['Basemap', 'Ocean', 'WindAir', 'LiveMaps', 'Ais', 'PublicTraffic', 'Hazards', 'Mobility', 'Weather', 'Space']) {
    assert.match(view, new RegExp(`<WorldView${panel}[^>]*active=\\{globeActive\\}`), panel);
  }
  assert.match(view, /WorldViewSar[^>]*globeActive=\{globeActive\}/);
});
