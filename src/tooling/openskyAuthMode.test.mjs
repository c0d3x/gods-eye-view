import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * Request /api/flights from a fresh copy of the OpenSky proxy, configured by
 * `environment`, and return the headers it sent upstream and answered with.
 */
async function flights(t, environment) {
  for (const [key, value] of Object.entries(environment)) {
    const original = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    });
  }
  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(String(message)));
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.includes('/token'))
      return Response.json({ access_token: 'fixture-token', expires_in: 1800 });
    if (url.includes('/states/')) {
      sent.push(options.headers);
      return Response.json({ time: Math.floor(Date.now() / 1000), states: [] });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  const { openSkyProxy } = await import(
    `../../server/providers/aircraft/opensky.js?auth=${Math.random()}`
  );
  let handler;
  openSkyProxy().configureServer({
    middlewares: {
      use(route, routeHandler) {
        if (route === '/api/flights') handler = routeHandler;
      },
    },
  });
  const response = { headers: {} };
  response.setHeader = (key, value) => {
    response.headers[key] = value;
  };
  response.writeHead = (status, headers = {}) => {
    response.status = status;
    Object.assign(response.headers, headers);
  };
  response.end = () => {};
  await handler({ url: '/', method: 'GET' }, response, () => {});
  return { sent: sent[0], headers: response.headers, warnings };
}

const BASIC = {
  OPENSKY_CLIENT_ID: undefined,
  OPENSKY_CLIENT_SECRET: undefined,
  OPENSKY_USERNAME: 'fixture-user',
  OPENSKY_PASSWORD: 'fixture-password',
};

test('the retired basic mode means oauth, with a warning, and sends no password', async (t) => {
  const { sent, headers, warnings } = await flights(t, {
    ...BASIC,
    OPENSKY_AUTH_MODE: 'basic',
  });
  assert.equal(sent.Authorization, undefined);
  assert.equal(headers['X-OpenSky-Auth-Mode-Requested'], 'oauth');
  assert.equal(headers['X-OpenSky-Auth-Mode-Used'], 'anon');
  assert.deepEqual(warnings, [
    '[OpenSky] OPENSKY_AUTH_MODE="basic" relied on Basic auth, which OpenSky no longer accepts; using "oauth"',
  ]);
});

test('the retired auto mode uses the OAuth client like oauth', async (t) => {
  const { sent, headers, warnings } = await flights(t, {
    ...BASIC,
    OPENSKY_AUTH_MODE: 'Auto',
    OPENSKY_CLIENT_ID: 'fixture-client',
    OPENSKY_CLIENT_SECRET: 'fixture-secret',
  });
  assert.equal(sent.Authorization, 'Bearer fixture-token');
  assert.equal(headers['X-OpenSky-Auth-Mode-Requested'], 'oauth');
  assert.equal(headers['X-OpenSky-Auth-Reason'], 'oauth_ok');
  assert.match(warnings[0], /"auto" relied on Basic auth/);
});

test('oauth and anon are the auth modes', async (t) => {
  for (const [mode, requested] of [
    [undefined, 'oauth'],
    [' OAuth ', 'oauth'],
    ['anon', 'anon'],
    ['bogus', 'oauth'],
  ]) {
    await t.test(String(mode), async (st) => {
      const { sent, headers, warnings } = await flights(st, {
        ...BASIC,
        OPENSKY_AUTH_MODE: mode,
      });
      assert.equal(sent.Authorization, undefined);
      assert.equal(headers['X-OpenSky-Auth-Mode-Requested'], requested);
      if (mode === 'bogus')
        assert.match(warnings[0], /Invalid OPENSKY_AUTH_MODE="bogus"/);
      else assert.deepEqual(warnings, []);
    });
  }
});

test('neither the proxy nor the launchers read a username and password', async () => {
  for (const file of [
    '../../server/providers/aircraft/opensky.js',
    '../../scripts/dev-fresh.sh',
  ]) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /OPENSKY_(USERNAME|PASSWORD)/, file);
    assert.doesNotMatch(source, /Basic \$\{/, file);
  }
});
