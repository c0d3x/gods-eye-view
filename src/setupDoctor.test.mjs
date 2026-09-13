import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildCapabilitySummary,
  CREDENTIALS,
  checkGitHook,
  checkLockfile,
  checkOpenSky,
  checkPnpmVersion,
  checkPort,
  checkQaBrowser,
  checkWs,
  classifyNodeVersion,
  devServerAddress,
  formatSetupReport,
  hasRequiredDependencies,
  inspectSetup,
  isConfiguredValue,
  lockfileSpecifiers,
  pnpmProcessSpec,
  readDoctorDotenvValue,
  readOpenSkyCredentialsFile,
  resolveCredential,
} from '../scripts/setup-doctor.mjs';

const credential = (name) => CREDENTIALS.find((spec) => spec.name === name);
const readRoot = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

/** Every provider unconfigured, for reports about something else. */
const unconfigured = () => Object.fromEntries(
  CREDENTIALS.map((spec) => [spec.name, { configured: false }]),
);

/** A ready report without findings; overrides replace its fields. */
function reportWith(overrides = {}) {
  const credentials = overrides.credentials || unconfigured();
  return {
    ready: true,
    node: { version: '24.14.0', level: 'ok', summary: 'supported' },
    pnpm: { available: true, version: '11.26.0', level: 'ok', summary: 'the version package.json pins' },
    dependenciesInstalled: true,
    checks: [],
    capabilities: buildCapabilitySummary(credentials),
    ...overrides,
    credentials,
  };
}

function withTempDir(prefix, run) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Whether a version satisfies an npm range of comparators joined by `||`. */
function satisfies(version, range) {
  const parse = (value) => [...value.split('.').map(Number), 0, 0].slice(0, 3);
  const compare = (a, b) => a.map((part, index) => part - b[index]).find((difference) => difference !== 0) ?? 0;
  return range.split('||').some((set) => set.trim().split(/\s+/).every((comparator) => {
    const [, operator = '=', target] = /^(>=|<=|>|<|=)?(\d+(?:\.\d+)*)$/.exec(comparator);
    const order = compare(parse(version), parse(target));
    return { '>=': order >= 0, '<=': order <= 0, '>': order > 0, '<': order < 0, '=': order === 0 }[operator];
  }));
}

const LOCKFILE = [
  "lockfileVersion: '9.0'",
  '',
  'importers:',
  '',
  '  .:',
  '    dependencies:',
  "      '@scope/lib':",
  '        specifier: ^1.0.0',
  '        version: 1.0.0',
  '    devDependencies:',
  '      tool:',
  '        specifier: 2.0.0',
  '        version: 2.0.0',
  '',
  'packages:',
  '',
  "  '@scope/lib@1.0.0':",
  '    resolution: {integrity: sha512-fixture}',
  '',
].join('\n');

test('doctor distinguishes supported, usable EOL, and unsupported Node versions', () => {
  assert.equal(classifyNodeVersion('24.14.0').level, 'ok');
  assert.equal(classifyNodeVersion('26.1.0').level, 'ok');
  assert.equal(classifyNodeVersion('25.6.1').level, 'warn');
  assert.match(classifyNodeVersion('25.6.1').summary, /usable but EOL/);
  assert.equal(classifyNodeVersion('22.0.0').level, 'error');
  // A FUTURE Node is a warning, never an install-bricking refusal: the
  // no-terminal user it would stop cannot act on "install Node 24".
  assert.equal(classifyNodeVersion('27.0.0').level, 'warn');
  assert.match(classifyNodeVersion('27.0.0').summary, /newer than this release has verified/);
});

test('.node-version names the Node release the gates are calibrated on', () => {
  const pinned = readRoot('.node-version').trim();
  const { engines } = JSON.parse(readRoot('package.json'));
  assert.equal(satisfies('24.13.9', engines.node), false);
  assert.equal(satisfies('25.1.0', engines.node), false);
  assert.ok(satisfies(pinned, engines.node), `${pinned} satisfies ${engines.node}`);
  assert.equal(classifyNodeVersion(pinned).level, 'ok');
  // The jobs that name one Node release run this one.
  const ci = readRoot('.github/workflows/ci.yml');
  const named = [...ci.matchAll(/node-version: (\d[\w.]*)$/gm)].map((match) => match[1]);
  assert.ok(named.length > 0);
  assert.deepEqual([...new Set(named)], [pinned]);
  assert.match(ci, new RegExp(`node: \\[${pinned.replaceAll('.', '\\.')},`));
});

test('doctor compares pnpm with the version packageManager pins', () => {
  assert.deepEqual(checkPnpmVersion('11.26.0', 'pnpm@11.26.0'), {
    level: 'ok',
    summary: 'the version package.json pins',
  });
  assert.equal(checkPnpmVersion('11.26.0', 'pnpm@11.26.0+sha512.0123abcd').level, 'ok');
  const other = checkPnpmVersion('11.20.1', 'pnpm@11.26.0');
  assert.equal(other.level, 'warn');
  const output = formatSetupReport(reportWith({ pnpm: { available: true, version: '11.20.1', ...other } }));
  assert.match(
    output,
    /\n\[WARN\] pnpm 11\.20\.1: package\.json pins pnpm 11\.26\.0\n {7}Run npm install --global pnpm@11\.26\.0\.\n/,
  );
});

test('doctor rejects an empty node_modules and requires every direct package', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gev-doctor-deps-'));
  try {
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      dependencies: { vite: '1.0.0' },
      devDependencies: { '@scope/tool': '1.0.0' },
    }));
    mkdirSync(path.join(root, 'node_modules'));
    assert.equal(hasRequiredDependencies(root), false);

    for (const packagePath of ['vite', '@scope/tool']) {
      const directory = path.join(root, 'node_modules', ...packagePath.split('/'));
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, 'package.json'), '{}');
    }
    assert.equal(hasRequiredDependencies(root), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('doctor notices a lockfile out of step with package.json or node_modules', () => {
  withTempDir('gev-doctor-lockfile-', (root) => {
    const manifest = { dependencies: { '@scope/lib': '^1.0.0' }, devDependencies: { tool: '2.0.0' } };
    writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
    assert.equal(checkLockfile(root).level, 'error');

    writeFileSync(path.join(root, 'pnpm-lock.yaml'), LOCKFILE);
    assert.deepEqual(lockfileSpecifiers(LOCKFILE), new Map([
      ['dependencies @scope/lib', '^1.0.0'],
      ['devDependencies tool', '2.0.0'],
    ]));
    assert.match(checkLockfile(root).summary, /holds no pnpm install/);

    // pnpm's copy of what it installed may differ in quoting and line endings.
    mkdirSync(path.join(root, 'node_modules', '.pnpm'), { recursive: true });
    writeFileSync(
      path.join(root, 'node_modules', '.pnpm', 'lock.yaml'),
      LOCKFILE.replaceAll("'", '"').replaceAll('\n', '\r\n'),
    );
    assert.deepEqual(checkLockfile(root), { level: 'ok', summary: 'node_modules matches pnpm-lock.yaml' });

    writeFileSync(path.join(root, 'pnpm-lock.yaml'), LOCKFILE.replace('version: 2.0.0', 'version: 2.0.1'));
    assert.deepEqual(checkLockfile(root), {
      level: 'warn',
      summary: 'pnpm-lock.yaml changed since the last install',
      hint: 'Run pnpm install.',
    });

    writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      ...manifest,
      dependencies: { '@scope/lib': '^1.1.0', added: '1.0.0' },
    }));
    const drift = checkLockfile(root);
    assert.equal(drift.level, 'warn');
    assert.equal(drift.summary, 'package.json and pnpm-lock.yaml disagree about @scope/lib, added');
    assert.match(drift.hint, /commit the updated pnpm-lock\.yaml/);
  });
});

test('the committed lockfile records what package.json declares', () => {
  const manifest = JSON.parse(readRoot('package.json'));
  const declared = new Map(['dependencies', 'devDependencies', 'optionalDependencies'].flatMap((group) => (
    Object.entries(manifest[group] || {}).map(([name, specifier]) => [`${group} ${name}`, specifier])
  )));
  assert.ok(declared.size >= 10);
  assert.deepEqual(lockfileSpecifiers(readRoot('pnpm-lock.yaml')), declared);
});

test('doctor loads ws the way the AISStream relay does', () => {
  withTempDir('gev-doctor-ws-', (root) => {
    const missing = checkWs(root);
    assert.equal(missing.level, 'warn');
    assert.match(missing.summary, /live vessel feed stays off/);
    assert.equal(missing.hint, 'Run pnpm install.');

    const ws = path.join(root, 'node_modules', 'ws');
    mkdirSync(ws, { recursive: true });
    writeFileSync(path.join(ws, 'package.json'), JSON.stringify({
      name: 'ws',
      version: '8.0.0-fixture',
      main: 'index.js',
    }));
    writeFileSync(path.join(ws, 'index.js'), "throw new Error('broken build');\n");
    const broken = checkWs(root);
    assert.equal(broken.level, 'warn');
    assert.match(broken.summary, /^8\.0\.0-fixture does not load \(broken build\)/);

    writeFileSync(path.join(ws, 'index.js'), 'module.exports = function WebSocket() {};\n');
    assert.deepEqual(checkWs(root), {
      level: 'ok',
      summary: '8.0.0-fixture loads for the AISStream vessel relay',
    });
  });
});

test('doctor checks that the port pnpm run dev will use is free', async () => {
  assert.deepEqual(devServerAddress(() => ''), { host: 'localhost', port: 4173 });
  const settings = { HOST: '0.0.0.0', PORT: '5173' };
  assert.deepEqual(devServerAddress((name) => settings[name] ?? ''), { host: '0.0.0.0', port: 5173 });

  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const { port } = blocker.address();
  try {
    const taken = await checkPort({ host: '127.0.0.1', port });
    assert.equal(taken.level, 'warn');
    assert.match(taken.summary, /^in use on 127\.0\.0\.1/);
    assert.match(taken.hint, /set PORT to a free port/);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
  assert.deepEqual(await checkPort({ host: '127.0.0.1', port }), { level: 'ok', summary: 'free on 127.0.0.1' });
  // 192.0.2.1 is reserved for documentation, so no machine owns it.
  assert.match((await checkPort({ host: '192.0.2.1', port })).summary, /not an address of this machine/);
  assert.match((await checkPort({ host: '127.0.0.1', port: 70000 })).summary, /not a valid port/);
});

test('doctor checks that Lefthook installed its pre-commit hook', () => {
  withTempDir('gev-doctor-hook-', (root) => {
    const calls = [];
    const spawn = (command, args, options) => {
      calls.push([command, ...args, options.cwd]);
      return { status: 0, stdout: '.git/hooks\n' };
    };
    const hooks = path.join(root, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    assert.deepEqual(checkGitHook({ rootDir: root, environment: {}, spawn }), {
      level: 'warn',
      summary: "Lefthook's pre-commit hook is not installed",
      hint: 'Run pnpm exec lefthook install, so commits get the Biome checks.',
    });
    // Git names the hooks directory, which core.hooksPath can move.
    assert.deepEqual(calls[0], ['git', 'rev-parse', '--git-path', 'hooks', root]);

    writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 0\n');
    assert.equal(
      checkGitHook({ rootDir: root, environment: {}, spawn }).summary,
      "the pre-commit hook is not Lefthook's",
    );
    writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\n[ "$LEFTHOOK_VERBOSE" = "1" ] && set -x\n');
    assert.equal(checkGitHook({ rootDir: root, environment: {}, spawn }).level, 'ok');

    assert.equal(checkGitHook({ rootDir: root, environment: { CI: 'true' }, spawn }).summary, 'not checked in CI');
    assert.equal(checkGitHook({ rootDir: root, environment: { CI: 'false' }, spawn }).level, 'ok');
    assert.equal(
      checkGitHook({ rootDir: root, environment: {}, spawn: () => ({ status: 128, stdout: '' }) }).summary,
      'no Git checkout found',
    );
  });
});

test('doctor finds the Chrome the QA scripts launch', async () => {
  const puppeteer = (executable) => async () => ({ default: { executablePath: async () => executable } });
  const exists = (file) => file === '/cache/chrome';

  assert.deepEqual(
    await checkQaBrowser({ environment: {}, loadPuppeteer: puppeteer('/cache/chrome'), exists }),
    { level: 'ok', summary: 'Chrome for Testing is installed' },
  );
  const absent = await checkQaBrowser({ environment: {}, loadPuppeteer: puppeteer('/cache/other'), exists });
  assert.equal(absent.level, 'info');
  assert.match(absent.summary, /only pnpm run test:track and the QA scripts need it/);
  assert.equal(absent.hint, 'Run pnpm exec puppeteer browsers install chrome.');
  const withoutPuppeteer = await checkQaBrowser({
    environment: {},
    loadPuppeteer: async () => {
      throw new Error('Cannot find package');
    },
    exists,
  });
  assert.equal(withoutPuppeteer.level, 'info');

  const environment = (file) => ({ PUPPETEER_EXECUTABLE_PATH: file });
  assert.equal(
    (await checkQaBrowser({ environment: environment('/cache/chrome'), loadPuppeteer: puppeteer(''), exists })).level,
    'ok',
  );
  const wrong = await checkQaBrowser({
    environment: environment('/nowhere/chrome'),
    loadPuppeteer: puppeteer('/cache/chrome'),
    exists,
  });
  assert.equal(wrong.level, 'warn');
  assert.equal(wrong.summary, 'PUPPETEER_EXECUTABLE_PATH names a missing file');
});

test('placeholder values are never counted as configured credentials', () => {
  assert.equal(isConfiguredValue(''), false);
  assert.equal(isConfiguredValue('your_google_maps_api_key_here'), false);
  assert.equal(isConfiguredValue('replace_me'), false);
  assert.equal(isConfiguredValue('configured-value'), true);
});

test('doctor selects a Windows-safe pnpm process without changing Unix behavior', () => {
  assert.deepEqual(pnpmProcessSpec('win32'), { command: 'pnpm', shell: true });
  assert.deepEqual(pnpmProcessSpec('darwin'), { command: 'pnpm', shell: false });
  assert.deepEqual(pnpmProcessSpec('linux'), { command: 'pnpm', shell: false });
});

test('doctor recognizes every OpenSky OAuth keychain alias used by dev-fresh', () => {
  assert.deepEqual(
    credential('OPENSKY_CLIENT_ID').keychain,
    [
      ['opensky-network', 'client_id'],
      ['opensky-network', 'client-id'],
      ['opensky-network', 'client'],
      ['opensky-network', 'api-key'],
      ['opensky', 'client_id'],
      ['opensky', 'client-id'],
      ['opensky', 'client'],
      ['opensky', 'api-key'],
    ],
  );
  assert.deepEqual(
    credential('OPENSKY_CLIENT_SECRET').keychain,
    [
      ['opensky-network', 'client_secret'],
      ['opensky-network', 'client-secret'],
      ['opensky-network', 'secret'],
      ['opensky', 'client_secret'],
      ['opensky', 'client-secret'],
      ['opensky', 'secret'],
    ],
  );
});

test('doctor checks the OpenSky mode, the client pair and retired Basic auth', () => {
  const pair = (id, secret) => ({
    OPENSKY_CLIENT_ID: { configured: id },
    OPENSKY_CLIENT_SECRET: { configured: secret },
  });
  assert.equal(checkOpenSky({ credentials: pair(true, true) }).level, 'ok');
  assert.equal(checkOpenSky({ mode: 'oauth', credentials: pair(true, true) }).level, 'ok');
  const half = checkOpenSky({ credentials: pair(true, false) });
  assert.equal(half.level, 'warn');
  assert.match(half.summary, /^OPENSKY_CLIENT_SECRET is missing, so flights use anonymous access/);
  assert.match(checkOpenSky({ credentials: pair(false, true) }).summary, /^OPENSKY_CLIENT_ID is missing/);
  assert.equal(checkOpenSky({ credentials: pair(false, false) }).level, 'info');

  const basic = checkOpenSky({ mode: 'Basic', credentials: pair(true, true) });
  assert.equal(basic.level, 'warn');
  assert.match(basic.summary, /^OPENSKY_AUTH_MODE=basic relied on Basic auth/);
  assert.match(checkOpenSky({ mode: 'bogus' }).summary, /^OPENSKY_AUTH_MODE=bogus is not a mode/);
  assert.equal(checkOpenSky({ mode: 'anon', credentials: pair(true, false) }).level, 'info');

  const retired = checkOpenSky({
    credentials: pair(false, false),
    retired: ['OPENSKY_USERNAME', 'OPENSKY_PASSWORD'],
  });
  assert.equal(retired.level, 'warn');
  assert.match(retired.summary, /^OPENSKY_USERNAME and OPENSKY_PASSWORD are set/);
  assert.match(retired.hint, /OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET/);
});

test('doctor reads the OpenSky credentials file as the launcher does, before the Keychain', () => {
  withTempDir('gev-doctor-opensky-', (root) => {
    const file = path.join(root, 'credentials.json');
    assert.equal(readOpenSkyCredentialsFile(file, root).state, 'missing');
    writeFileSync(file, '{not json');
    assert.equal(readOpenSkyCredentialsFile(file, root).state, 'invalid');
    writeFileSync(file, JSON.stringify({ clientId: 'fixture-id' }));
    assert.equal(readOpenSkyCredentialsFile(file, root).state, 'incomplete');
    writeFileSync(file, JSON.stringify({ client_id: 'fixture-id', client_secret: 'fixture-secret' }));
    const parsed = readOpenSkyCredentialsFile('credentials.json', root);
    assert.equal(parsed.state, 'ok');

    // The launcher's order: environment, dotenv files, this file, the Keychain.
    assert.deepEqual(resolveCredential(credential('OPENSKY_CLIENT_ID'), {
      environment: {},
      rootDir: root,
      keychainLookup: () => true,
      credentialsFile: parsed.values,
    }), { configured: true, source: 'OpenSky credentials file' });
    assert.deepEqual(resolveCredential(credential('OPENSKY_CLIENT_ID'), {
      environment: { OPENSKY_CLIENT_ID: 'from-environment' },
      rootDir: root,
      credentialsFile: parsed.values,
    }), { configured: true, source: 'environment' });

    const missing = checkOpenSky({ credentialsFile: { path: '~/credentials.json', state: 'missing', values: {} } });
    assert.equal(missing.level, 'warn');
    assert.equal(missing.summary, 'OPENSKY_CREDENTIALS_FILE (~/credentials.json) does not exist');
    assert.match(missing.hint, /does not expand ~/);
    assert.match(
      checkOpenSky({ credentialsFile: { path: file, state: 'incomplete', values: {} } }).summary,
      /lacks clientId or clientSecret$/,
    );

    // Only dev-fresh.sh reads the file, so a report relying on it points there.
    const credentials = { ...unconfigured(), OPENSKY_CLIENT_ID: { configured: true, source: 'OpenSky credentials file' } };
    assert.match(formatSetupReport(reportWith({ credentials })), /Run \.\/scripts\/dev-fresh\.sh/);
  });
});

test('only the launcher diagnosis reads the OpenSky credentials file, and never prints it', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gev-doctor-opensky-run-'));
  try {
    writeFileSync(path.join(root, 'credentials.json'), JSON.stringify({
      clientId: 'fixture-id',
      clientSecret: 'fixture-secret',
    }));
    const environment = { OPENSKY_CREDENTIALS_FILE: 'credentials.json' };
    const options = { rootDir: root, includeKeychain: false, developerChecks: false };

    const launcher = await inspectSetup({ ...options, environment, includeCredentialsFile: true });
    assert.equal(launcher.credentials.OPENSKY_CLIENT_SECRET.source, 'OpenSky credentials file');
    assert.equal(launcher.checks.find((check) => check.id === 'opensky').level, 'ok');
    assert.doesNotMatch(JSON.stringify(launcher), /fixture-(id|secret)/);
    assert.doesNotMatch(formatSetupReport(launcher), /fixture-(id|secret)/);

    const pinokio = await inspectSetup({ ...options, environment, authoritativeEnvironment: true });
    assert.equal(pinokio.credentials.OPENSKY_CLIENT_ID.configured, false);
    const anonymous = await inspectSetup({
      ...options,
      environment: { ...environment, OPENSKY_AUTH_MODE: 'anon' },
      includeCredentialsFile: true,
    });
    assert.equal(anonymous.credentials.OPENSKY_CLIENT_ID.configured, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('doctor lists the optional TfL app key, which has no Keychain item', () => {
  assert.deepEqual(credential('TFL_APP_KEY'), { name: 'TFL_APP_KEY', label: 'TfL cameras', keychain: [] });
  const credentials = { ...unconfigured(), TFL_APP_KEY: { configured: true, source: 'dotenv files' } };
  assert.match(formatSetupReport(reportWith({ credentials })), /\n {2}\[OK\] TfL cameras \(dotenv files\)\n/);
  assert.match(formatSetupReport(reportWith()), /\n {2}\[--\] TfL cameras\n/);
});

test('Pinokio-scoped diagnosis ignores Keychain items its start path does not import', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gev-pinokio-doctor-'));
  try {
    const spec = credential('OPENAI_API_KEY');
    const keychainLookup = () => true;
    assert.deepEqual(resolveCredential(spec, {
      environment: {},
      rootDir: root,
      keychainLookup,
    }), { configured: true, source: 'macOS Keychain' });
    assert.deepEqual(resolveCredential(spec, {
      includeKeychain: false,
      environment: {},
      rootDir: root,
      keychainLookup,
    }), { configured: false, source: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Pinokio-scoped diagnosis does not count dotenv values shadowed by blank app fields', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gev-pinokio-doctor-env-'));
  try {
    const spec = credential('GOOGLE_MAPS_API_KEY');
    writeFileSync(path.join(root, '.env.local'), 'GOOGLE_MAPS_API_KEY=dotenv-only\n');
    assert.deepEqual(resolveCredential(spec, {
      environment: { GOOGLE_MAPS_API_KEY: '' },
      rootDir: root,
      keychainLookup: () => false,
    }), { configured: true, source: 'dotenv files' });
    assert.deepEqual(resolveCredential(spec, {
      authoritativeEnvironment: true,
      environment: { GOOGLE_MAPS_API_KEY: '' },
      rootDir: root,
      keychainLookup: () => false,
    }), { configured: false, source: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('doctor reads the dotenv ladder without requiring Vite to be installed', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gev-doctor-'));
  try {
    writeFileSync(path.join(root, '.env'), 'GEV_TEST_KEY=base\n');
    writeFileSync(path.join(root, '.env.local'), 'GEV_TEST_KEY=local\n');
    writeFileSync(path.join(root, '.env.development.local'), 'GEV_TEST_KEY=mode-local\n');
    assert.equal(readDoctorDotenvValue('GEV_TEST_KEY', root), 'mode-local');
    assert.equal(readDoctorDotenvValue('not valid', root), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('doctor describes the credential ladder without exposing values', () => {
  const credentials = {
    GOOGLE_MAPS_API_KEY: { configured: false },
    GOOGLE_MAPS_SERVER_API_KEY: { configured: false },
    CESIUM_ION_TOKEN: { configured: true, source: 'environment' },
    OPENAI_API_KEY: { configured: true, source: 'dotenv files' },
    AISSTREAM_API_KEY: { configured: false },
    FIRMS_MAP_KEY: { configured: false },
    TOMTOM_API_KEY: { configured: false },
    OPENSKY_CLIENT_ID: { configured: false },
    OPENSKY_CLIENT_SECRET: { configured: false },
    LL2_API_TOKEN: { configured: true, source: 'environment' },
    TFL_APP_KEY: { configured: false },
  };
  const capabilities = buildCapabilitySummary(credentials);
  assert.match(capabilities.map, /Google Photorealistic 3D Tiles through Cesium ion/);
  assert.match(capabilities.map, /Bing and world-terrain stacks/);
  assert.equal(capabilities.voice, 'available');
  assert.match(capabilities.missions, /token allowance/);
  assert.equal(capabilities.flights, 'OpenSky OAuth credentials not configured');

  const report = formatSetupReport({
    ready: true,
    node: { version: '25.6.1', level: 'warn', summary: 'usable but EOL' },
    pnpm: { available: true, version: '11.26.0' },
    dependenciesInstalled: true,
    credentials,
    capabilities,
  });
  assert.doesNotMatch(report, /configured-value/);
  assert.match(report, /\[OK\] pnpm 11\.26\.0\n/);
  assert.match(report, /Cesium ion \(environment\)/);
  assert.match(report, /Launch Library 2 \(environment\)/);

  const pinokioReport = formatSetupReport({
    ready: true,
    node: { version: '24.14.0', level: 'ok', summary: 'supported' },
    pnpm: { available: true, version: '11.26.0' },
    dependenciesInstalled: true,
    credentials,
    capabilities,
  }, { readyMessage: 'Ready. Return to Pinokio and choose Start.' });
  assert.match(pinokioReport, /Return to Pinokio and choose Start/);
  assert.doesNotMatch(pinokioReport, /pnpm run dev/);
});

test('doctor sends Keychain-backed reports to dev-fresh and describes OpenSky as presence only', () => {
  const credentials = {
    ...unconfigured(),
    GOOGLE_MAPS_API_KEY: { configured: true, source: 'macOS Keychain' },
    OPENSKY_CLIENT_ID: { configured: true, source: 'environment' },
    OPENSKY_CLIENT_SECRET: { configured: true, source: 'environment' },
  };
  const capabilities = buildCapabilitySummary(credentials);
  const output = formatSetupReport(reportWith({ credentials }));
  assert.match(output, /Run \.\/scripts\/dev-fresh\.sh/);
  assert.doesNotMatch(output, /Run pnpm run dev/);
  assert.match(capabilities.flights, /credentials present/);
  assert.match(capabilities.flights, /runtime mode and validity not verified/);
  assert.doesNotMatch(capabilities.flights, /polling/);
});

test('doctor never calls a dependency-missing setup ready', () => {
  const output = formatSetupReport(reportWith({ ready: false, dependenciesInstalled: false }));
  assert.match(output, /dependencies missing; run pnpm install/);
  assert.match(output, /Setup needs attention/);
  assert.doesNotMatch(output, /Ready\. Run/);
});

test('each check prints the hint on how to fix it under its line', () => {
  const output = formatSetupReport(reportWith({
    checks: [
      { id: 'port', label: 'Port 4173', level: 'warn', summary: 'in use on localhost', hint: 'Stop it.' },
      { id: 'qa-browser', label: 'QA browser', level: 'info', summary: 'not installed', hint: 'Install it.' },
      { id: 'ws', label: 'ws', level: 'ok', summary: '8.21.3 loads' },
    ],
  }));
  assert.match(
    output,
    /\n\[WARN\] Port 4173: in use on localhost\n {7}Stop it\.\n\[--\] QA browser: not installed\n {7}Install it\.\n\[OK\] ws: 8\.21\.3 loads\n/,
  );
});

test('pnpm run doctor reports every check, and the Pinokio install skips the developer ones', async () => {
  const report = await inspectSetup({ includeKeychain: false, environment: {} });
  assert.deepEqual(
    report.checks.map((check) => check.id),
    ['lockfile', 'ws', 'port', 'git-hook', 'qa-browser', 'opensky'],
  );
  const output = formatSetupReport(report);
  for (const check of report.checks) {
    assert.ok(['ok', 'warn', 'error', 'info'].includes(check.level), check.id);
    assert.ok(output.includes(`] ${check.label}: ${check.summary}`), `${check.id} is in the report`);
  }
  if (report.pnpm.available) assert.match(output, /\n\[(OK|WARN)\] pnpm \d+\.\d+\.\d+: /);

  const pinokio = await inspectSetup({
    includeKeychain: false,
    authoritativeEnvironment: true,
    developerChecks: false,
    environment: {},
  });
  assert.deepEqual(pinokio.checks.map((check) => check.id), ['lockfile', 'ws', 'opensky']);
});
