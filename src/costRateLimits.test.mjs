import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_GOOGLE_REQUESTS_PER_MINUTE,
  DEFAULT_OPENAI_REQUESTS_PER_MINUTE,
} from '../server/lib/rateLimit.mjs';
import {
  cctvProxy,
  googlePlacesContextProxy,
  openAiRealtimeProxy,
} from '../vite.config.js';

// The cost limiters are built once per process from the environment, so this
// file leaves GEV_RATELIMIT_* unset and every test sees the defaults. Each
// test uses its own client address, so the per-client budgets never overlap.
delete process.env.GEV_RATELIMIT_OPENAI_PER_MIN;
delete process.env.GEV_RATELIMIT_GOOGLE_PER_MIN;

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

function invoke(handler, { method = 'GET', url = '/', remoteAddress }) {
  return new Promise((resolve, reject) => {
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader(name, value) {
        headers[String(name).toLowerCase()] = String(value);
      },
      writeHead(status, values = {}) {
        this.statusCode = status;
        for (const [name, value] of Object.entries(values)) {
          this.setHeader(name, value);
        }
        return this;
      },
      end(body = '') {
        const text = String(body);
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          // Frames are images, not JSON.
        }
        resolve({ statusCode: this.statusCode, headers, text, json });
      },
    };
    const req = { method, url, headers: {}, socket: { remoteAddress } };
    Promise.resolve(handler(req, res)).catch(reject);
  });
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

test('the OpenAI routes allow 30 requests a minute per client by default', async (t) => {
  setEnv(t, { OPENAI_API_KEY: '' });
  const token = installRoutes(openAiRealtimeProxy()).get('/api/realtime/token');
  for (let sent = 0; sent < DEFAULT_OPENAI_REQUESTS_PER_MINUTE; sent += 1) {
    // Admitted by the limiter, then refused for the missing key.
    const response = await invoke(token, { remoteAddress: '10.0.0.1' });
    assert.equal(response.statusCode, 503);
  }
  const limited = await invoke(token, { remoteAddress: '10.0.0.1' });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers['retry-after'], '5');
  assert.deepEqual(limited.json, { error: 'Rate limit exceeded' });

  // Another client keeps its own budget.
  const other = await invoke(token, { remoteAddress: '10.0.0.2' });
  assert.equal(other.statusCode, 503);
});

test('the Places routes share 120 requests a minute per client by default', async (t) => {
  setEnv(t, { GOOGLE_MAPS_SERVER_API_KEY: 'test-server-key' });
  const upstream = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ places: [] }),
  );
  const routes = installRoutes(googlePlacesContextProxy());
  const nearby = routes.get('/api/google/nearby-places');
  const textSearch = routes.get('/api/google/text-search');
  for (let sent = 0; sent < DEFAULT_GOOGLE_REQUESTS_PER_MINUTE; sent += 1) {
    const response = await invoke(sent % 2 === 0 ? nearby : textSearch, {
      url: '/?lat=30.27&lon=-97.74&q=capitol',
      remoteAddress: '10.0.1.1',
    });
    assert.equal(response.statusCode, 200);
  }
  const callsBefore = upstream.mock.callCount();
  const limited = await invoke(nearby, {
    url: '/?lat=30.27&lon=-97.74',
    remoteAddress: '10.0.1.1',
  });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers['retry-after'], '5');
  assert.deepEqual(limited.json, { error: 'Rate limit exceeded', places: [] });
  assert.equal(upstream.mock.callCount(), callsBefore);
});

test('the Street View fallback has its own budget, then shows the synthetic frame', async (t) => {
  setEnv(t, {
    GOOGLE_MAPS_SERVER_API_KEY: 'test-server-key',
    CCTV_PREFER_AUSTIN: '0',
  });
  const streetView = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const target = String(url);
    if (target.startsWith('https://maps.googleapis.com/maps/api/streetview')) {
      streetView.push(target);
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
        headers: { 'content-type': 'image/jpeg' },
      });
    }
    if (target.startsWith('https://places.googleapis.com/')) {
      return Response.json({ places: [] });
    }
    return new Response('not found', { status: 404 });
  });
  const frames = installRoutes(cctvProxy()).get('/api/cctv');
  const url = '/frame/test-camera?lat=30.27&lon=-97.74&heading=90';
  for (let sent = 0; sent < DEFAULT_GOOGLE_REQUESTS_PER_MINUTE; sent += 1) {
    const frame = await invoke(frames, { url, remoteAddress: '10.0.2.1' });
    assert.equal(frame.headers['x-cctv-source'], 'streetview');
  }
  const limited = await invoke(frames, { url, remoteAddress: '10.0.2.1' });
  assert.equal(limited.statusCode, 200);
  assert.equal(limited.headers['x-cctv-source'], 'synthetic');
  assert.match(limited.text, /STREET VIEW RATE LIMITED/);
  assert.equal(streetView.length, DEFAULT_GOOGLE_REQUESTS_PER_MINUTE);

  // The same client's Places budget is untouched.
  const nearby = installRoutes(googlePlacesContextProxy()).get(
    '/api/google/nearby-places',
  );
  const places = await invoke(nearby, {
    url: '/?lat=30.27&lon=-97.74',
    remoteAddress: '10.0.2.1',
  });
  assert.equal(places.statusCode, 200);
});
