import assert from 'node:assert/strict';
import test from 'node:test';
import { baselineFromReport } from '../../scripts/knip-baseline.mjs';

test('the knip baseline lists, per file, only the issue types knip reported there', () => {
  const baseline = baselineFromReport({
    issues: [
      {
        file: 'src/b.js',
        owners: [],
        exports: [{ name: 'unused' }],
        types: [],
        duplicates: [[{ name: 'a' }, { name: 'b' }]],
        enumMembers: {},
      },
      { file: 'src/a.js', files: [{ name: 'src/a.js' }], exports: [] },
      { file: 'src/clean.js', exports: [], classMembers: {} },
    ],
  });
  assert.deepEqual(baseline, {
    'src/a.js': ['files'],
    'src/b.js': ['duplicates', 'exports'],
  });
  assert.deepEqual(Object.keys(baseline), ['src/a.js', 'src/b.js']);
});
