import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { normalizeOpenSkyAuthMode } from '../vite.config.js';

test('OpenSky auth is oauth or anon, and the retired Basic modes mean oauth', (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(String(message)));
  assert.equal(normalizeOpenSkyAuthMode(undefined), 'oauth');
  assert.equal(normalizeOpenSkyAuthMode(' OAuth '), 'oauth');
  assert.equal(normalizeOpenSkyAuthMode('anon'), 'anon');
  assert.equal(normalizeOpenSkyAuthMode('basic'), 'oauth');
  assert.equal(normalizeOpenSkyAuthMode('basic'), 'oauth');
  assert.equal(normalizeOpenSkyAuthMode('auto'), 'oauth');
  assert.equal(normalizeOpenSkyAuthMode('bogus'), 'oauth');
  assert.equal(warnings.length, 3, 'one warning per unusable value');
  assert.match(
    warnings[0],
    /"basic" relied on Basic auth, which OpenSky no longer accepts/,
  );
  assert.match(warnings[1], /"auto" relied on Basic auth/);
  assert.match(warnings[2], /Invalid OPENSKY_AUTH_MODE="bogus"/);
});

test('neither the proxy nor the launcher sends a username and password', async () => {
  for (const file of ['../vite.config.js', '../scripts/dev-fresh.sh']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /OPENSKY_(USERNAME|PASSWORD)/, file);
    assert.doesNotMatch(source, /Authorization = `Basic /, file);
  }
});
