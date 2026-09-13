import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  areaOf,
  discoverSourceFiles,
  parseLcov,
  summarizeCoverage,
} from '../../scripts/coverage-summary.mjs';

const LCOV = [
  'TN:',
  'SF:/repo/src/data/alpha.js',
  'FN:1,start',
  'FNDA:1,start',
  'FNF:4',
  'FNH:3',
  'BRF:10',
  'BRH:5',
  'DA:1,1',
  'LF:200',
  'LH:150',
  'end_of_record',
  'SF:server/lib/beta.mjs',
  'FNF:2',
  'FNH:2',
  'BRF:0',
  'BRH:0',
  'LF:50',
  'LH:50',
  'end_of_record',
  'SF:vite.config.js',
  'FNF:10',
  'FNH:1',
  'BRF:20',
  'BRH:2',
  'LF:1000',
  'LH:100',
  'end_of_record',
  '',
].join('\n');

test('lcov records parse into per-file counts with repository paths', () => {
  const records = parseLcov(LCOV, '/repo');
  assert.deepEqual(
    records.map((record) => record.file),
    ['src/data/alpha.js', 'server/lib/beta.mjs', 'vite.config.js'],
  );
  assert.deepEqual(records[0], {
    file: 'src/data/alpha.js',
    lines: { found: 200, hit: 150 },
    branches: { found: 10, hit: 5 },
    functions: { found: 4, hit: 3 },
  });
});

test('files are grouped by their top two directories', () => {
  assert.equal(areaOf('src/data/alpha.js'), 'src/data');
  assert.equal(areaOf('src/ui.js'), 'src');
  assert.equal(areaOf('server/lib/beta.mjs'), 'server/lib');
  assert.equal(areaOf('vite.config.js'), 'vite.config.js');
});

test('the summary gives totals, areas, unloaded files and the least covered', () => {
  const records = parseLcov(LCOV, '/repo');
  const summary = summarizeCoverage(
    records,
    [
      { file: 'src/data/alpha.js', lines: 200 },
      { file: 'src/ui.js', lines: 10_000 },
      { file: 'src/worker.js', lines: 40 },
    ],
    { minLines: 100 },
  );
  // 300 of 1,250 lines, 7 of 30 branches and 6 of 16 functions.
  assert.match(
    summary,
    /^## Coverage\n\nLines \*\*24\.0%\*\* · branches \*\*23\.3%\*\* · functions \*\*37\.5%\*\* across 3 files that tests load\./,
  );
  assert.match(summary, /2 of 3 source files .* are never loaded by a test/);
  assert.match(summary, /\| `server\/lib` \| 1 \| 100\.0% \| — \| 100\.0% \|/);

  const unloaded = summary.slice(
    summary.indexOf('### Largest files no test loads'),
    summary.indexOf('### Least-covered files'),
  );
  assert.ok(unloaded.indexOf('src/ui.js') < unloaded.indexOf('src/worker.js'));
  assert.doesNotMatch(unloaded, /alpha/);

  const least = summary.slice(summary.indexOf('### Least-covered files'));
  assert.match(least, /`vite\.config\.js` \| 10\.0% \(100\/1000\)/);
  assert.ok(
    least.indexOf('vite.config.js') < least.indexOf('src/data/alpha.js'),
  );
  assert.doesNotMatch(least, /beta/, 'files under the line floor are left out');
});

test('source discovery covers src, server and vite.config.js, without tests', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const files = discoverSourceFiles(root);
  assert.ok(files.includes('vite.config.js'));
  assert.ok(files.includes('server/lib/requestGuard.mjs'));
  assert.ok(files.includes('src/ui.js'));
  assert.equal(
    files.some((file) => file.endsWith('.test.mjs')),
    false,
  );
});
