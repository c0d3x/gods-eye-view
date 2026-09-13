import assert from 'node:assert/strict';
import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import test from 'node:test';
import {
  CameraRedirectError,
  fetchCameraResponse,
  mediaTypeKind,
} from './cameraFetch.mjs';
import { PrivateAddressError } from './publicAddress.mjs';

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

test('a configured camera may redirect within its own origin', async (t) => {
  const camera = await cameraHost(t, {
    '/cam': [302, { Location: '/frame.jpg' }, ''],
    '/frame.jpg': [200, { 'Content-Type': 'image/jpeg' }, 'jpeg'],
  });
  const response = await fetchCameraResponse(`${camera.origin}/cam`, {
    localConfig: true,
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
      fetchCameraResponse(`${camera.origin}/cam`, { localConfig: true }),
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
      lookup: async () => [{ address: '10.0.0.5', family: 4 }],
    }),
    PrivateAddressError,
  );
});

test('every hop of a feed camera is checked before it is requested', async () => {
  const lookup = async (host, options) =>
    host.endsWith('.example')
      ? [{ address: '93.184.216.34', family: 4 }]
      : dnsLookup(host, options);
  const requested = [];
  const fetchImpl = async (target, init) => {
    requested.push(String(target));
    assert.equal(init.redirect, 'manual');
    if (target.pathname === '/private') {
      return new Response(null, {
        status: 302,
        headers: { Location: 'http://10.0.0.1/secret' },
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

  await assert.rejects(
    fetchCameraResponse('https://camera.example/private', {
      lookup,
      fetchImpl,
    }),
    PrivateAddressError,
  );
  assert.deepEqual(requested, ['https://camera.example/private']);

  const response = await fetchCameraResponse('https://camera.example/cdn', {
    lookup,
    fetchImpl,
  });
  assert.equal(await response.text(), 'jpeg');
  assert.deepEqual(requested.slice(1), [
    'https://camera.example/cdn',
    'https://cdn.example/frame.jpg',
  ]);
});

test('redirects stop after three hops, or without a Location', async (t) => {
  const camera = await cameraHost(t, {
    '/loop': [302, { Location: '/loop' }, ''],
    '/nowhere': [302, {}, ''],
  });
  await assert.rejects(
    fetchCameraResponse(`${camera.origin}/loop`, { localConfig: true }),
    CameraRedirectError,
  );
  // The first request and three redirects.
  assert.equal(camera.hits.filter((hit) => hit === '/loop').length, 4);
  await assert.rejects(
    fetchCameraResponse(`${camera.origin}/nowhere`, { localConfig: true }),
    CameraRedirectError,
  );
});

test('an abort stops a lookup that never answers', async () => {
  const controller = new AbortController();
  const pending = fetchCameraResponse('https://camera.example/cam', {
    signal: controller.signal,
    lookup: () => new Promise(() => {}),
  });
  controller.abort(new Error('deadline passed'));
  await assert.rejects(pending, /deadline passed/);
});
