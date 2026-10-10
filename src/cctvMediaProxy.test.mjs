import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { cctvProxy } from '../server/providers/cctv.js';

// A camera host on this machine, standing in for a LAN camera from the
// operator's own config. Each path is one scenario.
const cameraRoutes = {
  '/page': [200, { 'Content-Type': 'text/html' }, '<script>alert(1)</script>'],
  '/drawing': [
    200,
    { 'Content-Type': 'image/svg+xml' },
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  ],
  '/frame.jpg': [200, { 'Content-Type': 'image/jpeg' }, 'jpeg-bytes'],
  '/still.jpg': [200, { 'Content-Type': 'image/jpeg' }, 'still-bytes'],
  '/live.m3u8': [
    200,
    { 'Content-Type': 'application/vnd.apple.mpegurl' },
    '#EXTM3U\n',
  ],
  '/moved': [302, { Location: '/frame.jpg' }, ''],
  '/metadata': [
    302,
    { Location: 'http://169.254.169.254/latest/meta-data/' },
    '',
  ],
};
const cameraHost = http.createServer((req, res) => {
  const [status, headers, body] = cameraRoutes[req.url] || [404, {}, ''];
  res.writeHead(status, headers);
  res.end(body);
});

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

const cameraOrigin = await listen(cameraHost);

// The operator's own camera list, so no live feed is fetched, and no Google
// key, so a frame that fails falls through to the synthetic one.
const saved = Object.fromEntries(
  [
    'CCTV_SOURCES_FILE',
    'CCTV_SOURCES_JSON',
    'CCTV_FORCE_AUSTIN',
    'GOOGLE_MAPS_SERVER_API_KEY',
    'GOOGLE_MAPS_API_KEY',
  ].map((name) => [name, process.env[name]]),
);
for (const name of Object.keys(saved)) delete process.env[name];
process.env.CCTV_SOURCES_FILE = '/nonexistent/cctv-sources.json';
process.env.CCTV_SOURCES_JSON = JSON.stringify(
  [
    ['html', '/page', 'mp4'],
    ['svg', '/drawing', 'image'],
    ['jpeg', '/frame.jpg', 'image'],
    ['still', '/still.jpg', 'mp4'],
    ['playlist', '/live.m3u8', 'mp4'],
    ['moved', '/moved', 'image'],
    ['metadata', '/metadata', 'mp4'],
  ].map(([id, pathname, feedType]) => ({
    id,
    name: id,
    lat: 30.27,
    lon: -97.74,
    url: `${cameraOrigin}${pathname}`,
    feedType,
  })),
);

const sourceRoot = mkdtempSync(path.join(tmpdir(), 'gev-cctv-media-'));
let route;
cctvProxy({ sourceRoot }).configureServer({
  middlewares: {
    use(_path, handler) {
      route = handler;
    },
  },
});
// Connect strips the mount path before a route sees the request.
const app = http.createServer((req, res) => {
  req.url = req.url.replace(/^\/api\/cctv/, '') || '/';
  route(req, res);
});
const appOrigin = await listen(app);

after(async () => {
  await Promise.all(
    [app, cameraHost].map((server) => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }),
  );
  rmSync(sourceRoot, { recursive: true, force: true });
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function get(pathname) {
  const response = await fetch(`${appOrigin}/api/cctv${pathname}`);
  return { response, body: await response.text() };
}

async function healthOf(id) {
  const { body } = await get('/health');
  return JSON.parse(body).cameras.find((camera) => camera.id === id);
}

test('a camera that sends an HTML page gets 502, not a relayed page', async () => {
  const { response, body } = await get('/media/html');
  assert.equal(response.status, 502);
  assert.deepEqual(JSON.parse(body), {
    error: 'Camera sent an unsupported media type',
  });
  // The health report uses our words, not the upstream type.
  const health = await healthOf('html');
  assert.equal(health.message, 'Camera sent an unsupported media type');
});

test('an SVG is refused as media and as a frame', async () => {
  const media = await get('/media/svg');
  assert.equal(media.response.status, 502);
  const frame = await get('/frame/svg');
  assert.equal(frame.response.headers.get('x-cctv-source'), 'synthetic');
  assert.doesNotMatch(frame.body, /alert/);
});

test('relayed media and every kind of frame carry nosniff and a sandboxing CSP', async () => {
  for (const pathname of [
    '/media/jpeg',
    '/media/playlist',
    '/frame/jpeg',
    '/frame/svg',
  ]) {
    const { response } = await get(pathname);
    assert.equal(response.status, 200, pathname);
    assert.equal(
      response.headers.get('x-content-type-options'),
      'nosniff',
      pathname,
    );
    assert.equal(
      response.headers.get('content-security-policy'),
      "default-src 'none'; sandbox",
      pathname,
    );
  }
});

test('a still image from a video camera is relayed, and its health says so in our words', async () => {
  const { response, body } = await get('/media/still');
  assert.equal(response.status, 200);
  assert.equal(body, 'still-bytes');
  const health = await healthOf('still');
  assert.equal(health.message, 'Camera sent a still image instead of video');
  assert.doesNotMatch(health.message, /image\/jpeg/);
});

test("a configured camera's redirect within its own origin is followed", async () => {
  const { response, body } = await get('/media/moved');
  assert.equal(response.status, 200);
  assert.equal(body, 'jpeg-bytes');
});

test('a redirect to a private address is refused', async () => {
  const { response, body } = await get('/media/metadata');
  assert.equal(response.status, 502);
  assert.deepEqual(JSON.parse(body), { error: 'Media proxy failed' });
  const health = await healthOf('metadata');
  assert.equal(health.message, 'Camera address is not allowed');
});
