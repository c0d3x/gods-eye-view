import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import unfinishedTestsReporter from '../scripts/lib/unfinishedTestsReporter.mjs';
import {
  ALLOCATION_TEST_FILES,
  allocationTestArgs,
  assertNode24AllocationRuntime,
  buildUnitTestPlan,
  discoverUnitTestFiles,
  isCalibratedAllocationRuntime,
  parallelTestArgs,
  parseUnitTestArgs,
  reporterFlags,
  runCheckedTests,
  UNIT_TEST_TIMEOUT_MS,
  unitTestFlags,
} from '../scripts/run-unit-tests.mjs';

/** A nested `node --test` that inherits NODE_TEST_CONTEXT skips running files. */
function nestedTestEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

test('unit runner serializes only GC-bracketed allocation microbenchmarks', () => {
  const ordinary = [
    'src/data/manager.test.mjs',
    'src/data/radio.test.mjs',
    'src/unitTestRunner.test.mjs',
  ];
  const plan = buildUnitTestPlan([
    ordinary[1],
    ALLOCATION_TEST_FILES[1],
    ordinary[0],
    ALLOCATION_TEST_FILES[0],
    ordinary[2],
  ]);

  assert.deepEqual(plan.parallel, ordinary);
  assert.deepEqual(plan.serializedAllocations, ALLOCATION_TEST_FILES);
  assert.equal(
    plan.parallel.some((file) => ALLOCATION_TEST_FILES.includes(file)),
    false,
  );
  for (const file of ALLOCATION_TEST_FILES) {
    assert.deepEqual(allocationTestArgs(file, { summaryFile: 's.json' }), [
      '--expose-gc',
      '--test',
      '--test-concurrency=1',
      ...unitTestFlags(),
      ...reporterFlags('s.json'),
      file,
    ]);
  }
  assert.throws(
    () => allocationTestArgs('src/data/radio.test.mjs'),
    /Not an allocation microbenchmark/,
  );
});

test('unit tests are discovered under both src and server', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = discoverUnitTestFiles(root);
  assert.ok(files.includes('src/unitTestRunner.test.mjs'));
  assert.ok(files.includes('server/lib/requestGuard.test.mjs'));
  assert.deepEqual(files, [...files].sort());
});

test('allocation runtime calibration is explicit and pinned to Node 24', () => {
  assert.equal(assertNode24AllocationRuntime('24.19.0'), '24.19.0');
  assert.throws(
    () => assertNode24AllocationRuntime('22.23.1'),
    /calibrated Node 24 runtime/,
  );
  assert.throws(
    () => assertNode24AllocationRuntime('26.0.0'),
    /calibrated Node 24 runtime/,
  );
  assert.equal(isCalibratedAllocationRuntime('24.19.0'), true);
  assert.equal(isCalibratedAllocationRuntime('22.23.1'), false);
  assert.equal(isCalibratedAllocationRuntime('26.3.0'), false);
});

test('npm test stays green on every supported engine, not only the calibrated one', () => {
  // package.json wiring: `npm test` must invoke this runner, and the engines
  // range it advertises must not be narrower than what the runner tolerates.
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  assert.equal(pkg.scripts.test, 'node scripts/run-unit-tests.mjs');
  const enginesNode = String(pkg.engines?.node || '');
  assert.ok(enginesNode, 'engines.node must be declared');
  // The runner throws for uncalibrated runtimes ONLY behind the explicit
  // opt-in env; by default it skips, so a supported non-24 engine cannot fail.
  const runner = readFileSync(
    new URL('../scripts/run-unit-tests.mjs', import.meta.url),
    'utf8',
  );
  assert.match(runner, /GEV_REQUIRE_ALLOCATION_GATE/);
  assert.match(runner, /SKIPPED .*allocation microbenchmarks/);
});

test('every run gives each test a deadline, and never forces an early exit', () => {
  assert.deepEqual(unitTestFlags(), [`--test-timeout=${UNIT_TEST_TIMEOUT_MS}`]);
  assert.deepEqual(unitTestFlags({ timeoutMs: 500 }), ['--test-timeout=500']);
  assert.deepEqual(
    parallelTestArgs(['a.test.mjs'], { summaryFile: 's.json' }),
    ['--test', ...unitTestFlags(), ...reporterFlags('s.json'), 'a.test.mjs'],
  );
  // --test-force-exit can end a file's process before all of its queued
  // tests have run, and Node then counts the file as passing.
  const runner = readFileSync(
    new URL('../scripts/run-unit-tests.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(runner, /'--test-force-exit'/);
  assert.match(
    runner,
    /runCheckedTests\(\s*\(\s*summaryFile,?\s*\)\s*=>\s*parallelTestArgs\(\s*plan\s*\.parallel,\s*\{\s*coverage,\s*summaryFile,?\s*\},?\s*\),?\s*\)/,
  );
});

test('the unfinished-tests reporter lists queued tests that never passed or failed', async () => {
  const file = '/repo/src/a.test.mjs';
  const events = [
    {
      type: 'test:enqueue',
      data: { file, name: 'src/a.test.mjs', nesting: 0 },
    },
    { type: 'test:enqueue', data: { file, name: 'one', nesting: 0 } },
    { type: 'test:enqueue', data: { file, name: 'twin', nesting: 0 } },
    { type: 'test:enqueue', data: { file, name: 'twin', nesting: 0 } },
    { type: 'test:pass', data: { file, name: 'one', nesting: 0 } },
    { type: 'test:fail', data: { file, name: 'twin', nesting: 0 } },
    {
      type: 'test:complete',
      data: { file, name: 'src/a.test.mjs', nesting: 0 },
    },
  ];
  async function* source() {
    yield* events;
  }
  let output = '';
  for await (const chunk of unfinishedTestsReporter(source())) output += chunk;
  assert.deepEqual(JSON.parse(output), {
    unfinished: [{ file, name: 'twin' }],
  });
});

test('a test file whose process stops early fails the run instead of dropping tests', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'gev-early-exit-'));
  try {
    const file = path.join(directory, 'early-exit.test.mjs');
    writeFileSync(
      file,
      [
        "import { test } from 'node:test';",
        "test('one', () => {});",
        "test('two', () => {});",
        "test('three stops the process', () => { setImmediate(() => process.exit(0)); });",
        "test('four', async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });",
        "test('five', () => {});",
        '',
      ].join('\n'),
    );
    const { status, unfinished } = runCheckedTests(
      (summaryFile) => [
        '--test',
        ...unitTestFlags(),
        ...reporterFlags(summaryFile),
        file,
      ],
      { stdio: 'pipe', env: nestedTestEnv(), log: () => {} },
    );
    assert.equal(status, 1);
    assert.deepEqual(unfinished.map(({ name }) => name).sort(), [
      'five',
      'four',
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a hung test fails at its deadline', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'gev-hung-test-'));
  try {
    const file = path.join(directory, 'hung.test.mjs');
    writeFileSync(
      file,
      [
        "import { test } from 'node:test';",
        "test('never settles in time', () => new Promise((resolve) => setTimeout(resolve, 3_000)));",
        "test('runs after it', () => {});",
        '',
      ].join('\n'),
    );
    const started = Date.now();
    const result = spawnSync(
      process.execPath,
      ['--test', ...unitTestFlags({ timeoutMs: 500 }), file],
      {
        encoding: 'utf8',
        env: nestedTestEnv(),
        timeout: 30_000,
      },
    );
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.signal, null, 'the run ended on its own');
    assert.equal(result.status, 1, output);
    assert.match(output, /test timed out after 500ms/);
    assert.ok(
      Date.now() - started < 15_000,
      'it failed at the deadline, not at the guard',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the Windows job runs the DACL test, with the same deadline', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );
  const job = workflow.slice(workflow.indexOf('\n  windows-onboarding:'));
  const command = /run: (node --test [^\n]+)/.exec(job)?.[1];
  assert.ok(command, 'the Windows job runs node --test');
  const args = command.split(/\s+/);
  for (const flag of unitTestFlags())
    assert.ok(args.includes(flag), `${flag} is passed`);
  assert.equal(
    args.includes('--test-force-exit'),
    false,
    'force-exit can drop tests',
  );
  assert.ok(
    args.includes('server/keySetupHardening.test.mjs'),
    'the real DACL check only runs on Windows',
  );
  const root = fileURLToPath(new URL('..', import.meta.url));
  for (const file of args.filter((arg) => arg.endsWith('.test.mjs'))) {
    assert.ok(existsSync(path.join(root, file)), `${file} exists`);
  }
});

test('the suite runs whole by default, or either half on its own', () => {
  assert.deepEqual(parseUnitTestArgs([]), {
    parallel: true,
    allocations: true,
    coverage: false,
  });
  assert.deepEqual(parseUnitTestArgs(['--skip-allocations']), {
    parallel: true,
    allocations: false,
    coverage: false,
  });
  assert.deepEqual(parseUnitTestArgs(['--allocations-only']), {
    parallel: false,
    allocations: true,
    coverage: false,
  });
  assert.deepEqual(parseUnitTestArgs(['--skip-allocations', '--coverage']), {
    parallel: true,
    allocations: false,
    coverage: true,
  });
  assert.deepEqual(parseUnitTestArgs(['--coverage']), {
    parallel: true,
    allocations: true,
    coverage: true,
  });
  assert.throws(() => parseUnitTestArgs(['--allocation-only']), /Usage/);
  assert.throws(
    () => parseUnitTestArgs(['--skip-allocations', '--allocations-only']),
    /Usage/,
  );
  assert.throws(
    () => parseUnitTestArgs(['--allocations-only', '--coverage']),
    /Usage/,
    'coverage skews allocations',
  );
  assert.throws(() => parseUnitTestArgs(['--coverage', '--coverage']), /Usage/);
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  assert.equal(
    pkg.scripts['test:allocations'],
    'node scripts/run-unit-tests.mjs --allocations-only',
  );
});

test('CI runs the allocation microbenchmarks in their own job, on the calibrated runtime', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );
  const jobs = workflow.slice(workflow.indexOf('\njobs:\n'));
  const section = (name) => {
    const start = jobs.indexOf(`\n  ${name}:\n`);
    assert.notEqual(start, -1, `the ${name} job exists`);
    const next = jobs.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/);
    return next === -1
      ? jobs.slice(start)
      : jobs.slice(start, start + 1 + next);
  };
  const verify = section('verify');
  assert.match(
    verify,
    /run: node scripts\/run-unit-tests\.mjs --skip-allocations\n/,
  );
  assert.doesNotMatch(verify, /GEV_REQUIRE_ALLOCATION_GATE/);
  const allocations = section('allocation-budgets');
  assert.match(allocations, /node-version: 24\./);
  assert.match(allocations, /GEV_REQUIRE_ALLOCATION_GATE: '1'/);
  assert.match(allocations, /run: pnpm run test:allocations\n/);
});

test('coverage measures the parallel tests into an lcov report, and CI publishes it', () => {
  assert.deepEqual(
    parallelTestArgs(['a.test.mjs'], { coverage: true, summaryFile: 's.json' }),
    [
      '--test',
      ...unitTestFlags(),
      '--experimental-test-coverage',
      ...reporterFlags('s.json', { coverage: true }),
      'a.test.mjs',
    ],
  );
  assert.ok(
    reporterFlags('s.json', { coverage: true }).includes(
      '--test-reporter-destination=coverage/lcov.info',
    ),
  );
  assert.equal(reporterFlags('s.json').includes('--test-reporter=lcov'), false);
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  assert.match(
    pkg.scripts['test:coverage'],
    /--skip-allocations --coverage && node scripts\/coverage-summary\.mjs$/,
  );
  const workflow = readFileSync(
    new URL('../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );
  const verify = workflow.slice(
    workflow.indexOf('\n  verify:\n'),
    workflow.indexOf('\n  allocation-budgets:\n'),
  );
  assert.match(
    verify,
    /run: node scripts\/run-unit-tests\.mjs --skip-allocations --coverage\n/,
  );
  assert.match(
    verify,
    /run: node scripts\/coverage-summary\.mjs coverage\/lcov\.info >> "\$GITHUB_STEP_SUMMARY"\n/,
  );
  assert.match(
    verify,
    /uses: actions\/upload-artifact@[0-9a-f]{40} # v\d+\.\d+\.\d+\n/,
  );
  assert.match(verify, /path: coverage\/lcov\.info\n/);
});
