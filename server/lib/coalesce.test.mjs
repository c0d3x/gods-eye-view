import assert from 'node:assert/strict';
import test from 'node:test';
import { coalesceProxyRequest } from './coalesce.mjs';

test('callers of one key share its in-flight request', async () => {
  const inFlight = new Map();
  const first = coalesceProxyRequest(inFlight, 'k', () => 'value');
  const second = coalesceProxyRequest(inFlight, 'k', () => 'other');
  assert.equal(first.shared, false);
  assert.equal(second.shared, true);
  assert.equal(second.promise, first.promise);
  assert.equal(await first.promise, 'value');
  assert.equal(inFlight.has('k'), false, 'a settled request frees its key');

  const third = coalesceProxyRequest(inFlight, 'k', () => 'fresh');
  assert.equal(third.shared, false);
  assert.equal(await third.promise, 'fresh');
});

test('a failed request frees its key too', async () => {
  const inFlight = new Map();
  const { promise } = coalesceProxyRequest(inFlight, 'k', () => {
    throw new Error('upstream down');
  });
  await assert.rejects(promise, /upstream down/);
  assert.equal(inFlight.size, 0);
});

test('a settling request leaves a newer one for the same key alone', async () => {
  const inFlight = new Map();
  const old = coalesceProxyRequest(inFlight, 'k', () => 'old');
  const newer = Promise.resolve('newer');
  inFlight.set('k', newer);
  await old.promise;
  assert.equal(inFlight.get('k'), newer);
});
