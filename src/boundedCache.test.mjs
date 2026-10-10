import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoundedCache } from '../server/providers/common/bounded-cache.js';

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

test('without a time to live, entries stay until the cap evicts them', () => {
  const clock = clockAt(0);
  const cache = createBoundedCache({ maxEntries: 2, now: clock.now });
  cache.set('a', 1);
  clock.time = Number.MAX_SAFE_INTEGER;
  assert.equal(cache.get('a'), 1);
  cache.set('b', 2);
  cache.set('c', 3);
  assert.equal(cache.get('a'), undefined);
  assert.deepEqual(
    [...cache.entries()],
    [
      ['b', 2],
      ['c', 3],
    ],
  );
});

test('evicts the least recently used entry once full', () => {
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

test('reading or storing a key again makes it the most recently used', () => {
  const cache = createBoundedCache({
    maxEntries: 2,
    ttlMs: 1000,
    now: () => 0,
  });
  cache.set('a', 1);
  cache.set('b', 2);
  // A point a request just read must outlive the points stored after it.
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);

  cache.set('c', 30);
  cache.set('d', 4);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('c'), 30);
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
  clock.time = 100;
  cache.set('c', 3);
  assert.equal(cache.size, 1);
});

test('entries() lists fresh entries only, least recently used first', () => {
  const clock = clockAt(0);
  const cache = createBoundedCache({
    maxEntries: 10,
    ttlMs: 100,
    now: clock.now,
  });
  cache.set('a', 1);
  clock.time = 50;
  cache.set('b', 2);
  cache.set('c', 3);
  cache.get('b');
  clock.time = 100;
  assert.deepEqual(Object.fromEntries(cache.entries()), { c: 3, b: 2 });
  assert.deepEqual(
    [...cache.entries()].map(([key]) => key),
    ['c', 'b'],
  );
});

test('rejects a cap or time to live that would not bound anything', () => {
  for (const maxEntries of [0, -1, 1.5, Number.NaN, undefined]) {
    assert.throws(
      () => createBoundedCache({ maxEntries, ttlMs: 1 }),
      RangeError,
    );
  }
  for (const ttlMs of [0, -1, Number.NaN]) {
    assert.throws(
      () => createBoundedCache({ maxEntries: 1, ttlMs }),
      RangeError,
    );
  }
});
