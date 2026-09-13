import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';
import config from '../vite.config.js';

const PRIVATE_DIRECTORIES = ['.gev-logs', '.gev-cache', '.claude'];
const PRIVATE_FILES = [
  '.gev-logs/realtime-conversations.jsonl',
  '.gev-cache/overpass/query.json',
  '.claude/settings.local.json',
];

/** Send a raw request and collect the status and headers. */
function request(port, rawPath, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    http
      .request(
        { host: '127.0.0.1', port, path: rawPath, method, headers },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res));
        },
      )
      .on('error', reject)
      .end();
  });
}

test('the dev and preview servers have CORS turned off', () => {
  const resolved = config({ mode: 'test' });
  assert.equal(resolved.server.cors, false);
  assert.equal(resolved.preview.cors, false);
});

test('the dev server denies its private directories', () => {
  const { deny } = config({ mode: 'test' }).server.fs;
  for (const directory of PRIVATE_DIRECTORIES) {
    assert.ok(deny.includes(`**/${directory}/**`), directory);
  }
  // The earlier protections stay in place.
  for (const pattern of ['.env', '.env.*', '*.{crt,pem}', '**/.git/**']) {
    assert.ok(deny.includes(pattern), pattern);
  }
});

test('Vite refuses the private files and answers other origins without CORS', async (t) => {
  const { cors, fs } = config({ mode: 'test' }).server;
  const root = await mkdtemp(path.join(tmpdir(), 'gev-server-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, 'index.html'),
    '<!doctype html><title>t</title>',
  );
  await writeFile(path.join(root, 'public.txt'), 'public');
  for (const file of PRIVATE_FILES) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), 'private');
  }

  const server = await createServer({
    root,
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true },
    server: { host: '127.0.0.1', port: 0, cors, fs: { deny: fs.deny } },
  });
  t.after(() => server.close());
  await server.listen();
  const { port } = server.httpServer.address();

  for (const file of PRIVATE_FILES) {
    const response = await request(port, `/${file}`);
    assert.equal(response.statusCode, 403, file);
  }

  const origin = { origin: 'http://localhost:9999' };
  const page = await request(port, '/public.txt', { headers: origin });
  assert.equal(page.statusCode, 200);
  assert.equal(page.headers['access-control-allow-origin'], undefined);

  const preflight = await request(port, '/public.txt', {
    method: 'OPTIONS',
    headers: { ...origin, 'access-control-request-method': 'POST' },
  });
  assert.equal(preflight.headers['access-control-allow-origin'], undefined);
});
