import assert from 'node:assert/strict';
import test from 'node:test';
import { overridesFromDiagnostics } from '../../scripts/biome-baseline.mjs';

const at = (path) => ({ path });

test('the baseline switches off each failing check for exactly the files that fail it', () => {
  const overrides = overridesFromDiagnostics([
    { severity: 'error', category: 'format', location: at('src/b.js') },
    { severity: 'error', category: 'format', location: at('src/a.js') },
    {
      severity: 'warning',
      category: 'lint/style/useConst',
      location: at('src/a.js'),
    },
    {
      severity: 'warning',
      category: 'lint/style/useConst',
      location: at('src/a.js'),
    },
    {
      severity: 'error',
      category: 'assist/source/organizeImports',
      location: at('server/c.js'),
    },
  ]);
  assert.deepEqual(overrides, [
    {
      includes: ['server/c.js'],
      assist: { actions: { source: { organizeImports: 'off' } } },
    },
    { includes: ['src/a.js', 'src/b.js'], formatter: { enabled: false } },
    {
      includes: ['src/a.js'],
      linter: { rules: { style: { useConst: 'off' } } },
    },
  ]);
});

test('infos stay out of the baseline because they never fail a run', () => {
  assert.deepEqual(
    overridesFromDiagnostics([
      {
        severity: 'info',
        category: 'lint/style/useTemplate',
        location: at('src/a.js'),
      },
    ]),
    [],
  );
});

test('an unknown diagnostic category stops the baseline instead of being dropped', () => {
  assert.throws(
    () =>
      overridesFromDiagnostics([
        { severity: 'error', category: 'parse', location: at('src/a.js') },
      ]),
    /parse/,
  );
});
