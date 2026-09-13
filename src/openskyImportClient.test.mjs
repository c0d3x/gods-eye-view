import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = fileURLToPath(
  new URL('../scripts/opensky-import-client.sh', import.meta.url),
);
const bashTest = process.platform === 'win32' ? test.skip : test;

/**
 * Run the import with a stand-in `security` that records its arguments and
 * whatever it reads on stdin, so the test can see where each value went.
 */
async function importWith(t, credentials) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-opensky-import-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  const argsLog = path.join(root, 'args.log');
  const stdinLog = path.join(root, 'stdin.log');
  await fs.writeFile(
    path.join(bin, 'security'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argsLog}'\ncat >> '${stdinLog}'\n`,
    { mode: 0o755 },
  );
  const file = path.join(root, 'credentials.json');
  await fs.writeFile(file, JSON.stringify(credentials));
  let result;
  try {
    result = await run('bash', [script, file], {
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    });
    result.code = 0;
  } catch (error) {
    result = { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
  const read = (name) => fs.readFile(name, 'utf8').catch(() => '');
  return { ...result, args: await read(argsLog), stdin: await read(stdinLog) };
}

bashTest(
  'the OpenSky credentials reach the Keychain on stdin, never as arguments',
  async (t) => {
    const clientId = 'fixture-api-client';
    const clientSecret = 'FixtureSecret0123456789abcdefXYZ';
    const result = await importWith(t, { clientId, clientSecret });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.args, '-i\n-i\n');
    assert.match(
      result.stdin,
      new RegExp(
        `^add-generic-password -U -s opensky-network -a client_id -w ${clientId}$`,
        'm',
      ),
    );
    assert.match(
      result.stdin,
      new RegExp(
        `^add-generic-password -U -s opensky-network -a client_secret -w ${clientSecret}$`,
        'm',
      ),
    );
  },
);

bashTest(
  'values security -i could misread are refused before anything runs',
  async (t) => {
    const result = await importWith(t, {
      clientId: 'fixture-api-client',
      clientSecret: 'has a "quoted" space',
    });
    assert.equal(result.code, 1);
    assert.equal(result.args, '');
    assert.match(
      result.stdout,
      /security add-generic-password -U -s opensky-network -a client_secret -w$/m,
    );
  },
);
