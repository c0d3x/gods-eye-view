import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ADSBDB_CACHE_MAX_ENTRIES,
  adsbdbProxy,
} from '../server/providers/aircraft/enrichment.js';
import { localProviderPlugins } from '../server/providers/local.js';
import { militaryInstallationDiskPruner } from '../server/providers/military-installations/cache.js';
import { overpassDiskPruner } from '../server/providers/overpass/cache.js';
import {
  TERRAIN_CACHE_MAX_POINTS,
  terrainHeightsProxy,
} from '../server/providers/terrain.js';
import { tomtomDiskPruner } from '../server/providers/traffic.js';

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

/** A terrain request for `size` distinct points, numbered from `first`. */
function terrainBatch(first, size) {
  const points = Array.from(
    { length: size },
    (_, i) => `${(-120 + (first + i) / 1000).toFixed(5)},35.00000`,
  );
  return `/?points=${encodeURIComponent(points.join(';'))}`;
}

function mockTerrainUpstream(t) {
  const fetched = { points: 0 };
  t.mock.method(globalThis, 'fetch', async (url) => {
    const points = new URL(String(url)).searchParams.get('points').split(';');
    fetched.points += points.length;
    return Response.json({ results: points.map(() => ({ ellipsoid: 100 })) });
  });
  return fetched;
}

test(`terrain heights keep at most ${TERRAIN_CACHE_MAX_POINTS} points and evict the least recently used`, async (t) => {
  const cacheDir = await temporaryDirectory(t);
  const fetched = mockTerrainUpstream(t);
  const request = install(
    terrainHeightsProxy({ cacheDir }),
    '/api/terrain/heights',
  );

  const size = 2000;
  const batches = Math.ceil(TERRAIN_CACHE_MAX_POINTS / size) + 1;
  for (let index = 0; index < batches; index += 1) {
    assert.equal(
      (await request(terrainBatch(index * size, size))).statusCode,
      200,
    );
  }
  assert.equal(fetched.points, batches * size);

  // The newest points are still cached...
  await request(terrainBatch((batches - 1) * size, size));
  assert.equal(fetched.points, batches * size);
  // ...and the oldest were evicted, so they are fetched again.
  await request(terrainBatch(0, size));
  assert.equal(fetched.points, (batches + 1) * size);
});

test('a full terrain cache still answers a request that mixes cached and new points', async (t) => {
  const cacheDir = await temporaryDirectory(t);
  const fetched = mockTerrainUpstream(t);
  const request = install(
    terrainHeightsProxy({ cacheDir }),
    '/api/terrain/heights',
  );
  const size = 2000;
  for (let first = 0; first < TERRAIN_CACHE_MAX_POINTS; first += size) {
    await request(terrainBatch(first, size));
  }
  // Half of these are the oldest cached points and half are new. Storing the
  // new half must not evict the cached half this request is about to return.
  const mixed = await request(terrainBatch(-size / 2, size));
  assert.equal(mixed.statusCode, 200);
  assert.equal(mixed.body.results.length, size);
  assert.equal(fetched.points, TERRAIN_CACHE_MAX_POINTS + size / 2);
});

test('terrain heights reload the newest points from an oversized disk cache', async (t) => {
  const cacheDir = await temporaryDirectory(t);
  const now = Date.now();
  const points = {};
  for (let i = 0; i <= TERRAIN_CACHE_MAX_POINTS; i += 1) {
    const key = `${(-120 + i / 1000).toFixed(5)},35.00000`;
    // Written newest first, so file order is not age order.
    points[key] = { at: now - i, result: { ellipsoid: 100 } };
  }
  await writeFile(
    path.join(cacheDir, 'terrain-heights.json'),
    JSON.stringify({ version: 2, points }),
  );
  const fetched = mockTerrainUpstream(t);
  const request = install(
    terrainHeightsProxy({ cacheDir }),
    '/api/terrain/heights',
  );
  await request(terrainBatch(0, 1));
  assert.equal(fetched.points, 0, 'the newest saved point is still cached');
  await request(terrainBatch(TERRAIN_CACHE_MAX_POINTS, 1));
  assert.equal(fetched.points, 1, 'the oldest saved point was dropped');
});

test(`adsbdb keeps at most ${ADSBDB_CACHE_MAX_ENTRIES} aircraft and evicts the least recently used`, async (t) => {
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

test('adsbdb reloads only fresh saved lookups', async (t) => {
  const cacheDir = await temporaryDirectory(t);
  const cachePath = path.join(cacheDir, 'adsbdb.json');
  const now = Date.now();
  const entry = (at) => ({
    at,
    data: { typeCode: 'A320', typeName: 'Airbus A320', registration: 'X' },
  });
  await writeFile(
    cachePath,
    JSON.stringify({
      routes: {},
      aircraft: {
        aaaaaa: entry(now - 1000),
        bbbbbb: entry(now - 25 * 3600_000),
      },
    }),
  );
  let upstream = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    upstream += 1;
    return new Response('', { status: 404 });
  });
  const request = install(adsbdbProxy({ cachePath }), '/api/adsbdb');
  assert.equal((await request('/type/aaaaaa')).body.found, true);
  assert.equal(upstream, 0);
  assert.equal((await request('/type/bbbbbb')).body.found, false);
  assert.equal(upstream, 1, 'a day-old lookup is fetched again');
});

test('the per-query disk caches are limited, TomTom keeps its budget, and the janitor is installed', () => {
  const pruners = {
    overpass: overpassDiskPruner,
    militaryInstallations: militaryInstallationDiskPruner,
    tomtom: tomtomDiskPruner,
  };
  for (const [name, pruner] of Object.entries(pruners)) {
    assert.ok(
      pruner.directory.includes(`${path.sep}.gev-cache${path.sep}`),
      name,
    );
    assert.equal(typeof pruner.afterWrite, 'function', name);
    assert.equal(typeof pruner.runNow, 'function', name);
    assert.ok(pruner.maxAgeMs > 0 && pruner.maxBytes > 0, name);
  }
  assert.deepEqual(tomtomDiskPruner.keep, ['budget.json']);
  const names = localProviderPlugins().map((plugin) => plugin?.name);
  assert.ok(names.includes('gev-disk-cache-janitor'));
});
