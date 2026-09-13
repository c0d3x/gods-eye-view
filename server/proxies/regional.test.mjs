import assert from 'node:assert/strict';
import test from 'node:test';
import { PROJECT_URL } from '../lib/projectUrl.mjs';
import { regionalBriefProxy, weatherEffectsProxy } from './regional.mjs';

function route(plugin, path) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: { use: (mount, handler) => routes.set(mount, handler) },
  });
  return routes.get(path);
}

let client = 0;
/** One request from a fresh client address, so no test spends another's limit. */
function ask(handler, { method = 'GET', query = '' } = {}) {
  client += 1;
  const req = {
    method,
    url: `/?${query}`,
    headers: {},
    socket: { remoteAddress: `192.0.2.${client}` },
  };
  return new Promise((resolve, reject) => {
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        resolve({
          status: this.status,
          headers: this.headers,
          body: JSON.parse(body),
        });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

const WEATHER = {
  current: {
    time: '2026-09-13T12:00',
    temperature_2m: 31.2,
    apparent_temperature: 33.4,
    precipitation: 0,
    weather_code: 1,
    cloud_cover: 20,
    wind_speed_10m: 12,
    wind_direction_10m: 180,
    visibility: 24000,
  },
};
const PLACE = {
  address: {
    city: 'Austin',
    state: 'Texas',
    country: 'United States',
    country_code: 'us',
  },
  display_name: 'Austin, Travis County, Texas, United States',
};
const RSS = [
  '<rss><channel><item>',
  '<title>Council approves budget</title>',
  '<link>https://news.example/budget</link>',
  '<source url="https://news.example">Example News</source>',
  '<pubDate>Sat, 13 Sep 2026 10:00:00 GMT</pubDate>',
  '</item></channel></rss>',
].join('');

test('both routes answer only a GET for a valid point', async () => {
  for (const [plugin, path] of [
    [regionalBriefProxy(), '/api/regional-brief'],
    [weatherEffectsProxy(), '/api/weather-effects'],
  ]) {
    const handler = route(plugin, path);
    assert.equal((await ask(handler, { method: 'POST' })).status, 405, path);
    assert.equal((await ask(handler)).status, 400, path);
    assert.equal(
      (await ask(handler, { query: 'latitude=91&longitude=0' })).status,
      400,
      path,
    );
  }
});

test('weather effects fetch Open-Meteo once, then answer from memory', async (t) => {
  const handler = route(weatherEffectsProxy(), '/api/weather-effects');
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url) => {
    assert.match(
      String(url),
      /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?/,
    );
    return Response.json(WEATHER);
  });
  const query = 'latitude=30.27&longitude=-97.74';
  const miss = await ask(handler, { query });
  assert.equal(miss.status, 200);
  assert.equal(miss.headers['X-Weather-Effects'], 'MISS');
  assert.equal(miss.body.weather.temperatureC, 31.2);
  assert.equal(miss.body.weather.observedAt, '2026-09-13T12:00:00.000Z');
  const hit = await ask(handler, { query });
  assert.equal(hit.headers['X-Weather-Effects'], 'HIT');
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('weather effects answer 503 without provider text when Open-Meteo fails', async (t) => {
  const handler = route(weatherEffectsProxy(), '/api/weather-effects');
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('meteo down <html>', { status: 500 }),
  );
  const outage = await ask(handler, {
    query: 'latitude=-33.87&longitude=151.21',
  });
  assert.equal(outage.status, 503);
  assert.deepEqual(outage.body, {
    error: 'Weather effects are temporarily unavailable',
  });
});

test('a regional brief combines place, weather and news, then answers from memory', async (t) => {
  const handler = route(regionalBriefProxy(), '/api/regional-brief');
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const { hostname } = new URL(url);
    calls.push({ hostname, headers: init.headers || {} });
    if (hostname === 'nominatim.openstreetmap.org') return Response.json(PLACE);
    if (hostname === 'api.open-meteo.com') return Response.json(WEATHER);
    if (hostname === 'news.google.com') return new Response(RSS);
    throw new Error(`unexpected upstream ${hostname}`);
  });
  const query = 'latitude=30.2672&longitude=-97.7431';
  const miss = await ask(handler, { query });
  assert.equal(miss.status, 200);
  assert.equal(miss.headers['X-Regional-Brief'], 'MISS');
  assert.equal(miss.body.status, 'ready');
  assert.equal(miss.body.place.label, 'Austin, Texas');
  assert.equal(miss.body.weather.temperatureC, 31.2);
  assert.equal(miss.body.newsSource, 'Google News RSS');
  assert.deepEqual(
    miss.body.articles.map((article) => article.title),
    ['Council approves budget'],
  );
  // Nominatim asks every client to name a contact point.
  const nominatim = calls.find(
    (call) => call.hostname === 'nominatim.openstreetmap.org',
  );
  assert.equal(nominatim.headers.Referer, PROJECT_URL);
  assert.ok(nominatim.headers['User-Agent'].includes(PROJECT_URL));

  const hit = await ask(handler, { query });
  assert.equal(hit.headers['X-Regional-Brief'], 'HIT');
  assert.equal(calls.length, 3, 'the second answer comes from memory');
});

test('a regional brief with every source down answers 503', async (t) => {
  const handler = route(regionalBriefProxy(), '/api/regional-brief');
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('offline');
  });
  const outage = await ask(handler, {
    query: 'latitude=51.5074&longitude=-0.1278',
  });
  assert.equal(outage.status, 503);
  assert.deepEqual(outage.body, {
    error: 'Regional briefing is temporarily unavailable',
  });
});
