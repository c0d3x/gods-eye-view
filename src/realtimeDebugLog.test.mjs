import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { DEBUG_LOG_MAX_RECORD_BYTES } from '../server/lib/debugLog.mjs';
import config, { openAiRealtimeProxy } from '../vite.config.js';

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

/** Install the debug-log route writing to a temporary directory. */
async function installDebugLog(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'gev-realtime-log-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, '.gev-logs');
  let route;
  openAiRealtimeProxy({ debugLogDirectory: directory }).configureServer({
    middlewares: {
      use(pathname, handler) {
        if (pathname === '/api/realtime/debug-log') route = handler;
      },
    },
  });

  const send = (body, { method = 'POST', headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
      Object.assign(req, {
        method,
        url: '/',
        headers: { 'content-type': 'application/json', ...headers },
        socket: { remoteAddress: '127.0.0.1' },
      });
      const res = {
        statusCode: 200,
        headers: {},
        setHeader(name, value) {
          this.headers[String(name).toLowerCase()] = String(value);
        },
        end(text = '') {
          resolve({
            statusCode: this.statusCode,
            headers: this.headers,
            body: text ? JSON.parse(String(text)) : null,
          });
        },
      };
      Promise.resolve(route(req, res)).catch(reject);
    });

  const lines = async () => {
    try {
      const text = await readFile(
        path.join(directory, 'realtime-conversations.jsonl'),
        'utf8',
      );
      return text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  };

  return { send, lines };
}

test('the debug log is off by default: the route answers 404 and writes nothing', async (t) => {
  setEnv(t, { GEV_REALTIME_DEBUG_LOG: '' });
  const log = await installDebugLog(t);
  for (const method of ['POST', 'GET']) {
    const response = await log.send('{"event":"x"}', { method });
    assert.equal(response.statusCode, 404, method);
    assert.deepEqual(response.body, { error: 'Not found' });
  }
  assert.equal(await log.lines(), null);
});

test('when on, the server redacts each record before appending it', async (t) => {
  setEnv(t, { GEV_REALTIME_DEBUG_LOG: '1' });
  const log = await installDebugLog(t);
  const response = await log.send(
    JSON.stringify({
      event: 'session.token.ready',
      payload: {
        client_secret: { value: 'ek_abcdefghijklmnopqrstuv' },
        note: 'sent Bearer abcdefghijklmnop',
      },
    }),
  );
  assert.equal(response.statusCode, 204);

  const [entry] = await log.lines();
  assert.equal(entry.event, 'session.token.ready');
  assert.deepEqual(entry.payload, {
    client_secret: '[Redacted]',
    note: 'sent Bearer [Redacted]',
  });
  assert.match(entry.loggedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('records over 256 KiB get a generic 413 and are not written', async (t) => {
  setEnv(t, { GEV_REALTIME_DEBUG_LOG: '1' });
  const log = await installDebugLog(t);
  const big = JSON.stringify({
    event: 'x',
    payload: 'a'.repeat(DEBUG_LOG_MAX_RECORD_BYTES),
  });

  const declared = await log.send(big, {
    headers: { 'content-length': String(Buffer.byteLength(big)) },
  });
  assert.equal(declared.statusCode, 413);
  assert.deepEqual(declared.body, { error: 'Debug log record too large' });

  // Without a declared length the cap applies while reading.
  const streamed = await log.send(big);
  assert.equal(streamed.statusCode, 413);
  assert.equal(await log.lines(), null);
});

test('malformed records get a generic 400', async (t) => {
  setEnv(t, { GEV_REALTIME_DEBUG_LOG: '1' });
  const log = await installDebugLog(t);
  for (const body of ['{not json', '[1,2]', '"text"', 'null']) {
    const response = await log.send(body);
    assert.equal(response.statusCode, 400, body);
    assert.deepEqual(response.body, { error: 'Invalid debug log record' });
  }
  assert.equal(await log.lines(), null);
});

test('only POST is accepted while the log is on', async (t) => {
  setEnv(t, { GEV_REALTIME_DEBUG_LOG: '1' });
  const log = await installDebugLog(t);
  const response = await log.send(undefined, { method: 'GET' });
  assert.equal(response.statusCode, 405);
  assert.deepEqual(response.body, { error: 'Method not allowed' });
});

test('the browser learns whether the log is on from a build-time define', (t) => {
  setEnv(t, { GEV_REALTIME_DEBUG_LOG: '' });
  const flag = () =>
    config({ mode: 'test' }).define['import.meta.env.GEV_REALTIME_DEBUG_LOG'];
  assert.equal(flag(), 'false');
  process.env.GEV_REALTIME_DEBUG_LOG = '1';
  assert.equal(flag(), 'true');
});
