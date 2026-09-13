import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import {
  ClientGoneError,
  describeUpstreamFailure,
  fetchWithTimeout,
  raceAbort,
  UpstreamTimeoutError,
  upstreamErrorMessage,
  upstreamErrorStatus,
} from './fetchWithTimeout.mjs';

/** Serve `handler` on a local port for one test; returns the base URL. */
async function serve(t, handler) {
  const server = http.createServer(handler);
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('a never-answering upstream times out and maps to 504', async (t) => {
  const base = await serve(t, () => {});
  const started = Date.now();
  await assert.rejects(
    fetchWithTimeout(`${base}/`, {}, { timeoutMs: 150 }),
    (error) => {
      assert.ok(error instanceof UpstreamTimeoutError);
      assert.equal(upstreamErrorStatus(error), 504);
      assert.equal(
        upstreamErrorMessage('Example', error),
        'Example did not answer in time',
      );
      return true;
    },
  );
  assert.ok(Date.now() - started < 2000);
});

test('the deadline also covers a body that never finishes', async (t) => {
  const base = await serve(t, (_req, res) => {
    res.writeHead(200);
    res.write('start');
  });
  const response = await fetchWithTimeout(`${base}/`, {}, { timeoutMs: 150 });
  await assert.rejects(response.text());
});

test('headersOnly stops the clock once the headers arrive', async (t) => {
  const base = await serve(t, (_req, res) => {
    res.writeHead(200);
    res.write('a');
    setTimeout(() => res.end('b'), 300);
  });
  const response = await fetchWithTimeout(
    `${base}/`,
    {},
    { timeoutMs: 150, headersOnly: true },
  );
  assert.equal(await response.text(), 'ab');
});

test('the call is aborted when the client disconnects first', async (t) => {
  const base = await serve(t, () => {});
  const client = Object.assign(new EventEmitter(), { writableEnded: false });
  const pending = fetchWithTimeout(
    `${base}/`,
    {},
    { timeoutMs: 5000, response: client },
  );
  client.emit('close');
  await assert.rejects(pending, ClientGoneError);
});

test("the caller's own signal still aborts the call", async (t) => {
  const base = await serve(t, () => {});
  const controller = new AbortController();
  const pending = fetchWithTimeout(
    `${base}/`,
    { signal: controller.signal },
    { timeoutMs: 5000 },
  );
  controller.abort(new Error('caller stopped'));
  await assert.rejects(pending, /caller stopped/);
});

test('a fetchImpl that ignores its signal is still abandoned in time', async () => {
  let received;
  const pending = fetchWithTimeout(
    'https://camera.example/',
    {},
    {
      timeoutMs: 50,
      fetchImpl: (_url, init) => {
        received = init.signal;
        return new Promise(() => {});
      },
    },
  );
  await assert.rejects(pending, UpstreamTimeoutError);
  assert.equal(received.aborted, true);
});

test('raceAbort settles with the promise, or with the abort', async () => {
  assert.equal(await raceAbort(Promise.resolve('value')), 'value');
  assert.equal(
    await raceAbort(Promise.resolve('value'), new AbortController().signal),
    'value',
  );
  await assert.rejects(
    raceAbort(new Promise(() => {}), AbortSignal.abort(new Error('stopped'))),
    /stopped/,
  );
});

test("error messages use our own words, never the provider's", () => {
  assert.equal(
    upstreamErrorMessage('OpenAI', 401),
    'OpenAI rejected the API key',
  );
  assert.equal(
    upstreamErrorMessage('OpenAI', 429),
    'OpenAI rate limit or quota reached',
  );
  assert.equal(
    upstreamErrorMessage('Google Places', 403),
    'Google Places refused the request; check the API key and its permissions',
  );
  assert.equal(upstreamErrorMessage('OpenSky', 503), 'OpenSky is unavailable');
  assert.equal(upstreamErrorMessage('OpenSky', 418), 'OpenSky request failed');
  assert.equal(
    upstreamErrorMessage('OpenSky', new Error('ECONNRESET 10.0.0.5')),
    'OpenSky request failed',
  );
  assert.equal(upstreamErrorStatus(new Error('network down')), 502);
});

test('failure descriptions keep the details for the server log', () => {
  assert.equal(
    describeUpstreamFailure(
      401,
      JSON.stringify({ error: { message: 'Incorrect API key provided' } }),
    ),
    'HTTP 401: Incorrect API key provided',
  );
  assert.equal(
    describeUpstreamFailure(403, '{"error":"denied"}'),
    'HTTP 403: denied',
  );
  assert.equal(
    describeUpstreamFailure(
      500,
      JSON.stringify({ message: 'line one\nline two' }),
    ),
    'HTTP 500: line one line two',
  );
  assert.equal(
    describeUpstreamFailure(502, '<html>Bad gateway</html>'),
    'HTTP 502',
  );
});
