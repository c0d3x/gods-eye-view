import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_GOOGLE_REQUESTS_PER_MINUTE } from '../server/lib/rateLimit.mjs';
import {
  CCTV_STREET_VIEW_CACHE_MAX_ENTRIES,
  CCTV_STREET_VIEW_CACHE_TTL_MS,
  cctvProxy,
} from '../vite.config.js';

// The Street View limiter is built once per process from the environment, so
// this file leaves GEV_RATELIMIT_GOOGLE_PER_MIN unset (the default budget) and
// gives every test its own client address.
delete process.env.GEV_RATELIMIT_GOOGLE_PER_MIN;

const STREET_VIEW = 'https://maps.googleapis.com/maps/api/streetview';

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

/**
 * Stand in for Google: Street View answers with a small JPEG while `status`
 * is 200 and with that status otherwise; every other URL is not found.
 */
function mockGoogle(t) {
  const google = { status: 200, requests: [] };
  t.mock.method(globalThis, 'fetch', async (url) => {
    const target = String(url);
    if (!target.startsWith(STREET_VIEW)) {
      return new Response('not found', { status: 404 });
    }
    google.requests.push(new URL(target));
    if (google.status !== 200) {
      return new Response('no imagery', { status: google.status });
    }
    return new Response(
      new Uint8Array([0xff, 0xd8, 0xff, google.requests.length]),
      { headers: { 'content-type': 'image/jpeg' } },
    );
  });
  return google;
}

/** Install the CCTV routes with a Google key and no live source packs. */
function installCctv(t) {
  setEnv(t, {
    GOOGLE_MAPS_SERVER_API_KEY: 'test-server-key',
    CCTV_PREFER_AUSTIN: '0',
  });
  let handler;
  cctvProxy().configureServer({
    middlewares: {
      use(path, route) {
        if (path === '/api/cctv') handler = route;
      },
    },
  });
  return (url, remoteAddress) =>
    new Promise((resolve, reject) => {
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
          resolve({
            statusCode: this.statusCode,
            headers,
            body: Buffer.from(body),
          });
        },
      };
      const req = {
        method: 'GET',
        url,
        headers: {},
        socket: { remoteAddress },
      };
      Promise.resolve(handler(req, res)).catch(reject);
    });
}

function frameUrl(lat, lon, { heading = 90, fov, pitch } = {}) {
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    heading: String(heading),
  });
  if (fov !== undefined) params.set('fov', String(fov));
  if (pitch !== undefined) params.set('pitch', String(pitch));
  return `/frame/test-camera?${params}`;
}

test('repeated polls of one camera call Street View once', async (t) => {
  const google = mockGoogle(t);
  const request = installCctv(t);
  const url = frameUrl(30.27, -97.74);
  // More polls than the client's Street View budget: cache hits neither call
  // Google nor spend that budget.
  const bodies = new Set();
  for (let polls = 0; polls < 150; polls += 1) {
    const frame = await request(url, '10.1.0.1');
    assert.equal(frame.statusCode, 200);
    assert.equal(frame.headers['x-cctv-source'], 'streetview');
    assert.equal(frame.headers['content-type'], 'image/jpeg');
    bodies.add(frame.body.toString('hex'));
  }
  assert.equal(google.requests.length, 1);
  assert.equal(bodies.size, 1);

  const health = await request('/health', '10.1.0.1');
  const [camera] = JSON.parse(health.body.toString()).cameras;
  assert.equal(camera.id, 'test-camera');
  assert.equal(camera.status, 'degraded');
  assert.equal(camera.sourceKind, 'streetview');
  assert.equal(camera.message, 'Fallback Street View frame');
});

test('each pose gets its own frame; nearby positions share one', async (t) => {
  const google = mockGoogle(t);
  const request = installCctv(t);
  const poses = [
    frameUrl(30.27, -97.74),
    frameUrl(30.28, -97.74),
    frameUrl(30.27, -97.73),
    frameUrl(30.27, -97.74, { heading: 180 }),
    frameUrl(30.27, -97.74, { fov: 60 }),
    frameUrl(30.27, -97.74, { pitch: 10 }),
  ];
  for (let round = 0; round < 3; round += 1) {
    for (const url of poses) {
      const frame = await request(url, '10.1.0.2');
      assert.equal(frame.headers['x-cctv-source'], 'streetview');
    }
  }
  assert.equal(google.requests.length, poses.length);

  // Positions that round to the same five decimals (about a metre) share a
  // frame, and Google is asked for the rounded location.
  await request(frameUrl(30.270001, -97.740004), '10.1.0.2');
  assert.equal(google.requests.length, poses.length);
  assert.equal(
    google.requests[0].searchParams.get('location'),
    '30.27000,-97.74000',
  );
});

test('a cached frame is fetched again after 30 minutes', async (t) => {
  const google = mockGoogle(t);
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const request = installCctv(t);
  const url = frameUrl(30.27, -97.74);
  await request(url, '10.1.0.3');
  t.mock.timers.tick(CCTV_STREET_VIEW_CACHE_TTL_MS - 1);
  await request(url, '10.1.0.3');
  assert.equal(google.requests.length, 1);

  t.mock.timers.tick(1);
  const refreshed = await request(url, '10.1.0.3');
  assert.equal(refreshed.headers['x-cctv-source'], 'streetview');
  assert.equal(google.requests.length, 2);
});

test(`the cache holds at most ${CCTV_STREET_VIEW_CACHE_MAX_ENTRIES} frames and evicts the oldest`, async (t) => {
  const google = mockGoogle(t);
  const request = installCctv(t);
  const pose = (index) => frameUrl(30 + index / 1000, -97.74);
  for (let index = 0; index <= CCTV_STREET_VIEW_CACHE_MAX_ENTRIES; index += 1) {
    await request(pose(index), '10.1.0.4');
  }
  const misses = CCTV_STREET_VIEW_CACHE_MAX_ENTRIES + 1;
  assert.equal(google.requests.length, misses);

  // The newest frames are still cached...
  await request(pose(CCTV_STREET_VIEW_CACHE_MAX_ENTRIES), '10.1.0.4');
  await request(pose(1), '10.1.0.4');
  assert.equal(google.requests.length, misses);
  // ...and the oldest was evicted to make room.
  await request(pose(0), '10.1.0.4');
  assert.equal(google.requests.length, misses + 1);
});

test('failed Street View responses are not cached', async (t) => {
  const google = mockGoogle(t);
  google.status = 404;
  const request = installCctv(t);
  const url = frameUrl(30.27, -97.74);
  const missing = await request(url, '10.1.0.5');
  assert.equal(missing.headers['x-cctv-source'], 'synthetic');

  google.status = 200;
  const found = await request(url, '10.1.0.5');
  assert.equal(found.headers['x-cctv-source'], 'streetview');
  await request(url, '10.1.0.5');
  assert.equal(google.requests.length, 2);
});

test('cached frames are still served after the Street View budget is spent', async (t) => {
  const google = mockGoogle(t);
  const request = installCctv(t);
  const pose = (index) => frameUrl(31 + index / 1000, -97.74);
  for (let index = 0; index < DEFAULT_GOOGLE_REQUESTS_PER_MINUTE; index += 1) {
    await request(pose(index), '10.1.0.6');
  }
  const limited = await request(
    pose(DEFAULT_GOOGLE_REQUESTS_PER_MINUTE),
    '10.1.0.6',
  );
  assert.equal(limited.headers['x-cctv-source'], 'synthetic');

  const cached = await request(
    pose(DEFAULT_GOOGLE_REQUESTS_PER_MINUTE - 1),
    '10.1.0.6',
  );
  assert.equal(cached.headers['x-cctv-source'], 'streetview');
  assert.equal(google.requests.length, DEFAULT_GOOGLE_REQUESTS_PER_MINUTE);
});
