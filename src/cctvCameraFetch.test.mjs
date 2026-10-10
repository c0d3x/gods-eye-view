import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {
  CameraRedirectError,
  cameraTransport,
  fetchCameraResponse,
  hlsCameraTransport,
  mediaTypeKind,
} from '../server/providers/cctv/camera-fetch.js';
import {
  fetchCctvImageFromUpstream,
  fetchCctvMediaUpstream,
} from '../server/providers/cctv/media.js';
import { fetchHlsBytes } from '../server/providers/cctv/stream.js';
import { PrivateAddressError } from '../server/providers/common/public-address.js';

/**
 * A camera host on 127.0.0.1 for one test. `routes` maps a path to
 * [status, headers, body]; `hits` records the paths requested.
 */
async function cameraHost(t, routes) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const [status, headers, body] = routes[req.url] || [404, {}, ''];
    res.writeHead(status, headers);
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, hits };
}

test('only raster images, video and HLS playlists are relayable', () => {
  assert.equal(mediaTypeKind('image/jpeg'), 'image');
  assert.equal(mediaTypeKind('IMAGE/PNG; charset=binary'), 'image');
  assert.equal(mediaTypeKind('video/mp4'), 'video');
  assert.equal(mediaTypeKind('video/MP2T'), 'video');
  assert.equal(mediaTypeKind('application/vnd.apple.mpegurl'), 'video');
  assert.equal(mediaTypeKind('application/x-mpegURL'), 'video');
  for (const type of [
    'image/svg+xml',
    'text/html',
    'text/html; charset=utf-8',
    'application/json',
    'multipart/x-mixed-replace; boundary=frame',
    'application/octet-stream',
    '',
    null,
  ]) {
    assert.equal(mediaTypeKind(type), null, String(type));
  }
});

test('a video feed may send video without naming its type', () => {
  for (const type of [
    'application/octet-stream',
    'binary/octet-stream',
    'application/mp4',
    '',
    null,
  ]) {
    assert.equal(
      mediaTypeKind(type, { videoFeed: true }),
      'video',
      String(type),
    );
  }
  assert.equal(mediaTypeKind('application/mpegurl'), 'video');
  for (const type of ['text/html', 'image/svg+xml', 'application/json']) {
    assert.equal(mediaTypeKind(type, { videoFeed: true }), null, type);
  }
});

test('a configured camera may redirect within its own origin', async (t) => {
  const camera = await cameraHost(t, {
    '/cam': [302, { Location: '/frame.jpg' }, ''],
    '/frame.jpg': [200, { 'Content-Type': 'image/jpeg' }, 'jpeg'],
  });
  const response = await fetchCameraResponse(`${camera.origin}/cam`, {
    fetchImpl: cameraTransport({ localOrigin: camera.origin }),
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'jpeg');
  assert.deepEqual(camera.hits, ['/cam', '/frame.jpg']);
});

test('a redirect to a private address is refused before it is followed', async (t) => {
  const other = await cameraHost(t, {
    '/': [200, { 'Content-Type': 'image/jpeg' }, 'private'],
  });
  for (const location of [
    'http://169.254.169.254/latest/meta-data/',
    `${other.origin}/`,
    'http://[::1]/',
    'http://10.0.0.1/',
  ]) {
    const camera = await cameraHost(t, {
      '/cam': [302, { Location: location }, ''],
    });
    await assert.rejects(
      fetchCameraResponse(`${camera.origin}/cam`, {
        fetchImpl: cameraTransport({ localOrigin: camera.origin }),
      }),
      PrivateAddressError,
      location,
    );
  }
  assert.deepEqual(other.hits, []);
});

test('a camera from a live feed must resolve to public addresses', async (t) => {
  const camera = await cameraHost(t, {
    '/cam': [200, { 'Content-Type': 'image/jpeg' }, 'jpeg'],
  });
  await assert.rejects(
    fetchCameraResponse(`${camera.origin}/cam`),
    PrivateAddressError,
  );
  assert.deepEqual(camera.hits, []);
  await assert.rejects(
    fetchCameraResponse('https://camera.example/cam', {
      fetchImpl: cameraTransport({
        lookup: async () => [{ address: '10.0.0.5', family: 4 }],
      }),
    }),
    PrivateAddressError,
  );
});

test('every hop of a feed camera is checked, then pinned to the checked address', async () => {
  const addresses = {
    'camera.example': '93.184.216.34',
    'cdn.example': '93.184.216.35',
    'internal.example': '10.0.0.1',
  };
  const lookup = async (host) => [{ address: addresses[host], family: 4 }];
  const requested = [];
  const request = async (target, init, pinned) => {
    requested.push([target.href, pinned[0].address]);
    assert.equal(init.redirect, 'manual');
    if (target.pathname === '/private') {
      return new Response(null, {
        status: 302,
        headers: { Location: 'http://internal.example/secret' },
      });
    }
    if (target.pathname === '/cdn') {
      return new Response(null, {
        status: 307,
        headers: { Location: 'https://cdn.example/frame.jpg' },
      });
    }
    return new Response('jpeg', { headers: { 'Content-Type': 'image/jpeg' } });
  };
  const fetchImpl = cameraTransport({ lookup, request });

  await assert.rejects(
    fetchCameraResponse('https://camera.example/private', { fetchImpl }),
    PrivateAddressError,
  );
  assert.deepEqual(requested, [
    ['https://camera.example/private', '93.184.216.34'],
  ]);

  const response = await fetchCameraResponse('https://camera.example/cdn', {
    fetchImpl,
  });
  assert.equal(await response.text(), 'jpeg');
  assert.deepEqual(requested.slice(1), [
    ['https://camera.example/cdn', '93.184.216.34'],
    ['https://cdn.example/frame.jpg', '93.184.216.35'],
  ]);
});

test('redirects stop after three hops, without a Location, or off http', async (t) => {
  const camera = await cameraHost(t, {
    '/loop': [302, { Location: '/loop' }, ''],
    '/nowhere': [302, {}, ''],
    '/file': [302, { Location: 'file:///etc/passwd' }, ''],
    '/credentials': [302, { Location: 'http://user:pass@cdn.example/' }, ''],
  });
  const fetchImpl = cameraTransport({ localOrigin: camera.origin });
  await assert.rejects(
    fetchCameraResponse(`${camera.origin}/loop`, { fetchImpl }),
    CameraRedirectError,
  );
  // The first request and three redirects.
  assert.equal(camera.hits.filter((hit) => hit === '/loop').length, 4);
  for (const path of ['/nowhere', '/file', '/credentials']) {
    await assert.rejects(
      fetchCameraResponse(`${camera.origin}${path}`, { fetchImpl }),
      CameraRedirectError,
      path,
    );
  }
});

test('an abort stops a lookup that never answers', async () => {
  const controller = new AbortController();
  const pending = fetchCameraResponse('https://camera.example/cam', {
    signal: controller.signal,
    fetchImpl: cameraTransport({ lookup: () => new Promise(() => {}) }),
  });
  controller.abort(new Error('deadline passed'));
  await assert.rejects(pending, /deadline passed/);
});

test('frames and media of a feed camera never reach a private address', async (t) => {
  const camera = await cameraHost(t, {
    '/frame.jpg': [200, { 'Content-Type': 'image/jpeg' }, 'jpeg'],
  });
  const url = `${camera.origin}/frame.jpg`;
  assert.equal(await fetchCctvImageFromUpstream(url), null);
  await assert.rejects(fetchCctvMediaUpstream(url), PrivateAddressError);
  assert.deepEqual(camera.hits, []);

  // The same camera from the operator's own config is fetched as configured.
  const frame = await fetchCctvImageFromUpstream(url, { localConfig: true });
  assert.equal(frame?.ok, true);
  assert.equal(frame.body.toString(), 'jpeg');
  const media = await fetchCctvMediaUpstream(url, { localConfig: true });
  assert.equal(await media.text(), 'jpeg');
});

test('a frame refuses SVG even from a configured camera', async (t) => {
  const camera = await cameraHost(t, {
    '/drawing': [
      200,
      { 'Content-Type': 'image/svg+xml' },
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    ],
  });
  assert.equal(
    await fetchCctvImageFromUpstream(`${camera.origin}/drawing`, {
      localConfig: true,
    }),
    null,
  );
});

test('the HLS puller reaches a private address only for a configured camera', async (t) => {
  const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n';
  const camera = await cameraHost(t, {
    '/live.m3u8': [
      200,
      { 'Content-Type': 'application/vnd.apple.mpegurl' },
      playlist,
    ],
  });
  const url = `${camera.origin}/live.m3u8`;
  await assert.rejects(
    fetchHlsBytes(url, {
      fetchImpl: hlsCameraTransport(new Set()),
      maxBytes: 1024,
    }),
    PrivateAddressError,
  );
  assert.deepEqual(camera.hits, []);
  const bytes = await fetchHlsBytes(url, {
    fetchImpl: hlsCameraTransport(new Set([camera.origin])),
    maxBytes: 1024,
  });
  assert.equal(Buffer.from(bytes).toString('utf8'), playlist);
});
