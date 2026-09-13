import assert from 'node:assert/strict';
import test from 'node:test';
import config from '../vite.config.js';

const GUARD = 'gev-api-request-guard';
const PLACES = 'google-places-context-proxy';
const HOST = '127.0.0.1:4173';
const NEARBY = '/api/google/nearby-places?lat=30.27&lon=-97.74';
const ENFORCE_RANK = { pre: 0, post: 2 };

/** Order plugins the way Vite runs their server hooks: `pre`, normal, `post`. */
function inHookOrder(plugins) {
  const rank = (plugin) => ENFORCE_RANK[plugin.enforce] ?? 1;
  return plugins
    .map((plugin, index) => ({ plugin, index }))
    .sort((a, b) => rank(a.plugin) - rank(b.plugin) || a.index - b.index)
    .map(({ plugin }) => plugin);
}

/** Just enough of connect to run mounted middleware in registration order. */
function createApp() {
  const stack = [];
  const server = {
    middlewares: {
      use(route, handle) {
        stack.push({ route, handle });
      },
    },
  };

  function request({ method = 'GET', url, headers = {} }) {
    return new Promise((resolve, reject) => {
      const responseHeaders = {};
      const res = {
        statusCode: 200,
        setHeader(name, value) {
          responseHeaders[String(name).toLowerCase()] = String(value);
        },
        writeHead(status, values = {}) {
          this.statusCode = status;
          for (const [name, value] of Object.entries(values)) {
            this.setHeader(name, value);
          }
          return this;
        },
        end(body = '') {
          resolve({
            statusCode: this.statusCode,
            headers: responseHeaders,
            body: String(body),
          });
        },
      };
      const req = {
        method,
        url,
        originalUrl: url,
        headers: { host: HOST, ...headers },
        socket: { remoteAddress: '127.0.0.1' },
      };
      const pathname = url.split('?')[0];
      let index = 0;
      const next = (error) => {
        if (error) {
          reject(error);
          return;
        }
        const layer = stack[index];
        index += 1;
        if (!layer) {
          res.statusCode = 404;
          res.end();
          return;
        }
        if (
          pathname !== layer.route &&
          !pathname.startsWith(`${layer.route}/`)
        ) {
          next();
          return;
        }
        const rest = url.slice(layer.route.length);
        req.url = rest.startsWith('/') ? rest : `/${rest}`;
        Promise.resolve(layer.handle(req, res, next)).catch(reject);
      };
      next();
    });
  }

  return { server, request };
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

test('the guard runs before every other plugin, in dev and preview', () => {
  const ordered = inHookOrder(config({ mode: 'test' }).plugins);
  for (const hook of ['configureServer', 'configurePreviewServer']) {
    const first = ordered.find(
      (plugin) => typeof plugin?.[hook] === 'function',
    );
    assert.equal(first?.name, GUARD, hook);
  }
});

test('a cross-site request to a paid route is refused before it reaches Google', async (t) => {
  setEnv(t, { GOOGLE_MAPS_SERVER_API_KEY: 'test-server-key' });
  const warnings = t.mock.method(console, 'warn', () => {});
  const upstream = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ places: [] }),
  );
  const plugins = config({ mode: 'test' }).plugins.filter((plugin) =>
    [GUARD, PLACES].includes(plugin?.name),
  );
  assert.equal(plugins.length, 2);
  const app = createApp();
  for (const plugin of inHookOrder(plugins)) plugin.configureServer(app.server);

  const refused = await app.request({
    url: NEARBY,
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(refused.statusCode, 403);
  assert.deepEqual(JSON.parse(refused.body), {
    error: 'Cross-site requests are refused',
  });
  assert.equal(upstream.mock.callCount(), 0);
  assert.equal(warnings.mock.callCount(), 1);

  const allowed = await app.request({
    url: NEARBY,
    headers: { 'sec-fetch-site': 'same-origin' },
  });
  assert.equal(allowed.statusCode, 200);
  assert.equal(upstream.mock.callCount(), 1);
});

test('vite preview installs the same guard, scoped to /api', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const guard = config({ mode: 'test' }).plugins.find(
    (plugin) => plugin?.name === GUARD,
  );
  const app = createApp();
  guard.configurePreviewServer(app.server);

  const refused = await app.request({
    method: 'POST',
    url: '/api/realtime/debug-log',
    headers: {
      origin: 'http://evil.example',
      'content-type': 'application/json',
      'content-length': '2',
    },
  });
  assert.equal(refused.statusCode, 403);

  // Outside /api the guard never runs, so the request falls through.
  const page = await app.request({
    url: '/index.html',
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(page.statusCode, 404);
});
