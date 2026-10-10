/**
 * Type-checks the browser and server code in strict mode, holding every file
 * to it except for the errors typecheck-baseline.json allows.
 *
 * Upstream's files are kept byte-identical so upstream syncs stay small, so
 * they cannot be annotated to satisfy strict mode. The baseline records, per
 * project, how many type errors each such file has today. The check fails
 * when a file has more errors than its count, or when a file outside the
 * baseline has any, so a fork edit to an upstream file cannot add errors
 * under cover of the ones already there. A file with fewer errors than its
 * count passes, with a note to lower the baseline. After an upstream sync,
 * `pnpm run baseline` rebaselines. Fork changes must not grow the baseline:
 * fix a new error instead. CI holds that rule through
 * scripts/check-baselines.mjs.
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
 * One project's baseline entry: each file's error count, sorted by file.
 * @param {Map<string, string[]>} errorsByFile
 * @returns {Record<string, number>}
 */
export function baselineCounts(errorsByFile) {
  return Object.fromEntries(
    [...errorsByFile.keys()]
      .sort()
      .map((file) => [file, errorsByFile.get(file)?.length ?? 0]),
  );
}

/**
 * The files with more errors than the baseline allows them, with their
 * errors. A file the baseline does not list is allowed none.
 * @param {Map<string, string[]>} errorsByFile
 * @param {Record<string, number>} baselined
 * @returns {Array<{file: string, errors: string[], allowed: number}>}
 */
export function newErrors(errorsByFile, baselined) {
  return [...errorsByFile]
    .map(([file, errors]) => ({ file, errors, allowed: baselined[file] ?? 0 }))
    .filter(({ errors, allowed }) => errors.length > allowed);
}

/**
 * The baselined files that now have fewer errors than their count, so the
 * baseline can be lowered.
 * @param {Map<string, string[]>} errorsByFile
 * @param {Record<string, number>} baselined
 * @returns {Array<{file: string, count: number, allowed: number}>}
 */
export function fixedErrors(errorsByFile, baselined) {
  return Object.entries(baselined)
    .map(([file, allowed]) => ({
      file,
      count: errorsByFile.get(file)?.length ?? 0,
      allowed,
    }))
    .filter(({ count, allowed }) => count < allowed);
}

/** @param {string} project */
function runTsc(project) {
  const result = spawnSync(TSC, ['--noEmit', '-p', project], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return parseTscOutput(`${result.stdout}\n${result.stderr}`);
}

/** @returns {Record<string, Record<string, number>>} */
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

/** @param {boolean} update */
function main(update) {
  const baseline = readBaseline();
  /** @type {Record<string, Record<string, number>>} */
  const next = {};
  let failed = false;
  for (const [name, project] of Object.entries(PROJECTS)) {
    const { errorsByFile, unplaced } = runTsc(project);
    if (unplaced.length) {
      console.error(`${project}:\n${unplaced.join('\n')}`);
      failed = true;
    }
    next[name] = baselineCounts(errorsByFile);
    if (update) continue;
    const grown = newErrors(errorsByFile, baseline[name] ?? {});
    for (const { file, errors, allowed } of grown) {
      console.error(errors.join('\n'));
      console.error(
        `${file}: ${errors.length} type error(s), ${BASELINE} allows ${allowed}.`,
      );
    }
    if (grown.length) {
      console.error(
        `${project}: ${grown.length} file(s) have more type errors than ${BASELINE} allows. Fix the new ones.`,
      );
      failed = true;
    }
    const fixed = fixedErrors(errorsByFile, baseline[name] ?? {});
    if (fixed.length) {
      const files = fixed.map(
        ({ file, count, allowed }) => `  ${file}: ${count} (was ${allowed})`,
      );
      console.log(
        `${project}: ${fixed.length} file(s) have fewer type errors than ${BASELINE} allows:\n${files.join('\n')}\nRun \`pnpm run baseline\` to lower the baseline.`,
      );
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
