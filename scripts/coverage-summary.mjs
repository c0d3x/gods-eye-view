/**
 * Summarizes an lcov report as Markdown for the CI job summary: totals, then
 * coverage by area, the largest source files no test loads, and the
 * least-covered files that tests do load.
 *
 * Usage: node scripts/coverage-summary.mjs [coverage/lcov.info]
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Directories whose sources a test should load, besides vite.config.js. */
export const SOURCE_ROOTS = Object.freeze(['src', 'server']);

const COUNTS = Object.freeze({
  LF: ['lines', 'found'],
  LH: ['lines', 'hit'],
  BRF: ['branches', 'found'],
  BRH: ['branches', 'hit'],
  FNF: ['functions', 'found'],
  FNH: ['functions', 'hit'],
});

function emptyCounts() {
  return {
    lines: { found: 0, hit: 0 },
    branches: { found: 0, hit: 0 },
    functions: { found: 0, hit: 0 },
  };
}

/**
 * Parses lcov text into one record per source file, with the file's path
 * relative to `root`.
 * @param {string} text - The contents of an lcov.info file.
 * @param {string} [root] - The directory that paths are made relative to.
 */
export function parseLcov(text, root = process.cwd()) {
  const records = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      const file = line.slice(3);
      const relative = path.isAbsolute(file) ? path.relative(root, file) : file;
      current = { file: relative.split(path.sep).join('/'), ...emptyCounts() };
    } else if (current && line === 'end_of_record') {
      records.push(current);
      current = null;
    } else if (current) {
      const [key, value] = line.split(':');
      const target = COUNTS[key];
      if (target) current[target[0]][target[1]] = Number(value);
    }
  }
  return records;
}

/** A file's area: its top two directories, or its name at the root. */
export function areaOf(file) {
  const parts = file.split('/');
  if (parts.length > 2) return `${parts[0]}/${parts[1]}`;
  return parts.length === 2 ? parts[0] : file;
}

function percent({ found, hit }) {
  return found === 0 ? '—' : `${((100 * hit) / found).toFixed(1)}%`;
}

function ratio({ found, hit }) {
  return found === 0 ? 1 : hit / found;
}

function addCounts(sum, record) {
  for (const kind of ['lines', 'branches', 'functions']) {
    sum[kind].found += record[kind].found;
    sum[kind].hit += record[kind].hit;
  }
  return sum;
}

/**
 * Source files a test should load: everything under SOURCE_ROOTS except
 * tests, plus vite.config.js.
 * @param {string} [root] - The repository root.
 * @returns {string[]} Paths relative to `root`, sorted.
 */
export function discoverSourceFiles(root = process.cwd()) {
  const files = existsSync(path.join(root, 'vite.config.js'))
    ? ['vite.config.js']
    : [];
  const visit = (directory) => {
    const entries = readdirSync(path.join(root, directory), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(relative);
      else if (
        /\.m?js$/.test(entry.name) &&
        !entry.name.endsWith('.test.mjs')
      ) {
        files.push(relative);
      }
    }
  };
  for (const directory of SOURCE_ROOTS) {
    if (existsSync(path.join(root, directory))) visit(directory);
  }
  return files.sort();
}

/**
 * Renders the Markdown summary.
 * @param {ReturnType<typeof parseLcov>} records - Per-file coverage.
 * @param {{ file: string, lines: number }[]} [sources] - Source files a test
 *   should load, with their line counts.
 * @param {{ listed?: number, minLines?: number }} [options]
 * @returns {string}
 */
export function summarizeCoverage(
  records,
  sources = [],
  { listed = 10, minLines = 100 } = {},
) {
  const total = records.reduce(addCounts, emptyCounts());
  const areas = new Map();
  for (const record of records) {
    const area = areaOf(record.file);
    const sum = areas.get(area) ?? { files: 0, ...emptyCounts() };
    sum.files += 1;
    areas.set(area, addCounts(sum, record));
  }
  const loaded = new Set(records.map((record) => record.file));
  const unloaded = sources
    .filter((source) => !loaded.has(source.file))
    .sort((a, b) => b.lines - a.lines);
  const leastCovered = records
    .filter((record) => record.lines.found >= minLines)
    .sort((a, b) => ratio(a.lines) - ratio(b.lines))
    .slice(0, listed);

  const out = [
    '## Coverage',
    '',
    `Lines **${percent(total.lines)}** · branches **${percent(total.branches)}** · functions **${percent(total.functions)}** across ${records.length} files that tests load.`,
  ];
  if (sources.length > 0) {
    out.push(
      '',
      `${unloaded.length} of ${sources.length} source files in ${SOURCE_ROOTS.join(' and ')}, and vite.config.js, are never loaded by a test and aren't counted above.`,
    );
  }
  out.push(
    '',
    '| Area | Files | Lines | Branches | Functions |',
    '| --- | ---: | ---: | ---: | ---: |',
  );
  for (const [area, sum] of [...areas].sort(([a], [b]) => a.localeCompare(b))) {
    out.push(
      `| \`${area}\` | ${sum.files} | ${percent(sum.lines)} | ${percent(sum.branches)} | ${percent(sum.functions)} |`,
    );
  }
  if (unloaded.length > 0) {
    out.push('', '### Largest files no test loads', '', '| File | Lines |');
    out.push('| --- | ---: |');
    for (const source of unloaded.slice(0, listed)) {
      out.push(`| \`${source.file}\` | ${source.lines} |`);
    }
  }
  if (leastCovered.length > 0) {
    out.push('', `### Least-covered files of ${minLines}+ lines`, '');
    out.push(
      '| File | Lines | Branches | Functions |',
      '| --- | ---: | ---: | ---: |',
    );
    for (const record of leastCovered) {
      out.push(
        `| \`${record.file}\` | ${percent(record.lines)} (${record.lines.hit}/${record.lines.found}) | ${percent(record.branches)} | ${percent(record.functions)} |`,
      );
    }
  }
  return `${out.join('\n')}\n`;
}

function main([lcovPath = 'coverage/lcov.info']) {
  const records = parseLcov(readFileSync(lcovPath, 'utf8'));
  const sources = discoverSourceFiles().map((file) => ({
    file,
    lines: readFileSync(file, 'utf8').split('\n').length,
  }));
  process.stdout.write(summarizeCoverage(records, sources));
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invokedPath) main(process.argv.slice(2));
