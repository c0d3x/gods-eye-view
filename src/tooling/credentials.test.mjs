import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CREDENTIALS,
  findKeychainItem,
  readKeychainValue,
} from '../../scripts/lib/credentials.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (file) =>
  readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

test('a Keychain value comes from the first item holding one, never through argv', () => {
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, ...args]);
    const found = args.includes('client-id') ? 'fixture-client-id\n' : '';
    return { status: found ? 0 : 44, stdout: found };
  };
  assert.equal(
    readKeychainValue('OPENSKY_CLIENT_ID', { spawn, platform: 'darwin' }),
    'fixture-client-id',
  );
  assert.deepEqual(
    calls.map((call) => call.slice(-3)),
    [
      ['-a', 'client_id', '-w'],
      ['-a', 'client-id', '-w'],
    ],
  );
  assert.ok(calls.every(([command]) => command === 'security'));
  assert.ok(calls.flat().every((arg) => !arg.includes('fixture')));
  assert.equal(
    readKeychainValue('LL2_API_TOKEN', { spawn, platform: 'darwin' }),
    '',
  );
  assert.equal(
    readKeychainValue('OPENSKY_CLIENT_ID', { spawn, platform: 'linux' }),
    '',
  );
  assert.equal(
    findKeychainItem('cesium-ion', 'token', {
      spawn: () => ({ status: 0 }),
      platform: 'darwin',
    }),
    true,
  );
});

test('every key the launcher reads from the Keychain has its items listed', () => {
  const launcher = read('scripts/dev-fresh.sh');
  const names = [...launcher.matchAll(/read_keychain_value ([A-Z0-9_]+)/g)].map(
    (match) => match[1],
  );
  assert.ok(
    names.length >= 8,
    'the launcher resolves its keys through the shared table',
  );
  for (const name of names) {
    const spec = CREDENTIALS.find((entry) => entry.name === name);
    assert.ok(spec?.keychain.length > 0, `${name} lists its Keychain items`);
  }
});

test('the Keychain is read in one place', () => {
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    { cwd: ROOT, encoding: 'utf8' },
  )
    .split('\n')
    .filter(
      (file) => /\.(?:m?js|cjs|sh)$/.test(file) && !file.endsWith('.test.mjs'),
    );
  const readers = files.filter((file) =>
    read(file).includes('find-generic-password'),
  );
  assert.deepEqual(readers, ['scripts/lib/credentials.mjs']);
});
