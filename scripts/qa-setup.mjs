#!/usr/bin/env node
/**
 * Gets the Chrome that the QA scripts, `pnpm run test:track` and
 * tools/cesium-render.mjs drive. Installing the dependencies does not download
 * it: pnpm-workspace.yaml keeps Puppeteer's install script from running. This
 * downloads Puppeteer's pinned Chrome for Testing instead, unless
 * PUPPETEER_EXECUTABLE_PATH names a Chrome to use.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** What `pnpm run qa:setup` does in this environment. */
export function qaSetupPlan({
  environment = process.env,
  exists = existsSync,
} = {}) {
  const executable = String(environment.PUPPETEER_EXECUTABLE_PATH || '').trim();
  if (!executable) return { action: 'install' };
  return { action: exists(executable) ? 'use' : 'missing', executable };
}

/** Puppeteer's command line, which this Node runs without a shell. */
export function puppeteerCli() {
  return createRequire(import.meta.url).resolve(
    'puppeteer/lib/puppeteer/node/cli.js',
  );
}

function main() {
  const plan = qaSetupPlan();
  if (plan.action === 'use') {
    console.log(
      `QA browser: ${plan.executable} (PUPPETEER_EXECUTABLE_PATH); nothing to download.`,
    );
    return 0;
  }
  if (plan.action === 'missing') {
    console.error(
      `PUPPETEER_EXECUTABLE_PATH names a missing file: ${plan.executable}`,
    );
    console.error(
      'Point it at an installed Chrome, or unset it to download Chrome for Testing.',
    );
    return 1;
  }
  // The harnesses run Chrome itself in headless mode, so they need neither
  // chrome-headless-shell nor another browser.
  const result = spawnSync(
    process.execPath,
    [puppeteerCli(), 'browsers', 'install', 'chrome'],
    { stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main();
}
