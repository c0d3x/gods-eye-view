import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CCTV_STREET_VIEW_CACHE_MAX_ENTRIES,
  CCTV_STREET_VIEW_CACHE_TTL_MS,
  STREET_VIEW_DEFAULT_PER_MIN,
} from '../server/providers/cctv/street-view.js';
import { cctvProxy } from '../server/providers/cctv.js';

const STREET_VIEW = 'https://maps.googleapis.com/maps/api/streetview';

function setEnv(t, values) {
  const previous = Object.fromEntries(
    Object.keys(values).map((name) => [name, process.env[name]]),
  );
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
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

/** Install the CCTV routes with a Google key and an empty camera catalog. */
function installCctv(t, env = {}) {
  setEnv(t, {
    GOOGLE_MAPS_SERVER_API_KEY: 'test-server-key',
    GEV_RATELIMIT_GOOGLE_PER_MIN: undefined,
    CCTV_PREFER_AUSTIN: '0',
    CCTV_FORCE_AUSTIN: undefined,
    CCTV_SOURCES_FILE: undefined,
    CCTV_SOURCES_JSON: undefined,
    ...env,
  });
  const sourceRoot = mkdtempSync(path.join(tmpdir(), 'gev-street-view-'));
  t.after(() => rmSync(sourceRoot, { recursive: true, force: true }));
  let handler;
  cctvProxy({ sourceRoot }).configureServer({
    middlewares: {
      use(route, fn) {
        if (route === '/api/cctv') handler = fn;
      },
    },
  });
  return (url, remoteAddress = '10.1.0.1') =>
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

async function cameraHealth(request) {
  const health = await request('/health');
  return JSON.parse(health.body.toString()).cameras.find(
    (camera) => camera.id === 'test-camera',
  );
}

test('repeated polls of one camera call Street View once', async (t) => {
  const google = mockGoogle(t);
  const request = installCctv(t);
  const url = frameUrl(30.27, -97.74);
  // More polls than the client's Street View budget: cache hits neither call
  // Google nor spend that budget.
  const bodies = new Set();
  for (let polls = 0; polls < STREET_VIEW_DEFAULT_PER_MIN + 30; polls += 1) {
    const frame = await request(url);
    assert.equal(frame.statusCode, 200);
    assert.equal(frame.headers['x-cctv-source'], 'streetview');
    assert.equal(frame.headers['content-type'], 'image/jpeg');
    bodies.add(frame.body.toString('hex'));
  }
  assert.equal(google.requests.length, 1);
  assert.equal(bodies.size, 1);

  const camera = await cameraHealth(request);
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
      const frame = await request(url);
      assert.equal(frame.headers['x-cctv-source'], 'streetview');
    }
  }
  assert.equal(google.requests.length, poses.length);

  // Positions that round to the same five decimals (about a metre) share a
  // frame, and Google is asked for the rounded location.
  await request(frameUrl(30.270001, -97.740004));
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
  await request(url);
  t.mock.timers.tick(CCTV_STREET_VIEW_CACHE_TTL_MS - 1);
  await request(url);
  assert.equal(google.requests.length, 1);

  t.mock.timers.tick(1);
  const refreshed = await request(url);
  assert.equal(refreshed.headers['x-cctv-source'], 'streetview');
  assert.equal(google.requests.length, 2);
});

test(`the cache holds at most ${CCTV_STREET_VIEW_CACHE_MAX_ENTRIES} frames`, async (t) => {
  const google = mockGoogle(t);
  const request = installCctv(t);
  const pose = (index) => frameUrl(30 + index / 1000, -97.74);
  for (let index = 0; index <= CCTV_STREET_VIEW_CACHE_MAX_ENTRIES; index += 1) {
    await request(pose(index));
  }
  const misses = CCTV_STREET_VIEW_CACHE_MAX_ENTRIES + 1;
  assert.equal(google.requests.length, misses);

  // The newest frames are still cached...
  await request(pose(CCTV_STREET_VIEW_CACHE_MAX_ENTRIES));
  await request(pose(1));
  assert.equal(google.requests.length, misses);
  // ...and the oldest was evicted to make room.
  await request(pose(0));
  assert.equal(google.requests.length, misses + 1);
});

test('failed Street View responses are not cached', async (t) => {
  const google = mockGoogle(t);
  google.status = 404;
  const request = installCctv(t);
  const url = frameUrl(30.27, -97.74);
  const missing = await request(url);
  assert.equal(missing.headers['x-cctv-source'], 'synthetic');

  google.status = 200;
  const found = await request(url);
  assert.equal(found.headers['x-cctv-source'], 'streetview');
  await request(url);
  assert.equal(google.requests.length, 2);
});

test('the Street View budget runs out per client, then the frame is synthetic', async (t) => {
  const google = mockGoogle(t);
  const request = installCctv(t);
  const pose = (index) => frameUrl(31 + index / 1000, -97.74);
  for (let index = 0; index < STREET_VIEW_DEFAULT_PER_MIN; index += 1) {
    const frame = await request(pose(index));
    assert.equal(frame.headers['x-cctv-source'], 'streetview');
  }
  const limited = await request(pose(STREET_VIEW_DEFAULT_PER_MIN));
  assert.equal(limited.statusCode, 200);
  assert.equal(limited.headers['x-cctv-source'], 'synthetic');
  assert.equal(limited.headers['content-type'], 'image/svg+xml');
  assert.match(limited.body.toString(), /STREET VIEW RATE LIMITED/);
  assert.equal(google.requests.length, STREET_VIEW_DEFAULT_PER_MIN);
  assert.equal(
    (await cameraHealth(request)).message,
    'Street View rate limit reached',
  );

  // A cached frame is still served once the budget is spent...
  const cached = await request(pose(STREET_VIEW_DEFAULT_PER_MIN - 1));
  assert.equal(cached.headers['x-cctv-source'], 'streetview');
  // ...and another client has a budget of its own.
  const other = await request(pose(STREET_VIEW_DEFAULT_PER_MIN), '10.9.9.9');
  assert.equal(other.headers['x-cctv-source'], 'streetview');
  assert.equal(google.requests.length, STREET_VIEW_DEFAULT_PER_MIN + 1);
});

test('GEV_RATELIMIT_GOOGLE_PER_MIN sets the Street View budget and 0 turns it off', async (t) => {
  await t.test('a lower cap', async (t) => {
    const google = mockGoogle(t);
    const request = installCctv(t, { GEV_RATELIMIT_GOOGLE_PER_MIN: '2' });
    const sources = [];
    for (let index = 0; index < 3; index += 1) {
      const frame = await request(frameUrl(32 + index / 1000, -97.74));
      sources.push(frame.headers['x-cctv-source']);
    }
    assert.deepEqual(sources, ['streetview', 'streetview', 'synthetic']);
    assert.equal(google.requests.length, 2);
  });
  await t.test('the explicit opt-out', async (t) => {
    const google = mockGoogle(t);
    const request = installCctv(t, { GEV_RATELIMIT_GOOGLE_PER_MIN: '0' });
    for (let index = 0; index <= STREET_VIEW_DEFAULT_PER_MIN; index += 1) {
      const frame = await request(frameUrl(33 + index / 1000, -97.74));
      assert.equal(frame.headers['x-cctv-source'], 'streetview');
    }
    assert.equal(google.requests.length, STREET_VIEW_DEFAULT_PER_MIN + 1);
  });
});

test('without a Google key the frame is synthetic and Google is never called', async (t) => {
  const google = mockGoogle(t);
  const request = installCctv(t, {
    GOOGLE_MAPS_SERVER_API_KEY: undefined,
    GOOGLE_MAPS_API_KEY: undefined,
  });
  const frame = await request(frameUrl(30.27, -97.74));
  assert.equal(frame.headers['x-cctv-source'], 'synthetic');
  assert.match(frame.body.toString(), /NO UPSTREAM CONFIGURED/);
  assert.equal(google.requests.length, 0);
});
