import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { utcDayKey } from '../../src/data/tomtomTiles.js';
import { tomtomProxy } from './tomtom.mjs';

const KEY = 'tomtom-test-key';

/** Set an environment variable, or remove it for null or undefined. */
function setEnv(name, value) {
  if (value == null) delete process.env[name];
  else process.env[name] = String(value);
}

function mount(cacheDir) {
  const routes = new Map();
  tomtomProxy({ cacheDir }).configureServer({
    middlewares: { use: (prefix, handler) => routes.set(prefix, handler) },
  });
  return routes.get('/api/tomtom');
}

/**
 * A proxy over a fresh cache directory, with TomTom's key and daily budget
 * set as given for the length of the test.
 */
async function setup(t, { key = KEY, budget } = {}) {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'gev-tomtom-'));
  const saved = {
    TOMTOM_API_KEY: process.env.TOMTOM_API_KEY,
    TOMTOM_DAILY_TILE_BUDGET: process.env.TOMTOM_DAILY_TILE_BUDGET,
  };
  setEnv('TOMTOM_API_KEY', key);
  setEnv('TOMTOM_DAILY_TILE_BUDGET', budget);
  t.after(async () => {
    for (const [name, value] of Object.entries(saved)) setEnv(name, value);
    // Let the proxy's unawaited budget write land before the directory goes.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await rm(cacheDir, { recursive: true, force: true });
  });
  return { handler: mount(cacheDir), cacheDir };
}

function request(handler, url) {
  const req = { method: 'GET', url, headers: {} };
  return new Promise((resolve, reject) => {
    const res = {
      headersSent: false,
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
        this.headersSent = true;
      },
      end(body) {
        resolve({ status: this.status, headers: this.headers, body });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

const json = (answer) => JSON.parse(String(answer.body));
const tile = (z, x, y) => ({
  url: `/flow/${z}/${x}/${y}.pbf`,
  file: `flow-${z}-${x}-${y}.pbf`,
});
const A = tile(12, 2048, 1361);
const B = tile(12, 2049, 1361);

/** Put a tile in the disk cache as if it was written `ageMs` ago. */
async function seedTile(cacheDir, where, bytes, ageMs) {
  const file = path.join(cacheDir, where.file);
  await writeFile(file, Buffer.from(bytes));
  const when = new Date(Date.now() - ageMs);
  await utimes(file, when, when);
}

const noUpstream = async () => {
  throw new Error('no upstream call expected');
};

test('without a key, status says so and tiles answer 503 unfetched', async (t) => {
  const { handler } = await setup(t, { key: null });
  const fetchMock = t.mock.method(globalThis, 'fetch', noUpstream);
  const status = await request(handler, '/status');
  assert.equal(status.status, 200);
  assert.equal(status.headers['Cache-Control'], 'no-store');
  assert.deepEqual(json(status), {
    hasKey: false,
    dailyCount: 0,
    budget: 40000,
    date: utcDayKey(),
  });
  const answer = await request(handler, A.url);
  assert.equal(answer.status, 503);
  assert.deepEqual(json(answer), { error: 'no_key' });
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('unknown paths, and tiles outside zoom 8-16 or the grid, are refused', async (t) => {
  const { handler } = await setup(t);
  const fetchMock = t.mock.method(globalThis, 'fetch', noUpstream);
  for (const url of ['/nope', '/flow/12/1/1.png']) {
    const answer = await request(handler, url);
    assert.equal(answer.status, 404, url);
    assert.deepEqual(json(answer), { error: 'not_found' }, url);
  }
  for (const url of ['/flow/7/1/1.pbf', '/flow/17/1/1.pbf', '/flow/10/1024/0.pbf']) {
    const answer = await request(handler, url);
    assert.equal(answer.status, 400, url);
    assert.deepEqual(json(answer), { error: 'invalid_tile' }, url);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('a miss fetches the tile once; memory, then disk, answer after that', async (t) => {
  const { handler, cacheDir } = await setup(t);
  const fetchMock = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(Uint8Array.from([1, 2, 3])),
  );
  const miss = await request(handler, A.url);
  assert.equal(miss.status, 200);
  assert.equal(miss.headers['Content-Type'], 'application/x-protobuf');
  assert.equal(miss.headers['x-tomtom-cache'], 'MISS');
  assert.deepEqual([...miss.body], [1, 2, 3]);
  const [url] = fetchMock.mock.calls[0].arguments;
  assert.equal(
    String(url),
    `https://api.tomtom.com/traffic/map/4/tile/flow/relative/12/2048/1361.pbf?key=${KEY}`,
  );
  assert.equal(json(await request(handler, '/status')).dailyCount, 1);

  const hit = await request(handler, A.url);
  assert.equal(hit.headers['x-tomtom-cache'], 'HIT');
  assert.ok(existsSync(path.join(cacheDir, A.file)), 'the tile is on disk');

  // A restarted server answers from disk.
  const fromDisk = await request(mount(cacheDir), A.url);
  assert.equal(fromDisk.headers['x-tomtom-cache'], 'HIT');
  assert.deepEqual([...fromDisk.body], [1, 2, 3]);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('concurrent misses for one tile share one upstream fetch', async (t) => {
  const { handler } = await setup(t);
  let release;
  const answered = new Promise((resolve) => {
    release = resolve;
  });
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    await answered;
    return new Response(Uint8Array.from([7]));
  });
  const both = Promise.all([request(handler, A.url), request(handler, A.url)]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();
  for (const answer of await both) assert.deepEqual([...answer.body], [7]);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('over the daily budget a stale tile is served, and without one 429', async (t) => {
  const { handler, cacheDir } = await setup(t, { budget: 1 });
  await writeFile(
    path.join(cacheDir, 'budget.json'),
    JSON.stringify({ date: utcDayKey(), count: 1 }),
  );
  await seedTile(cacheDir, A, [9, 9], 10 * 60_000);
  const fetchMock = t.mock.method(globalThis, 'fetch', noUpstream);

  const stale = await request(handler, A.url);
  assert.equal(stale.status, 200);
  assert.equal(stale.headers['x-tomtom-cache'], 'STALE-BUDGET');
  assert.deepEqual([...stale.body], [9, 9]);

  const refused = await request(handler, B.url);
  assert.equal(refused.status, 429);
  assert.deepEqual(json(refused), { error: 'budget' });
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.deepEqual(json(await request(handler, '/status')), {
    hasKey: true,
    dailyCount: 1,
    budget: 1,
    date: utcDayKey(),
  });
});

test('a failed fetch serves the stale tile, and without one a 502 that names no key', async (t) => {
  const { handler, cacheDir } = await setup(t);
  await seedTile(cacheDir, A, [4, 2], 10 * 60_000);
  t.mock.method(console, 'warn', () => {});
  const fetchMock = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(`invalid key ${KEY}`, { status: 403 }),
  );

  const stale = await request(handler, A.url);
  assert.equal(stale.headers['x-tomtom-cache'], 'STALE-ERROR');
  assert.deepEqual([...stale.body], [4, 2]);

  const failed = await request(handler, B.url);
  assert.equal(failed.status, 502);
  assert.deepEqual(json(failed), { error: 'upstream' });
  assert.doesNotMatch(String(failed.body), new RegExp(KEY));
  // TomTom bills a refused request too, so both attempts count.
  assert.equal(fetchMock.mock.callCount(), 2);
  assert.equal(json(await request(handler, '/status')).dailyCount, 2);
});
