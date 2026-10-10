/**
 * Regenerates knip-baseline.json: for each file, the knip issue types that
 * upstream's code has today, which knip.config.js then ignores there.
 *
 * Like biome-baseline.json, this keeps upstream's files byte-identical while
 * `pnpm run knip` holds every other file, and every other issue type, to
 * knip's checks. `pnpm run baseline` reruns it after an upstream sync; fix
 * new fork findings instead of re-running it.
 *
 * Usage: node scripts/knip-baseline.mjs
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = 'knip-baseline.json';
const BIN = path.join(ROOT, 'node_modules', '.bin');

/**
 * Maps each file to the issue types knip reports for it, from knip's JSON
 * reporter output.
 * @param {{issues: Array<Record<string, unknown>>}} report
 */
export function baselineFromReport(report) {
  /** @type {Record<string, string[]>} */
  const baseline = {};
  for (const issue of report.issues) {
    const file = /** @type {string} */ (issue.file);
    const types = Object.entries(issue)
      .filter(([type, value]) => {
        if (type === 'file' || type === 'owners') return false;
        if (Array.isArray(value)) return value.length > 0;
        return Boolean(value) && Object.keys(value).length > 0;
      })
      .map(([type]) => type)
      .sort();
    if (types.length) baseline[file] = types;
  }
  return Object.fromEntries(
    Object.entries(baseline).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function knipReport() {
  let stdout;
  try {
    stdout = execFileSync(path.join(BIN, 'knip'), ['--reporter', 'json'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, KNIP_BASELINE: 'off' },
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch (error) {
    // knip exits 1 when it reports issues; the report is still on stdout.
    stdout = /** @type {{stdout?: string}} */ (error).stdout ?? '';
  }
  return JSON.parse(stdout);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const formatted = execFileSync(
    path.join(BIN, 'biome'),
    ['format', `--stdin-file-path=${BASELINE}`],
    {
      cwd: ROOT,
      input: JSON.stringify(baselineFromReport(knipReport())),
      encoding: 'utf8',
    },
  );
  writeFileSync(path.join(ROOT, BASELINE), formatted);
}
