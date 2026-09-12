import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { build, createServer } from 'vite';
import cesium, {
  rewriteCesiumImports,
} from '../../scripts/cesium-vite-plugin.mjs';

const unminified = path.join(
  path.dirname(createRequire(import.meta.url).resolve('cesium/package.json')),
  'Build/CesiumUnminified',
);

async function fixture(t, prefix, html) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, 'index.html'),
    `<!doctype html><html><head></head><body>${html}</body></html>`,
  );
  return root;
}

/** Request a raw path, bypassing fetch's URL normalization. */
function get(port, rawPath) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: rawPath }, (res) => {
        res.resume();
        res.on('end', () => resolve(res));
      })
      .on('error', reject);
  });
}

test('cesium imports become references to the global Cesium', async () => {
  const source = [
    "import * as Cesium from 'cesium';",
    "import * as Engine from 'cesium';",
    "import { Viewer, Cartesian3 as Point, default as Whole } from 'cesium';",
    'globalThis.seen = [Cesium.VERSION, Engine.VERSION, Viewer, Point, Whole.VERSION];',
    "globalThis.load = () => import('cesium');",
  ].join('\n');
  const { code } = rewriteCesiumImports(source);
  assert.equal(code.split('\n').length, source.split('\n').length);
  assert.doesNotMatch(code, /['"]cesium['"]/);

  const Cesium = { VERSION: '1.x', Viewer: class {}, Cartesian3: class {} };
  const context = vm.createContext({ Cesium });
  vm.runInContext(code, context);
  assert.deepEqual(
    [...context.seen],
    ['1.x', '1.x', Cesium.Viewer, Cesium.Cartesian3, '1.x'],
  );
  assert.equal(await context.load(), Cesium);
});

test('modules without cesium imports are untouched and re-exports are rejected', () => {
  assert.equal(rewriteCesiumImports("const label = 'cesium';"), null);
  assert.equal(rewriteCesiumImports("import x from 'cesium-helper';"), null);
  for (const source of [
    "export { Viewer } from 'cesium';",
    "export * from 'cesium';",
  ]) {
    assert.throws(() => rewriteCesiumImports(source, 'layer.js'), /layer\.js/);
  }
});

test('a build loads the global Cesium.js and ships its runtime files', async (t) => {
  const root = await fixture(
    t,
    'gev-cesium-build-',
    '<script type="module" src="/main.js"></script>',
  );
  await writeFile(
    path.join(root, 'main.js'),
    "import * as Cesium from 'cesium';\ndocument.title = Cesium.VERSION;\n",
  );
  await build({
    root,
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    plugins: [cesium()],
  });

  const dist = path.join(root, 'dist');
  const html = await readFile(path.join(dist, 'index.html'), 'utf8');
  assert.match(
    html,
    /<link rel="stylesheet" href="\/cesium\/Widgets\/widgets\.css">/,
  );
  assert.match(html, /<script src="\/cesium\/Cesium\.js"><\/script>/);
  const [entry] = (await readdir(path.join(dist, 'assets'))).filter((name) =>
    name.endsWith('.js'),
  );
  const js = await readFile(path.join(dist, 'assets', entry), 'utf8');
  assert.match(js, /Cesium\.VERSION/);
  assert.doesNotMatch(js, /['"]cesium['"]/);
  assert.deepEqual((await readdir(path.join(dist, 'cesium'))).sort(), [
    'Assets',
    'Cesium.js',
    'ThirdParty',
    'Widgets',
    'Workers',
  ]);
});

test('the dev server serves unminified Cesium and defines its base URL', async (t) => {
  const root = await fixture(t, 'gev-cesium-dev-', '');
  const server = await createServer({
    root,
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    plugins: [cesium()],
    optimizeDeps: { noDiscovery: true },
    server: { host: '127.0.0.1', port: 0 },
  });
  t.after(() => server.close());
  await server.listen();
  const { port } = server.httpServer.address();
  const base = `http://127.0.0.1:${port}`;
  assert.equal(server.config.define.CESIUM_BASE_URL, '"/cesium/"');

  const worker = 'Workers/createVerticesFromHeightmap.js';
  const response = await fetch(`${base}/cesium/${worker}`);
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get('content-type'),
    'application/javascript; charset=UTF-8',
  );
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(
    await response.text(),
    await readFile(path.join(unminified, worker), 'utf8'),
  );
  const cached = await fetch(`${base}/cesium/${worker}`, {
    headers: { 'If-None-Match': response.headers.get('etag') },
  });
  assert.equal(cached.status, 304);
  const css = await fetch(`${base}/cesium/Widgets/widgets.css`);
  assert.equal(css.headers.get('content-type'), 'text/css; charset=UTF-8');
  await css.arrayBuffer();

  const directory = await get(port, '/cesium/Workers');
  assert.equal(directory.statusCode, 301);
  assert.equal(directory.headers.location, '/cesium/Workers/');
  for (const rawPath of [
    '/cesium/Workers%2F..%2F..%2Fpackage.json',
    '/cesium/Workers%5C..%5C..%5Cpackage.json',
  ]) {
    const outside = await get(port, rawPath);
    assert.equal(outside.headers['access-control-allow-origin'], undefined);
  }

  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /href="\/cesium\/Widgets\/widgets\.css"/);
  assert.doesNotMatch(html, /Cesium\.js/);
});
