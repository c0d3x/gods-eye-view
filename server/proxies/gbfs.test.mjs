import assert from 'node:assert/strict';
import test from 'node:test';
import {
  UpstreamTimeoutError,
  upstreamErrorMessage,
} from '../lib/fetchWithTimeout.mjs';
import { gbfsProxy } from './gbfs.mjs';

function route() {
  const routes = new Map();
  gbfsProxy().configureServer({
    middlewares: { use: (mount, handler) => routes.set(mount, handler) },
  });
  return routes.get('/api/gbfs');
}

/** One request for `target`, the part of the URL after /api/gbfs/. */
function request(handler, { method = 'GET', target = '' } = {}) {
  const req = { method, url: `/${target}`, headers: {} };
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
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

/** The client sends the feed URL encoded as one path segment. */
const feed = (url) => encodeURIComponent(url);
const STATUS_FEED = 'https://gbfs.lyft.com/gbfs/2.3/bkn/en/station_status.json';
const INFO_FEED =
  'https://gbfs.lyft.com/gbfs/2.3/bkn/en/station_information.json';

const noUpstream = async () => {
  throw new Error('no upstream call expected');
};

test('only a GET is answered', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', noUpstream);
  const answer = await request(route(), {
    method: 'POST',
    target: feed(STATUS_FEED),
  });
  assert.equal(answer.status, 405);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('a target that is not an allowed https station feed is refused unfetched', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', noUpstream);
  const handler = route();
  const cases = [
    ['', 400, 'Missing GBFS upstream target'],
    ['%E0%A4%A', 400, 'Invalid GBFS target encoding'],
    [feed('not a url'), 400, 'Invalid GBFS upstream URL'],
    [
      feed(STATUS_FEED.replace('https:', 'http:')),
      400,
      'Only https GBFS targets are allowed',
    ],
    [
      feed('https://gbfs.example.com/en/station_status.json'),
      403,
      'GBFS host not allowed',
    ],
    [
      feed('https://evilpublicbikesystem.net/en/station_status.json'),
      403,
      'GBFS host not allowed',
    ],
    [
      feed('https://gbfs.lyft.com/gbfs/2.3/bkn/en/free_bike_status.json'),
      400,
      'Only station_information/station_status endpoints are allowed',
    ],
  ];
  for (const [target, status, error] of cases) {
    const answer = await request(handler, { target });
    assert.equal(answer.status, status, target);
    assert.deepEqual(JSON.parse(answer.body), { error }, target);
    assert.equal(answer.headers['Cache-Control'], 'no-store', target);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('an allowed feed is relayed with a cache policy per endpoint', async (t) => {
  const body = '{"data":{"stations":[]}}';
  const fetchMock = t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(body, {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
  );
  const handler = route();

  const info = await request(handler, { target: feed(INFO_FEED) });
  assert.equal(info.status, 200);
  assert.equal(info.body, body);
  assert.equal(info.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(info.headers['Cache-Control'], 'public, max-age=300');
  assert.equal(info.headers['X-GBFS-Upstream'], 'gbfs.lyft.com');
  assert.equal(info.headers['X-GBFS-Cache'], 'MISS');
  const [url, init] = fetchMock.mock.calls[0].arguments;
  assert.equal(String(url), INFO_FEED);
  assert.equal(init.headers['User-Agent'], 'gods-eye-view-gbfs-proxy/1.0');

  const status = await request(handler, { target: feed(STATUS_FEED) });
  assert.equal(status.headers['Cache-Control'], 'no-store');

  // Every publicbikesystem.net city feed is allowed.
  const city = await request(handler, {
    target: feed(
      'https://toronto.publicbikesystem.net/customer/gbfs/v2/en/station_status.json',
    ),
  });
  assert.equal(city.status, 200);
  assert.equal(city.headers['X-GBFS-Upstream'], 'toronto.publicbikesystem.net');
});

test('a failed feed answers with its status and none of its text', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('<html>feed exploded</html>', { status: 503 }),
  );
  const answer = await request(route(), { target: feed(STATUS_FEED) });
  assert.equal(answer.status, 503);
  assert.deepEqual(JSON.parse(answer.body), {
    error: upstreamErrorMessage('GBFS feed', 503),
  });
  assert.doesNotMatch(answer.body, /exploded|<html>/);
});

test('a feed over 5 MB is refused', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('x'.repeat(5 * 1024 * 1024 + 1)),
  );
  const answer = await request(route(), { target: feed(STATUS_FEED) });
  assert.equal(answer.status, 502);
  assert.deepEqual(JSON.parse(answer.body), {
    error: 'GBFS upstream response too large',
  });
});

test('a timeout answers 504, and any other failure a generic 502', async (t) => {
  const handler = route();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new UpstreamTimeoutError(12_000);
  });
  const late = await request(handler, { target: feed(STATUS_FEED) });
  assert.equal(late.status, 504);
  assert.deepEqual(JSON.parse(late.body), { error: 'GBFS upstream timeout' });

  const logged = t.mock.method(console, 'error', () => {});
  fetchMock.mock.mockImplementation(async () => {
    throw new Error('connect ECONNREFUSED 10.0.0.7:443');
  });
  const failed = await request(handler, { target: feed(STATUS_FEED) });
  assert.equal(failed.status, 502);
  assert.deepEqual(JSON.parse(failed.body), { error: 'GBFS proxy error' });
  assert.equal(logged.mock.callCount(), 1, 'the detail goes to the server log');
});
