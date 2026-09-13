import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAllowedHosts } from './allowedHosts.mjs';

test("the list holds localhost and this machine's names, lowercased", () => {
  assert.deepEqual(resolveAllowedHosts({ hostname: 'Christers-MBP.local' }), [
    'localhost',
    '127.0.0.1',
    'christers-mbp.local',
    'christers-mbp',
  ]);
  assert.deepEqual(resolveAllowedHosts({ hostname: 'devbox' }), [
    'localhost',
    '127.0.0.1',
    'devbox',
    'devbox.local',
  ]);
  assert.deepEqual(resolveAllowedHosts({ hostname: 'studio.lan.' }), [
    'localhost',
    '127.0.0.1',
    'studio.lan',
    'studio',
    'studio.local',
  ]);
});

test('no entry admits every .local name, and nothing turns the check off', () => {
  const hosts = resolveAllowedHosts({ hostname: 'devbox', extra: '.local' });
  assert.equal(hosts.includes(true), false);
  // Only an explicit GEV_ALLOWED_HOSTS entry can add a whole domain.
  assert.deepEqual(
    resolveAllowedHosts({ hostname: 'devbox' }).filter((name) =>
      name.startsWith('.'),
    ),
    [],
  );
});

test('GEV_ALLOWED_HOSTS adds names; malformed entries are ignored', () => {
  const hosts = resolveAllowedHosts({
    hostname: 'devbox',
    extra:
      ' GEV.Example , .home.arpa,,http://bad.example,bad.example:4173,two words ',
  });
  assert.deepEqual(hosts.slice(4), ['gev.example', '.home.arpa']);
});

test('an empty hostname still leaves localhost', () => {
  assert.deepEqual(resolveAllowedHosts({ hostname: '' }), [
    'localhost',
    '127.0.0.1',
  ]);
});
