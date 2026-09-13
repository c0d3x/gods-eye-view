import assert from 'node:assert/strict';
import test from 'node:test';
import { UpstreamTimeoutError } from '../lib/fetchWithTimeout.mjs';

const TOKEN_URL =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const STATES_URL = 'https://opensky-network.org/api/states/all?extended=1';
const ADSBLOL_URL = 'https://api.adsb.lol/';
const CLIENT = {
  OPENSKY_CLIENT_ID: 'client-a',
  OPENSKY_CLIENT_SECRET: 's3cret&=',
};
const ANON = { OPENSKY_AUTH_MODE: 'anon' };
const ENV_NAMES = [
  'OPENSKY_AUTH_MODE',
  'OPENSKY_CLIENT_ID',
  'OPENSKY_CLIENT_SECRET',
];

/** Set an environment variable, or remove it for null or undefined. */
function setEnv(name, value) {
  if (value == null) delete process.env[name];
  else process.env[name] = String(value);
}

let instances = 0;
/**
 * A fresh copy of the proxy, since its token and cache are module state, with
 * the given environment, a clock the test moves, and the console captured.
 */
async function setup(t, env = {}) {
  const saved = Object.fromEntries(
    ENV_NAMES.map((name) => [name, process.env[name]]),
  );
  for (const name of ENV_NAMES) setEnv(name, env[name]);
  t.after(() => {
    for (const name of ENV_NAMES) setEnv(name, saved[name]);
  });
  const clock = { now: 1_800_000_000_000 };
  t.mock.method(Date, 'now', () => clock.now);
  const logs = { log: [], warn: [], error: [] };
  for (const level of Object.keys(logs)) {
    t.mock.method(console, level, (...args) =>
      logs[level].push(args.join(' ')),
    );
  }
  instances += 1;
  const { openSkyProxy } = await import(`./opensky.mjs?instance=${instances}`);
  const routes = new Map();
  openSkyProxy().configureServer({
    middlewares: { use: (prefix, handler) => routes.set(prefix, handler) },
  });
  return { handler: routes.get('/api/opensky'), clock, logs };
}

function request(handler, url = '/') {
  const req = { method: 'GET', url, headers: {} };
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

/**
 * Answer OpenSky's token and states endpoints and adsb.lol with the given
 * functions, and record each call by kind.
 */
function mockUpstream(t, answers) {
  const calls = { token: [], states: [], adsblol: [] };
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const href = String(url);
    let kind = null;
    if (href === TOKEN_URL) kind = 'token';
    else if (href === STATES_URL) kind = 'states';
    else if (href.startsWith(ADSBLOL_URL)) kind = 'adsblol';
    if (!kind || !answers[kind]) throw new Error(`unexpected upstream ${href}`);
    calls[kind].push({ url: href, init });
    return answers[kind](calls[kind].length);
  });
  return calls;
}

/**
 * A current OpenSky snapshot, with `remaining` daily credits left; null
 * leaves that header out.
 */
function snapshot(clock, remaining = 3000) {
  return new Response(
    JSON.stringify({ time: Math.floor(clock.now / 1000), states: [] }),
    {
      headers:
        remaining === null
          ? {}
          : { 'x-rate-limit-remaining': String(remaining) },
    },
  );
}

/** OpenSky's 429, asking for `retryAfterSeconds`; null leaves that out. */
function rateLimited(retryAfterSeconds) {
  return new Response('<html>Too many requests</html>', {
    status: 429,
    headers:
      retryAfterSeconds === null
        ? {}
        : { 'x-rate-limit-retry-after-seconds': retryAfterSeconds },
  });
}

test('an OAuth token is reused until a minute before it expires', async (t) => {
  const { handler, clock } = await setup(t, CLIENT);
  const calls = mockUpstream(t, {
    token: (n) => Response.json({ access_token: `tok-${n}`, expires_in: 300 }),
    states: () => snapshot(clock),
  });
  const first = await request(handler);
  assert.equal(first.status, 200);
  assert.equal(first.headers['X-OpenSky-Cache'], 'MISS');
  assert.equal(first.headers['X-OpenSky-Auth'], 'oauth');
  assert.equal(first.headers['X-OpenSky-Auth-Reason'], 'oauth_ok');
  assert.equal(calls.states[0].init.headers.Authorization, 'Bearer tok-1');
  assert.equal(calls.token[0].init.method, 'POST');
  assert.equal(
    calls.token[0].init.body,
    'grant_type=client_credentials&client_id=client-a&client_secret=s3cret%26%3D',
  );

  clock.now += 10_000; // past the 9 s cache
  await request(handler);
  assert.equal(calls.token.length, 1);
  assert.equal(calls.states[1].init.headers.Authorization, 'Bearer tok-1');

  clock.now += 231_000; // 241 s in: the token's last minute
  await request(handler);
  assert.equal(calls.token.length, 2);
  assert.equal(calls.states[2].init.headers.Authorization, 'Bearer tok-2');
});

test('concurrent requests share one token request', async (t) => {
  const { handler, clock, logs } = await setup(t, CLIENT);
  let issue;
  const issued = new Promise((resolve) => {
    issue = resolve;
  });
  const calls = mockUpstream(t, {
    token: async () => {
      await issued;
      return Response.json({ access_token: 'tok-1' });
    },
    states: () => snapshot(clock),
  });
  const both = Promise.all([request(handler), request(handler)]);
  issue();
  for (const answer of await both) {
    assert.equal(answer.headers['X-OpenSky-Auth'], 'oauth');
  }
  assert.equal(calls.token.length, 1);
  // A token without expires_in lasts 30 minutes.
  assert.match(logs.log.join('\n'), /expires in 1800 s/);
});

test('OAuth without a client configured goes anonymous without asking for a token', async (t) => {
  const { handler, clock } = await setup(t);
  const calls = mockUpstream(t, { states: () => snapshot(clock) });
  const answer = await request(handler);
  assert.equal(answer.status, 200);
  assert.equal(answer.headers['X-OpenSky-Auth-Mode-Requested'], 'oauth');
  assert.equal(answer.headers['X-OpenSky-Auth'], 'anon');
  assert.equal(
    answer.headers['X-OpenSky-Auth-Reason'],
    'oauth_invalid_or_missing',
  );
  assert.equal(calls.states[0].init.headers.Authorization, undefined);
});

test('anon mode never asks for a token, even with a client configured', async (t) => {
  const { handler, clock } = await setup(t, { ...CLIENT, ...ANON });
  const calls = mockUpstream(t, { states: () => snapshot(clock) });
  const answer = await request(handler);
  assert.equal(answer.headers['X-OpenSky-Auth-Mode-Requested'], 'anon');
  assert.equal(answer.headers['X-OpenSky-Auth-Reason'], 'anonymous_ok');
  assert.equal(calls.states[0].init.headers.Authorization, undefined);
});

test('a refused token request warns once and falls back to anonymous', async (t) => {
  const { handler, clock, logs } = await setup(t, CLIENT);
  const calls = mockUpstream(t, {
    token: () =>
      Response.json(
        {
          error: 'invalid_client',
          error_description: 'Invalid client credentials',
        },
        { status: 401 },
      ),
    states: () => snapshot(clock),
  });
  const first = await request(handler);
  assert.equal(first.status, 200);
  assert.equal(first.headers['X-OpenSky-Auth'], 'anon');
  assert.equal(
    first.headers['X-OpenSky-Auth-Reason'],
    'oauth_invalid_or_missing',
  );
  clock.now += 10_000;
  await request(handler);
  assert.equal(calls.token.length, 2, 'each uncached request tries again');
  assert.equal(
    logs.warn.filter((line) => line.includes('Invalid client credentials'))
      .length,
    1,
  );
});

test('a refused states request says which credentials failed', async (t) => {
  const cases = [
    {
      name: 'rejected OAuth credentials',
      env: CLIENT,
      status: 401,
      used: 'oauth',
      reason: 'oauth_invalid_credentials',
      error: 'OpenSky auth invalid. OAuth client credentials were rejected.',
    },
    {
      name: 'OAuth without a client',
      env: {},
      status: 401,
      used: 'anon',
      reason: 'oauth_invalid_or_missing',
      error:
        'OpenSky auth invalid. OAuth mode requires valid OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET.',
    },
    {
      name: 'anonymous access refused',
      env: ANON,
      status: 403,
      used: 'anon',
      reason: 'auth_required',
      error: 'OpenSky auth required.',
    },
  ];
  for (const c of cases) {
    await t.test(c.name, async (st) => {
      const { handler } = await setup(st, c.env);
      const calls = mockUpstream(st, {
        token: () => Response.json({ access_token: 'tok-1' }),
        states: () => new Response('<html>denied</html>', { status: c.status }),
      });
      const answer = await request(handler);
      assert.equal(answer.status, c.status);
      assert.equal(answer.headers['X-OpenSky-Auth'], c.used);
      assert.equal(answer.headers['X-OpenSky-Auth-Reason'], c.reason);
      assert.deepEqual(JSON.parse(answer.body), { error: c.error });
      await request(handler);
      assert.equal(calls.states.length, 2, 'a refusal is not cached');
    });
  }
});

test('the cache TTL stretches as the daily credits run down', async () => {
  const { openskyAdaptiveTtlMs } = await import('./opensky.mjs');
  const tiers = [
    [Number.NaN, 9000],
    [2401, 9000],
    [2400, 30_000],
    [1201, 30_000],
    [1200, 90_000],
    [401, 90_000],
    [400, 300_000],
    [0, 300_000],
  ];
  for (const [remaining, ttl] of tiers) {
    assert.equal(openskyAdaptiveTtlMs(remaining), ttl, String(remaining));
  }
});

test('a snapshot is served from cache for as long as its credits allow', async (t) => {
  const { handler, clock } = await setup(t, ANON);
  const calls = mockUpstream(t, { states: () => snapshot(clock, 1000) });
  const fresh = await request(handler);
  clock.now += 60_000; // 1000 credits left: a 90 s TTL
  const hit = await request(handler);
  assert.equal(hit.headers['X-OpenSky-Cache'], 'HIT');
  assert.equal(hit.body, fresh.body);
  assert.equal(calls.states.length, 1);
  clock.now += 31_000;
  const miss = await request(handler);
  assert.equal(miss.headers['X-OpenSky-Cache'], 'MISS');
  assert.equal(calls.states.length, 2);
});

test('a snapshot without a credits header keeps the base 9 s cache', async (t) => {
  const { handler, clock } = await setup(t, ANON);
  const calls = mockUpstream(t, { states: () => snapshot(clock, null) });
  await request(handler);
  clock.now += 8_000;
  assert.equal((await request(handler)).headers['X-OpenSky-Cache'], 'HIT');
  clock.now += 2_000;
  assert.equal((await request(handler)).headers['X-OpenSky-Cache'], 'MISS');
  assert.equal(calls.states.length, 2);
});

test('a 429 starts a cooldown that serves the last good snapshot as STALE', async (t) => {
  const { handler, clock } = await setup(t, ANON);
  let limited = false;
  const calls = mockUpstream(t, {
    states: () => (limited ? rateLimited('600') : snapshot(clock)),
  });
  const fresh = await request(handler);
  limited = true;
  clock.now += 10_000;
  const stale = await request(handler);
  assert.equal(stale.status, 200);
  assert.equal(stale.body, fresh.body);
  assert.equal(stale.headers['X-OpenSky-Cache'], 'STALE');
  assert.equal(
    stale.headers['X-OpenSky-Auth-Reason'],
    'rate_limited_serving_stale',
  );
  assert.equal(stale.headers['X-OpenSky-Stale-Seconds'], '10');
  assert.equal(stale.headers['X-OpenSky-Retry-After-Seconds'], '600');

  clock.now += 60_000; // still cooling down: OpenSky is not asked
  const cooling = await request(handler);
  assert.equal(cooling.headers['X-OpenSky-Cache'], 'STALE');
  assert.equal(cooling.headers['X-OpenSky-Stale-Seconds'], '70');
  assert.equal(cooling.headers['X-OpenSky-Retry-After-Seconds'], '540');
  assert.equal(calls.states.length, 2);

  limited = false;
  clock.now += 541_000; // the cooldown is over
  const recovered = await request(handler);
  assert.equal(recovered.headers['X-OpenSky-Cache'], 'MISS');
  assert.equal(calls.states.length, 3);
});

test('the cooldown follows retry-after within 30 s and 30 minutes, and is 2 minutes without it', async (t) => {
  const cases = [
    ['5', '30'],
    ['600', '600'],
    ['7200', '1800'],
    ['soon', '120'],
    [null, '120'],
  ];
  for (const [retryAfter, cooldown] of cases) {
    const name =
      retryAfter === null ? 'no retry-after' : `retry-after ${retryAfter}`;
    await t.test(name, async (st) => {
      const { handler, clock } = await setup(st, ANON);
      let limited = false;
      mockUpstream(st, {
        states: () => (limited ? rateLimited(retryAfter) : snapshot(clock)),
      });
      await request(handler);
      limited = true;
      clock.now += 10_000;
      const stale = await request(handler);
      assert.equal(stale.headers['X-OpenSky-Retry-After-Seconds'], cooldown);
    });
  }
});

test('a cold start into a rate limit answers 429, then cools down without asking', async (t) => {
  const { handler, clock } = await setup(t, ANON);
  const calls = mockUpstream(t, { states: () => rateLimited('60') });
  const limited = await request(handler);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['X-OpenSky-Auth-Reason'], 'rate_limited');
  assert.deepEqual(JSON.parse(limited.body), {
    error: 'OpenSky rate limit or quota reached',
  });

  clock.now += 30_000;
  const cooling = await request(handler);
  assert.equal(cooling.status, 429);
  assert.equal(cooling.headers['X-OpenSky-Cache'], 'COOLDOWN');
  assert.equal(cooling.headers['X-OpenSky-Retry-After-Seconds'], '30');
  assert.deepEqual(JSON.parse(cooling.body), {
    error: 'OpenSky rate limited; proxy cooling down.',
  });
  assert.equal(calls.states.length, 1);
});

test('a failed states call serves the cached snapshot as STALE', async (t) => {
  const { handler, clock, logs } = await setup(t, ANON);
  let down = false;
  mockUpstream(t, {
    states: () => {
      if (down) throw new Error('socket hang up');
      return snapshot(clock);
    },
  });
  const fresh = await request(handler);
  down = true;
  clock.now += 10_000;
  const stale = await request(handler);
  assert.equal(stale.status, 200);
  assert.equal(stale.body, fresh.body);
  assert.equal(stale.headers['X-OpenSky-Cache'], 'STALE');
  // The cached answer keeps the reason it was fetched with.
  assert.equal(stale.headers['X-OpenSky-Auth-Reason'], 'anonymous_ok');
  assert.match(logs.error.join('\n'), /socket hang up/);
});

test('with nothing cached, a timeout answers 504 and an outage answers in our words', async (t) => {
  const { handler } = await setup(t, ANON);
  let failure = 'timeout';
  mockUpstream(t, {
    states: () => {
      if (failure === 'timeout') throw new UpstreamTimeoutError(30_000);
      return new Response('<html>bad gateway</html>', { status: 502 });
    },
  });
  const late = await request(handler);
  assert.equal(late.status, 504);
  assert.equal(late.headers['X-OpenSky-Auth-Reason'], 'upstream_timeout');
  assert.deepEqual(JSON.parse(late.body), {
    error: 'OpenSky did not answer in time',
  });

  failure = 'outage';
  const down = await request(handler);
  assert.equal(down.status, 502);
  assert.deepEqual(JSON.parse(down.body), { error: 'OpenSky is unavailable' });
  assert.doesNotMatch(down.body, /bad gateway|<html>/);
});

test('with a view anchor, an OpenSky outage falls back to a 250 nm adsb.lol snapshot', async (t) => {
  const { handler } = await setup(t);
  const aircraft = { hex: '4CA7B5', flight: 'SAS123 ', lat: 59.95, lon: 10.8 };
  const calls = mockUpstream(t, {
    states: () => new Response('down', { status: 503 }),
    // The record without a hex is dropped.
    adsblol: () => Response.json({ ac: [aircraft, { lat: 60, lon: 10 }] }),
  });
  const answer = await request(handler, '/?lat=59.91&lon=10.75');
  assert.equal(answer.status, 200);
  assert.equal(answer.headers['X-Flight-Source'], 'adsb.lol');
  assert.equal(answer.headers['X-Flight-Coverage'], '250nm regional fallback');
  assert.equal(answer.headers['X-Flight-Count'], '1');
  assert.equal(answer.headers['X-OpenSky-Auth'], 'adsblol-regional');
  assert.equal(
    answer.headers['X-OpenSky-Auth-Reason'],
    'opensky_http_503_regional_fallback',
  );
  // The view is rounded to a 0.25° anchor.
  assert.equal(
    calls.adsblol[0].url,
    'https://api.adsb.lol/v2/lat/60/lon/10.75/dist/250',
  );
  const [state] = JSON.parse(answer.body).states;
  assert.equal(state[0], '4ca7b5');
  assert.equal(state[1], 'SAS123');
});
