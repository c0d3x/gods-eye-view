/**
 * Regenerates biome-baseline.json: the Biome checks that upstream code does
 * not pass yet, switched off for exactly the files that fail them.
 *
 * The fork keeps upstream's files byte-identical so upstream syncs stay
 * small, which means Biome cannot reformat or lint-fix them. After a sync,
 * run this script so `pnpm run lint` and `pnpm run format:check` hold the
 * fork to Biome's rules everywhere upstream already passes them. Fork changes
 * must not grow the baseline: fix a new finding instead of re-running this.
 *
 * Usage: node scripts/biome-baseline.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = 'biome-baseline.json';
const BIOME = path.join(ROOT, 'node_modules', '.bin', 'biome');

/**
 * Builds the baseline's overrides from Biome's JSON report diagnostics.
 * Infos are ignored because they never fail a run.
 * @param {Array<{severity: string, category: string, location: {path: string}}>} diagnostics
 */
export function overridesFromDiagnostics(diagnostics) {
  /** @type {Map<string, Set<string>>} */
  const filesByCategory = new Map();
  for (const { severity, category, location } of diagnostics) {
    if (severity !== 'error' && severity !== 'warning') continue;
    const files = filesByCategory.get(category) ?? new Set();
    files.add(location.path.split(path.sep).join('/'));
    filesByCategory.set(category, files);
  }
  return [...filesByCategory.keys()].sort().map((category) => ({
    includes: [...filesByCategory.get(category)].sort(),
    ...settingFor(category),
  }));
}

/** The override setting that switches off one diagnostic category. */
function settingFor(category) {
  if (category === 'format') return { formatter: { enabled: false } };
  const [kind, group, name] = category.split('/');
  if (kind === 'lint' && group && name) {
    return { linter: { rules: { [group]: { [name]: 'off' } } } };
  }
  if (kind === 'assist' && group && name) {
    return { assist: { actions: { [group]: { [name]: 'off' } } } };
  }
  throw new Error(`No baseline setting for the diagnostic "${category}"`);
}

function biomeReport(args) {
  let stdout;
  try {
    stdout = execFileSync(
      BIOME,
      [...args, '--reporter=json', '--max-diagnostics=none'],
      {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
  } catch (error) {
    // Biome exits 1 when it reports diagnostics; the report is still on stdout.
    stdout = /** @type {{stdout?: string}} */ (error).stdout ?? '';
  }
  return JSON.parse(stdout).diagnostics;
}

/** Runs Biome with an empty baseline and returns the baseline it implies. */
export function collectBaseline() {
  const file = path.join(ROOT, BASELINE);
  const saved = readFileSync(file, 'utf8');
  writeFileSync(file, '{}\n');
  try {
    const diagnostics = [
      ...biomeReport(['format', '.']),
      ...biomeReport(['check', '--formatter-enabled=false', '.']),
    ];
    return { overrides: overridesFromDiagnostics(diagnostics) };
  } finally {
    writeFileSync(file, saved);
  }
}

function formatJson(value) {
  return execFileSync(BIOME, ['format', `--stdin-file-path=${BASELINE}`], {
    cwd: ROOT,
    input: `${JSON.stringify(value)}\n`,
    encoding: 'utf8',
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(path.join(ROOT, BASELINE), formatJson(collectBaseline()));
}
