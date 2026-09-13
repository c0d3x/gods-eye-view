import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CCTV_FRAME_FETCH_TIMEOUT_MS,
  fetchCctvImageFromUpstream,
} from '../../vite.config.js';

// Feed cameras must resolve to public addresses; this stands in for DNS.
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

test('CCTV upstream frame fetch supplies a bounded abort signal', async () => {
  let observedSignal = null;
  const startedAt = Date.now();
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 20,
    lookup: publicLookup,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      observedSignal = options.signal;
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }),
  });

  assert.equal(result, null);
  assert.ok(observedSignal instanceof AbortSignal);
  assert.equal(observedSignal.aborted, true);
  assert.ok(Date.now() - startedAt < 500, 'test timeout should settle promptly');
  assert.ok(CCTV_FRAME_FETCH_TIMEOUT_MS < 10_000, 'production timeout must beat the active refresh cadence');
});

test('CCTV upstream frame fetch returns a valid image response', async () => {
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 100,
    lookup: publicLookup,
    fetchImpl: async () => new Response(Uint8Array.from([1, 2, 3]), {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg' },
    }),
  });

  assert.equal(result?.ok, true);
  assert.equal(result?.contentType, 'image/jpeg');
  assert.deepEqual(result?.body, Buffer.from([1, 2, 3]));
});

test('CCTV upstream frame fetch refuses an SVG, which can carry script', async () => {
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.svg', {
    timeoutMs: 100,
    lookup: publicLookup,
    fetchImpl: async () => new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', {
      status: 200,
      headers: { 'Content-Type': 'image/svg+xml' },
    }),
  });

  assert.equal(result, null);
});

test('CCTV upstream frame fetch refuses a feed camera on a private address', async () => {
  let fetched = false;
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 100,
    lookup: async () => [{ address: '10.0.0.5', family: 4 }],
    fetchImpl: async () => {
      fetched = true;
      return new Response('never');
    },
  });

  assert.equal(result, null);
  assert.equal(fetched, false);
});
