import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { adsbLolProxy } from '../server/providers/aircraft/adsb-lol.js';
import { installMapillaryRoutes } from '../server/providers/mapillary/routes.js';
import {
  _resetTileMemoryForTest,
  _setTileCacheDirForTest,
  _settleTileWritesForTest,
} from '../server/providers/mapillary/tiles.js';
import { handleHudSummary } from '../server/providers/openai/hud-summary.js';
import { googlePlacesContextProxy } from '../server/providers/places/google.js';
import { aisLiveProxy } from '../server/providers/vessels/ais-live.js';

// Provider error text, an internal host and a key: none of it may reach a
// client or the server log.
const LEAK = 'fixture-secret internal.example req_fixture_1234';

function setEnv(t, values) {
  for (const [name, value] of Object.entries(values)) {
    const previous = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
}

/** Capture console.warn and console.error for one test. */
function captureLogs(t) {
  const lines = [];
  for (const level of ['warn', 'error']) {
    t.mock.method(console, level, (...args) => lines.push(args.join(' ')));
  }
  return lines;
}

function mockResponse() {
  const headers = {};
  return {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    headers,
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = String(value);
    },
    writeHead(status, values = {}) {
      this.statusCode = status;
      for (const [name, value] of Object.entries(values))
        this.setHeader(name, value);
      this.headersSent = true;
    },
    end(body = '') {
      this.body = String(body);
      this.writableEnded = true;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

/** A request whose body streams like an IncomingMessage. */
function postRequest(body) {
  return Object.assign(Readable.from(body ? [Buffer.from(body)] : []), {
    method: 'POST',
    url: '/',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  });
}

function routes(register) {
  const map = new Map();
  register({
    use(route, handler) {
      map.set(route, handler);
    },
  });
  return map;
}

test('a malformed HUD summary request gets 400, an oversized one 413, and OpenAI is never called', async (t) => {
  setEnv(t, {
    OPENAI_API_KEY: 'fixture-key',
    GEV_RATELIMIT_OPENAI_PER_MIN: '0',
  });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return Response.json({ output_text: 'never' });
  });

  const malformed = mockResponse();
  await handleHudSummary(postRequest('{not json'), malformed);
  assert.equal(malformed.statusCode, 400);
  assert.deepEqual(malformed.json(), { error: 'Invalid HUD summary request' });

  const oversized = mockResponse();
  await handleHudSummary(postRequest('x'.repeat(65 * 1024)), oversized);
  assert.equal(oversized.statusCode, 413);
  assert.equal(oversized.headers.connection, 'close');
  assert.equal(calls, 0);
});

test('a HUD summary network failure answers generically and logs no detail', async (t) => {
  setEnv(t, {
    OPENAI_API_KEY: 'fixture-key',
    GEV_RATELIMIT_OPENAI_PER_MIN: '0',
  });
  const logs = captureLogs(t);
  t.mock.method(globalThis, 'fetch', async () => {
    throw Object.assign(new TypeError(`fetch failed ${LEAK}`), {
      cause: Object.assign(new Error(LEAK), { code: 'ENOTFOUND' }),
    });
  });
  const res = mockResponse();
  await handleHudSummary(postRequest('{}'), res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(res.json(), { error: 'OpenAI HUD summary request failed' });
  assert.doesNotMatch(logs.join('\n'), /fixture-secret|internal\.example/);
  assert.match(logs.join('\n'), /TypeError \(ENOTFOUND\)/);
});

test('a HUD summary answer past the size cap is not buffered', async (t) => {
  setEnv(t, {
    OPENAI_API_KEY: 'fixture-key',
    GEV_RATELIMIT_OPENAI_PER_MIN: '0',
  });
  captureLogs(t);
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response('{}', {
        headers: { 'content-length': String(64 * 1024 * 1024) },
      }),
  );
  const res = mockResponse();
  await handleHudSummary(postRequest('{}'), res);
  assert.equal(res.statusCode, 502);
});

for (const [route, query] of [
  ['/api/google/nearby-places', '?lat=30&lon=-97'],
  ['/api/google/text-search', '?q=museum&lat=30&lon=-97'],
]) {
  test(`${route} keeps Google's error text server-side and never caches a failure`, async (t) => {
    const logs = captureLogs(t);
    const handlers = routes((middlewares) =>
      googlePlacesContextProxy({
        resolveApiKey: () => 'fixture-key',
        fetchImpl: async () =>
          Response.json({ error: { message: LEAK } }, { status: 429 }),
      }).configureServer({ middlewares }),
    );
    const refused = mockResponse();
    await handlers.get(route)(
      { url: query, method: 'GET', headers: {}, socket: {} },
      refused,
    );
    assert.equal(refused.statusCode, 429);
    assert.equal(refused.headers['cache-control'], 'no-store');
    assert.deepEqual(refused.json(), {
      places: [],
      error: 'Google Places rate limit or quota reached',
    });

    const thrown = routes((middlewares) =>
      googlePlacesContextProxy({
        resolveApiKey: () => 'fixture-key',
        fetchImpl: async () => {
          throw new Error(LEAK);
        },
      }).configureServer({ middlewares }),
    );
    const failed = mockResponse();
    await thrown.get(route)(
      { url: query, method: 'GET', headers: {}, socket: {} },
      failed,
    );
    assert.equal(failed.statusCode, 502);
    assert.equal(failed.headers['cache-control'], 'no-store');
    assert.deepEqual(failed.json(), {
      places: [],
      error: 'Google Places request failed',
    });
    assert.doesNotMatch(
      `${refused.body}${failed.body}${logs.join('\n')}`,
      /fixture-secret|internal\.example|req_fixture/,
    );
  });
}

test('a Places search that never answers is abandoned when the client leaves', async (t) => {
  captureLogs(t);
  let signal;
  const handlers = routes((middlewares) =>
    googlePlacesContextProxy({
      resolveApiKey: () => 'fixture-key',
      fetchImpl: (_url, init) => {
        signal = init.signal;
        return new Promise(() => {});
      },
    }).configureServer({ middlewares }),
  );
  const listeners = {};
  const res = Object.assign(mockResponse(), {
    once(event, fn) {
      listeners[event] = fn;
    },
  });
  const pending = handlers.get('/api/google/nearby-places')(
    { url: '?lat=30&lon=-97', method: 'GET', headers: {}, socket: {} },
    res,
  );
  await new Promise((resolve) => setImmediate(resolve));
  listeners.close();
  await pending;
  assert.equal(signal.aborted, true);
  assert.equal(res.body, undefined, 'nobody is left to answer');
});

test('adsb.lol failures with nothing cached carry our words, not the upstream body', async (t) => {
  const logs = captureLogs(t);
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(`<html>${LEAK}</html>`, { status: 500 }),
  );
  let handler;
  adsbLolProxy().configureServer({
    middlewares: {
      use(_route, fn) {
        handler = fn;
      },
    },
  });
  const res = mockResponse();
  await handler({ url: '/', method: 'GET' }, res, () => {});
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.json(), { error: 'adsb.lol is unavailable' });
  assert.doesNotMatch(
    `${res.body}${logs.join('\n')}`,
    /fixture-secret|internal\.example/,
  );
});

test('the AIS route answers an unexpected failure without its text', async (t) => {
  const logs = captureLogs(t);
  const handlers = routes((middlewares) =>
    aisLiveProxy().configureServer({
      middlewares,
      httpServer: { on() {} },
    }),
  );
  let thrown = false;
  const res = mockResponse();
  const setHeader = res.setHeader;
  res.setHeader = function (name, value) {
    if (!thrown) {
      thrown = true;
      throw new Error(LEAK);
    }
    return setHeader.call(this, name, value);
  };
  await handlers.get('/api/vessels')({ url: '/', method: 'GET' }, res);
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.json(), { error: 'AIS live stream error', rows: [] });
  assert.doesNotMatch(logs.join('\n'), /fixture-secret|internal\.example/);
});

test('a Mapillary tile failure that is not an upstream answer stays generic', async (t) => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'gev-mly-errors-'));
  _setTileCacheDirForTest(cacheDir);
  _resetTileMemoryForTest();
  t.after(async () => {
    await _settleTileWritesForTest();
    _resetTileMemoryForTest();
    await rm(cacheDir, { recursive: true, force: true });
  });
  setEnv(t, { MAPILLARY_CLIENT_TOKEN: 'MLY|fixture|token' });
  const logs = captureLogs(t);
  t.mock.method(globalThis, 'fetch', async (url) => {
    throw new TypeError(`fetch failed ${url} ${LEAK}`);
  });
  const handlers = routes(installMapillaryRoutes);
  const res = Object.assign(mockResponse(), { on() {} });
  await handlers.get('/api/mapillary/tiles')(
    { url: '/coverage/14/3/3', method: 'GET', headers: {}, on() {} },
    res,
  );
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.json(), { error: 'Tile fetch failed' });
  assert.doesNotMatch(
    `${res.body}${logs.join('\n')}`,
    /MLY\||fixture-secret|internal\.example/,
  );
});
