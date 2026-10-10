import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadBundledBytes } from './bundledBytes.js';

const GRID = new URL('./local_data/egm96/egm96-15.bin.gz', import.meta.url);

test('bundled bytes: a file URL is read from disk under Node', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch');
  const bytes = await loadBundledBytes(GRID);
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(bytes.byteLength, 937_381);
  // gzip's magic number: the file is returned exactly as stored.
  assert.deepEqual([bytes[0], bytes[1]], [0x1f, 0x8b]);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('bundled bytes: a served URL is fetched as raw bytes', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(String(url));
    return new Response(new Uint8Array([1, 2, 3]));
  });
  const url = new URL('http://localhost/src/data/local_data/egm96/grid.bin');
  assert.deepEqual(await loadBundledBytes(url), new Uint8Array([1, 2, 3]));
  assert.deepEqual(requests, [url.href]);
});

test('bundled bytes: an HTTP error rejects so the caller can retry', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('', { status: 404 }),
  );
  await assert.rejects(
    loadBundledBytes(new URL('http://localhost/missing.bin')),
    /HTTP 404/,
  );
});

test('bundled bytes: an aborted load rejects before reading', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(loadBundledBytes(GRID, { signal: controller.signal }), {
    name: 'AbortError',
  });
});
