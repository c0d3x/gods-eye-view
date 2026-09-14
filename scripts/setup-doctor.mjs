#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { selectMapStartupRoute } from '../src/mapStartup.js';
import { CREDENTIALS, findKeychainItem } from './lib/credentials.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The port vite.config.js listens on when PORT is unset. */
const DEFAULT_PORT = 4173;

/** Credential sources that only ./scripts/dev-fresh.sh reads. */
const LAUNCHER_SOURCES = new Set([
  'macOS Keychain',
  'OpenSky credentials file',
]);

// The provider keys and their Keychain items live in scripts/lib/credentials.mjs.
export { CREDENTIALS };

export function isConfiguredValue(value) {
  const normalized = String(value || '').trim();
  return (
    normalized.length > 0 &&
    !/^(your_|replace_|example|changeme)/i.test(normalized)
  );
}

export function classifyNodeVersion(version = process.versions.node) {
  const [major = 0, minor = 0] = String(version).split('.').map(Number);
  if (major === 24 && minor >= 14) {
    return {
      level: 'ok',
      summary: 'supported LTS and calibrated for release gates',
    };
  }
  if (major === 26) return { level: 'ok', summary: 'supported runtime' };
  if (major === 25) {
    return {
      level: 'warn',
      summary: 'usable but EOL; allocation benchmarks will be skipped',
    };
  }
  if (major < 24 || (major === 24 && minor < 14)) {
    return { level: 'error', summary: 'too old; install Node 24.14 or newer' };
  }
  // NEWER than this release has verified is a warning, never a refusal: a
  // future Node must not brick a no-terminal install with advice its user
  // cannot follow. Too-old stays an error above — old runtimes genuinely fail.
  return {
    level: 'warn',
    summary:
      'newer than this release has verified; Node 24.14.x or 26.x is the tested path',
  };
}

/**
 * Compare the pnpm that runs here with the version package.json's
 * packageManager pins. Another version still installs, but it may resolve or
 * write the lockfile differently from CI.
 */
export function checkPnpmVersion(version, packageManager) {
  const pinned = /^pnpm@(\d+\.\d+\.\d+)/.exec(
    String(packageManager || ''),
  )?.[1];
  if (!pinned) return { level: 'ok', summary: 'package.json pins no version' };
  if (version === pinned)
    return { level: 'ok', summary: 'the version package.json pins' };
  return {
    level: 'warn',
    summary: `package.json pins pnpm ${pinned}`,
    hint: `Run npm install --global pnpm@${pinned}.`,
  };
}

/** Verify that every direct package declared by this checkout is present. */
export function hasRequiredDependencies(rootDir = ROOT) {
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(rootDir, 'package.json'), 'utf8'),
    );
    const packages = new Set([
      ...Object.keys(manifest.dependencies || {}),
      ...Object.keys(manifest.devDependencies || {}),
    ]);
    return (
      packages.size > 0 &&
      [...packages].every((name) =>
        existsSync(
          path.join(
            rootDir,
            'node_modules',
            ...name.split('/'),
            'package.json',
          ),
        ),
      )
    );
  } catch {
    return false;
  }
}

const unquote = (value) => value.trim().replace(/^(['"])(.*)\1$/, '$2');

/**
 * The direct dependencies a pnpm lockfile records for the root package, as
 * `<group> <name>` → specifier, such as `devDependencies vite` → `^8.3.0`.
 */
export function lockfileSpecifiers(text) {
  const specifiers = new Map();
  let inRoot = false;
  let group = null;
  let name = null;
  for (const line of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\S/.test(line)) {
      inRoot = false;
    } else if (/^ {2}\S/.test(line)) {
      inRoot = /^ {2}\.:\s*$/.test(line);
      group = null;
    } else if (inRoot) {
      const heading = /^ {4}(\w+):\s*$/.exec(line);
      const entry = /^ {6}(\S.*):\s*$/.exec(line);
      const specifier = /^ {8}specifier:(.+)$/.exec(line);
      if (heading) {
        group = heading[1];
        name = null;
      } else if (entry) {
        name = unquote(entry[1]);
      } else if (specifier && group && name) {
        specifiers.set(`${group} ${name}`, unquote(specifier[1]));
      }
    }
  }
  return specifiers;
}

function manifestSpecifiers(manifest) {
  const specifiers = new Map();
  for (const group of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
  ]) {
    for (const [name, specifier] of Object.entries(manifest[group] || {})) {
      specifiers.set(`${group} ${name}`, String(specifier));
    }
  }
  return specifiers;
}

/** A lockfile's lines, ignoring line endings and quoting. */
function lockfileLines(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/['"]/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

/**
 * Check pnpm-lock.yaml against package.json, and against the copy pnpm keeps
 * of the lockfile it last installed (node_modules/.pnpm/lock.yaml).
 */
export function checkLockfile(rootDir = ROOT) {
  const read = (...parts) => {
    try {
      return readFileSync(path.join(rootDir, ...parts), 'utf8');
    } catch {
      return null;
    }
  };
  const lockfile = read('pnpm-lock.yaml');
  if (lockfile === null) {
    return {
      level: 'error',
      summary: 'pnpm-lock.yaml is missing',
      hint: 'Restore it with git checkout -- pnpm-lock.yaml, then run pnpm install.',
    };
  }
  let manifest = null;
  try {
    manifest = JSON.parse(read('package.json'));
  } catch {
    // The dependency check already reports an unreadable package.json.
  }
  if (manifest) {
    const declared = manifestSpecifiers(manifest);
    const locked = lockfileSpecifiers(lockfile);
    const drift = [
      ...new Set(
        [...declared.keys(), ...locked.keys()]
          .filter((key) => declared.get(key) !== locked.get(key))
          .map((key) => key.slice(key.indexOf(' ') + 1)),
      ),
    ];
    if (drift.length > 0) {
      const names =
        drift.length > 3
          ? `${drift.slice(0, 3).join(', ')} and ${drift.length - 3} more`
          : drift.join(', ');
      return {
        level: 'warn',
        summary: `package.json and pnpm-lock.yaml disagree about ${names}`,
        hint: 'Run pnpm install, and commit the updated pnpm-lock.yaml with package.json.',
      };
    }
  }
  const installed = read('node_modules', '.pnpm', 'lock.yaml');
  if (installed === null) {
    return {
      level: 'warn',
      summary: 'node_modules holds no pnpm install',
      hint: 'Run pnpm install.',
    };
  }
  if (
    lockfileLines(installed).join('\n') !== lockfileLines(lockfile).join('\n')
  ) {
    return {
      level: 'warn',
      summary: 'pnpm-lock.yaml changed since the last install',
      hint: 'Run pnpm install.',
    };
  }
  return { level: 'ok', summary: 'node_modules matches pnpm-lock.yaml' };
}

/** Load `ws` the way vite.config.js does for the AISStream vessel relay. */
export function checkWs(rootDir = ROOT) {
  const require = createRequire(path.join(rootDir, 'vite.config.js'));
  let version;
  try {
    ({ version } = require('ws/package.json'));
  } catch {
    return {
      level: 'warn',
      summary: 'not installed, so the live vessel feed stays off',
      hint: 'Run pnpm install.',
    };
  }
  try {
    require('ws');
  } catch (error) {
    const reason = String(error?.message || error).split('\n')[0];
    return {
      level: 'warn',
      summary: `${version} does not load (${reason}), so the live vessel feed stays off`,
      hint: 'Run pnpm install --force.',
    };
  }
  return {
    level: 'ok',
    summary: `${version} loads for the AISStream vessel relay`,
  };
}

/** The address `pnpm run dev` listens on, resolved as vite.config.js does. */
export function devServerAddress(setting) {
  return {
    host: setting('HOST') || 'localhost',
    port: Number.parseInt(setting('PORT'), 10) || DEFAULT_PORT,
  };
}

/** Listen where the dev server will, and report what would stop it. */
export function checkPort({ host, port }) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        resolve({
          level: 'warn',
          summary: `in use on ${host}, so the dev server would move to another port`,
          hint: 'Stop the program using it, or set PORT to a free port. ./scripts/dev-fresh.sh stops whatever listens there.',
        });
      } else if (error.code === 'EACCES') {
        resolve({
          level: 'warn',
          summary: `not allowed on ${host}`,
          hint: 'Set PORT to a port above 1023.',
        });
      } else if (
        ['EADDRNOTAVAIL', 'ENOTFOUND', 'EAI_AGAIN'].includes(error.code)
      ) {
        resolve({
          level: 'warn',
          summary: `${host} is not an address of this machine`,
          hint: "Set HOST to localhost, or to one of this machine's addresses.",
        });
      } else {
        resolve({
          level: 'warn',
          summary: `could not be checked on ${host} (${error.code || error.message})`,
        });
      }
    });
    try {
      server.listen({ host, port }, () => {
        server.close(() =>
          resolve({ level: 'ok', summary: `free on ${host}` }),
        );
      });
    } catch {
      resolve({
        level: 'warn',
        summary: 'is not a valid port',
        hint: 'Set PORT to a number from 1 to 65535.',
      });
    }
  });
}

/**
 * Check that Lefthook installed its pre-commit hook where Git looks for hooks
 * (core.hooksPath, or .git/hooks). Lefthook skips installing it when CI is set.
 */
export function checkGitHook({
  rootDir = ROOT,
  environment = process.env,
  spawn = spawnSync,
} = {}) {
  const ci = String(environment.CI || '').toLowerCase();
  if (ci && ci !== 'false' && ci !== '0')
    return { level: 'info', summary: 'not checked in CI' };
  const result = spawn('git', ['rev-parse', '--git-path', 'hooks'], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  if (result.status !== 0)
    return { level: 'info', summary: 'no Git checkout found' };
  let hook = '';
  try {
    hook = readFileSync(
      path.join(
        path.resolve(rootDir, String(result.stdout).trim()),
        'pre-commit',
      ),
      'utf8',
    );
  } catch {
    // No pre-commit hook.
  }
  if (/lefthook/i.test(hook))
    return { level: 'ok', summary: "Lefthook's pre-commit hook is installed" };
  return {
    level: 'warn',
    summary: hook
      ? "the pre-commit hook is not Lefthook's"
      : "Lefthook's pre-commit hook is not installed",
    hint: 'Run pnpm exec lefthook install, so commits get the Biome checks.',
  };
}

/**
 * Find the Chrome the QA scripts launch: PUPPETEER_EXECUTABLE_PATH, or else
 * Puppeteer's Chrome for Testing. Only they and `pnpm run test:track` need it.
 */
export async function checkQaBrowser({
  environment = process.env,
  loadPuppeteer = () => import('puppeteer'),
  exists = existsSync,
} = {}) {
  const configured = String(environment.PUPPETEER_EXECUTABLE_PATH || '').trim();
  if (configured) {
    return exists(configured)
      ? {
          level: 'ok',
          summary: 'PUPPETEER_EXECUTABLE_PATH names an installed browser',
        }
      : {
          level: 'warn',
          summary: 'PUPPETEER_EXECUTABLE_PATH names a missing file',
          hint: 'Point it at an installed Chrome, or unset it to use Chrome for Testing.',
        };
  }
  let executable = '';
  try {
    executable = await (await loadPuppeteer()).default.executablePath();
  } catch {
    // Puppeteer is not installed; the dependency check reports that.
  }
  if (executable && exists(executable))
    return { level: 'ok', summary: 'Chrome for Testing is installed' };
  return {
    level: 'info',
    summary:
      'Chrome for Testing is not installed; only pnpm run test:track and the QA scripts need it',
    hint: 'Run pnpm run qa:setup.',
  };
}

/**
 * Read the credentials JSON OpenSky issues for an API client the way
 * ./scripts/dev-fresh.sh does: clientId/clientSecret or client_id/client_secret.
 */
export function readOpenSkyCredentialsFile(filePath, rootDir = ROOT) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path.resolve(rootDir, filePath), 'utf8'));
  } catch (error) {
    return {
      state: error?.code === 'ENOENT' ? 'missing' : 'invalid',
      values: {},
    };
  }
  const values = {
    OPENSKY_CLIENT_ID: String(raw?.clientId ?? raw?.client_id ?? '').trim(),
    OPENSKY_CLIENT_SECRET: String(
      raw?.clientSecret ?? raw?.client_secret ?? '',
    ).trim(),
  };
  return {
    state:
      values.OPENSKY_CLIENT_ID && values.OPENSKY_CLIENT_SECRET
        ? 'ok'
        : 'incomplete',
    values,
  };
}

/**
 * Check the OpenSky settings the launcher and the proxy act on: the auth mode,
 * both halves of the OAuth client, the credentials file, and the Basic-auth
 * variables OpenSky no longer accepts.
 */
export function checkOpenSky({
  mode = '',
  credentials = {},
  credentialsFile = null,
  retired = [],
} = {}) {
  const requested = String(mode).trim().toLowerCase();
  if (requested && requested !== 'oauth' && requested !== 'anon') {
    return {
      level: 'warn',
      summary:
        requested === 'basic' || requested === 'auto'
          ? `OPENSKY_AUTH_MODE=${requested} relied on Basic auth, which OpenSky no longer accepts, so it means oauth`
          : `OPENSKY_AUTH_MODE=${requested} is not a mode, so it means oauth`,
      hint: 'Set OPENSKY_AUTH_MODE to oauth, or to anon for anonymous access.',
    };
  }
  if (requested === 'anon') {
    return {
      level: 'info',
      summary:
        'anonymous access (OPENSKY_AUTH_MODE=anon); client credentials are not used',
    };
  }
  if (credentialsFile && credentialsFile.state !== 'ok') {
    const file = `OPENSKY_CREDENTIALS_FILE (${credentialsFile.path})`;
    if (credentialsFile.state === 'missing') {
      return {
        level: 'warn',
        summary: `${file} does not exist`,
        hint: credentialsFile.path.startsWith('~')
          ? 'Write the full path: the launcher does not expand ~ in a value from a dotenv file.'
          : 'Point it at the credentials.json OpenSky issued for your API client.',
      };
    }
    return {
      level: 'warn',
      summary:
        credentialsFile.state === 'invalid'
          ? `${file} is not valid JSON`
          : `${file} lacks clientId or clientSecret`,
      hint: "Download your API client's credentials.json from your OpenSky account again.",
    };
  }
  const id = credentials.OPENSKY_CLIENT_ID?.configured === true;
  const secret = credentials.OPENSKY_CLIENT_SECRET?.configured === true;
  if (id && secret) {
    return {
      level: 'ok',
      summary:
        'OAuth client ID and secret found; only OpenSky can tell whether they are valid',
    };
  }
  if (id || secret) {
    return {
      level: 'warn',
      summary: `${id ? 'OPENSKY_CLIENT_SECRET' : 'OPENSKY_CLIENT_ID'} is missing, so flights use anonymous access`,
      hint: 'Set both OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET, or neither.',
    };
  }
  if (retired.length > 0) {
    return {
      level: 'warn',
      summary: `${retired.join(' and ')} ${retired.length === 1 ? 'is' : 'are'} set, but OpenSky no longer accepts a username and password`,
      hint: 'Create an API client in your OpenSky account, and set OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET (docs/opensky-auth.md).',
    };
  }
  return {
    level: 'info',
    summary:
      'anonymous access; an OAuth API client gets more requests (docs/opensky-auth.md)',
  };
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
  for (const filename of [
    '.env',
    '.env.local',
    `.env.${mode}`,
    `.env.${mode}.local`,
  ]) {
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

/** A setting from the environment, or else from the dotenv files. */
function readSetting(name, { environment, rootDir, authoritativeEnvironment }) {
  const value = String(environment[name] ?? '').trim();
  if (value) return value;
  if (
    authoritativeEnvironment &&
    Object.prototype.hasOwnProperty.call(environment, name)
  )
    return '';
  return readDoctorDotenvValue(name, rootDir).trim();
}

function hasKeychainItem(service, account) {
  return findKeychainItem(service, account);
}

export function resolveCredential(
  spec,
  {
    includeKeychain = true,
    authoritativeEnvironment = false,
    environment = process.env,
    rootDir = ROOT,
    keychainLookup = hasKeychainItem,
    credentialsFile = {},
  } = {},
) {
  const environmentDefinesKey = Object.prototype.hasOwnProperty.call(
    environment,
    spec.name,
  );
  if (isConfiguredValue(environment[spec.name]))
    return { configured: true, source: 'environment' };
  if (authoritativeEnvironment && environmentDefinesKey)
    return { configured: false, source: null };
  if (isConfiguredValue(readDoctorDotenvValue(spec.name, rootDir)))
    return { configured: true, source: 'dotenv files' };
  // dev-fresh.sh reads OPENSKY_CREDENTIALS_FILE after the dotenv files and
  // before the Keychain.
  if (isConfiguredValue(credentialsFile[spec.name]))
    return { configured: true, source: 'OpenSky credentials file' };
  if (
    includeKeychain &&
    spec.keychain.some(([service, account]) => keychainLookup(service, account))
  ) {
    return { configured: true, source: 'macOS Keychain' };
  }
  return { configured: false, source: null };
}

export function buildCapabilitySummary(credentials) {
  const configured = (name) => credentials[name]?.configured === true;
  const route = selectMapStartupRoute({
    googleApiKey: configured('GOOGLE_MAPS_API_KEY') ? 'configured' : '',
    cesiumToken: configured('CESIUM_ION_TOKEN') ? 'configured' : '',
  });
  return {
    map:
      route === 'google-direct'
        ? 'Google Photorealistic 3D Tiles (direct)'
        : route === 'google-ion'
          ? 'Google Photorealistic 3D Tiles through Cesium ion; Bing and world-terrain stacks available'
          : 'Esri World Imagery (keyless satellite basemap) with keyless terrain',
    flights:
      configured('OPENSKY_CLIENT_ID') && configured('OPENSKY_CLIENT_SECRET')
        ? 'OpenSky OAuth credentials present (runtime mode and validity not verified)'
        : 'OpenSky OAuth credentials not configured',
    voice: configured('OPENAI_API_KEY')
      ? 'available'
      : 'off until an OpenAI key is added',
    vessels: configured('AISSTREAM_API_KEY')
      ? 'live AISStream feed'
      : 'off until an AISStream key is added',
    fires: configured('FIRMS_MAP_KEY')
      ? 'live NASA FIRMS feed'
      : 'off until a FIRMS key is added',
    traffic: configured('TOMTOM_API_KEY')
      ? 'live TomTom flow'
      : 'built-in traffic simulation',
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
  const setting = (name) =>
    readSetting(name, { environment, rootDir, authoritativeEnvironment });
  const node = classifyNodeVersion();
  const pnpmSpec = pnpmProcessSpec();
  const pnpmResult = spawnSync(pnpmSpec.command, ['--version'], {
    cwd: rootDir,
    encoding: 'utf8',
    shell: pnpmSpec.shell,
  });
  let packageManager = '';
  try {
    ({ packageManager = '' } = JSON.parse(
      readFileSync(path.join(rootDir, 'package.json'), 'utf8'),
    ));
  } catch {
    // hasRequiredDependencies reports an unreadable package.json.
  }
  const pnpmVersion = String(pnpmResult.stdout || '').trim();
  const pnpm =
    pnpmResult.status === 0
      ? {
          available: true,
          version: pnpmVersion,
          ...checkPnpmVersion(pnpmVersion, packageManager),
        }
      : { available: false, version: null };

  // The launcher reads the credentials file only in oauth mode.
  const openSkyMode = setting('OPENSKY_AUTH_MODE');
  const credentialsFilePath =
    includeCredentialsFile && openSkyMode.toLowerCase() !== 'anon'
      ? setting('OPENSKY_CREDENTIALS_FILE')
      : '';
  const credentialsFile = credentialsFilePath
    ? {
        path: credentialsFilePath,
        ...readOpenSkyCredentialsFile(credentialsFilePath, rootDir),
      }
    : null;
  const credentials = Object.fromEntries(
    CREDENTIALS.map((spec) => [
      spec.name,
      resolveCredential(spec, {
        includeKeychain,
        authoritativeEnvironment,
        environment,
        rootDir,
        credentialsFile: credentialsFile?.values,
      }),
    ]),
  );
  const dependenciesInstalled = hasRequiredDependencies(rootDir);

  const checks = [
    { id: 'lockfile', label: 'Lockfile', ...checkLockfile(rootDir) },
    { id: 'ws', label: 'ws', ...checkWs(rootDir) },
  ];
  if (developerChecks) {
    const address = devServerAddress(setting);
    checks.push(
      {
        id: 'port',
        label: `Port ${address.port}`,
        ...(await checkPort(address)),
      },
      {
        id: 'git-hook',
        label: 'Git hook',
        ...checkGitHook({ rootDir, environment }),
      },
      {
        id: 'qa-browser',
        label: 'QA browser',
        ...(await checkQaBrowser({ environment })),
      },
    );
  }
  checks.push({
    id: 'opensky',
    label: 'OpenSky',
    ...checkOpenSky({
      mode: openSkyMode,
      credentials,
      credentialsFile,
      retired: ['OPENSKY_USERNAME', 'OPENSKY_PASSWORD'].filter((name) =>
        isConfiguredValue(setting(name)),
      ),
    }),
  });

  return {
    ready:
      node.level !== 'error' &&
      pnpm.available &&
      dependenciesInstalled &&
      checks.every((check) => check.level !== 'error'),
    node: { version: process.versions.node, ...node },
    pnpm,
    dependenciesInstalled,
    checks,
    credentials,
    capabilities: buildCapabilitySummary(credentials),
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
  const lines = [
    `[${symbol(level)}] ${summary ? `${label}: ${summary}` : label}`,
  ];
  if (hint) lines.push(`       ${hint}`);
  return lines;
}

export function formatSetupReport(report, { readyMessage } = {}) {
  const needsLauncher = Object.values(report.credentials || {}).some(
    (credential) => LAUNCHER_SOURCES.has(credential?.source),
  );
  const resolvedReadyMessage =
    readyMessage ||
    (needsLauncher
      ? 'Ready. Run ./scripts/dev-fresh.sh, then open http://localhost:4173.'
      : 'Ready. Run pnpm run dev, then open http://localhost:4173.');
  const lines = [
    "God's Eye View setup doctor",
    '',
    `[${symbol(report.node.level)}] Node ${report.node.version}: ${report.node.summary}`,
    ...(report.pnpm.available
      ? checkLines(`pnpm ${report.pnpm.version}`, report.pnpm)
      : ['[ERROR] pnpm was not found; install pnpm 11']),
    report.dependenciesInstalled
      ? '[OK] dependencies installed'
      : '[WARN] dependencies missing; run pnpm install',
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
  if (process.argv.includes('--json'))
    console.log(JSON.stringify(report, null, 2));
  else console.log(formatSetupReport(report));
  if (!report.ready) process.exitCode = 1;
}
