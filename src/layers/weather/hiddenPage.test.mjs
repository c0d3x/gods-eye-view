// A hidden tab never renders, so Cesium never requests a staging frame's tiles
// and the frame times out after 25 s. Before the fix, every poll in a
// background tab started such a frame, and the user came back to "Frame
// unavailable; previous observation retained" for up to two minutes. These
// tests pin that the weather layers wait for a visible page instead.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createWeatherClock } from './clock.js';
import { createWeatherLayer } from './index.js';

const T = [
  '2026-09-15T20:00:00.000Z',
  '2026-09-15T20:05:00.000Z',
  '2026-09-15T20:10:00.000Z',
  '2026-09-15T20:15:00.000Z',
];
const PRODUCTS = {
  'weather-radar': 'radar',
  'weather-satellite': 'clouds-regional',
  'weather-lightning': 'lightning',
};
const FRAME_TIMEOUT_MS = 25_000;
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

function fakeDocument() {
  const listeners = new Set();
  return {
    hidden: false,
    addEventListener(name, fn) {
      if (name === 'visibilitychange') listeners.add(fn);
    },
    removeEventListener(_name, fn) {
      listeners.delete(fn);
    },
    setHidden(value) {
      this.hidden = value;
      for (const fn of [...listeners]) fn();
    },
  };
}

/** Like Cesium imagery: a staging frame finishes only when the scene renders,
 * and otherwise fails at the rendering's 25 s deadline. */
function fakeRendering() {
  const frames = [];
  let shown = null;
  let lastError = null;
  return {
    frames,
    render() {
      for (const frame of frames) frame.settle(true);
    },
    rehome() {},
    setAlpha() {},
    setHidden() {},
    cancelPrefetch() {},
    clear() {
      shown = null;
      lastError = null;
    },
    setFrame(_snapshot, time, { signal } = {}) {
      if (time === shown) return Promise.resolve(true);
      return new Promise((resolve) => {
        const frame = { time, signal, settled: false };
        frame.settle = (ok) => {
          if (frame.settled) return;
          frame.settled = true;
          clearTimeout(frame.timeout);
          if (ok) {
            shown = time;
            lastError = null;
          } else if (!signal?.aborted)
            lastError = 'Weather tiles unavailable · previous frame retained';
          resolve(ok);
        };
        frame.timeout = setTimeout(() => frame.settle(false), FRAME_TIMEOUT_MS);
        signal?.addEventListener('abort', () => frame.settle(false), {
          once: true,
        });
        frames.push(frame);
      });
    },
    getDiagnostics: () => ({
      time: shown,
      hidden: false,
      infrared: 'filtered',
      loading: frames.some((frame) => !frame.settled),
      error: lastError,
    }),
  };
}

function weatherLayer({ id, clock, documentRef, source }) {
  const rendering = fakeRendering();
  const fetches = [];
  const layer = createWeatherLayer({
    id,
    clock,
    documentRef,
    eventTarget: { addEventListener() {}, removeEventListener() {} },
    matchMedia: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
    feed: {
      async getSnapshot({ product }) {
        fetches.push(product);
        return {
          product,
          times: [...source.times],
          latest: source.times.at(-1),
          bounds: { west: -130, south: 20, east: -60, north: 55 },
        };
      },
    },
    createRendering: () => rendering,
  });
  layer.init({ camera: { moveEnd: { addEventListener: () => () => {} } } });
  layer.enable();
  return { layer, rendering, fetches };
}

/** One lifecycle poll on a visible page, with the scene rendering. */
async function poll(entry) {
  const done = entry.layer.update();
  await flush();
  entry.rendering.render();
  return done;
}

function setup(t, { ids = Object.keys(PRODUCTS), shared = true } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse(T[2]) });
  const documentRef = fakeDocument();
  const source = { times: T.slice(0, 3) };
  const clock = shared ? createWeatherClock() : undefined;
  const layers = ids.map((id) =>
    weatherLayer({ id, clock, documentRef, source }),
  );
  t.after(() => {
    for (const { layer } of layers) layer.destroy();
    clock?.destroy();
  });
  return { documentRef, source, clock, layers };
}

const status = ({ layer }) => layer.getRowControls().summary.status;

/** Let work started now run past the frame deadline, then settle it. */
async function pastFrameDeadline(t, pending) {
  await flush();
  t.mock.timers.tick(FRAME_TIMEOUT_MS + 5_000);
  await flush();
  return Promise.all(pending);
}

test('radar, satellite and lightning skip polls on a hidden page and catch up once it is visible', async (t) => {
  const h = setup(t);
  for (const entry of h.layers) {
    assert.equal(await poll(entry), true);
    assert.equal(entry.layer.getStats().observedAt, T[2]);
  }

  h.documentRef.setHidden(true);
  h.source.times = T;
  t.mock.timers.tick(60_000);
  const polls = await pastFrameDeadline(
    t,
    h.layers.map(({ layer }) => layer.update()),
  );
  assert.deepEqual(
    polls,
    h.layers.map(() => true),
    'a skipped poll is not a failed refresh',
  );
  for (const entry of h.layers) {
    assert.equal(entry.fetches.length, 1, 'no snapshot fetch while hidden');
    assert.equal(entry.rendering.frames.length, 1, 'no frame while hidden');
    assert.equal(entry.layer.getStats().error, null);
    assert.equal(status(entry), null);
    assert.equal(entry.layer.getStats().observedAt, T[2]);
  }

  h.documentRef.setHidden(false);
  await flush();
  for (const entry of h.layers) {
    assert.equal(entry.fetches.length, 2, 'one fresh fetch on return');
    assert.deepEqual(
      entry.rendering.frames.map((frame) => frame.time),
      [T[2], T[3]],
    );
    entry.rendering.render();
  }
  await flush();
  for (const entry of h.layers) {
    assert.equal(entry.layer.getStats().observedAt, T[3]);
    assert.equal(entry.layer.getStats().error, null);
    assert.equal(status(entry), null);
  }
});

test('a frame still loading when the page hides is cancelled, not timed out, and reloads on return', async (t) => {
  const h = setup(t, { ids: ['weather-radar'] });
  const [entry] = h.layers;
  const update = entry.layer.update();
  await flush();
  const [first] = entry.rendering.frames;
  assert.equal(first.settled, false);

  h.documentRef.setHidden(true);
  assert.equal(first.signal.aborted, true);
  assert.deepEqual(await pastFrameDeadline(t, [update]), [true]);
  assert.equal(entry.layer.getStats().error, null);
  assert.equal(status(entry), null);

  h.documentRef.setHidden(false);
  await flush();
  assert.equal(entry.fetches.length, 1, 'the manifest is still current');
  assert.deepEqual(
    entry.rendering.frames.map((frame) => frame.time),
    [T[2], T[2]],
  );
  entry.rendering.render();
  await flush();
  assert.equal(entry.layer.getStats().observedAt, T[2]);
  assert.equal(entry.layer.getStats().error, null);
});

test('a short hide with no poll due fetches and loads nothing on return', async (t) => {
  const h = setup(t, { ids: ['weather-satellite'] });
  const [entry] = h.layers;
  await poll(entry);
  h.documentRef.setHidden(true);
  h.documentRef.setHidden(false);
  await flush();
  assert.equal(entry.fetches.length, 1);
  assert.equal(entry.rendering.frames.length, 1);
  assert.equal(entry.layer.getStats().observedAt, T[2]);
});

test('shared history waits for a visible page, then loads the target time', async (t) => {
  const h = setup(t, { ids: ['weather-lightning'] });
  const [entry] = h.layers;
  await poll(entry);
  const history = h.clock.setTarget(T[0]);
  await flush();
  entry.rendering.render();
  await history;
  assert.equal(entry.layer.getStats().observedAt, T[0]);

  h.documentRef.setHidden(true);
  await pastFrameDeadline(t, [h.clock.setTarget(T[1])]);
  assert.equal(entry.rendering.frames.length, 2, 'no frame while hidden');
  assert.equal(entry.layer.getStats().error, null);

  h.documentRef.setHidden(false);
  await flush();
  assert.equal(entry.rendering.frames.at(-1).time, T[1]);
  entry.rendering.render();
  await flush();
  assert.equal(entry.layer.getStats().observedAt, T[1]);
  assert.equal(entry.layer.getStats().error, null);
});

test('without a shared clock a skipped poll also catches up on return', async (t) => {
  const h = setup(t, { ids: ['weather-radar'], shared: false });
  const [entry] = h.layers;
  await poll(entry);
  h.documentRef.setHidden(true);
  h.source.times = T;
  assert.deepEqual(await pastFrameDeadline(t, [entry.layer.update()]), [true]);
  assert.equal(entry.fetches.length, 1);
  assert.equal(entry.layer.getStats().error, null);
  h.documentRef.setHidden(false);
  await flush();
  assert.equal(entry.fetches.length, 2);
  entry.rendering.render();
  await flush();
  assert.equal(entry.layer.getStats().observedAt, T[3]);
});

test('disabling a layer drops work it skipped while hidden', async (t) => {
  const h = setup(t, { ids: ['weather-radar'] });
  const [entry] = h.layers;
  await poll(entry);
  h.documentRef.setHidden(true);
  await pastFrameDeadline(t, [entry.layer.update()]);
  entry.layer.disable();
  entry.layer.enable();
  h.documentRef.setHidden(false);
  await flush();
  assert.equal(entry.fetches.length, 1);
});
