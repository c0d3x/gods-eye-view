import assert from 'node:assert/strict';
import test from 'node:test';
import { readUiSource } from './testing/uiSources.mjs';

const ui = readUiSource();

test('POI pills show the key and the name as text, never as markup', () => {
  const start = ui.indexOf('_expandPOIRow(cityId) {');
  const end = ui.indexOf('\n  }\n', start);
  assert.ok(start >= 0 && end > start, '_expandPOIRow not found in ui.js');
  const body = ui.slice(start, end);
  assert.doesNotMatch(body, /\.innerHTML\s*=\s*`/);
  assert.match(body, /nameSpan\.textContent = poi\.name;/);
});
