import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoundedCache } from './boundedCache.mjs';

function clockAt(start) {
  const clock = { time: start, now: () => clock.time };
  return clock;
}

test('returns stored values until they expire', () => {
  const clock = clockAt(1000);
  const cache = createBoundedCache({
    maxEntries: 4,
    ttlMs: 100,
    now: clock.now,
  });
  assert.equal(cache.set('a', 1), 1);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('missing'), undefined);
  clock.time = 1099;
  assert.equal(cache.get('a'), 1);
  clock.time = 1100;
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.size, 0);
});

test('evicts the oldest entry once full', () => {
  const cache = createBoundedCache({
    maxEntries: 3,
    ttlMs: 1000,
    now: () => 0,
  });
  for (const key of ['a', 'b', 'c', 'd']) cache.set(key, key);
  assert.equal(cache.size, 3);
  assert.equal(cache.get('a'), undefined);
  assert.deepEqual(
    ['b', 'c', 'd'].map((key) => cache.get(key)),
    ['b', 'c', 'd'],
  );
});

test('reading keeps an entry in place; storing it again makes it the newest', () => {
  const cache = createBoundedCache({
    maxEntries: 2,
    ttlMs: 1000,
    now: () => 0,
  });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a');
  cache.set('c', 3);
  assert.equal(cache.get('a'), undefined);

  cache.set('b', 20);
  cache.set('d', 4);
  assert.equal(cache.get('c'), undefined);
  assert.equal(cache.get('b'), 20);
  assert.equal(cache.get('d'), 4);
});

test('storing a key again restarts its time to live', () => {
  const clock = clockAt(0);
  const cache = createBoundedCache({
    maxEntries: 2,
    ttlMs: 100,
    now: clock.now,
  });
  cache.set('a', 1);
  clock.time = 60;
  cache.set('a', 2);
  clock.time = 159;
  assert.equal(cache.get('a'), 2);
  clock.time = 160;
  assert.equal(cache.get('a'), undefined);
});

test('writes drop expired entries so they stop holding memory', () => {
  const clock = clockAt(0);
  const cache = createBoundedCache({
    maxEntries: 10,
    ttlMs: 100,
    now: clock.now,
  });
  cache.set('a', 1);
  cache.set('b', 2);
  clock.time = 50;
  cache.set('c', 3);
  clock.time = 120;
  cache.set('d', 4);
  assert.equal(cache.size, 2);
  assert.equal(cache.get('c'), 3);
  assert.equal(cache.get('d'), 4);
});

test('delete and clear remove entries', () => {
  const cache = createBoundedCache({
    maxEntries: 4,
    ttlMs: 1000,
    now: () => 0,
  });
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.delete('a'), true);
  assert.equal(cache.delete('a'), false);
  assert.equal(cache.get('a'), undefined);
  cache.clear();
  assert.equal(cache.size, 0);
});

test('rejects bounds that would leave the cache unbounded or empty', () => {
  for (const options of [
    { maxEntries: 0, ttlMs: 100 },
    { maxEntries: 1.5, ttlMs: 100 },
    { maxEntries: Number.POSITIVE_INFINITY, ttlMs: 100 },
    { maxEntries: 10, ttlMs: 0 },
    { maxEntries: 10 },
  ]) {
    assert.throws(
      () => createBoundedCache(options),
      RangeError,
      JSON.stringify(options),
    );
  }
});

test('the default clock reads Date.now() at call time', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const cache = createBoundedCache({ maxEntries: 1, ttlMs: 1000 });
  cache.set('a', 1);
  t.mock.timers.tick(999);
  assert.equal(cache.get('a'), 1);
  t.mock.timers.tick(1);
  assert.equal(cache.get('a'), undefined);
});
