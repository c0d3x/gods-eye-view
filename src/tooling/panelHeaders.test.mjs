import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { panelBuildPlugin } from '../../build/panel.js';
import { BROWSER_HEADERS, createBrowserViteConfig } from '../../build/vite.js';

test('the dev server sends its browser headers with the panel build, so it cannot be framed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'panel-headers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'out'), { recursive: true });
  await writeFile(join(root, 'out', 'index.html'), '<p>panel</p>');
  const { headers } = createBrowserViteConfig().server;
  assert.equal(headers, BROWSER_HEADERS);
  let middleware;
  panelBuildPlugin({ outDir: 'out' }).configureServer({
    config: { root, server: { headers } },
    middlewares: { use: (fn) => (middleware = fn) },
  });
  const get = (url) =>
    new Promise((resolve) => {
      const res = {
        statusCode: 200,
        headers: {},
        setHeader(name, value) {
          this.headers[name] = value;
        },
        end() {
          resolve({ status: this.statusCode, headers: this.headers });
        },
      };
      middleware({ url }, res, () => resolve({ passed: true }));
    });
  for (const url of ['/panel/', '/panel/missing.js']) {
    const response = await get(url);
    assert.equal(response.headers['X-Frame-Options'], 'DENY', url);
    assert.match(
      response.headers['Content-Security-Policy'],
      /frame-ancestors 'none'/,
      url,
    );
    assert.equal(response.headers['X-Content-Type-Options'], 'nosniff', url);
  }
  assert.deepEqual(await get('/other'), { passed: true });
});
