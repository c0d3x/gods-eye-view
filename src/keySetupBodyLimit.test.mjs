import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { keySetupEndpoint } from '../server/keySetupEndpoint.mjs';

/** Serve the Provider Settings save route on 127.0.0.1 for one test. */
async function serveKeySetup(t) {
  const routes = new Map();
  keySetupEndpoint().configureServer({
    middlewares: {
      use(path, handler) {
        routes.set(path, handler);
      },
    },
    restart: async () => {},
  });
  const server = http.createServer((req, res) => {
    routes.get('/api/setup/keys')(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}

/** POST a body the way the Provider Settings panel does. */
function post(port, body, { chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      Origin: `http://127.0.0.1:${port}`,
      'Content-Type': 'application/json',
    };
    if (chunked) headers['Transfer-Encoding'] = 'chunked';
    else headers['Content-Length'] = Buffer.byteLength(body);
    const request = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: '/', headers },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () => {
          resolve({
            status: response.statusCode,
            headers: response.headers,
            text,
          });
        });
      },
    );
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

test('an oversized save gets a 413 reply, not a reset connection', async (t) => {
  const port = await serveKeySetup(t);
  const body = JSON.stringify({ OPENAI_API_KEY: 'x'.repeat(9 * 1024) });
  for (const chunked of [false, true]) {
    const response = await post(port, body, { chunked });
    assert.equal(response.status, 413, `chunked: ${chunked}`);
    assert.deepEqual(JSON.parse(response.text), { error: 'Request too large' });
    assert.equal(response.headers.connection, 'close');
  }
});

test('a save within the limit is still read and checked', async (t) => {
  const port = await serveKeySetup(t);
  const response = await post(port, '{not json');
  assert.equal(response.status, 400);
  assert.deepEqual(JSON.parse(response.text), { error: 'Invalid JSON' });
});
