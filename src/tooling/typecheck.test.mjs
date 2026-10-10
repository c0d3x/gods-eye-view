import assert from 'node:assert/strict';
import test from 'node:test';
import { newErrors, parseTscOutput } from '../../scripts/typecheck.mjs';

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
    newErrors(errorsByFile, ['src/a.js']).map(([file]) => file),
    ['server/b.js'],
  );
  assert.deepEqual(newErrors(errorsByFile, ['src/a.js', 'server/b.js']), []);
});
