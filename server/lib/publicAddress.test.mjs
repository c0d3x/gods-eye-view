import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {
  isNonGlobalIpv4,
  isPublicAddress,
  PrivateAddressError,
  requestPinned,
  resolvePublicAddresses,
} from './publicAddress.mjs';

/** Serve `handler` on 127.0.0.1 for one test; returns the port. */
async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}

test('only global unicast addresses count as public', () => {
  for (const address of [
    '10.1.2.3',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
    'not-an-address',
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of [
    '93.184.216.34',
    '8.8.8.8',
    '2606:4700:4700::1111',
    '[2606:4700:4700::1111]',
  ]) {
    assert.equal(isPublicAddress(address), true, address);
  }
  assert.equal(isNonGlobalIpv4('10.0.0.1'), true);
  assert.equal(isNonGlobalIpv4('camera.example'), false);
});

test('a resolution with any private address is refused whole', async () => {
  const mixed = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '10.0.0.5', family: 4 },
  ];
  await assert.rejects(
    resolvePublicAddresses('camera.example', mixed),
    PrivateAddressError,
  );
  const publicOnly = async () => [{ address: '93.184.216.34', family: 4 }];
  assert.deepEqual(await resolvePublicAddresses('camera.example', publicOnly), [
    { address: '93.184.216.34', family: 4 },
  ]);
});

test('an IP literal resolves to itself and gets the same check', async () => {
  await assert.rejects(
    resolvePublicAddresses('169.254.169.254'),
    PrivateAddressError,
  );
  await assert.rejects(resolvePublicAddresses('[::1]'), PrivateAddressError);
});

test('a pinned request connects to the checked address', async (t) => {
  const port = await serve(t, (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'X-Seen-Host': req.headers.host,
    });
    res.end('frame');
  });
  // camera.invalid never resolves; the pin sends the connection to 127.0.0.1.
  const response = await requestPinned(
    new URL(`http://camera.invalid:${port}/frame.jpg`),
    { headers: { 'User-Agent': 'test' } },
    [{ address: '127.0.0.1', family: 4 }],
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.equal(response.headers.get('x-seen-host'), `camera.invalid:${port}`);
  assert.equal(await response.text(), 'frame');
});

test('a pinned request returns redirects and bodyless statuses as they are', async (t) => {
  const port = await serve(t, (req, res) => {
    if (req.url === '/moved') {
      res.writeHead(302, { Location: 'http://10.0.0.1/' });
    } else {
      res.writeHead(304);
    }
    res.end();
  });
  const pin = [{ address: '127.0.0.1', family: 4 }];
  const moved = await requestPinned(
    `http://camera.invalid:${port}/moved`,
    {},
    pin,
  );
  assert.equal(moved.status, 302);
  assert.equal(moved.headers.get('location'), 'http://10.0.0.1/');
  const unchanged = await requestPinned(
    `http://camera.invalid:${port}/`,
    {},
    pin,
  );
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.body, null);
});
