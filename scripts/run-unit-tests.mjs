import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ALLOCATION_TEST_FILES = Object.freeze([
  'src/data/focusAllocations.test.mjs',
  'src/overlays/worldOverlayAllocation.test.mjs',
]);

/** Whether this runtime matches the one the allocation budgets were calibrated on. */
export function isCalibratedAllocationRuntime(version = process.versions.node) {
  return Number.parseInt(String(version).split('.')[0], 10) === 24;
}

/** Require the runtime on which allocation budgets were calibrated. */
export function assertNode24AllocationRuntime(version = process.versions.node) {
  if (!isCalibratedAllocationRuntime(version)) {
    throw new Error(`Allocation budgets require the calibrated Node 24 runtime; received ${version}`);
  }
  return version;
}

/**
 * Per-test deadline. The slowest test takes about 5 s, so this is generous
 * even on a slow runner; a hung test fails here instead of holding the job.
 */
export const UNIT_TEST_TIMEOUT_MS = 60_000;

/**
 * Flags every unit-test run passes: the per-test deadline. Not
 * --test-force-exit, which ends a test file's process as soon as Node
 * decides its tests are done; a file cut short reports only the tests it
 * reached, and passes.
 */
export function unitTestFlags({ timeoutMs = UNIT_TEST_TIMEOUT_MS } = {}) {
  return [`--test-timeout=${timeoutMs}`];
}

/** Directories whose `*.test.mjs` files make up the unit suite. */
export const UNIT_TEST_ROOTS = Object.freeze(['src', 'server']);

/** Discover repository unit tests in stable path order. */
export function discoverUnitTestFiles(root = process.cwd()) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
        files.push(path.relative(root, absolute).split(path.sep).join('/'));
      }
    }
  };
  const present = new Set(
    readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  );
  for (const name of UNIT_TEST_ROOTS) {
    if (present.has(name)) visit(path.join(root, name));
  }
  return files.sort();
}

/** Partition ordinary parallel tests from the two GC-bracketed probes. */
export function buildUnitTestPlan(files) {
  const known = new Set(files);
  const missingAllocationTests = ALLOCATION_TEST_FILES.filter((file) => !known.has(file));
  if (missingAllocationTests.length) {
    throw new Error(`Missing allocation microbenchmarks: ${missingAllocationTests.join(', ')}`);
  }
  const allocationSet = new Set(ALLOCATION_TEST_FILES);
  return {
    parallel: files.filter((file) => !allocationSet.has(file)).sort(),
    serializedAllocations: [...ALLOCATION_TEST_FILES],
  };
}

/** Build the isolated Node invocation for one GC-bracketed allocation probe. */
export function allocationTestArgs(file, { summaryFile } = {}) {
  if (!ALLOCATION_TEST_FILES.includes(file)) {
    throw new Error(`Not an allocation microbenchmark: ${file}`);
  }
  return [
    '--expose-gc', '--test', '--test-concurrency=1', ...unitTestFlags(),
    ...reporterFlags(summaryFile), file,
  ];
}

/** The reporter that lists queued tests that never finished. */
export const UNFINISHED_TESTS_REPORTER = new URL('./lib/unfinishedTestsReporter.mjs', import.meta.url).href;

/**
 * Runs node with the arguments `buildArgs(summaryFile)` returns, then fails
 * the run if any test was queued but never finished: Node counts a test file
 * whose process stopped early as passing, with only the tests it reached.
 * @returns {{ status: number, unfinished: { file: string, name: string }[] }}
 */
export function runCheckedTests(buildArgs, { stdio = 'inherit', env = process.env, log = console.error } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'gev-unit-'));
  const summaryFile = path.join(directory, 'unfinished.json');
  try {
    const result = spawnSync(process.execPath, buildArgs(summaryFile), {
      cwd: process.cwd(),
      stdio,
      env,
    });
    if (result.error) throw result.error;
    const status = result.status ?? 1;
    // No report means the run itself broke off; its status says how.
    if (!existsSync(summaryFile)) return { status: status || 1, unfinished: [] };
    const { unfinished } = JSON.parse(readFileSync(summaryFile, 'utf8'));
    if (unfinished.length === 0) return { status, unfinished };
    log(`[unit] ${unfinished.length} queued tests never finished; their file's process stopped early:`);
    for (const { file, name } of unfinished.slice(0, 20)) {
      log(`  ${path.relative(process.cwd(), file || '')} :: ${name}`);
    }
    return { status: 1, unfinished };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Command-line modes. CI runs the two halves of the suite as separate jobs. */
export const UNIT_TEST_MODES = Object.freeze({
  '--skip-allocations': Object.freeze({ parallel: true, allocations: false }),
  '--allocations-only': Object.freeze({ parallel: false, allocations: true }),
});

/** Where `--coverage` writes lcov.info. */
export const COVERAGE_DIRECTORY = 'coverage';

/**
 * Reporters for one run: spec results on stdout, an lcov report when
 * measuring coverage, and the list of queued tests that never finished,
 * written to `summaryFile`.
 */
export function reporterFlags(summaryFile, { coverage = false } = {}) {
  return [
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    ...(coverage
      ? ['--test-reporter=lcov', `--test-reporter-destination=${COVERAGE_DIRECTORY}/lcov.info`]
      : []),
    `--test-reporter=${UNFINISHED_TESTS_REPORTER}`,
    `--test-reporter-destination=${summaryFile}`,
  ];
}

/** The Node invocation for the parallel tests. */
export function parallelTestArgs(files, { coverage = false, summaryFile } = {}) {
  return [
    '--test',
    ...unitTestFlags(),
    ...(coverage ? ['--experimental-test-coverage'] : []),
    ...reporterFlags(summaryFile, { coverage }),
    ...files,
  ];
}

/**
 * Which parts of the suite to run. With no arguments, both halves: the
 * parallel tests, then the allocation microbenchmarks. `--coverage` measures
 * the parallel tests only; it would skew the microbenchmarks' allocations.
 * @param {string[]} argv - Arguments after the script path.
 * @returns {{ parallel: boolean, allocations: boolean, coverage: boolean }}
 */
export function parseUnitTestArgs(argv = []) {
  const flags = new Set(argv);
  const coverage = flags.delete('--coverage');
  const modes = [...flags];
  const mode = modes.length === 0
    ? { parallel: true, allocations: true }
    : UNIT_TEST_MODES[modes[0]];
  const repeated = flags.size + Number(coverage) !== argv.length;
  if (!mode || modes.length > 1 || repeated || (coverage && !mode.parallel)) {
    throw new Error(
      `Usage: node scripts/run-unit-tests.mjs [${Object.keys(UNIT_TEST_MODES).join(' | ')}] [--coverage]`,
    );
  }
  return { ...mode, coverage };
}

export function runUnitTests({ parallel = true, allocations = true, coverage = false } = {}) {
  const plan = buildUnitTestPlan(discoverUnitTestFiles());
  if (parallel) {
    if (coverage) mkdirSync(COVERAGE_DIRECTORY, { recursive: true });
    const { status } = runCheckedTests((summaryFile) => parallelTestArgs(plan.parallel, { coverage, summaryFile }));
    if (status !== 0 || !allocations) return status;
  }

  // The GC-bracketed budgets are calibrated on Node 24 and are meaningless on
  // other allocators. A contributor's suite must stay green on any supported
  // engine (package.json permits >=24), so uncalibrated runtimes skip the
  // probes with a warning. Set GEV_REQUIRE_ALLOCATION_GATE=1 (pinned CI /
  // release batteries) to make an uncalibrated runtime a hard failure.
  if (!isCalibratedAllocationRuntime()) {
    if (process.env.GEV_REQUIRE_ALLOCATION_GATE === '1') {
      assertNode24AllocationRuntime();
    }
    console.warn(
      `[unit] SKIPPED ${ALLOCATION_TEST_FILES.length} allocation microbenchmarks: `
      + `budgets are calibrated for Node 24, running ${process.versions.node}. `
      + 'Run under Node 24 (or set GEV_REQUIRE_ALLOCATION_GATE=1 to fail instead).',
    );
    return 0;
  }
  for (const file of plan.serializedAllocations) {
    const { status } = runCheckedTests((summaryFile) => allocationTestArgs(file, { summaryFile }));
    if (status !== 0) return status;
  }
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  let options;
  try {
    options = parseUnitTestArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  process.exitCode = runUnitTests(options);
}
