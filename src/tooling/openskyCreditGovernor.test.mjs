import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * A fresh copy of the OpenSky proxy, so its module-level cache and cooldown
 * start empty, with the clock, the network and the environment under test
 * control. Returns a function that requests /api/flights.
 */
async function setup(t, answer) {
  for (const [key, value] of Object.entries({
    OPENSKY_AUTH_MODE: 'anon',
    OPENSKY_CLIENT_ID: undefined,
    OPENSKY_CLIENT_SECRET: undefined,
  })) {
    const original = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    });
  }
  const clock = { now: Date.now() };
  t.mock.method(Date, 'now', () => clock.now);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(url);
    if (url.includes('/states/')) return answer(clock);
    throw new Error(`Unexpected URL: ${url}`);
  });
  const { openSkyProxy } = await import(
    `../../server/providers/aircraft/opensky.js?governor=${Math.random()}`
  );
  let handler;
  openSkyProxy().configureServer({
    middlewares: {
      use(route, routeHandler) {
        if (route === '/api/flights') handler = routeHandler;
      },
    },
  });
  const request = async () => {
    const response = { headers: {} };
    response.setHeader = (key, value) => {
      response.headers[key] = value;
    };
    response.writeHead = (status, headers = {}) => {
      response.status = status;
      Object.assign(response.headers, headers);
    };
    response.end = (body) => {
      response.body = body;
    };
    await handler({ url: '/', method: 'GET' }, response, () => {});
    return response;
  };
  return { request, clock, calls };
}

test('a snapshot without a credits header keeps the base 9 s cache', async (t) => {
  const { request, clock, calls } = await setup(
    t,
    ({ now }) =>
      new Response(
        JSON.stringify({ time: Math.floor(now / 1000), states: [] }),
      ),
  );
  assert.equal((await request()).headers['X-OpenSky-Cache'], 'MISS');
  clock.now += 8_000;
  assert.equal((await request()).headers['X-OpenSky-Cache'], 'HIT');
  // A missing header once read as zero credits left, which cached the
  // snapshot for five minutes.
  clock.now += 2_000;
  assert.equal((await request()).headers['X-OpenSky-Cache'], 'MISS');
  assert.equal(calls.length, 2);
});

test('a 429 without a retry-after header cools down for 2 minutes', async (t) => {
  const { request, clock, calls } = await setup(
    t,
    () => new Response('<html>Too many requests</html>', { status: 429 }),
  );
  assert.equal((await request()).status, 429);
  const cooling = await request();
  assert.equal(cooling.headers['X-OpenSky-Cache'], 'COOLDOWN');
  // A missing header once read as a zero wait: the 30 s minimum.
  assert.equal(cooling.headers['X-OpenSky-Retry-After-Seconds'], '120');
  clock.now += 119_000;
  assert.equal((await request()).headers['X-OpenSky-Cache'], 'COOLDOWN');
  clock.now += 1_000;
  await request();
  assert.equal(calls.length, 2);
});

test('a 429 still honors the retry-after header it sends', async (t) => {
  const { request } = await setup(
    t,
    () =>
      new Response('', {
        status: 429,
        headers: { 'x-rate-limit-retry-after-seconds': '600' },
      }),
  );
  await request();
  assert.equal(
    (await request()).headers['X-OpenSky-Retry-After-Seconds'],
    '600',
  );
});
