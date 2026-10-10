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
import { CREDENTIALS as DOCTOR_CREDENTIALS } from '../../scripts/setup-doctor.mjs';

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

test('the launcher reads exactly the keys the shared table lists Keychain items for', () => {
  const launcher = read('scripts/dev-fresh.sh');
  const names = [
    ...new Set(
      [...launcher.matchAll(/read_keychain_value ([A-Z0-9_]+)/g)].map(
        (match) => match[1],
      ),
    ),
  ].sort();
  // The doctor reports a Keychain item as configured and then sends the user
  // to dev-fresh.sh, so the launcher must read every key that has one.
  assert.deepEqual(
    names,
    CREDENTIALS.filter((spec) => spec.keychain.length > 0)
      .map((spec) => spec.name)
      .sort(),
  );
  assert.ok(names.includes('MAPILLARY_CLIENT_TOKEN'));
  assert.equal(DOCTOR_CREDENTIALS, CREDENTIALS);
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
