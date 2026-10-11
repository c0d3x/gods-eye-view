import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appViteConfig, startAppServer } from './server.mjs';

/**
 * A built app with only its two documents, in a temporary root.
 * @param {import('node:test').TestContext} t
 */
function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-app-server-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'dist', 'panel'), { recursive: true });
  const page = (/** @type {string} */ title) =>
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body></body></html>`;
  fs.writeFileSync(path.join(root, 'dist', 'index.html'), page('app'));
  fs.writeFileSync(
    path.join(root, 'dist', 'panel', 'index.html'),
    page('panel'),
  );
  return root;
}

function memoryStore(text = '') {
  /** @type {string[]} */
  const writes = [];
  return {
    writes,
    store: {
      name: 'app-keychain',
      read: () => text,
      write: (/** @type {string} */ next) => {
        text = next;
        writes.push(next);
      },
    },
  };
}

test('the app server serves the built app with its keys, Provider Settings and the guards', async (t) => {
  const root = tempRoot(t);
  const { store, writes } = memoryStore();
  let saved = 0;
  const env = { CESIUM_ION_TOKEN: 'ion-token', OPENAI_API_KEY: 'sk-secret' };
  const server = await startAppServer({
    root,
    store,
    env,
    onSaved: () => {
      saved += 1;
    },
    port: 0,
  });
  t.after(() => server.close());
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const origin = server.url.slice(0, -1);
  /**
   * @param {string} pathname
   * @param {RequestInit} [init]
   */
  const get = (pathname, init) => fetch(`${origin}${pathname}`, init);

  const page = await get('/');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.match(
    page.headers.get('content-security-policy') ?? '',
    /frame-ancestors 'none'/,
  );
  assert.match(
    await page.text(),
    /<script src="\/gev-runtime-config\.js"><\/script>/,
  );
  assert.match(await (await get('/panel/')).text(), /gev-runtime-config\.js/);

  const config = await (await get('/gev-runtime-config.js')).text();
  assert.match(config, /"CESIUM_ION_TOKEN":"ion-token"/);
  assert.doesNotMatch(
    config,
    /sk-secret/,
    'server-only keys never reach the page',
  );

  const status = await get('/api/setup/status');
  assert.equal(status.status, 200);
  const body = /** @type {{store: string, keys: {id: string}[]}} */ (
    await status.json()
  );
  assert.equal(body.store, 'app-keychain');
  assert.ok(body.keys.some((key) => key.id === 'tfl'));

  const save = await get('/api/setup/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ LL2_API_TOKEN: 'token-0123456789abcdef' }),
  });
  assert.equal(save.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(saved, 1, 'a save asks the app to restart');
  assert.match(writes.at(-1) ?? '', /LL2_API_TOKEN=token-0123456789abcdef/);

  const crossSite = await get('/api/launches', {
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(crossSite.status, 403);
  // fetch() will not send a Host header of its own choosing.
  const foreignHost = await new Promise((resolve, reject) => {
    http
      .get(`${origin}/`, { headers: { host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
      .on('error', reject);
  });
  assert.equal(foreignHost, 403);
  const unknown = await get('/api/no-such-route');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers.get('content-type'), 'application/json');
});

test('the app serves every plugin the standalone server does, without loading .env', async () => {
  const { default: standalone } = await import(
    '../server/standalone/vite.config.js'
  );
  // Vite's PluginOption nests arrays and promises; only the names matter.
  const names = (/** @type {any} */ plugins) =>
    new Set(
      plugins.flat(Infinity).map((/** @type {any} */ plugin) => plugin?.name),
    );
  const expected = names(
    standalone({ command: 'serve', mode: 'production', isPreview: true })
      .plugins,
  );
  const config = appViteConfig({
    root: os.tmpdir(),
    ...memoryStore(),
    onSaved: () => {},
  });
  const actual = names(config.plugins ?? []);
  for (const name of expected) assert.ok(actual.has(name), name);
  assert.ok(actual.has('gev-app-runtime-config'));
  assert.equal(config.envDir, false);
  assert.equal(config.preview?.host, '127.0.0.1');
});
