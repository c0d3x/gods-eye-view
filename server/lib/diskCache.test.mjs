import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCachePruner, pruneCacheDirectory } from './diskCache.mjs';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 13, 12);

async function cacheDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'gev-disk-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** Write `size` bytes to `name`, last modified `ageMs` before NOW. */
async function put(directory, name, size, ageMs) {
  const file = path.join(directory, name);
  await writeFile(file, Buffer.alloc(size));
  const seconds = (NOW - ageMs) / 1000;
  await utimes(file, seconds, seconds);
}

async function names(directory) {
  return (await readdir(directory)).sort();
}

test('removes files older than the age limit', async (t) => {
  const directory = await cacheDirectory(t);
  await put(directory, 'old.json', 10, 8 * DAY);
  await put(directory, 'fresh.json', 10, DAY);
  assert.deepEqual(
    await pruneCacheDirectory(directory, {
      maxAgeMs: 7 * DAY,
      maxBytes: 1000,
      now: NOW,
    }),
    { removed: 1, bytes: 10 },
  );
  assert.deepEqual(await names(directory), ['fresh.json']);
});

test('removes the least recently modified files until under the size limit', async (t) => {
  const directory = await cacheDirectory(t);
  await put(directory, 'a.json', 400, 3 * DAY);
  await put(directory, 'b.json', 400, 2 * DAY);
  await put(directory, 'c.json', 400, DAY);
  assert.deepEqual(
    await pruneCacheDirectory(directory, {
      maxAgeMs: 30 * DAY,
      maxBytes: 900,
      now: NOW,
    }),
    { removed: 1, bytes: 800 },
  );
  assert.deepEqual(await names(directory), ['b.json', 'c.json']);
});

test('kept names and subdirectories are never touched', async (t) => {
  const directory = await cacheDirectory(t);
  await put(directory, 'budget.json', 50, 90 * DAY);
  await put(directory, 'flow-1-2-3.pbf', 50, 90 * DAY);
  await mkdir(path.join(directory, 'nested'));
  await pruneCacheDirectory(directory, {
    maxAgeMs: DAY,
    maxBytes: 0,
    keep: ['budget.json'],
    now: NOW,
  });
  assert.deepEqual(await names(directory), ['budget.json', 'nested']);
});

test('a missing directory is not an error', async (t) => {
  const directory = await cacheDirectory(t);
  assert.deepEqual(
    await pruneCacheDirectory(path.join(directory, 'absent'), {
      maxAgeMs: DAY,
      maxBytes: 0,
      now: NOW,
    }),
    { removed: 0, bytes: 0 },
  );
});

test('the pruner runs on demand, then at most once per interval after writes', async (t) => {
  const directory = await cacheDirectory(t);
  let clock = NOW;
  const pruner = createCachePruner({
    directory,
    maxAgeMs: DAY,
    maxBytes: 1000,
    intervalMs: 600_000,
    now: () => clock,
  });
  await put(directory, 'one.json', 10, 2 * DAY);
  await pruner.runNow();
  assert.deepEqual(await names(directory), []);

  await put(directory, 'two.json', 10, 2 * DAY);
  clock += 599_999;
  assert.equal(pruner.afterWrite(), null);
  assert.deepEqual(await names(directory), ['two.json']);

  clock += 1;
  await pruner.afterWrite();
  assert.deepEqual(await names(directory), []);
});

test('pruning failures are logged, not thrown', async (t) => {
  const directory = await cacheDirectory(t);
  const notADirectory = path.join(directory, 'not-a-directory');
  await writeFile(notADirectory, 'x');
  const logged = [];
  const pruner = createCachePruner({
    directory: notADirectory,
    maxAgeMs: DAY,
    maxBytes: 0,
    log: (message) => logged.push(message),
  });
  assert.deepEqual(await pruner.runNow(), { removed: 0, bytes: 0 });
  assert.equal(logged.length, 1);
  assert.match(logged[0], /Pruning not-a-directory failed/);
});
