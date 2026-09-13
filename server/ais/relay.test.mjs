import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { aisLiveProxy, createAisRelay } from './relay.mjs';

const T0 = Date.parse('2026-09-13T12:00:00Z');
const KEY = 'aisstream-test-key';

/** A `ws`-shaped fake that records what the relay does with each socket. */
function fakeTransport() {
  const sockets = [];
  class FakeSocket extends EventEmitter {
    constructor(url, options) {
      super();
      this.url = url;
      this.options = options;
      this.sent = [];
      this.terminated = false;
      sockets.push(this);
    }
    send(text) {
      this.sent.push(JSON.parse(text));
    }
    terminate() {
      if (this.terminated) return;
      this.terminated = true;
      queueMicrotask(() => this.emit('close'));
    }
  }
  return { FakeSocket, sockets };
}

/** A relay over a fake transport, a clock the test moves, and a fake timer. */
function setup({ env = { AISSTREAM_API_KEY: KEY }, ...options } = {}) {
  const transport = fakeTransport();
  const clock = { t: T0 };
  const intervals = [];
  const cleared = [];
  const warnings = [];
  const relay = createAisRelay({
    env,
    loadWebSocket: () => transport.FakeSocket,
    clock: { wall: () => clock.t, mono: () => clock.t },
    now: () => clock.t,
    setInterval: (fn, ms) => {
      const timer = {
        fn,
        ms,
        unrefs: 0,
        unref() {
          this.unrefs += 1;
          return this;
        },
      };
      intervals.push(timer);
      return timer;
    },
    clearInterval: (timer) => cleared.push(timer),
    warn: (...args) => warnings.push(args.join(' ')),
    ...options,
  });
  return {
    relay,
    env,
    clock,
    sockets: transport.sockets,
    intervals,
    cleared,
    warnings,
  };
}

/** AISStream's envelope for one position report, as the socket delivers it. */
function positionReport(mmsi, lat, lon, time, name = 'NORDIC STAR') {
  return JSON.stringify({
    MessageType: 'PositionReport',
    MetaData: {
      MMSI: mmsi,
      ShipName: name,
      latitude: lat,
      longitude: lon,
      time_utc: new Date(time).toISOString(),
    },
    Message: {
      PositionReport: {
        UserID: mmsi,
        Latitude: lat,
        Longitude: lon,
        Sog: 12.5,
        Cog: 90,
        TrueHeading: 91,
      },
    },
  });
}

/** One pass opens a socket, which opens and delivers `report`. */
function goLive(ctx, report = positionReport(257000000, 60.5, 10.25, T0)) {
  ctx.relay.ensure();
  const socket = ctx.sockets.at(-1);
  socket.emit('open');
  socket.emit('message', report);
  return socket;
}

function mount(relay) {
  const routes = new Map();
  aisLiveProxy({ relay }).configureServer({
    middlewares: { use: (prefix, handler) => routes.set(prefix, handler) },
  });
  return routes.get('/api/ais-live');
}

function request(handler, url = '/') {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      end(body) {
        resolve({
          status: this.statusCode,
          headers: this.headers,
          body: JSON.parse(body),
        });
      },
    };
    Promise.resolve(handler({ method: 'GET', url, headers: {} }, res)).catch(
      reject,
    );
  });
}

test('without a key the feed reads missing-key and no socket opens', async () => {
  const ctx = setup({ env: {} });
  const answer = await request(mount(ctx.relay));
  assert.equal(answer.status, 503);
  assert.equal(answer.headers['cache-control'], 'no-store');
  assert.equal(answer.body.status, 'missing-key');
  assert.equal(answer.body.error, 'AISSTREAM_API_KEY is not set');
  assert.deepEqual(answer.body.rows, []);
  assert.equal(ctx.sockets.length, 0);
});

test('without ws the feed reads unsupported and no socket opens', () => {
  const ctx = setup({
    loadWebSocket: () => {
      throw new Error("Cannot find package 'ws'");
    },
  });
  ctx.relay.ensure();
  const status = ctx.relay.status();
  assert.equal(status.status, 'unsupported');
  assert.equal(status.error, 'Node WebSocket transport is unavailable');
  assert.equal(ctx.sockets.length, 0);
  assert.match(ctx.warnings.join('\n'), /`ws` is unavailable/);
});

test('a key opens one socket that subscribes, and data makes the feed live', async () => {
  const ctx = setup();
  const handler = mount(ctx.relay);
  const connecting = await request(handler);
  assert.equal(connecting.status, 200);
  assert.equal(connecting.body.status, 'connecting');
  assert.equal(connecting.body.refreshing, true);
  const [socket] = ctx.sockets;
  assert.equal(socket.url, 'wss://stream.aisstream.io/v0/stream');
  assert.equal(socket.options.maxPayload, 1024 * 1024);

  socket.emit('open');
  assert.deepEqual(socket.sent, [
    {
      APIKey: KEY,
      BoundingBoxes: [
        [
          [-90, -180],
          [90, 180],
        ],
      ],
      FilterMessageTypes: [
        'PositionReport',
        'StandardClassBPositionReport',
        'ExtendedClassBPositionReport',
        'ShipStaticData',
        'StaticDataReport',
      ],
    },
  ]);
  socket.emit('message', positionReport(257000000, 60.5, 10.25, T0));

  const live = await request(handler);
  assert.equal(live.body.status, 'live');
  assert.equal(live.body.refreshing, false);
  assert.equal(live.body.lastMessageAt, T0);
  assert.equal(live.body.newestPositionAt, '2026-09-13T12:00:00.000Z');
  assert.deepEqual(live.body.rows, [
    {
      lat: 60.5,
      lon: 10.25,
      name: 'NORDIC STAR',
      mmsi: '257000000',
      imo: '',
      type: '',
      destination: '',
      speed: 12.5,
      course: 90,
      heading: 91,
      last_position_UTC: '2026-09-13T12:00:00.000Z',
      last_position_epoch: T0 / 1000,
    },
  ]);
  assert.equal(ctx.sockets.length, 1, 'a live feed keeps its one socket');
});

test('a dropped socket reconnects on the backoff ladder, then slows to the down cadence', () => {
  const ctx = setup();
  ctx.relay.ensure();
  for (const [attempt, wait] of [5_000, 15_000, 60_000, 300_000].entries()) {
    ctx.sockets.at(-1).emit('close');
    const status = ctx.relay.status();
    assert.equal(status.status, 'reconnecting');
    assert.equal(status.reconnectAttempt, attempt + 1);
    assert.equal(status.nextAttemptAt, ctx.clock.t + wait);
    ctx.clock.t += wait - 1;
    ctx.relay.ensure();
    assert.equal(ctx.sockets.length, attempt + 1, `no retry before ${wait} ms`);
    ctx.clock.t += 1;
    ctx.relay.ensure();
    assert.equal(ctx.sockets.length, attempt + 2, `a retry at ${wait} ms`);
  }

  ctx.sockets.at(-1).emit('close');
  const down = ctx.relay.status();
  assert.equal(down.status, 'down');
  assert.equal(down.nextAttemptAt, ctx.clock.t + 900_000);
  ctx.clock.t += 900_000;
  ctx.relay.ensure();
  assert.equal(ctx.sockets.length, 6);
});

test('data resets the backoff ladder', () => {
  const ctx = setup();
  ctx.relay.ensure();
  ctx.sockets[0].emit('close');
  ctx.clock.t += 5_000;
  ctx.relay.ensure();
  ctx.sockets[1].emit('close');
  assert.equal(ctx.relay.status().reconnectAttempt, 2);

  ctx.clock.t += 15_000;
  const socket = goLive(
    ctx,
    positionReport(257000000, 60.5, 10.25, ctx.clock.t),
  );
  assert.equal(ctx.relay.status().reconnectAttempt, 0);
  socket.emit('close');
  assert.equal(ctx.relay.status().nextAttemptAt, ctx.clock.t + 5_000);
});

test('a refused key waits an hour, and a new key reconnects at once', () => {
  const ctx = setup();
  ctx.relay.ensure();
  ctx.sockets[0].emit(
    'unexpected-response',
    {},
    { statusCode: 401, headers: {} },
  );
  const refused = ctx.relay.status();
  assert.equal(refused.status, 'auth-failed');
  assert.equal(refused.error, 'AISStream rejected the API key (HTTP 401)');
  assert.equal(refused.nextAttemptAt, ctx.clock.t + 3_600_000);
  assert.equal(ctx.sockets[0].terminated, true);

  ctx.clock.t += 5 * 60_000;
  ctx.relay.ensure();
  assert.equal(ctx.sockets.length, 1, 'no fast retries on a refused key');

  ctx.env.AISSTREAM_API_KEY = 'a-new-key';
  ctx.relay.ensure();
  assert.equal(ctx.sockets.length, 2);
  assert.equal(ctx.relay.status().status, 'connecting');
  ctx.sockets[1].emit('open');
  assert.equal(ctx.sockets[1].sent[0].APIKey, 'a-new-key');
});

test('a silent feed reads stale after 2 minutes and is recycled after 5', () => {
  const ctx = setup();
  const socket = goLive(ctx);
  ctx.clock.t += 119_999;
  ctx.relay.ensure();
  assert.equal(ctx.relay.status().status, 'live');
  ctx.clock.t += 1;
  ctx.relay.ensure();
  assert.equal(ctx.relay.status().status, 'stale');

  ctx.clock.t += 179_999;
  ctx.relay.ensure();
  assert.equal(socket.terminated, false);
  ctx.clock.t += 1;
  ctx.relay.ensure();
  assert.equal(socket.terminated, true, 'recycled after 300 s of silence');
  const recycled = ctx.relay.status();
  assert.equal(recycled.status, 'reconnecting');
  assert.match(recycled.error, /no data for 300s/);
  ctx.clock.t += 5_000;
  ctx.relay.ensure();
  assert.equal(ctx.sockets.length, 2);
});

test('a custom subscription turns the silence watch off, unless a timeout is set', () => {
  const harbor = '[[[59,10],[60,11]]]';
  const custom = setup({
    env: {
      AISSTREAM_API_KEY: KEY,
      AISSTREAM_BOUNDING_BOXES: harbor,
      AISSTREAM_MESSAGE_TYPES: 'PositionReport, ShipStaticData',
    },
  });
  const socket = goLive(custom);
  assert.deepEqual(socket.sent[0].BoundingBoxes, JSON.parse(harbor));
  assert.deepEqual(socket.sent[0].FilterMessageTypes, [
    'PositionReport',
    'ShipStaticData',
  ]);
  assert.equal(custom.relay.status().watchdog, 'custom-subscription-off');
  custom.clock.t += 60 * 60_000;
  custom.relay.ensure();
  assert.equal(socket.terminated, false, 'a quiet harbor is not a dead feed');

  const sized = setup({
    env: {
      AISSTREAM_API_KEY: KEY,
      AISSTREAM_BOUNDING_BOXES: harbor,
      AISSTREAM_SILENCE_TIMEOUT_MS: '600000',
    },
  });
  goLive(sized);
  assert.equal(sized.relay.status().watchdog, 'armed');
  assert.equal(sized.relay.status().staleAfterMs, 600_000);

  const off = setup({
    env: { AISSTREAM_API_KEY: KEY, AISSTREAM_SILENCE_TIMEOUT_MS: '0' },
  });
  goLive(off);
  assert.equal(off.relay.status().watchdog, 'custom-subscription-off');
});

test("the tick starts once, is unref'd, and a failed pass is logged rather than thrown", () => {
  let unreadable = false;
  const env = new Proxy(
    { AISSTREAM_API_KEY: KEY },
    {
      get(target, name) {
        if (unreadable) throw new Error('env unreadable');
        return target[name];
      },
    },
  );
  const ctx = setup({ env });
  ctx.relay.startTick();
  ctx.relay.startTick();
  assert.equal(ctx.intervals.length, 1, 'a restart cannot stack intervals');
  const [tick] = ctx.intervals;
  assert.equal(tick.ms, 15_000);
  assert.equal(tick.unrefs, 1, 'the tick never holds the server open');

  tick.fn();
  assert.equal(ctx.sockets.length, 1, 'the tick connects without requests');
  unreadable = true;
  assert.doesNotThrow(() => tick.fn());
  unreadable = false;
  assert.match(ctx.warnings.join('\n'), /watchdog tick failed env unreadable/);
});

test('dispose stops the tick and hangs up, and the next pass re-reads the settings', () => {
  const ctx = setup();
  ctx.relay.startTick();
  const socket = goLive(ctx);
  ctx.env.AISSTREAM_URL = 'ws://127.0.0.1:9/stand-in';
  ctx.relay.ensure();
  assert.equal(ctx.sockets.length, 1, 'settings are read once per server run');

  ctx.relay.dispose();
  assert.deepEqual(ctx.cleared, [ctx.intervals[0]]);
  assert.equal(socket.terminated, true);
  ctx.relay.dispose();

  ctx.relay.ensure();
  assert.equal(ctx.sockets.length, 2);
  assert.equal(ctx.sockets[1].url, 'ws://127.0.0.1:9/stand-in');
  ctx.relay.startTick();
  assert.equal(ctx.intervals.length, 2, 'a restarted server ticks again');
});

test('tracks keep thinned samples in order, and the route checks the MMSI', async () => {
  const ctx = setup();
  const mmsi = 257000000;
  const socket = goLive(ctx, positionReport(mmsi, 60.5, 10.25, T0));
  // 10 s later: too soon to keep.
  socket.emit('message', positionReport(mmsi, 60.501, 10.25, T0 + 10_000));
  // 40 s and about 110 m on: kept.
  socket.emit('message', positionReport(mmsi, 60.501, 10.25, T0 + 40_000));
  // 40 s on again, but only about 11 m: too close to keep.
  socket.emit('message', positionReport(mmsi, 60.5011, 10.25, T0 + 80_000));

  const handler = mount(ctx.relay);
  const answer = await request(handler, `/track?mmsi=${mmsi}`);
  assert.equal(answer.status, 200);
  assert.equal(answer.body.retainedSec, 1800);
  assert.deepEqual(
    answer.body.samples.map((sample) => sample.t),
    [T0 / 1000, T0 / 1000 + 40],
  );
  assert.ok(Math.abs(answer.body.samples[1].lat - 60.501) < 1e-4);

  const refused = await request(handler, '/track?mmsi=12');
  assert.equal(refused.status, 400);
  assert.deepEqual(refused.body, {
    error: 'mmsi query param required',
    samples: [],
  });
});

test('rows come newest first, maxRows caps them, and a quiet vessel drops out', async () => {
  const ctx = setup();
  const socket = goLive(
    ctx,
    positionReport(257000001, 60.5, 10.25, T0, 'FIRST'),
  );
  ctx.clock.t += 1_000;
  socket.emit(
    'message',
    positionReport(257000002, 61.5, 11.25, ctx.clock.t, 'SECOND'),
  );
  const handler = mount(ctx.relay);
  const all = await request(handler);
  assert.deepEqual(
    all.body.rows.map((row) => row.name),
    ['SECOND', 'FIRST'],
  );
  const one = await request(handler, '/?maxRows=1');
  assert.deepEqual(
    one.body.rows.map((row) => row.name),
    ['SECOND'],
  );

  ctx.clock.t += 31 * 60_000;
  const later = await request(handler);
  assert.deepEqual(later.body.rows, []);
});

test('the plugin starts the tick and tears the relay down with the server', async (t) => {
  const calls = [];
  const relay = {
    ensure: () => {
      throw new Error('relay exploded');
    },
    startTick: () => calls.push('startTick'),
    dispose: () => calls.push('dispose'),
  };
  const plugin = aisLiveProxy({ relay });
  const routes = new Map();
  const hooks = [];
  const server = {
    middlewares: { use: (prefix, handler) => routes.set(prefix, handler) },
    httpServer: { on: (event, handler) => hooks.push([event, handler]) },
  };
  plugin.configureServer(server);
  assert.deepEqual(calls, ['startTick']);
  assert.deepEqual(
    hooks.map(([event]) => event),
    ['close'],
  );
  hooks[0][1]();
  plugin.closeBundle();
  plugin.configurePreviewServer(server);
  assert.deepEqual(calls, ['startTick', 'dispose', 'dispose', 'startTick']);

  t.mock.method(console, 'warn', () => {});
  const answer = await request(routes.get('/api/ais-live'));
  assert.equal(answer.status, 502);
  assert.deepEqual(answer.body, { error: 'AIS live stream error', rows: [] });
});
