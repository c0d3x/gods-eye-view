import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkApiRequest,
  createApiRequestGuard,
  isExactOrigin,
  requestOrigin,
} from './requestGuard.mjs';

const HOST = '127.0.0.1:4173';
const PLACES = '/api/google/nearby-places?lat=30.27&lon=-97.74';

function check(headers, request = {}) {
  return checkApiRequest({
    method: 'GET',
    path: PLACES,
    headers: { host: HOST, ...headers },
    ...request,
  });
}

function post(path, contentType, headers = {}) {
  return checkApiRequest({
    method: 'POST',
    path,
    headers: {
      host: HOST,
      'sec-fetch-site': 'same-origin',
      'content-length': '12',
      ...(contentType === undefined ? {} : { 'content-type': contentType }),
      ...headers,
    },
  });
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = String(value);
    },
    end(body = '') {
      this.body = String(body);
    },
  };
}

test('requests from the app itself pass', () => {
  assert.deepEqual(check({ 'sec-fetch-site': 'same-origin' }), { ok: true });
  assert.deepEqual(check({ 'sec-fetch-site': 'none' }), { ok: true });
  assert.deepEqual(check({ 'sec-fetch-site': 'Same-Origin' }), { ok: true });
});

test('requests from other sites and other localhost ports are refused', () => {
  for (const site of ['cross-site', 'same-site', 'unexpected']) {
    const verdict = check({ 'sec-fetch-site': site });
    assert.equal(verdict.ok, false, site);
    assert.equal(verdict.status, 403, site);
    assert.equal(verdict.error, 'Cross-site requests are refused');
  }
});

test('without Sec-Fetch-Site, an Origin must name this server exactly', () => {
  assert.deepEqual(check({ origin: 'http://127.0.0.1:4173' }), { ok: true });
  for (const origin of [
    'http://127.0.0.1:5173',
    'http://localhost:4173',
    'https://127.0.0.1:4173',
    'http://evil.example',
    'null',
    'http://127.0.0.1:4173/path',
    'http://user@127.0.0.1:4173',
    'not a url',
  ]) {
    const verdict = check({ origin });
    assert.equal(verdict.ok, false, origin);
    assert.equal(verdict.status, 403, origin);
    assert.equal(verdict.error, 'Cross-origin requests are refused');
  }
  // With no Host header there is nothing to compare the Origin with.
  const hostless = checkApiRequest({
    headers: { origin: 'http://127.0.0.1:4173' },
  });
  assert.equal(hostless.ok, false);
});

test('TLS requests compare against the https origin', () => {
  assert.deepEqual(
    check({ origin: 'https://127.0.0.1:4173' }, { encrypted: true }),
    { ok: true },
  );
  assert.equal(
    check({ origin: 'http://127.0.0.1:4173' }, { encrypted: true }).ok,
    false,
  );
});

test('Sec-Fetch-Site decides when a browser sends it', () => {
  assert.deepEqual(
    check({ 'sec-fetch-site': 'same-origin', origin: 'http://other.example' }),
    { ok: true },
  );
  assert.equal(
    check({ 'sec-fetch-site': 'cross-site', origin: 'http://127.0.0.1:4173' })
      .ok,
    false,
  );
});

test('non-browser clients without either header pass', () => {
  assert.deepEqual(check({}), { ok: true });
  assert.deepEqual(checkApiRequest(), { ok: true });
});

test('request bodies must be JSON', () => {
  for (const type of [
    'application/json',
    'application/json; charset=utf-8',
    'Application/JSON',
    'application/merge-patch+json',
  ]) {
    assert.deepEqual(post('/api/openai/hud-summary', type), { ok: true }, type);
  }
  for (const type of [
    'text/plain',
    'text/plain;charset=UTF-8',
    'application/x-www-form-urlencoded',
    'multipart/form-data; boundary=x',
    undefined,
  ]) {
    const verdict = post('/api/openai/hud-summary', type);
    assert.equal(verdict.ok, false, String(type));
    assert.equal(verdict.status, 415, String(type));
    assert.equal(verdict.error, 'Content-Type must be application/json');
  }
});

test('the Overpass proxy keeps its form-encoded queries', () => {
  const form = 'application/x-www-form-urlencoded';
  assert.deepEqual(post('/api/overpass', form), { ok: true });
  assert.deepEqual(post('/api/overpass?mirror=1', form), { ok: true });
  assert.deepEqual(post('/api/overpass/interpreter', form), { ok: true });
  assert.equal(post('/api/overpass', 'text/plain').status, 415);
  assert.equal(post('/api/overpassx', form).status, 415);
  assert.equal(post('/api/openai/hud-summary', form).status, 415);
});

test('requests without a body need no Content-Type', () => {
  assert.deepEqual(
    post('/api/radio/click/abc', undefined, { 'content-length': '0' }),
    { ok: true },
  );
  assert.deepEqual(
    checkApiRequest({
      method: 'POST',
      path: '/api/radio/click/abc',
      headers: { host: HOST, 'sec-fetch-site': 'same-origin' },
    }),
    { ok: true },
  );
  assert.equal(
    post('/api/openai/hud-summary', 'text/plain', {
      'content-length': undefined,
      'transfer-encoding': 'chunked',
    }).status,
    415,
  );
});

test('origins are normalized the way browsers send them', () => {
  assert.equal(requestOrigin('LOCALHOST:4173'), 'http://localhost:4173');
  assert.equal(requestOrigin('localhost:80'), 'http://localhost');
  assert.equal(requestOrigin('localhost:443', true), 'https://localhost');
  assert.equal(requestOrigin('[::1]:4173'), 'http://[::1]:4173');
  assert.equal(requestOrigin(''), null);
  assert.equal(requestOrigin(undefined), null);
  assert.equal(requestOrigin('host/path'), null);
  assert.equal(requestOrigin('user@host'), null);

  const expected = 'http://localhost:4173';
  assert.equal(isExactOrigin('http://localhost:4173', expected), true);
  assert.equal(isExactOrigin('http://LOCALHOST:4173', expected), true);
  assert.equal(isExactOrigin('http://localhost:4173?x', expected), false);
  assert.equal(isExactOrigin('http://localhost:4173#x', expected), false);
  assert.equal(isExactOrigin('null', expected), false);
  assert.equal(isExactOrigin(undefined, expected), false);
});

test('the middleware passes allowed requests on and refuses the rest with JSON', () => {
  const logged = [];
  const guard = createApiRequestGuard({
    log: (message) => logged.push(message),
    now: () => 1000,
  });
  let passed = 0;
  const next = () => {
    passed += 1;
  };

  guard(
    {
      method: 'GET',
      url: '/google/nearby-places?lat=30.27&lon=-97.74',
      originalUrl: PLACES,
      headers: { host: HOST, 'sec-fetch-site': 'same-origin' },
      socket: {},
    },
    response(),
    next,
  );
  assert.equal(passed, 1);

  const res = response();
  guard(
    {
      method: 'GET',
      url: '/google/nearby-places?lat=30.27&lon=-97.74',
      originalUrl: PLACES,
      headers: { host: HOST, 'sec-fetch-site': 'cross-site' },
      socket: {},
    },
    res,
    next,
  );
  assert.equal(passed, 1);
  assert.equal(res.statusCode, 403);
  assert.equal(res.headers['content-type'], 'application/json');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(res.body), {
    error: 'Cross-site requests are refused',
  });
  assert.deepEqual(logged, [
    '[API guard] Refused GET /api/google/nearby-places (Sec-Fetch-Site: cross-site)',
  ]);
});

test('refusals are logged at most once a minute per route', () => {
  let clock = 0;
  const logged = [];
  const guard = createApiRequestGuard({
    log: (message) => logged.push(message),
    now: () => clock,
  });
  const refuse = (path) =>
    guard(
      {
        method: 'POST',
        originalUrl: path,
        headers: { host: HOST, origin: 'http://evil.example' },
        socket: {},
      },
      response(),
      () => assert.fail('a refused request must not reach the route'),
    );

  refuse('/api/realtime/debug-log');
  refuse('/api/realtime/debug-log');
  refuse('/api/openai/hud-summary');
  clock = 59_999;
  refuse('/api/realtime/debug-log');
  clock = 60_000;
  refuse('/api/realtime/debug-log');
  assert.deepEqual(logged, [
    '[API guard] Refused POST /api/realtime/debug-log (Origin: http://evil.example)',
    '[API guard] Refused POST /api/openai/hud-summary (Origin: http://evil.example)',
    '[API guard] Refused POST /api/realtime/debug-log (Origin: http://evil.example)',
  ]);
});

test('logged values cannot carry terminal control sequences', () => {
  const logged = [];
  const guard = createApiRequestGuard({
    log: (message) => logged.push(message),
  });
  guard(
    {
      method: 'GET',
      originalUrl: '/api/x',
      headers: { host: HOST, origin: 'http://evil.example\u001b[2J' },
      socket: {},
    },
    response(),
    () => {},
  );
  assert.equal(logged.length, 1);
  assert.equal(logged[0].includes('\u001b'), false);
  assert.match(logged[0], /Origin: http:\/\/evil\.example\?\[2J/);
});
