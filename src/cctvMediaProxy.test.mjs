import assert from 'node:assert/strict';
import http from 'node:http';
import test, { after } from 'node:test';

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

// The operator's own camera list, so no live feed is fetched.
process.env.CCTV_SOURCES_FILE = '/nonexistent/cctv-sources.json';
delete process.env.CCTV_FORCE_AUSTIN;
process.env.CCTV_SOURCES_JSON = JSON.stringify([
  { id: 'html', url: `${cameraOrigin}/page`, feedType: 'mp4' },
  { id: 'svg', url: `${cameraOrigin}/drawing`, feedType: 'image' },
  { id: 'jpeg', url: `${cameraOrigin}/frame.jpg`, feedType: 'image' },
  { id: 'hls', url: `${cameraOrigin}/live.m3u8`, feedType: 'hls' },
  { id: 'moved', url: `${cameraOrigin}/moved`, feedType: 'image' },
  { id: 'metadata', url: `${cameraOrigin}/metadata`, feedType: 'mp4' },
]);

const { cctvProxy } = await import('../server/proxies/cctv.mjs');
let route;
cctvProxy().configureServer({
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

after(() =>
  Promise.all(
    [app, cameraHost].map((server) => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }),
  ),
);

async function get(path) {
  const response = await fetch(`${appOrigin}/api/cctv${path}`);
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

test('relayed media and frames carry nosniff and a sandboxing CSP', async () => {
  for (const path of ['/media/jpeg', '/media/hls', '/frame/jpeg']) {
    const { response } = await get(path);
    assert.equal(response.status, 200, path);
    assert.equal(
      response.headers.get('x-content-type-options'),
      'nosniff',
      path,
    );
    assert.equal(
      response.headers.get('content-security-policy'),
      "default-src 'none'; sandbox",
      path,
    );
  }
});

test("a configured camera's redirect within its own origin is followed", async () => {
  const { response, body } = await get('/media/moved');
  assert.equal(response.status, 200);
  assert.equal(body, 'jpeg-bytes');
});

test('a redirect to a private address is refused', async () => {
  const { response } = await get('/media/metadata');
  assert.equal(response.status, 502);
  const health = await healthOf('metadata');
  assert.equal(health.message, 'Camera address is not allowed');
});
