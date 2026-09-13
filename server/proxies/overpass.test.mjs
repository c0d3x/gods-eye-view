import assert from 'node:assert/strict';
import test from 'node:test';
import { overpassProxy } from './overpass.mjs';

function route(path) {
  const routes = new Map();
  overpassProxy().configureServer({
    middlewares: { use: (mount, handler) => routes.set(mount, handler) },
  });
  return routes.get(path);
}

let client = 0;
/** One route request from a fresh client address. */
function ask(handler, params) {
  client += 1;
  const req = {
    method: 'GET',
    url: `/?${new URLSearchParams(params)}`,
    headers: {},
    socket: { remoteAddress: `203.0.113.${client}` },
  };
  return new Promise((resolve, reject) => {
    const res = {
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        resolve({ status: this.status, body: JSON.parse(body) });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test('the route proxy refuses bad input without calling OSRM', async (t) => {
  const handler = route('/api/route');
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('no upstream call expected');
  });
  const refusal = async (params, error) => {
    const answer = await ask(handler, params);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, { ok: false, error });
  };
  await refusal({ profile: 'boat', coords: '0,0;0,1' }, 'invalid profile');
  await refusal({ coords: '0,0' }, 'need 2-12 coordinates');
  await refusal({ coords: 'abc,1;2,3' }, 'invalid coordinate');
  await refusal({ coords: '0,95;0,1' }, 'invalid coordinate');
  // Ten degrees of longitude on the equator is about 1,112 km, past the leg cap.
  await refusal({ coords: '0,0;10,0' }, 'route leg too long');
  // Seven legs of about 490 km each: every leg is fine, the total is not.
  const longWay = Array.from({ length: 8 }, (_, i) => `${i * 4.4},0`).join(';');
  await refusal({ coords: longWay }, 'route too long');
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('a route is fetched once from OSRM and then served from the cache', async (t) => {
  const handler = route('/api/route');
  const coordinates = [
    [-97.7431, 30.2672],
    [-97.74, 30.27],
  ];
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(String(url));
    return Response.json({
      code: 'Ok',
      routes: [{ distance: 1234.4, duration: 99.6, geometry: { coordinates } }],
    });
  });
  const params = {
    profile: 'walking',
    coords: '-97.7431,30.2672;-97.7400,30.2700',
  };
  const expected = {
    ok: true,
    profile: 'foot',
    distanceM: 1234,
    durationS: 100,
    geometry: coordinates,
  };
  const first = await ask(handler, params);
  assert.deepEqual(first.body, expected);
  const second = await ask(handler, params);
  assert.deepEqual(second.body, expected);
  assert.equal(urls.length, 1, 'the second answer comes from the cache');
  assert.match(
    urls[0],
    /^https:\/\/routing\.openstreetmap\.de\/routed-foot\/route\/v1\/foot\/-97\.7431,30\.2672;-97\.74,30\.27\?/,
  );
});

test('an OSRM failure answers ok:false without its details', async (t) => {
  const handler = route('/api/route');
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('OSRM crashed <html>', { status: 500 }),
  );
  const answer = await ask(handler, {
    profile: 'car',
    coords: '-0.1278,51.5074;-0.1200,51.5100',
  });
  assert.deepEqual(answer.body, { ok: false, error: 'no route found' });
});
