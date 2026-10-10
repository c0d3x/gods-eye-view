import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createBrowserViteConfig } from '../../build/vite.js';
import {
  createDebugLogHandler,
  isRealtimeDebugLogEnabled,
} from '../../server/providers/openai/debug-log.js';
import { openAiRealtimeProxy } from '../../server/providers/openai.js';
import standaloneConfig from '../../vite.config.js';
import { GevRealtimeController } from '../voice/realtimeController.js';
import {
  createDebugLogPoster,
  DEBUG_LOG_URL,
  isDebugLogEnabled,
  postDebugLog,
} from '../voice/realtimeDiagnostics.js';

const LOG_FILE = 'realtime-conversations.jsonl';

function setEnv(t, name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

async function sourceRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'gev-realtime-log-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** Call a debug-log handler the way the server would. */
function send(handler, body, { method = 'POST' } = {}) {
  return new Promise((resolve, reject) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
    Object.assign(req, {
      method,
      url: '/',
      headers: { 'content-type': 'application/json' },
      socket: { remoteAddress: '127.0.0.1' },
    });
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) {
        this.headers[String(name).toLowerCase()] = String(value);
      },
      writeHead(status, values = {}) {
        this.statusCode = status;
        for (const [name, value] of Object.entries(values))
          this.setHeader(name, value);
      },
      end(text = '') {
        resolve({
          status: this.statusCode,
          body: text ? JSON.parse(String(text)) : null,
        });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

async function readLog(root) {
  try {
    const text = await readFile(path.join(root, '.gev-logs', LOG_FILE), 'utf8');
    return text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function routeOf(plugin, route) {
  let handler;
  plugin.configureServer({
    middlewares: {
      use(pathname, value) {
        if (pathname === route) handler = value;
      },
    },
    httpServer: null,
  });
  return handler;
}

test('only an explicit yes turns the debug log on', () => {
  for (const value of ['1', 'true', 'TRUE', 'on', 'yes', ' 1 ']) {
    assert.equal(isRealtimeDebugLogEnabled(value), true, value);
  }
  for (const value of [undefined, '', '0', 'false', 'off', 'no', 'maybe']) {
    assert.equal(isRealtimeDebugLogEnabled(value), false, String(value));
  }
});

test('the debug log is off by default: the route answers 404 and writes nothing', async (t) => {
  setEnv(t, 'GEV_REALTIME_DEBUG_LOG', undefined);
  const root = await sourceRoot(t);
  const handler = routeOf(
    openAiRealtimeProxy({ sourceRoot: root }),
    '/api/realtime/debug-log',
  );
  for (const method of ['POST', 'GET']) {
    const response = await send(handler, '{"event":"x"}', { method });
    assert.equal(response.status, 404, method);
    assert.deepEqual(response.body, { error: 'Not found' });
  }
  assert.deepEqual(await readdir(root), []);
});

test('when on, the server redacts each record after omitting voice content', async (t) => {
  setEnv(t, 'GEV_REALTIME_DEBUG_LOG', '1');
  const root = await sourceRoot(t);
  const handler = routeOf(
    openAiRealtimeProxy({ sourceRoot: root }),
    '/api/realtime/debug-log',
  );
  // Assembled at runtime so the source holds no key-shaped string for secret
  // scanning to flag; the redaction still sees a Google API key's shape.
  const googleKey = `AIza${'x'.repeat(35)}`;
  const frame = 'data:image/png;base64,iVBORw0KGgo=';
  const response = await send(
    handler,
    JSON.stringify({
      event: 'session.token.ready',
      payload: {
        client_secret: { value: 'ek_abcdefghijklmnopqrstuvwxyz' },
        headers: { Authorization: 'Bearer sk-proj-abcdefghijklmnopqrstuvwxyz' },
        note: `keys ek_abcdefghijklmnopqrstuvwxyz and ${googleKey}`,
        status: 'Authorization: Basic dXNlcjpwYXNz',
        transcript: 'my address is 12 Elm Street',
        frame,
      },
    }),
  );
  assert.equal(response.status, 204);
  const [entry] = await readLog(root);
  assert.equal(entry.event, 'session.token.ready');
  assert.deepEqual(entry.payload, {
    client_secret: '[Redacted]',
    headers: { Authorization: '[Redacted]' },
    note: 'keys [Redacted ephemeral key] and [Redacted Google API key]',
    status: 'Authorization: [Redacted]',
    transcript: '[omitted 27 chars]',
    frame: `[Redacted image data URL, ${frame.length} chars]`,
  });
  assert.match(entry.loggedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('records over 256 KiB get a 413 and are not written', async (t) => {
  const root = await sourceRoot(t);
  const handler = createDebugLogHandler({ sourceRoot: root, enabled: true });
  const record = (size) =>
    JSON.stringify({ event: 'x', pad: 'a'.repeat(size - 22) });
  assert.equal(Buffer.byteLength(record(256 * 1024)), 256 * 1024);

  const tooLarge = await send(handler, record(256 * 1024 + 1));
  assert.equal(tooLarge.status, 413);
  assert.deepEqual(tooLarge.body, {
    error: 'Failed to write Realtime debug log',
  });
  assert.equal(await readLog(root), null);

  assert.equal((await send(handler, record(256 * 1024))).status, 204);
});

test('only this user can read the log, and older logs are tightened', {
  skip: process.platform === 'win32' && 'POSIX modes only',
}, async (t) => {
  const root = await sourceRoot(t);
  const directory = path.join(root, '.gev-logs');
  const file = path.join(directory, LOG_FILE);
  const handler = createDebugLogHandler({ sourceRoot: root, enabled: true });
  assert.equal((await send(handler, '{"event":"first"}')).status, 204);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  // A world-readable log left by an older version is tightened on the
  // first write.
  const legacyRoot = await sourceRoot(t);
  const legacy = path.join(legacyRoot, '.gev-logs');
  const legacyFile = path.join(legacy, LOG_FILE);
  await mkdir(legacy);
  await chmod(legacy, 0o755);
  await writeFile(legacyFile, '{}\n');
  await chmod(legacyFile, 0o644);
  await writeFile(`${legacyFile}.1`, '{}\n');
  await chmod(`${legacyFile}.1`, 0o644);
  const legacyHandler = createDebugLogHandler({
    sourceRoot: legacyRoot,
    enabled: true,
  });
  assert.equal((await send(legacyHandler, '{"event":"next"}')).status, 204);
  assert.equal((await stat(legacy)).mode & 0o777, 0o700);
  assert.equal((await stat(legacyFile)).mode & 0o777, 0o600);
  assert.equal((await stat(`${legacyFile}.1`)).mode & 0o777, 0o600);
});

test('the browser learns whether the log is on from a build-time define', (t) => {
  const flag = (config) =>
    config.define['import.meta.env.GEV_REALTIME_DEBUG_LOG'];
  assert.equal(flag(createBrowserViteConfig()), 'false');
  assert.equal(
    flag(createBrowserViteConfig({ realtimeDebugLog: true })),
    'true',
  );
  setEnv(t, 'GEV_REALTIME_DEBUG_LOG', '');
  assert.equal(flag(standaloneConfig({ mode: 'test' })), 'false');
  process.env.GEV_REALTIME_DEBUG_LOG = '1';
  assert.equal(flag(standaloneConfig({ mode: 'test' })), 'true');
});

test('the browser posts nothing while the log is off', async (t) => {
  const posted = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    posted.push(String(url));
    return new Response(null, { status: 204 });
  });
  // Outside Vite the define is absent, which is the same as the log being off.
  assert.equal(isDebugLogEnabled(), false);
  postDebugLog({ event: 'x' });
  createDebugLogPoster().post({ event: 'x' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(posted, []);

  // And the voice controller has no debug sink by default.
  const hub = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  };
  for (const [name, value] of Object.entries({
    window: hub,
    document: {
      ...hub,
      visibilityState: 'visible',
      activeElement: null,
      querySelectorAll: () => [],
    },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else delete globalThis[name];
    });
  }
  const controller = new GevRealtimeController({
    runner: async () => ({}),
    ui: {
      root: { dataset: {}, querySelectorAll: () => [], remove() {} },
      status: {},
      detail: {},
    },
  });
  assert.equal(controller.debugSink, null);
});

test('while on, the browser posts JSON and stops once the server answers 404', async () => {
  const calls = [];
  let status = 204;
  const poster = createDebugLogPoster({
    enabled: true,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status });
    },
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  poster.post({ event: 'first' });
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, DEBUG_LOG_URL);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.keepalive, true);
  assert.deepEqual(JSON.parse(calls[0].init.body), { event: 'first' });

  // A failed write is not a reason to stop.
  status = 500;
  poster.post({ event: 'second' });
  await settle();
  assert.equal(poster.isEnabled(), true);

  status = 404;
  poster.post({ event: 'third' });
  await settle();
  assert.equal(poster.isEnabled(), false);
  poster.post({ event: 'fourth' });
  await settle();
  assert.equal(calls.length, 3);
});
