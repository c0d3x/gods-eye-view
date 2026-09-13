import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import test from 'node:test';
import {
  MILITARY_INSTALLATION_ELEMENT_CAP,
  militaryInstallationCacheKey,
  militaryInstallationDiskPath,
  militaryInstallationsProxy,
  quantizeMilitaryInstallationBox,
} from './militaryInstallations.mjs';

function route() {
  const routes = new Map();
  militaryInstallationsProxy().configureServer({
    middlewares: { use: (path, handler) => routes.set(path, handler) },
  });
  return routes.get('/api/military-installations');
}

let client = 0;
/** One request from a fresh client address, so no test spends another's limit. */
function request(handler, { method = 'GET', query = '' } = {}) {
  client += 1;
  const req = {
    method,
    url: `/?${query}`,
    headers: {},
    socket: { remoteAddress: `198.51.100.${client}` },
  };
  return new Promise((resolve, reject) => {
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        resolve({ status: this.status, headers: this.headers, body });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

/** A small box in the South Pacific no earlier run has cached. */
function freshBox() {
  const south = -45 + Math.random();
  const west = -140 + Math.random();
  return { south, west, north: south + 0.2, east: west + 0.2 };
}
const query = (box) => new URLSearchParams(Object.entries(box)).toString();
const diskFile = (box) =>
  militaryInstallationDiskPath(
    militaryInstallationCacheKey(quantizeMilitaryInstallationBox(box)),
  );

test('only a GET for a bounded bbox is answered', async () => {
  const handler = route();
  assert.equal((await request(handler, { method: 'POST' })).status, 405);
  assert.equal((await request(handler)).status, 400);
  const tooWide = { south: 0, west: 0, north: 1, east: 20 };
  assert.equal((await request(handler, { query: query(tooWide) })).status, 400);
  const inverted = { south: 1, west: 0, north: 0, east: 1 };
  assert.equal(
    (await request(handler, { query: query(inverted) })).status,
    400,
  );
});

test('a miss asks Overpass once, persists, and then answers from memory', async (t) => {
  const handler = route();
  const box = freshBox();
  const file = diskFile(box);
  const element = {
    type: 'node',
    id: 1,
    lat: box.south + 0.1,
    lon: box.west + 0.1,
    tags: { military: 'airfield' },
  };
  const fetchMock = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ elements: [element] }),
  );
  try {
    const miss = await request(handler, { query: query(box) });
    assert.equal(miss.status, 200);
    assert.equal(miss.headers['X-Military-Installations'], 'MISS');
    const payload = JSON.parse(miss.body);
    assert.deepEqual(payload.elements, [element]);
    assert.equal(payload.saturated, false);
    assert.equal(payload.elementCap, MILITARY_INSTALLATION_ELEMENT_CAP);

    const hit = await request(handler, { query: query(box) });
    assert.equal(hit.headers['X-Military-Installations'], 'HIT');
    assert.equal(fetchMock.mock.callCount(), 1);

    for (let i = 0; i < 100 && !existsSync(file); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(existsSync(file), 'the answer is kept on disk');
  } finally {
    await rm(file, { force: true });
  }
});

test('an outage with nothing cached answers 503 with a reason and no provider text', async (t) => {
  const handler = route();
  const box = freshBox();
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('mirror exploded <html>', { status: 503 }),
  );
  try {
    const outage = await request(handler, { query: query(box) });
    assert.equal(outage.status, 503);
    const body = JSON.parse(outage.body);
    assert.ok(
      ['unavailable', 'timeout', 'rate_limited', 'query_failed'].includes(
        body.reason,
      ),
      body.reason,
    );
    assert.doesNotMatch(outage.body, /exploded|<html>/);
  } finally {
    await rm(diskFile(box), { force: true });
  }
});
