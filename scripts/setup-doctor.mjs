#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { projectRoot } from './project-root.mjs';
import { selectMapStartupRoute } from '../src/mapStartup.js';
import { CREDENTIALS, findKeychainItem } from './lib/credentials.mjs';
import {
  checkGitHook,
  checkLockfile,
  checkOpenSky,
  checkPnpmVersion,
  checkPort,
  checkQaBrowser,
  checkWs,
  devServerAddress,
  readOpenSkyCredentialsFile,
} from './lib/setup-checks.mjs';

const ROOT = projectRoot(import.meta.url);

/** Credential sources that only ./scripts/dev-fresh.sh reads. */
const LAUNCHER_SOURCES = new Set(['macOS Keychain', 'OpenSky credentials file']);

// The checks live in scripts/lib/setup-checks.mjs.
export {
  checkGitHook,
  checkLockfile,
  checkOpenSky,
  checkPnpmVersion,
  checkPort,
  checkQaBrowser,
  checkWs,
  devServerAddress,
  readOpenSkyCredentialsFile,
};
export { lockfileSpecifiers } from './lib/setup-checks.mjs';
const OPENSKY_AUTH_MODE_DEFAULT = 'oauth';
// OpenSky accepts only OAuth client credentials, so the retired basic and auto
// modes mean oauth, as they do in the proxy and the launcher.
const OPENSKY_AUTH_MODES = new Set(['oauth', 'anon']);

// The provider keys and their Keychain items live in scripts/lib/credentials.mjs.
export { CREDENTIALS };

export function isConfiguredValue(value) {
  const normalized = String(value || '').trim();
  return normalized.length > 0 && !/^(your_|replace_|example|changeme)/i.test(normalized);
}

export function classifyNodeVersion(version = process.versions.node) {
  const [major = 0, minor = 0] = String(version).split('.').map(Number);
  if (major === 24 && minor >= 14) {
    return { level: 'ok', summary: 'supported LTS and calibrated for release gates' };
  }
  if (major === 26) return { level: 'ok', summary: 'supported runtime' };
  if (major === 25) {
    return { level: 'warn', summary: 'usable but EOL; allocation benchmarks will be skipped' };
  }
  if (major < 24 || (major === 24 && minor < 14)) {
    return { level: 'error', summary: 'too old; install Node 24.14 or newer' };
  }
  // NEWER than this release has verified is a warning, never a refusal: a
  // future Node must not brick a no-terminal install with advice its user
  // cannot follow. Too-old stays an error above — old runtimes genuinely fail.
  return { level: 'warn', summary: 'newer than this release has verified; Node 24.14.x or 26.x is the tested path' };
}

/** Verify that every direct package declared by this checkout is present. */
export function hasRequiredDependencies(rootDir = ROOT) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    const packages = new Set([
      ...Object.keys(manifest.dependencies || {}),
      ...Object.keys(manifest.devDependencies || {}),
    ]);
    return packages.size > 0 && [...packages].every((name) => (
      existsSync(path.join(rootDir, 'node_modules', ...name.split('/'), 'package.json'))
    ));
  } catch {
    return false;
  }
}

/** Return the pnpm command and spawn mode required by the target platform. */
export function pnpmProcessSpec(platform = process.platform) {
  // Windows installs pnpm as pnpm.cmd or pnpm.exe; its shell resolves either.
  return { command: 'pnpm', shell: platform === 'win32' };
}

/** Read one key from Vite's dotenv file ladder without depending on Vite. */
export function readDoctorDotenvValue(
  variableName,
  rootDir = ROOT,
  mode = 'development',
) {
  const key = String(variableName || '').trim();
  if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) return '';

  const values = {};
  for (const filename of ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]) {
    const filepath = path.join(rootDir, filename);
    if (!existsSync(filepath)) continue;
    try {
      Object.assign(values, parseEnv(readFileSync(filepath, 'utf8')));
    } catch {
      // A malformed optional dotenv file must not crash the setup diagnosis.
    }
  }
  return String(values[key] ?? '');
}

/** Resolve the OpenSky auth mode using the same environment and dotenv precedence as the launcher. */
export function resolveOpenSkyAuthMode({
  authoritativeEnvironment = false,
  environment = process.env,
  rootDir = ROOT,
} = {}) {
  const environmentDefinesMode = Object.prototype.hasOwnProperty.call(environment, 'OPENSKY_AUTH_MODE');
  const environmentMode = String(environment.OPENSKY_AUTH_MODE || '').trim();
  const dotenvMode = authoritativeEnvironment && environmentDefinesMode
    ? ''
    : readDoctorDotenvValue('OPENSKY_AUTH_MODE', rootDir);
  const mode = (environmentMode || dotenvMode).trim().toLowerCase();
  return OPENSKY_AUTH_MODES.has(mode) ? mode : OPENSKY_AUTH_MODE_DEFAULT;
}

/** A setting from the environment, or else from the dotenv files. */
function readSetting(name, { environment, rootDir, authoritativeEnvironment }) {
  const value = String(environment[name] ?? '').trim();
  if (value) return value;
  if (authoritativeEnvironment && Object.hasOwn(environment, name)) return '';
  return readDoctorDotenvValue(name, rootDir).trim();
}

function hasKeychainItem(service, account) {
  return findKeychainItem(service, account);
}

export function resolveCredential(spec, {
  includeKeychain = true,
  authoritativeEnvironment = false,
  environment = process.env,
  rootDir = ROOT,
  keychainLookup = hasKeychainItem,
  credentialsFile = {},
} = {}) {
  const environmentDefinesKey = Object.prototype.hasOwnProperty.call(environment, spec.name);
  if (isConfiguredValue(environment[spec.name])) return { configured: true, source: 'environment' };
  if (authoritativeEnvironment && environmentDefinesKey) return { configured: false, source: null };
  if (isConfiguredValue(readDoctorDotenvValue(spec.name, rootDir))) return { configured: true, source: 'dotenv files' };
  // dev-fresh.sh reads OPENSKY_CREDENTIALS_FILE after the dotenv files and
  // before the Keychain.
  if (isConfiguredValue(credentialsFile[spec.name])) return { configured: true, source: 'OpenSky credentials file' };
  if (includeKeychain && spec.keychain.some(([service, account]) => keychainLookup(service, account))) {
    return { configured: true, source: 'macOS Keychain' };
  }
  return { configured: false, source: null };
}

export function buildCapabilitySummary(
  credentials,
  { openSkyAuthMode = OPENSKY_AUTH_MODE_DEFAULT } = {},
) {
  const configured = (name) => credentials[name]?.configured === true;
  const hasOAuthCredentials = configured('OPENSKY_CLIENT_ID') && configured('OPENSKY_CLIENT_SECRET');
  const requestedOpenSkyMode = String(openSkyAuthMode || '').trim().toLowerCase();
  const openSkyMode = OPENSKY_AUTH_MODES.has(requestedOpenSkyMode)
    ? requestedOpenSkyMode
    : OPENSKY_AUTH_MODE_DEFAULT;
  const flights = openSkyMode !== 'anon' && hasOAuthCredentials
    ? 'OpenSky OAuth credentials present (runtime mode and validity not verified)'
    : 'OpenSky keyless anonymous access (rate-limited)';
  const route = selectMapStartupRoute({
    googleApiKey: configured('GOOGLE_MAPS_API_KEY') ? 'configured' : '',
    cesiumToken: configured('CESIUM_ION_TOKEN') ? 'configured' : '',
  });
  return {
    map: route === 'google-direct'
      ? 'Google Photorealistic 3D Tiles (direct)'
      : route === 'google-ion'
        ? 'Google Photorealistic 3D Tiles through Cesium ion; Bing and world-terrain stacks available'
        : 'Esri World Imagery (keyless satellite basemap) with keyless terrain',
    flights,
    voice: configured('OPENAI_API_KEY')
      ? 'available'
      : 'off until an OpenAI key is added, or a Codex ChatGPT sign-in is selected in Provider Settings (experimental)',
    vessels: configured('AISSTREAM_API_KEY') ? 'live AISStream feed' : 'off until an AISStream key is added',
    fires: configured('FIRMS_MAP_KEY') ? 'live NASA FIRMS feed' : 'off until a FIRMS key is added',
    traffic: configured('TOMTOM_API_KEY') ? 'live TomTom flow' : 'built-in traffic simulation',
    missions: configured('LL2_API_TOKEN')
      ? 'Launch Library 2 token allowance'
      : 'Launch Library 2 public access',
  };
}

/**
 * Diagnose this checkout. `includeKeychain` and `includeCredentialsFile` add
 * the sources only ./scripts/dev-fresh.sh reads; `developerChecks` adds the
 * port, Git hook and QA browser checks, which a Pinokio install has no use for.
 */
export async function inspectSetup({
  includeKeychain = true,
  includeCredentialsFile = includeKeychain,
  authoritativeEnvironment = false,
  developerChecks = true,
  environment = process.env,
  rootDir = ROOT,
} = {}) {
  const setting = (name) => readSetting(name, { environment, rootDir, authoritativeEnvironment });
  const node = classifyNodeVersion();
  const pnpmSpec = pnpmProcessSpec();
  const pnpmResult = spawnSync(pnpmSpec.command, ['--version'], {
    cwd: rootDir,
    encoding: 'utf8',
    shell: pnpmSpec.shell,
  });
  let packageManager = '';
  try {
    ({ packageManager = '' } = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8')));
  } catch {
    // hasRequiredDependencies reports an unreadable package.json.
  }
  const pnpmVersion = String(pnpmResult.stdout || '').trim();
  const pnpm = pnpmResult.status === 0
    ? { available: true, version: pnpmVersion, ...checkPnpmVersion(pnpmVersion, packageManager) }
    : { available: false, version: null };

  // The launcher reads the credentials file only in oauth mode.
  const openSkyMode = setting('OPENSKY_AUTH_MODE');
  const credentialsFilePath = includeCredentialsFile && openSkyMode.toLowerCase() !== 'anon'
    ? setting('OPENSKY_CREDENTIALS_FILE')
    : '';
  const credentialsFile = credentialsFilePath
    ? { path: credentialsFilePath, ...readOpenSkyCredentialsFile(credentialsFilePath, rootDir) }
    : null;
  const credentials = Object.fromEntries(CREDENTIALS.map((spec) => [
    spec.name,
    resolveCredential(spec, {
      includeKeychain,
      authoritativeEnvironment,
      environment,
      rootDir,
      credentialsFile: credentialsFile?.values,
    }),
  ]));
  const dependenciesInstalled = hasRequiredDependencies(rootDir);

  const checks = [
    { id: 'lockfile', label: 'Lockfile', ...checkLockfile(rootDir) },
    { id: 'ws', label: 'ws', ...checkWs(rootDir) },
  ];
  if (developerChecks) {
    const address = devServerAddress(setting);
    checks.push(
      { id: 'port', label: `Port ${address.port}`, ...(await checkPort(address)) },
      { id: 'git-hook', label: 'Git hook', ...checkGitHook({ rootDir, environment }) },
      { id: 'qa-browser', label: 'QA browser', ...(await checkQaBrowser({ environment })) },
    );
  }
  checks.push({
    id: 'opensky',
    label: 'OpenSky',
    ...checkOpenSky({
      mode: openSkyMode,
      credentials,
      credentialsFile,
      retired: ['OPENSKY_USERNAME', 'OPENSKY_PASSWORD'].filter((name) => isConfiguredValue(setting(name))),
    }),
  });

  return {
    ready: node.level !== 'error' &&
      pnpm.available &&
      dependenciesInstalled &&
      checks.every((check) => check.level !== 'error'),
    node: { version: process.versions.node, ...node },
    pnpm,
    dependenciesInstalled,
    checks,
    credentials,
    capabilities: buildCapabilitySummary(credentials, {
      openSkyAuthMode: resolveOpenSkyAuthMode({ authoritativeEnvironment, environment, rootDir }),
    }),
  };
}

function symbol(level) {
  if (level === 'ok') return 'OK';
  if (level === 'warn') return 'WARN';
  if (level === 'info') return '--';
  return 'ERROR';
}

/** A check's report line, and the hint on how to fix it on the next. */
function checkLines(label, { level = 'ok', summary, hint } = {}) {
  const lines = [`[${symbol(level)}] ${summary ? `${label}: ${summary}` : label}`];
  if (hint) lines.push(`       ${hint}`);
  return lines;
}

export function formatSetupReport(report, { readyMessage } = {}) {
  const needsLauncher = Object.values(report.credentials || {})
    .some((credential) => LAUNCHER_SOURCES.has(credential?.source));
  const resolvedReadyMessage = readyMessage || (needsLauncher
    ? 'Ready. Run ./scripts/dev-fresh.sh, then open http://localhost:4173.'
    : 'Ready. Run pnpm run dev, then open http://localhost:4173.');
  const lines = [
    "God's Eye View setup doctor",
    '',
    `[${symbol(report.node.level)}] Node ${report.node.version}: ${report.node.summary}`,
    ...(report.pnpm.available
      ? checkLines(`pnpm ${report.pnpm.version}`, report.pnpm)
      : ['[ERROR] pnpm was not found; install pnpm 11']),
    report.dependenciesInstalled ? '[OK] dependencies installed' : '[WARN] dependencies missing; run pnpm install',
    ...(report.checks || []).flatMap((check) => checkLines(check.label, check)),
    '',
    `Map:     ${report.capabilities.map}`,
    `Flights: ${report.capabilities.flights}`,
    `Voice:   ${report.capabilities.voice}`,
    `Vessels: ${report.capabilities.vessels}`,
    `Fires:   ${report.capabilities.fires}`,
    `Traffic: ${report.capabilities.traffic}`,
    `Missions: ${report.capabilities.missions}`,
    '',
    'Configured providers:',
    ...CREDENTIALS.map((spec) => {
      const state = report.credentials[spec.name];
      return state?.configured
        ? `  [OK] ${spec.label} (${state.source})`
        : `  [--] ${spec.label}`;
    }),
    '',
    report.ready
      ? resolvedReadyMessage
      : 'Setup needs attention before the app can start.',
  ];
  return lines.join('\n');
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const report = await inspectSetup();
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else console.log(formatSetupReport(report));
  if (!report.ready) process.exitCode = 1;
}
