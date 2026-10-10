import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  baselineCounts,
  fixedErrors,
  newErrors,
  PROJECTS,
  parseTscOutput,
} from '../../scripts/typecheck.mjs';

const OUTPUT = [
  "src/a.js(3,5): error TS7006: Parameter 'x' implicitly has an 'any' type.",
  "src/a.js(9,1): error TS2304: Cannot find name 'y'.",
  "server/b.js(1,1): error TS2307: Cannot find module './c.js'.",
  '  Some continuation text tsc prints under an error.',
  '',
].join('\n');

test('tsc output is grouped by the file each error is in', () => {
  const { errorsByFile, unplaced } = parseTscOutput(OUTPUT);
  assert.deepEqual([...errorsByFile.keys()], ['src/a.js', 'server/b.js']);
  assert.equal(errorsByFile.get('src/a.js')?.length, 2);
  assert.deepEqual(unplaced, []);
});

test('an error that names no file is kept apart, since no baseline covers it', () => {
  const { errorsByFile, unplaced } = parseTscOutput(
    "error TS5083: Cannot read file 'jsconfig.json'.",
  );
  assert.equal(errorsByFile.size, 0);
  assert.equal(unplaced.length, 1);
});

test('only files outside the baseline fail the check', () => {
  const { errorsByFile } = parseTscOutput(OUTPUT);
  assert.deepEqual(
    newErrors(errorsByFile, { 'src/a.js': 2 }).map(({ file }) => file),
    ['server/b.js'],
  );
  assert.deepEqual(
    newErrors(errorsByFile, { 'src/a.js': 2, 'server/b.js': 1 }),
    [],
  );
});

test('a baselined file fails once it has more errors than its count', () => {
  const { errorsByFile } = parseTscOutput(OUTPUT);
  const grown = newErrors(errorsByFile, { 'src/a.js': 1, 'server/b.js': 1 });
  assert.deepEqual(
    grown.map(({ file, allowed }) => [file, allowed]),
    [['src/a.js', 1]],
  );
  assert.equal(grown[0].errors.length, 2, 'every error in the file is shown');
});

test('a file under its count passes, and is named so the baseline can drop', () => {
  const { errorsByFile } = parseTscOutput(OUTPUT);
  const baselined = { 'src/a.js': 3, 'server/b.js': 1, 'src/gone.js': 4 };
  assert.deepEqual(newErrors(errorsByFile, baselined), []);
  assert.deepEqual(fixedErrors(errorsByFile, baselined), [
    { file: 'src/a.js', count: 2, allowed: 3 },
    { file: 'src/gone.js', count: 0, allowed: 4 },
  ]);
  assert.deepEqual(
    fixedErrors(errorsByFile, { 'src/a.js': 2, 'server/b.js': 1 }),
    [],
  );
});

test('the baseline records each file with its error count, sorted', () => {
  const { errorsByFile } = parseTscOutput(OUTPUT);
  const counts = baselineCounts(errorsByFile);
  assert.deepEqual(counts, { 'server/b.js': 1, 'src/a.js': 2 });
  assert.deepEqual(Object.keys(counts), ['server/b.js', 'src/a.js']);
});

test('the checked-in baseline holds a count per file for each project', () => {
  const baseline = JSON.parse(
    readFileSync(
      new URL('../../typecheck-baseline.json', import.meta.url),
      'utf8',
    ),
  );
  assert.deepEqual(Object.keys(baseline).sort(), Object.keys(PROJECTS).sort());
  for (const [project, counts] of Object.entries(baseline)) {
    assert.equal(Array.isArray(counts), false, project);
    const files = Object.keys(counts);
    assert.deepEqual(files, [...files].sort(), `${project} is sorted`);
    for (const [file, count] of Object.entries(counts)) {
      assert.ok(
        Number.isInteger(count) && count > 0,
        `${project}: ${file} has a positive count`,
      );
    }
  }
});
