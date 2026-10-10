import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeFixtureRoot } from './tooling/fixtureRoot.mjs';

const run = promisify(execFile);
const bashTest = process.platform === 'win32' ? test.skip : test;

async function launch(overrides = {}, dotenv = '', omitCctv = false, script = 'dev-cctv.sh', keychain = {}) {
  // Physical path: the launched process reports its cwd resolved, and macOS
  // reaches the temp directory through a symlink.
  const root = await makeFixtureRoot('gev-cctv-launch-');
  try {
    await fs.mkdir(path.join(root, 'scripts', 'lib'), { recursive: true });
    await fs.mkdir(path.join(root, 'bin'));
    await fs.mkdir(path.join(root, 'src', 'data'), { recursive: true });
    await fs.copyFile(new URL('./data/cctv.js', import.meta.url), path.join(root, 'src', 'data', 'cctv.js'));
    for (const name of ['dev-cctv.sh', 'dev-fresh.sh', 'dev-secure.sh', 'read-dotenv-value.mjs', 'read-keychain-value.mjs', 'lib/credentials.mjs']) {
      await fs.copyFile(new URL(`../scripts/${name}`, import.meta.url), path.join(root, 'scripts', name));
    }
    await fs.mkdir(path.join(root, 'src', 'standalone'), { recursive: true });
    const catalog = await fs.readFile(new URL('./standalone/catalog.js', import.meta.url), 'utf8');
    await fs.writeFile(path.join(root, 'src', 'standalone', 'catalog.js'), catalog);
    await fs.mkdir(path.join(root, 'src', 'app'), { recursive: true });
    const assembly = await fs.readFile(new URL('./app/constructCatalog.js', import.meta.url), 'utf8');
    await fs.writeFile(path.join(root, 'src', 'app', 'constructCatalog.js'), omitCctv ? assembly.replace(/^\s*createApplicationCctv\(.*$/m, '') : assembly);
    await fs.mkdir(path.join(root, 'node_modules'));
    await fs.symlink(fileURLToPath(new URL('.', import.meta.resolve('vite/package.json'))), path.join(root, 'node_modules', 'vite'), 'dir');
    await fs.writeFile(path.join(root, '.env'), dotenv);
    // Stub only external programs; both production launchers and dotenv parsing run.
    for (const command of ['security', 'pkill', 'lsof']) {
      await fs.writeFile(path.join(root, 'bin', command), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    }
    // `security find-generic-password -s SERVICE -a ACCOUNT -w` answers from
    // `keychain`, keyed by SERVICE/ACCOUNT.
    const items = Object.entries(keychain).map(([item, value]) => `  ${item}) printf '%s\\n' '${value}'; exit 0 ;;`);
    if (items.length) await fs.writeFile(path.join(root, 'bin', 'security'), `#!/bin/sh\ncase "$3/$5" in\n${items.join('\n')}\nesac\nexit 44\n`, { mode: 0o755 });
    await fs.writeFile(path.join(root, 'bin', 'npm'), `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.CCTV_TEST_CAPTURE, JSON.stringify({ args: process.argv.slice(2), env: process.env, cwd: process.cwd() }));
`, { mode: 0o755 });
    const capture = path.join(root, 'capture.json');
    const result = await run('bash', [path.join(root, 'scripts', script)], {
      cwd: os.tmpdir(),
      env: { PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`, CCTV_TEST_CAPTURE: capture, ...overrides },
      timeout: 30_000,
    });
    return { ...JSON.parse(await fs.readFile(capture, 'utf8')), output: result.stdout + result.stderr, root };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

bashTest('CCTV preset starts keyless on localhost through the normal launcher', async () => {
  const result = await launch();
  assert.deepEqual(result.args, ['run', 'dev', '--', '--host', 'localhost', '--port', '4173', '--force']);
  assert.equal(result.cwd, result.root);
  assert.equal(result.env.CCTV_SOURCES_FILE, 'config/cctv_sources.austin.json');
  assert.equal(result.env.CCTV_PREFER_AUSTIN, '1');
  assert.equal(result.env.CCTV_AUSTIN_MAX_SOURCES, '36');
  assert.equal(result.env.CCTV_MAX_SOURCES, '48');
  assert.equal(result.env.GEV_LAUNCHER, 'dev-fresh');
  assert.equal(result.env.GEV_KEY_SETUP_EXTERNAL_KEYS, '');
  assert.equal(result.env.GOOGLE_MAPS_API_KEY, undefined);
  assert.match(result.output, /Startup map: Esri World Imagery/);
  assert.doesNotMatch(result.output, /!! WARNING/);
});

bashTest('CCTV preset preserves explicit LAN and source overrides with a warning', async () => {
  const result = await launch({ HOST: '0.0.0.0', PORT: '4999', CCTV_SOURCES_FILE: 'config/custom.json', CCTV_PREFER_AUSTIN: '0', CCTV_AUSTIN_MAX_SOURCES: '5', CCTV_MAX_SOURCES: '9', CCTV_CALTRANS_DISTRICTS: '', CCTV_TFL_ENABLED: '0' });
  assert.deepEqual(result.args.slice(-5), ['--host', '0.0.0.0', '--port', '4999', '--force']);
  assert.equal(result.env.CCTV_SOURCES_FILE, 'config/custom.json');
  assert.equal(result.env.CCTV_PREFER_AUSTIN, '0');
  assert.equal(result.env.CCTV_AUSTIN_MAX_SOURCES, '5');
  assert.equal(result.env.CCTV_MAX_SOURCES, '9');
  assert.equal(result.env.CCTV_CALTRANS_DISTRICTS, '');
  assert.equal(result.env.CCTV_TFL_ENABLED, '0');
  assert.match(result.output, /!! WARNING: HOST=0\.0\.0\.0/);
});

bashTest('CCTV preset shares dotenv precedence and names-only credential provenance', async () => {
  const result = await launch({ GOOGLE_MAPS_API_KEY: 'fixture-shell-maps' }, 'GOOGLE_MAPS_API_KEY=fixture-file-maps\nOPENAI_API_KEY=fixture-file-voice\n');
  assert.equal(result.env.GOOGLE_MAPS_API_KEY, 'fixture-shell-maps');
  assert.equal(result.env.OPENAI_API_KEY, 'fixture-file-voice');
  assert.equal(result.env.GEV_KEY_SETUP_EXTERNAL_KEYS, 'GOOGLE_MAPS_API_KEY');
  assert.doesNotMatch(result.output, /fixture-shell-maps|fixture-file-maps|fixture-file-voice/);
});

bashTest('CCTV preset refuses a catalog that no longer registers its layer', async () => {
  await assert.rejects(launch({}, '', true), (error) => {
    assert.match(error.stdout, /CCTV layer not wired in src\/standalone\/catalog.js/);
    return true;
  });
});

bashTest('the secure launcher pins the loopback address, whatever HOST says, and starts keyless', async () => {
  const result = await launch({ HOST: '0.0.0.0' }, '', false, 'dev-secure.sh');
  assert.deepEqual(result.args.slice(-5), ['--host', '127.0.0.1', '--port', '4173', '--force']);
  assert.equal(result.env.GOOGLE_MAPS_API_KEY, undefined);
  assert.match(result.output, /Local-only mode/);
  assert.doesNotMatch(result.output, /!! WARNING/);
});

bashTest('the secure launcher reads keys from .env like the normal launcher', async () => {
  const result = await launch({}, 'OPENAI_API_KEY=fixture-secure-voice\nGOOGLE_MAPS_API_KEY=fixture-secure-maps\nMAPILLARY_CLIENT_TOKEN=fixture-secure-street\n', false, 'dev-secure.sh');
  assert.equal(result.env.OPENAI_API_KEY, 'fixture-secure-voice');
  assert.equal(result.env.GOOGLE_MAPS_API_KEY, 'fixture-secure-maps');
  assert.equal(result.env.MAPILLARY_CLIENT_TOKEN, 'fixture-secure-street');
  assert.equal(result.env.GEV_KEY_SETUP_EXTERNAL_KEYS, '');
  assert.doesNotMatch(result.output, /fixture-secure/);
});

const keychainTest = process.platform === 'darwin' ? test : test.skip;

keychainTest('the launcher reads a key missing from the environment and .env through the shared Keychain table', async () => {
  const result = await launch({ OPENAI_API_KEY: 'fixture-shell-voice' }, '', false, 'dev-cctv.sh', {
    'google-maps-api/default': 'fixture-keychain-maps',
    'mapillary/token': 'fixture-keychain-street',
    'openai-api/api-key': 'fixture-keychain-voice',
  });
  assert.equal(result.env.GOOGLE_MAPS_API_KEY, 'fixture-keychain-maps');
  assert.equal(result.env.MAPILLARY_CLIENT_TOKEN, 'fixture-keychain-street');
  assert.equal(result.env.OPENAI_API_KEY, 'fixture-shell-voice');
  assert.match(result.output, /Google Maps key source: keychain/);
  assert.doesNotMatch(result.output, /fixture-/);
});
