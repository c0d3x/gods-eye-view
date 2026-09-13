import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  GOOGLE_PLACES_TIMEOUT_MS,
  googlePlacesContextProxy,
  OPENAI_TIMEOUT_MS,
  openAiRealtimeProxy,
} from '../vite.config.js';

// The cost limiters are built once per process with their defaults. Each test
// uses its own client address, so the per-client budgets never overlap.
delete process.env.GEV_RATELIMIT_OPENAI_PER_MIN;
delete process.env.GEV_RATELIMIT_GOOGLE_PER_MIN;

const source = readFileSync(
  new URL('../vite.config.js', import.meta.url),
  'utf8',
);

// Provider error text that must never reach the browser.
const providerDetail = 'Incorrect API key provided: sk-fixture <html>';

function installRoutes(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(path, handler) {
        routes.set(path, handler);
      },
    },
  });
  return routes;
}

/**
 * Call a route with a fake request and response. The response is an
 * EventEmitter, so a test can emit 'close' to act as a browser that
 * disconnects.
 */
function invoke(handler, { method = 'GET', url = '/', body, remoteAddress }) {
  const req = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), {
    method,
    url,
    headers: {},
    socket: { remoteAddress },
  });
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    headers: {},
    headersSent: false,
    writableEnded: false,
    text: '',
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = String(value);
    },
    writeHead(status, values = {}) {
      this.statusCode = status;
      for (const [name, value] of Object.entries(values)) {
        this.setHeader(name, value);
      }
      this.headersSent = true;
      return this;
    },
    end(text = '') {
      this.headersSent = true;
      this.writableEnded = true;
      this.text = String(text);
    },
  });
  const done = Promise.resolve(handler(req, res)).then(() => res);
  return { res, done };
}

function setEnv(t, values) {
  const previous = Object.fromEntries(
    Object.keys(values).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, values);
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

/** A fetch that never answers; it rejects only when its signal aborts. */
function hangingFetch(t) {
  return t.mock.method(
    globalThis,
    'fetch',
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => reject(init.signal.reason),
          { once: true },
        );
      }),
  );
}

const turn = () => new Promise((resolve) => setImmediate(resolve));

/** Wait a few event-loop turns at most for `condition()` to hold. */
async function until(condition) {
  for (let turns = 0; turns < 50 && !condition(); turns += 1) {
    await turn();
  }
  assert.ok(condition(), 'the condition never came true');
}

/** The source text of a call's arguments, from just after its "(". */
function callArguments(text, start) {
  let depth = 1;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'" || char === '"' || char === '`') {
      index = closingQuote(text, index);
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index);
    }
  }
  throw new Error('unbalanced call');
}

function closingQuote(text, open) {
  for (let index = open + 1; index < text.length; index += 1) {
    if (text[index] === '\\') index += 1;
    else if (text[index] === text[open]) return index;
  }
  throw new Error('unterminated string');
}

test('every upstream fetch in vite.config.js can be aborted', () => {
  const calls = [];
  for (const match of source.matchAll(/(?<![\w.])fetch\(/g)) {
    const lineStart = source.lastIndexOf('\n', match.index) + 1;
    const line = source.slice(lineStart, source.indexOf('\n', match.index));
    // Skip mentions of fetch() in comments.
    if (/^\s*(\/\*|\*|\/\/)/.test(line)) continue;
    calls.push({
      line: source.slice(0, match.index).split('\n').length,
      args: callArguments(source, match.index + 'fetch('.length),
    });
  }
  assert.ok(calls.length >= 10, `found only ${calls.length} fetch() calls`);
  const bare = calls
    .filter((call) => !/\bsignal\b/.test(call.args))
    .map((call) => `vite.config.js:${call.line}`);
  assert.deepEqual(bare, [], 'give these a signal, or use fetchWithTimeout');
});

test('a stalled OpenAI call answers 504 when its deadline passes', async (t) => {
  setEnv(t, { OPENAI_API_KEY: 'test-openai-key' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(console, 'warn', () => {});
  const upstream = hangingFetch(t);
  const hud = installRoutes(openAiRealtimeProxy()).get(
    '/api/openai/hud-summary',
  );
  const { res, done } = invoke(hud, {
    method: 'POST',
    body: '{"place":"Austin"}',
    remoteAddress: '10.0.8.1',
  });
  await until(() => upstream.mock.callCount() === 1);
  t.mock.timers.tick(OPENAI_TIMEOUT_MS - 1);
  await turn();
  assert.equal(res.writableEnded, false);
  t.mock.timers.tick(1);
  await done;
  assert.equal(res.statusCode, 504);
  assert.deepEqual(JSON.parse(res.text), {
    summary: null,
    error: 'OpenAI did not answer in time',
  });
});

test('a stalled Places call answers 504 and keeps the places list', async (t) => {
  setEnv(t, { GOOGLE_MAPS_SERVER_API_KEY: 'test-server-key' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(console, 'warn', () => {});
  const upstream = hangingFetch(t);
  const nearby = installRoutes(googlePlacesContextProxy()).get(
    '/api/google/nearby-places',
  );
  const { res, done } = invoke(nearby, {
    url: '/?lat=30.27&lon=-97.74',
    remoteAddress: '10.0.8.2',
  });
  await until(() => upstream.mock.callCount() === 1);
  t.mock.timers.tick(GOOGLE_PLACES_TIMEOUT_MS - 1);
  await turn();
  assert.equal(res.writableEnded, false);
  t.mock.timers.tick(1);
  await done;
  assert.equal(res.statusCode, 504);
  assert.deepEqual(JSON.parse(res.text), {
    error: 'Google Places did not answer in time',
    places: [],
  });
});

test("OpenAI's error text stays out of the Realtime token response", async (t) => {
  setEnv(t, { OPENAI_API_KEY: 'test-openai-key' });
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(
      { error: { message: providerDetail, code: 'invalid_api_key' } },
      { status: 401 },
    ),
  );
  const warn = t.mock.method(console, 'warn', () => {});
  const token = installRoutes(openAiRealtimeProxy()).get('/api/realtime/token');
  const { res, done } = invoke(token, { remoteAddress: '10.0.8.3' });
  await done;
  assert.equal(res.statusCode, 401);
  assert.deepEqual(JSON.parse(res.text), {
    error: 'OpenAI rejected the API key',
  });
  assert.equal(res.headers['x-gev-voice-tier'], 'standard');
  // The details go to the server log instead.
  const logged = warn.mock.calls
    .map((call) => call.arguments.join(' '))
    .join('\n');
  assert.match(logged, /HTTP 401: Incorrect API key provided/);
});

test('a minted Realtime secret is passed through untouched', async (t) => {
  setEnv(t, { OPENAI_API_KEY: 'test-openai-key' });
  const minted = { value: 'fixture-client-secret', expires_at: 1 };
  t.mock.method(globalThis, 'fetch', async () => Response.json(minted));
  const token = installRoutes(openAiRealtimeProxy()).get('/api/realtime/token');
  const { res, done } = invoke(token, { remoteAddress: '10.0.8.4' });
  await done;
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.text), minted);
});

test("Google's error text stays out of the Places responses", async (t) => {
  setEnv(t, { GOOGLE_MAPS_SERVER_API_KEY: 'test-server-key' });
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(
      {
        error: {
          code: 403,
          message: providerDetail,
          status: 'PERMISSION_DENIED',
        },
      },
      { status: 403 },
    ),
  );
  t.mock.method(console, 'warn', () => {});
  const routes = installRoutes(googlePlacesContextProxy());
  for (const [route, url] of [
    ['/api/google/nearby-places', '/?lat=30.27&lon=-97.74'],
    ['/api/google/text-search', '/?lat=30.27&lon=-97.74&q=capitol'],
  ]) {
    const { res, done } = invoke(routes.get(route), {
      url,
      remoteAddress: '10.0.8.5',
    });
    await done;
    assert.equal(res.statusCode, 403);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(res.text), {
      error:
        'Google Places refused the request; check the API key and its permissions',
      places: [],
    });
  }
});

test('a failed upstream call answers 502 without the exception text', async (t) => {
  setEnv(t, { GOOGLE_MAPS_SERVER_API_KEY: 'test-server-key' });
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError(`fetch failed: ${providerDetail}`);
  });
  t.mock.method(console, 'warn', () => {});
  const nearby = installRoutes(googlePlacesContextProxy()).get(
    '/api/google/nearby-places',
  );
  const { res, done } = invoke(nearby, {
    url: '/?lat=30.27&lon=-97.74',
    remoteAddress: '10.0.8.6',
  });
  await done;
  assert.equal(res.statusCode, 502);
  assert.deepEqual(JSON.parse(res.text), {
    error: 'Google Places request failed',
    places: [],
  });
});

test('a call made for one browser request stops when it disconnects', async (t) => {
  setEnv(t, { GOOGLE_MAPS_SERVER_API_KEY: 'test-server-key' });
  const upstream = hangingFetch(t);
  const warn = t.mock.method(console, 'warn', () => {});
  const nearby = installRoutes(googlePlacesContextProxy()).get(
    '/api/google/nearby-places',
  );
  const { res, done } = invoke(nearby, {
    url: '/?lat=30.27&lon=-97.74',
    remoteAddress: '10.0.8.7',
  });
  await until(() => upstream.mock.callCount() === 1);
  res.emit('close');
  await done;
  assert.equal(upstream.mock.calls[0].arguments[1].signal.aborted, true);
  // Nothing is written to the closed connection, and nothing is logged.
  assert.equal(res.writableEnded, false);
  assert.equal(warn.mock.callCount(), 0);
});
