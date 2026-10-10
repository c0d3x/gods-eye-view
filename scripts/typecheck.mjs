/**
 * Type-checks the browser and server code in strict mode, holding every file
 * to it except those listed in typecheck-baseline.json.
 *
 * Upstream's files are kept byte-identical so upstream syncs stay small, so
 * they cannot be annotated to satisfy strict mode. The baseline lists, per
 * project, the files that have type errors today; every other file must have
 * none, including the fork's own modules and any upstream file that already
 * passes. After an upstream sync, `pnpm run baseline` rebaselines.
 * Fork changes must not grow the baseline: fix a new error instead.
 *
 * Usage: node scripts/typecheck.mjs [--update]
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = 'typecheck-baseline.json';
const TSC = path.join(ROOT, 'node_modules', '.bin', 'tsc');
const BIOME = path.join(ROOT, 'node_modules', '.bin', 'biome');

/** The TypeScript projects, by the name the baseline files them under. */
export const PROJECTS = Object.freeze({
  browser: 'jsconfig.json',
  server: 'server/jsconfig.json',
});

const DIAGNOSTIC = /^(.+?)\(\d+,\d+\): error (TS\d+): /;

/**
 * Groups tsc's output by file. Returns the files with errors and any error
 * that names no file (a configuration problem, which no baseline can cover).
 * @param {string} output
 */
export function parseTscOutput(output) {
  /** @type {Map<string, string[]>} */
  const errorsByFile = new Map();
  /** @type {string[]} */
  const unplaced = [];
  for (const line of output.split(/\r?\n/)) {
    const match = DIAGNOSTIC.exec(line);
    if (match) {
      const file = match[1].split(path.sep).join('/');
      const errors = errorsByFile.get(file) ?? [];
      errors.push(line);
      errorsByFile.set(file, errors);
    } else if (/\berror TS\d+:/.test(line)) {
      unplaced.push(line);
    }
  }
  return { errorsByFile, unplaced };
}

/**
 * The files whose errors the baseline does not cover, with their errors.
 * @param {Map<string, string[]>} errorsByFile
 * @param {string[]} baselined
 */
export function newErrors(errorsByFile, baselined) {
  const allowed = new Set(baselined);
  return [...errorsByFile].filter(([file]) => !allowed.has(file));
}

function runTsc(project) {
  const result = spawnSync(TSC, ['--noEmit', '-p', project], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return parseTscOutput(`${result.stdout}\n${result.stderr}`);
}

function readBaseline() {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, BASELINE), 'utf8'));
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

function main(update) {
  const baseline = readBaseline();
  /** @type {Record<string, string[]>} */
  const next = {};
  let failed = false;
  for (const [name, project] of Object.entries(PROJECTS)) {
    const { errorsByFile, unplaced } = runTsc(project);
    if (unplaced.length) {
      console.error(`${project}:\n${unplaced.join('\n')}`);
      failed = true;
    }
    next[name] = [...errorsByFile.keys()].sort();
    if (update) continue;
    const fresh = newErrors(errorsByFile, baseline[name] ?? []);
    for (const [, errors] of fresh) console.error(errors.join('\n'));
    if (fresh.length) {
      console.error(
        `${project}: ${fresh.length} file(s) outside ${BASELINE} have type errors.`,
      );
      failed = true;
    }
  }
  if (update) {
    // Written as Biome formats it, so format:check accepts the file.
    const formatted = execFileSync(
      BIOME,
      ['format', `--stdin-file-path=${BASELINE}`],
      { cwd: ROOT, input: JSON.stringify(next), encoding: 'utf8' },
    );
    writeFileSync(path.join(ROOT, BASELINE), formatted);
    console.log(`Updated ${BASELINE}`);
  }
  if (failed) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.includes('--update'));
}
