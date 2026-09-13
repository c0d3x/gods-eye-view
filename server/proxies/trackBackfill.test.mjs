import assert from 'node:assert/strict';
import test from 'node:test';
import { trackBackfillProxies } from './trackBackfill.mjs';

const TRACK =
  '{"icao24":"abc123","path":[[1800000000,60.5,10.25,3000,90,false]]}';
const CLIENT_ENV = ['OPENSKY_CLIENT_ID', 'OPENSKY_CLIENT_SECRET'];

function mount() {
  const routes = new Map();
  trackBackfillProxies().configureServer({
    middlewares: { use: (prefix, handler) => routes.set(prefix, handler) },
  });
  return {
    openSky: routes.get('/api/opensky-track'),
    adsbLol: routes.get('/api/adsblol/trace'),
  };
}

function request(handler, url) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      end(body) {
        resolve({
          status: this.statusCode,
          headers: this.headers,
          body: String(body ?? ''),
        });
      },
    };
    Promise.resolve(handler({ method: 'GET', url, headers: {} }, res)).catch(
      reject,
    );
  });
}

/** Set OpenSky's client credentials for the test, or clear them with null. */
function openSkyClient(t, id, secret) {
  const saved = Object.fromEntries(
    CLIENT_ENV.map((name) => [name, process.env[name]]),
  );
  for (const [name, value] of [
    [CLIENT_ENV[0], id],
    [CLIENT_ENV[1], secret],
  ]) {
    if (value === null) delete process.env[name];
    else process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

const noUpstream = async () => {
  throw new Error('no upstream call expected');
};

test('an OpenSky track needs a 6-character hex icao24', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', noUpstream);
  const { openSky } = mount();
  for (const url of ['/', '/?icao24=abc', '/?icao24=zzzzzz', '/?icao24=abc1234']) {
    const answer = await request(openSky, url);
    assert.equal(answer.status, 400, url);
    assert.deepEqual(
      JSON.parse(answer.body),
      { error: 'icao24 must be a 6-char hex string' },
      url,
    );
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('without an OpenSky client the track is fetched anonymously, then cached for a minute', async (t) => {
  openSkyClient(t, null, null);
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const fetchMock = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(TRACK),
  );
  const { openSky } = mount();
  const first = await request(openSky, '/?icao24=ABC123');
  assert.equal(first.status, 200);
  assert.equal(first.body, TRACK);
  assert.equal(first.headers['cache-control'], 'no-store');
  const [url, init] = fetchMock.mock.calls[0].arguments;
  assert.equal(
    String(url),
    'https://opensky-network.org/api/tracks/all?icao24=abc123&time=0',
  );
  assert.equal(init.headers.Authorization, undefined);

  now += 59_999;
  assert.equal((await request(openSky, '/?icao24=abc123')).body, TRACK);
  assert.equal(fetchMock.mock.callCount(), 1);
  now += 1;
  await request(openSky, '/?icao24=abc123');
  assert.equal(fetchMock.mock.callCount(), 2);
});

test('a refused track keeps its status with a generic body, and is cached too', async (t) => {
  openSkyClient(t, null, null);
  const fetchMock = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('<html>no such track</html>', { status: 404 }),
  );
  const { openSky } = mount();
  const missing = await request(openSky, '/?icao24=abc123');
  assert.equal(missing.status, 404);
  assert.deepEqual(JSON.parse(missing.body), {
    error: 'Track source HTTP 404',
  });
  await request(openSky, '/?icao24=abc123');
  // The client falls back to its own trail until the entry expires.
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('a track over 5 MB is replaced by an error body', async (t) => {
  openSkyClient(t, null, null);
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('x'.repeat(5 * 1024 * 1024 + 1)),
  );
  const { openSky } = mount();
  const answer = await request(openSky, '/?icao24=abc123');
  assert.deepEqual(JSON.parse(answer.body), {
    error: 'Upstream track response too large',
  });
});

test('a failed OpenSky track answers 502', async (t) => {
  openSkyClient(t, null, null);
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('socket hang up');
  });
  const { openSky } = mount();
  const answer = await request(openSky, '/?icao24=abc123');
  assert.equal(answer.status, 502);
  assert.deepEqual(JSON.parse(answer.body), {
    error: 'OpenSky track fetch failed',
  });
});

test('an adsb.lol trace comes from its hex bucket, and bad hex is refused', async (t) => {
  const fetchMock = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(TRACK),
  );
  const { adsbLol } = mount();
  const refused = await request(adsbLol, '/?hex=nothex');
  assert.equal(refused.status, 400);
  assert.deepEqual(JSON.parse(refused.body), {
    error: 'hex must be a 6-7 char hex string',
  });

  const answer = await request(adsbLol, '/?hex=AE1234');
  assert.equal(answer.status, 200);
  assert.equal(answer.body, TRACK);
  assert.equal(
    String(fetchMock.mock.calls[0].arguments[0]),
    'https://adsb.lol/data/traces/34/trace_full_ae1234.json',
  );
  // A non-ICAO address keeps its ~ marker.
  await request(adsbLol, '/?hex=~ae1234');
  assert.equal(
    String(fetchMock.mock.calls[1].arguments[0]),
    'https://adsb.lol/data/traces/34/trace_full_~ae1234.json',
  );

  fetchMock.mock.mockImplementation(async () => {
    throw new Error('socket hang up');
  });
  const failed = await request(adsbLol, '/?hex=ae5678');
  assert.equal(failed.status, 502);
  assert.deepEqual(JSON.parse(failed.body), {
    error: 'adsb.lol trace fetch failed',
  });
});

// Last: OpenSky's token stays cached in its module for the rest of the file.
test('with an OpenSky client configured, the track request carries its token', async (t) => {
  openSkyClient(t, 'client-a', 's3cret');
  t.mock.method(console, 'log', () => {});
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url) =>
    String(url).endsWith('/protocol/openid-connect/token')
      ? Response.json({ access_token: 'tok-track', expires_in: 300 })
      : new Response(TRACK),
  );
  const { openSky } = mount();
  const answer = await request(openSky, '/?icao24=abc123');
  assert.equal(answer.status, 200);
  const trackCall = fetchMock.mock.calls.find((call) =>
    String(call.arguments[0]).includes('/api/tracks/all'),
  );
  assert.equal(trackCall.arguments[1].headers.Authorization, 'Bearer tok-track');
});
