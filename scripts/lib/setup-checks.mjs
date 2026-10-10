/**
 * The setup doctor's checks of the toolchain and the local setup. Each check
 * returns `{ level, summary, hint? }`, where level is ok, warn, info or error
 * and the hint says how to fix what it found. scripts/setup-doctor.mjs runs
 * them and prints them.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';

/** The port the dev server listens on when PORT is unset. */
export const DEFAULT_PORT = 4173;

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

const unquote = (value) => value.trim().replace(/^(['"])(.*)\1$/, '$2');

/**
 * The direct dependencies a pnpm lockfile records for the root package, as
 * `<group> <name>` → specifier, such as `dependencies vite` → `^8.3.4`.
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

/** The direct dependencies package.json declares, keyed as above. */
export function manifestSpecifiers(manifest) {
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
export function checkLockfile(rootDir) {
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

/**
 * Load `ws` the way the AISStream vessel relay does
 * (server/providers/vessels/ais-live.js).
 */
export function checkWs(rootDir) {
  const require = createRequire(
    path.join(rootDir, 'server', 'providers', 'vessels', 'ais-live.js'),
  );
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

/**
 * The address `pnpm run dev` listens on, resolved as the dev server's Vite
 * config does.
 */
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
  rootDir,
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
export function readOpenSkyCredentialsFile(filePath, rootDir) {
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
