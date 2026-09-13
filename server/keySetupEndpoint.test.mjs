import assert from 'node:assert/strict';
import test from 'node:test';
import { KEY_SETUP_KEYS } from '../src/keySetupCatalog.js';
import { keySetupEndpoint } from './keySetupEndpoint.mjs';

const SHARING_OFF = {
  PINOKIO_SHARE_CLOUDFLARE: undefined,
  PINOKIO_SHARE_LOCAL: undefined,
  PINOKIO_SHARE_VAR: undefined,
};

/** Set environment variables for one test; undefined removes one. */
function setEnv(t, values) {
  const saved = Object.fromEntries(
    Object.keys(values).map((name) => [name, process.env[name]]),
  );
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

function statusRoute() {
  const routes = new Map();
  keySetupEndpoint().configureServer({
    middlewares: { use: (path, handler) => routes.set(path, handler) },
  });
  return routes.get('/api/setup/status');
}

/** Ask the status route, from this machine by a local name unless told otherwise. */
function ask(
  route,
  { method = 'GET', remoteAddress = '127.0.0.1', headers = {} } = {},
) {
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(text) {
      this.body = JSON.parse(text);
    },
  };
  route(
    {
      method,
      socket: { remoteAddress },
      headers: { host: '127.0.0.1:4173', ...headers },
    },
    res,
  );
  return res;
}

test('status lists every provider key and whether it is set, never its value', (t) => {
  const secret = 'tomtom-test-secret-value';
  setEnv(t, { ...SHARING_OFF, TOMTOM_API_KEY: secret });
  const res = ask(statusRoute());
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    res.body.keys.map((key) => key.id),
    KEY_SETUP_KEYS.map((key) => key.id),
  );
  assert.equal(res.body.total, KEY_SETUP_KEYS.length);
  assert.equal(res.body.keys.find((key) => key.id === 'tomtom').set, true);
  assert.equal(res.body.store, 'env-file');
  assert.doesNotMatch(JSON.stringify(res.body), new RegExp(secret));
  // A credential status must never be cached or framed.
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(
    res.headers['content-security-policy'],
    "frame-ancestors 'none'",
  );
});

test('status answers only a GET from this machine, by a local name, unproxied and same-origin', (t) => {
  setEnv(t, SHARING_OFF);
  const route = statusRoute();
  const refusals = [
    [{ method: 'POST' }, 405, 'Method not allowed'],
    [
      { remoteAddress: '192.168.1.20' },
      403,
      'Provider Settings answers only the machine running the server',
    ],
    [
      { headers: { host: 'attacker.example:4173' } },
      403,
      'Provider Settings answers only local hostnames',
    ],
    [
      { headers: { 'x-forwarded-for': '203.0.113.9' } },
      403,
      'Provider Settings does not answer proxied requests',
    ],
    [
      { headers: { origin: 'https://attacker.example' } },
      403,
      'Cross-origin requests are refused',
    ],
  ];
  for (const [request, status, error] of refusals) {
    const res = ask(route, request);
    assert.equal(res.statusCode, status, error);
    assert.deepEqual(res.body, { error }, error);
  }
});

test('status is refused while the Pinokio share is on', (t) => {
  setEnv(t, { ...SHARING_OFF, PINOKIO_SHARE_CLOUDFLARE: 'true' });
  const res = ask(statusRoute());
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, {
    error: 'Provider Settings is disabled while sharing is enabled',
  });
});
