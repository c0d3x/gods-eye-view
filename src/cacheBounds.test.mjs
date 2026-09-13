import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import config, {
  ADSBDB_CACHE_MAX_ENTRIES,
  adsbdbProxy,
  DISK_CACHE_LIMITS,
  TERRAIN_CACHE_MAX_POINTS,
  terrainHeightsProxy,
} from '../vite.config.js';

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'gev-cache-bounds-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** Install one plugin route and return a GET helper for it. */
function install(plugin, route) {
  let handler;
  plugin.configureServer({
    middlewares: {
      use(pathname, fn) {
        if (pathname === route) handler = fn;
      },
    },
  });
  return (url) =>
    new Promise((resolve, reject) => {
      const res = {
        headersSent: false,
        statusCode: 200,
        writeHead(status) {
          this.statusCode = status;
          return this;
        },
        end(body = '') {
          this.headersSent = true;
          resolve({
            statusCode: this.statusCode,
            body: body ? JSON.parse(String(body)) : null,
          });
        },
      };
      const req = {
        method: 'GET',
        url,
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
      };
      Promise.resolve(handler(req, res)).catch(reject);
    });
}

test(`terrain heights keep at most ${TERRAIN_CACHE_MAX_POINTS} points and evict the oldest`, async (t) => {
  const cacheDir = await temporaryDirectory(t);
  let fetchedPoints = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    const points = new URL(String(url)).searchParams.get('points').split(';');
    fetchedPoints += points.length;
    return Response.json({ results: points.map(() => ({ ellipsoid: 100 })) });
  });
  const request = install(
    terrainHeightsProxy({ cacheDir }),
    '/api/terrain/heights',
  );

  const size = 2000;
  const batches = Math.ceil(TERRAIN_CACHE_MAX_POINTS / size) + 1;
  const batch = (index) =>
    `/?points=${encodeURIComponent(
      Array.from(
        { length: size },
        (_, i) => `${(-120 + (index * size + i) / 1000).toFixed(5)},35.00000`,
      ).join(';'),
    )}`;
  for (let index = 0; index < batches; index += 1) {
    assert.equal((await request(batch(index))).statusCode, 200);
  }
  assert.equal(fetchedPoints, batches * size);

  // The newest points are still cached...
  await request(batch(batches - 1));
  assert.equal(fetchedPoints, batches * size);
  // ...and the oldest were evicted, so they are fetched again.
  await request(batch(0));
  assert.equal(fetchedPoints, (batches + 1) * size);
});

test(`adsbdb keeps at most ${ADSBDB_CACHE_MAX_ENTRIES} aircraft and evicts the oldest`, async (t) => {
  const cacheDir = await temporaryDirectory(t);
  let upstream = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    upstream += 1;
    return Response.json({
      response: {
        aircraft: {
          icao_type: 'B738',
          manufacturer: 'Boeing',
          type: '737-800',
          registration: 'N1',
        },
      },
    });
  });
  const request = install(
    adsbdbProxy({ cachePath: path.join(cacheDir, 'adsbdb.json') }),
    '/api/adsbdb',
  );

  const hex = (index) => index.toString(16).padStart(6, '0');
  for (let index = 0; index <= ADSBDB_CACHE_MAX_ENTRIES; index += 1) {
    await request(`/type/${hex(index)}`);
  }
  assert.equal(upstream, ADSBDB_CACHE_MAX_ENTRIES + 1);

  const newest = await request(`/type/${hex(ADSBDB_CACHE_MAX_ENTRIES)}`);
  assert.deepEqual(newest.body, {
    found: true,
    typeCode: 'B738',
    typeName: 'Boeing 737-800',
    registration: 'N1',
  });
  await request(`/type/${hex(1)}`);
  assert.equal(upstream, ADSBDB_CACHE_MAX_ENTRIES + 1);
  await request(`/type/${hex(0)}`);
  assert.equal(upstream, ADSBDB_CACHE_MAX_ENTRIES + 2);
});

test('the per-query disk caches are limited, TomTom keeps its budget, and the janitor is installed', () => {
  assert.deepEqual(Object.keys(DISK_CACHE_LIMITS).sort(), [
    'militaryInstallations',
    'overpass',
    'tomtom',
  ]);
  for (const [name, limits] of Object.entries(DISK_CACHE_LIMITS)) {
    assert.ok(
      limits.directory.includes(`${path.sep}.gev-cache${path.sep}`),
      name,
    );
    assert.ok(limits.maxAgeMs > 0 && limits.maxBytes > 0, name);
  }
  assert.deepEqual(DISK_CACHE_LIMITS.tomtom.keep, ['budget.json']);

  const names = config({ mode: 'test' }).plugins.map((plugin) => plugin?.name);
  assert.ok(names.includes('gev-disk-cache-janitor'));
});
