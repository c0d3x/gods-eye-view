#!/usr/bin/env node
/**
 * Builds, runs, signs and installs God's Eye View as a Mac app (app/).
 *
 *   pnpm run app:setup     download Electron's binary (once)
 *   pnpm run app:dev       build the web app and open it in Electron
 *   pnpm run app:build     build, sign and package the .app and .dmg
 *   pnpm run app:smoke     launch the built app and check it works
 *   pnpm run app:notarize  notarize and staple the .dmg (Developer ID only)
 *   pnpm run app:install   copy the built app to /Applications
 *
 * Environment:
 *   GEV_APP_OUT_DIR        where the build goes (default: release/)
 *   GEV_APP_SIGN_IDENTITY  a certificate name or SHA-1 hash to sign with
 *                          (default: Developer ID Application, then Apple
 *                          Development, then an ad-hoc signature)
 *   GEV_NOTARY_PROFILE     the notarytool keychain profile (default:
 *                          gods-eye-view), made once with
 *                          `xcrun notarytool store-credentials gods-eye-view`
 *   electron_config_cache  where Electron's download is cached
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  electronBuilderConfig,
  isUnsignedResource,
  PRODUCT_NAME,
  pickSigningIdentity,
} from '../app/packaging.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'node_modules', '.bin');

/** The browser keys, blanked so no developer key is baked into the app. */
export const BLANK_BROWSER_KEYS = Object.freeze({
  GOOGLE_MAPS_API_KEY: '',
  CESIUM_ION_TOKEN: '',
  MAPILLARY_CLIENT_TOKEN: '',
  GEV_REALTIME_DEBUG_LOG: '',
});

/**
 * Where a build goes, and where its parts land in it.
 * @param {NodeJS.ProcessEnv} env
 */
export function buildPaths(env = process.env) {
  const outDir = path.resolve(ROOT, env.GEV_APP_OUT_DIR || 'release');
  return {
    outDir,
    app: path.join(outDir, 'mac-arm64', `${PRODUCT_NAME}.app`),
    dmgPattern: /\.dmg$/,
  };
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 */
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: ROOT, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} ${args[0] ?? ''} failed`);
  }
}

function electronBinary() {
  return path.join(
    ROOT,
    'node_modules',
    'electron',
    'dist',
    'Electron.app',
    'Contents',
    'MacOS',
    'Electron',
  );
}

function setup() {
  if (fs.existsSync(electronBinary())) return;
  console.log('Downloading Electron…');
  run(process.execPath, [
    path.join(ROOT, 'node_modules', 'electron', 'install.js'),
  ]);
}

/** The web app and the MCP panel build, without baked-in keys. */
function buildWeb() {
  const env = { ...process.env, ...BLANK_BROWSER_KEYS };
  run(path.join(BIN, 'vite'), ['build'], env);
  run(process.execPath, [path.join(ROOT, 'scripts', 'build-panel.mjs')], env);
}

function dev() {
  setup();
  buildWeb();
  run(path.join(BIN, 'electron'), ['.']);
}

async function build() {
  if (process.platform !== 'darwin') {
    throw new Error('The Mac app is built on macOS.');
  }
  setup();
  buildWeb();
  const found = execFileSync(
    'security',
    ['find-identity', '-v', '-p', 'codesigning'],
    { encoding: 'utf8' },
  );
  const wanted = process.env.GEV_APP_SIGN_IDENTITY || undefined;
  // '-' asks for an ad-hoc signature even when a certificate is present.
  const identity = wanted === '-' ? null : pickSigningIdentity(found, wanted);
  if (wanted && wanted !== '-' && !identity) {
    throw new Error(
      `No codesigning certificate named ${process.env.GEV_APP_SIGN_IDENTITY}`,
    );
  }
  console.log(
    identity
      ? `Signing with ${identity.name}`
      : 'No signing certificate found; signing ad hoc',
  );
  const { outDir } = buildPaths();
  const builder = await import('electron-builder');
  const signApp = await osxSign();
  // electron-builder finds the certificate by hash but then signs by name,
  // which codesign refuses when a keychain holds two of that name. This signs
  // by hash, and skips the files that need no signature of their own.
  /** @param {object} opts electron-builder's options for @electron/osx-sign. */
  const sign = (opts) =>
    signApp({
      ...opts,
      identity: identity?.hash ?? '-',
      identityValidation: false,
      ignore: isUnsignedResource,
    });
  await builder.build({
    targets: builder.Platform.MAC.createTarget(['dmg'], builder.Arch.arm64),
    config: /** @type {any} */ (
      electronBuilderConfig({
        outDir,
        identity: identity?.hash ?? null,
        sign,
      })
    ),
  });
  console.log(`Built ${buildPaths().app}`);
  if (identity?.kind !== 'developer-id') {
    console.log(
      'Not notarizable: notarization needs a Developer ID Application certificate.',
    );
  }
}

/** @electron/osx-sign, the signer electron-builder itself uses. */
async function osxSign() {
  const fromBuilder = createRequire(
    createRequire(import.meta.url).resolve('electron-builder/package.json'),
  );
  const fromLib = createRequire(
    fromBuilder.resolve('app-builder-lib/package.json'),
  );
  const { signAsync } = await import(
    pathToFileURL(fromLib.resolve('@electron/osx-sign')).href
  );
  return /** @type {(opts: object) => Promise<void>} */ (signAsync);
}

function builtDmg() {
  const { outDir, dmgPattern } = buildPaths();
  const dmg = fs
    .readdirSync(outDir)
    .filter((name) => dmgPattern.test(name))
    .map((name) => path.join(outDir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (!dmg) throw new Error(`No .dmg in ${outDir}; run pnpm run app:build`);
  return dmg;
}

function notarize() {
  const dmg = builtDmg();
  const profile = process.env.GEV_NOTARY_PROFILE || 'gods-eye-view';
  run('xcrun', [
    'notarytool',
    'submit',
    dmg,
    '--keychain-profile',
    profile,
    '--wait',
  ]);
  run('xcrun', ['stapler', 'staple', dmg]);
  console.log(`Notarized and stapled ${dmg}`);
}

/**
 * Launches the built app and checks it from outside: the page and its
 * runtime config, Provider Settings, an unknown route, that its server
 * listens on 127.0.0.1 only, that quitting releases the port, and that
 * running it wrote nothing into the signed bundle.
 */
async function smoke() {
  const { app } = buildPaths();
  const binary = path.join(app, 'Contents', 'MacOS', PRODUCT_NAME);
  if (!fs.existsSync(binary)) {
    throw new Error(`No app at ${app}; run pnpm run app:build`);
  }
  const started = Date.now();
  const child = spawn(binary, [], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('The app did not start within 90 s')),
        90_000,
      );
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
        const match = /is serving (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`The app exited (${code}) before it served`));
      });
    });
    const origin = url.slice(0, -1);
    const check = (ok, what) => {
      if (!ok) throw new Error(`Smoke test failed: ${what}`);
      console.log(`ok - ${what}`);
    };
    const page = await fetch(url);
    check(
      page.ok && (await page.text()).includes('/gev-runtime-config.js'),
      'the page loads with its runtime config',
    );
    check(
      (await fetch(`${origin}/gev-runtime-config.js`)).ok,
      'the runtime config answers',
    );
    const status = await fetch(`${origin}/api/setup/status`);
    check(
      status.ok && (await status.json()).store === 'app-keychain',
      'Provider Settings answers from the app key store',
    );
    check(
      (await fetch(`${origin}/api/no-such-route`)).status === 404,
      'an unknown /api route is a 404',
    );
    const listening = execFileSync(
      'lsof',
      ['-nP', '-a', '-p', String(child.pid), '-iTCP', '-sTCP:LISTEN'],
      { encoding: 'utf8' },
    );
    check(
      /127\.0\.0\.1:\d+ \(LISTEN\)/.test(listening) &&
        !/(\*|0\.0\.0\.0|\[::\]):\d+ \(LISTEN\)/.test(listening),
      'the server listens on 127.0.0.1 only',
    );
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
    const released = await fetch(url).then(
      () => false,
      () => true,
    );
    check(released, 'quitting closes the server');
    const written = fs
      .readdirSync(app, { recursive: true })
      .map((entry) => path.join(app, String(entry)))
      .filter((file) => fs.lstatSync(file).mtimeMs >= started);
    check(written.length === 0, 'nothing was written inside the bundle');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

function install() {
  const { app } = buildPaths();
  if (!fs.existsSync(app)) {
    throw new Error(`No app at ${app}; run pnpm run app:build`);
  }
  const target = path.join('/Applications', `${PRODUCT_NAME}.app`);
  fs.rmSync(target, { recursive: true, force: true });
  // ditto keeps the signature, extended attributes and symlinks intact.
  run('ditto', [app, target]);
  console.log(`Installed ${target}`);
}

const COMMANDS = { setup, dev, build, smoke, notarize, install };

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const name = /** @type {keyof typeof COMMANDS} */ (process.argv[2]);
  const command = COMMANDS[name];
  if (!command) {
    console.error(
      `Usage: node scripts/app.mjs <${Object.keys(COMMANDS).join('|')}>`,
    );
    process.exit(2);
  }
  try {
    await command();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
