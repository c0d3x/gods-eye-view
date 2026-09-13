import assert from 'node:assert/strict';
import test from 'node:test';
import {
  UpstreamTimeoutError,
  upstreamErrorMessage,
} from '../lib/fetchWithTimeout.mjs';
import { adsbLolProxy } from './adsbLol.mjs';

const MIL_URL = 'https://api.adsb.lol/v2/mil';
const FEED = '{"ac":[{"hex":"ae1234","flight":"RCH123"}],"now":1800000000000}';

function mount() {
  const routes = new Map();
  adsbLolProxy().configureServer({
    middlewares: { use: (prefix, handler) => routes.set(prefix, handler) },
  });
  return routes.get('/api/adsblol/mil');
}

function request(handler) {
  return new Promise((resolve, reject) => {
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        resolve({
          status: this.status,
          headers: this.headers,
          body: String(body ?? ''),
        });
      },
    };
    Promise.resolve(handler({ method: 'GET', url: '/', headers: {} }, res)).catch(
      reject,
    );
  });
}

test('a miss fetches the military feed, then the cache answers for 12 s', async (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const fetchMock = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(FEED),
  );
  const handler = mount();
  const miss = await request(handler);
  assert.equal(miss.status, 200);
  assert.equal(miss.headers['X-ADS-B-Cache'], 'MISS');
  assert.equal(miss.headers['Cache-Control'], 'no-store');
  assert.equal(miss.body, FEED);
  const [url, init] = fetchMock.mock.calls[0].arguments;
  assert.equal(String(url), MIL_URL);
  assert.equal(init.headers['User-Agent'], 'gods-eye-view-adsblol-proxy/1.0');

  now += 11_999;
  const hit = await request(handler);
  assert.equal(hit.headers['X-ADS-B-Cache'], 'HIT');
  assert.equal(hit.body, FEED);
  assert.equal(fetchMock.mock.callCount(), 1);
  now += 1;
  await request(handler);
  assert.equal(fetchMock.mock.callCount(), 2);
});

test('a failed feed answers with its status in our words, and is not cached', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const fetchMock = t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response('<html>adsb.lol exploded</html>', { status: 503 }),
  );
  const handler = mount();
  const failed = await request(handler);
  assert.equal(failed.status, 503);
  assert.deepEqual(JSON.parse(failed.body), {
    error: upstreamErrorMessage('adsb.lol', 503),
  });
  assert.doesNotMatch(failed.body, /exploded|<html>/);
  assert.equal(warn.mock.callCount(), 1, 'the detail goes to the server log');
  await request(handler);
  assert.equal(fetchMock.mock.callCount(), 2, 'a failure is not cached');
});

test('an outage serves the last good feed as STALE, and fails without one', async (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'error', () => {});
  let failure = null;
  t.mock.method(globalThis, 'fetch', async () => {
    if (failure) throw failure;
    return new Response(FEED);
  });
  const handler = mount();
  await request(handler);
  now += 20_000;
  failure = new Error('socket hang up');
  const stale = await request(handler);
  assert.equal(stale.status, 200);
  assert.equal(stale.headers['X-ADS-B-Cache'], 'STALE');
  assert.equal(stale.body, FEED);

  const cold = mount();
  failure = new UpstreamTimeoutError(12_000);
  const late = await request(cold);
  assert.equal(late.status, 504);
  assert.deepEqual(JSON.parse(late.body), { error: 'ADS-B proxy error' });
  failure = new Error('connect ECONNREFUSED 127.0.0.1:443');
  assert.equal((await request(cold)).status, 502);
});
