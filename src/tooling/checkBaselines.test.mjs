import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  baselineGrowth,
  baselinesAt,
  biomeEntries,
  growth,
  isUpstreamMerge,
  knipEntries,
  parseArgs,
  typecheckEntries,
  upstreamMerges,
} from '../../scripts/check-baselines.mjs';

const read = (file) =>
  readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

test('the type-check baseline may not gain a file or an error', () => {
  const before = { browser: { 'src/a.js': 3 }, server: { 'server/b.js': 1 } };
  assert.deepEqual(
    growth(typecheckEntries(before), typecheckEntries(before)),
    [],
  );
  assert.deepEqual(
    growth(
      typecheckEntries(before),
      typecheckEntries({
        browser: { 'src/a.js': 4, 'src/c.js': 2 },
        server: { 'server/b.js': 1, 'src/a.js': 1 },
      }),
    ),
    [
      'browser: src/a.js (3 → 4)',
      'browser: src/c.js (2)',
      'server: src/a.js (1)',
    ],
  );
});

test('a smaller type-check baseline passes', () => {
  assert.deepEqual(
    growth(
      typecheckEntries({ browser: { 'src/a.js': 3, 'src/b.js': 1 } }),
      typecheckEntries({ browser: { 'src/a.js': 2 } }),
    ),
    [],
  );
});

test('a type-check baseline that only listed files allows each without a cap', () => {
  const lists = typecheckEntries({ browser: ['src/a.js'] });
  assert.deepEqual(
    growth(lists, typecheckEntries({ browser: { 'src/a.js': 9 } })),
    [],
  );
  assert.deepEqual(
    growth(lists, typecheckEntries({ browser: { 'src/b.js': 1 } })),
    ['browser: src/b.js (1)'],
  );
});

const override = (includes, setting) => ({ includes, ...setting });
const rule = (group, name) => ({
  linter: { rules: { [group]: { [name]: 'off' } } },
});

test('the Biome baseline may not gain a rule or a file under a rule', () => {
  const before = {
    overrides: [
      override(['a.js', 'b.js'], { formatter: { enabled: false } }),
      override(['a.js'], rule('style', 'useTemplate')),
    ],
  };
  assert.deepEqual(growth(biomeEntries(before), biomeEntries(before)), []);
  const after = {
    overrides: [
      override(['a.js', 'c.js'], { formatter: { enabled: false } }),
      override(['a.js'], rule('style', 'useTemplate')),
      override(['d.js', 'e.js'], rule('suspicious', 'noDoubleEquals')),
      override(['f.js'], {
        assist: { actions: { source: { organizeImports: 'off' } } },
      }),
    ],
  };
  assert.deepEqual(growth(biomeEntries(before), biomeEntries(after)), [
    'format: c.js',
    'lint/suspicious/noDoubleEquals',
    'assist/source/organizeImports',
  ]);
  const fixed = {
    overrides: [override(['a.js'], { formatter: { enabled: false } })],
  };
  assert.deepEqual(
    growth(biomeEntries(before), biomeEntries(fixed)),
    [],
    'dropping a rule or a file passes',
  );
});

test('the knip baseline may not gain a file or an issue type', () => {
  const before = { 'a.js': ['exports'], 'b.js': ['binaries'] };
  assert.deepEqual(growth(knipEntries(before), knipEntries(before)), []);
  assert.deepEqual(
    growth(
      knipEntries(before),
      knipEntries({ 'a.js': ['exports', 'types'], 'c.js': ['exports'] }),
    ),
    ['a.js: types', 'c.js'],
  );
});

test('the growth is reported by baseline file', () => {
  const baselines = {
    typecheck: { browser: { 'src/a.js': 1 } },
    biome: { overrides: [] },
    knip: {},
  };
  assert.deepEqual(baselineGrowth(baselines, baselines), {});
  assert.deepEqual(
    baselineGrowth(baselines, {
      ...baselines,
      knip: { 'a.js': ['exports'] },
    }),
    { 'knip-baseline.json': ['a.js'] },
  );
});

test('the committed baselines are in the shapes the check reads', () => {
  const typecheck = typecheckEntries(
    JSON.parse(read('typecheck-baseline.json')),
  );
  const biome = biomeEntries(JSON.parse(read('biome-baseline.json')));
  const knip = knipEntries(JSON.parse(read('knip-baseline.json')));
  assert.ok(typecheck.size > 0 && biome.size > 0 && knip.size > 0);
  assert.ok(
    [...typecheck.values()].every(({ count }) => Number.isInteger(count)),
    'every type-checked file has a count',
  );
  assert.ok(biome.has('format'), 'the format override is named format');
});

test('a merge is upstream when its merge base is off the first-parent chain', () => {
  const chain = new Set(['f3', 'f2', 'f1']);
  assert.equal(isUpstreamMerge('f2', chain), false, 'a fork branch');
  assert.equal(isUpstreamMerge('u7', chain), true, 'an upstream sync');
  assert.equal(isUpstreamMerge(undefined, chain), true, 'unrelated history');
});

test('the base is required and the head defaults to HEAD', () => {
  assert.deepEqual(parseArgs(['--base', 'abc']), { base: 'abc', head: 'HEAD' });
  assert.deepEqual(parseArgs(['--base', 'abc', '--head', 'def']), {
    base: 'abc',
    head: 'def',
  });
  assert.throws(() => parseArgs(['--base']), /Usage/);
  assert.throws(() => parseArgs(['--from', 'abc']), /Usage/);
});

/** A throwaway repository, with the commands the scenarios below need. */
function scratchRepository() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'gev-check-baselines-'));
  const git = (...args) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Baseline Check Test',
        '-c',
        'user.email=baseline-check-test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  const commit = (message, files = {}) => {
    for (const [file, content] of Object.entries(files)) {
      writeFileSync(path.join(cwd, file), `${JSON.stringify(content)}\n`);
      git('add', file);
    }
    git('commit', '-q', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const merge = (branch, message) => {
    git('merge', '-q', '--no-ff', '-m', message, branch);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'upstream');
  return { cwd, git, commit, merge };
}

test('only merges of upstream history are exempt', () => {
  const { cwd, git, commit, merge } = scratchRepository();
  try {
    // Upstream's history, which the fork started from.
    commit('upstream 1', { 'knip-baseline.json': {} });
    git('switch', '-q', '-c', 'main');
    commit('fork 1');
    git('switch', '-q', 'upstream');
    commit('upstream 2');
    git('switch', '-q', 'main');
    merge('upstream', 'first sync');
    // Upstream moves on; the fork syncs again, and merges a branch of its own.
    git('switch', '-q', 'upstream');
    commit('upstream 3');
    git('switch', '-q', 'main');
    const beforeSync = commit('fork 2');
    const sync = merge('upstream', 'Merge upstream');
    git('switch', '-q', '-c', 'feature');
    commit('feature 1', { 'knip-baseline.json': { 'a.js': ['exports'] } });
    git('switch', '-q', 'main');
    const beforeBranch = commit('fork 3');
    merge('feature', 'Merge the feature branch');

    const subjects = (base, head) =>
      upstreamMerges(base, head, cwd).map((line) =>
        line.slice(line.indexOf(' ') + 1),
      );
    assert.deepEqual(subjects(beforeSync, sync), ['Merge upstream']);
    assert.deepEqual(subjects(beforeBranch, 'HEAD'), [], 'a fork branch');
    assert.deepEqual(subjects(beforeSync, 'HEAD'), ['Merge upstream']);
    assert.deepEqual(baselinesAt(beforeBranch, cwd).knip, {});
    assert.deepEqual(baselinesAt('HEAD', cwd).knip, { 'a.js': ['exports'] });
    assert.deepEqual(
      baselinesAt('HEAD', cwd).typecheck,
      {},
      'missing reads empty',
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('CI checks the baselines once, against the commit before the change', () => {
  const ci = read('.github/workflows/ci.yml');
  const verify = ci.slice(
    ci.indexOf('\n  verify:\n'),
    ci.indexOf('\n  allocation-budgets:\n'),
  );
  const step = verify.slice(
    verify.indexOf('- name: Check that the baselines only shrink'),
  );
  assert.ok(step.length < verify.length, 'the step is in the verify job');
  const body = step.slice(0, step.indexOf('\n      - name:'));
  assert.match(body, /if: matrix\.node == '24\.22\.1'/);
  assert.match(body, /github\.event\.pull_request\.base\.sha/);
  assert.match(body, /github\.event\.before/);
  assert.match(body, /'HEAD\^'/);
  assert.match(body, /run: pnpm run check:baselines --base "\$BASE"/);
  assert.match(verify, /fetch-depth: 0/);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(
    pkg.scripts['check:baselines'],
    'node scripts/check-baselines.mjs',
  );
});
