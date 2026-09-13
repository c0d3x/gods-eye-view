import { mkdirSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
 * Flags every unit-test run passes: the per-test deadline, and force-exit so
 * that timers or sockets a timed-out test left behind can't keep its file's
 * process alive.
 */
export function unitTestFlags({ timeoutMs = UNIT_TEST_TIMEOUT_MS } = {}) {
  return [`--test-timeout=${timeoutMs}`, '--test-force-exit'];
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
export function allocationTestArgs(file) {
  if (!ALLOCATION_TEST_FILES.includes(file)) {
    throw new Error(`Not an allocation microbenchmark: ${file}`);
  }
  return ['--expose-gc', '--test', '--test-concurrency=1', ...unitTestFlags(), file];
}

function runTests(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/** Command-line modes. CI runs the two halves of the suite as separate jobs. */
export const UNIT_TEST_MODES = Object.freeze({
  '--skip-allocations': Object.freeze({ parallel: true, allocations: false }),
  '--allocations-only': Object.freeze({ parallel: false, allocations: true }),
});

/** Where `--coverage` writes lcov.info. */
export const COVERAGE_DIRECTORY = 'coverage';

/**
 * Flags that measure the parallel tests' coverage: spec results on stdout,
 * and an lcov report for tools and the CI summary.
 */
export function coverageFlags(directory = COVERAGE_DIRECTORY) {
  return [
    '--experimental-test-coverage',
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test-reporter=lcov',
    `--test-reporter-destination=${directory}/lcov.info`,
  ];
}

/** The Node invocation for the parallel tests. */
export function parallelTestArgs(files, { coverage = false } = {}) {
  return ['--test', ...unitTestFlags(), ...(coverage ? coverageFlags() : []), ...files];
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
    const parallelStatus = runTests(parallelTestArgs(plan.parallel, { coverage }));
    if (parallelStatus !== 0 || !allocations) return parallelStatus;
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
    const status = runTests(allocationTestArgs(file));
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
