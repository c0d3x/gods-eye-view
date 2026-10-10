// Every HUD AI summary is a paid OpenAI call (POST /api/openai/hud-summary).
// With a live layer on, each poll changes the layer counts, so the summary goes
// stale and the 15 s tick asks again: about four calls a minute, also from a
// background tab nobody is looking at. These tests drive a live IntelHUD and
// pin that a hidden tab asks for none, and that one fresh summary is requested
// when the tab is visible again.
//
// As in hudAltitudeDatum.test.mjs, module hooks stub `mgrs` (CommonJS) and the
// voice stack's label lookup, and hud.js is imported before any DOM globals.

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { ensureGeoidReady } from './data/geoid.js';

const STUBS = {
  mgrs: 'export function forward() { return "10SEG55776339"; }\nexport default { forward };\n',
  './voice/gevActions.js':
    'export async function getBasemapLabelContext() {\n  return { placeLabels: ["San Francisco"], streetLabels: [], nearbyPlaceLabels: [] };\n}\n',
};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'mgrs' || context.parentURL?.endsWith('/src/hud.js')) {
      if (Object.hasOwn(STUBS, specifier))
        return { url: `gev-test-stub:${specifier}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    const specifier = url.startsWith('gev-test-stub:')
      ? url.slice('gev-test-stub:'.length)
      : null;
    if (specifier && Object.hasOwn(STUBS, specifier))
      return { format: 'module', shortCircuit: true, source: STUBS[specifier] };
    return next(url, context);
  },
});

const { IntelHUD } = await import('./hud.js');

const SUMMARY_INTERVAL_MS = 15_000;
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

/** A camera over SFO, a document that can hide, and a live Transit layer. */
function hudHarness(t, { canRequest = () => true } = {}) {
  const elements = new Map();
  const visibility = new Set();
  const previous = { document: globalThis.document, window: globalThis.window };
  const documentRef = {
    hidden: false,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { textContent: '', style: {} });
      return id === 'intel-hud' ? null : elements.get(id);
    },
    querySelectorAll: () => [],
    addEventListener(name, fn) {
      if (name === 'visibilitychange') visibility.add(fn);
    },
    removeEventListener(name, fn) {
      if (name === 'visibilitychange') visibility.delete(fn);
    },
  };
  globalThis.document = documentRef;
  globalThis.window = {
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (...args) => clearTimeout(...args),
  };
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });

  const viewer = {
    camera: {
      pitch: -Math.PI / 2,
      positionCartographic: {
        latitude: (37.616 * Math.PI) / 180,
        longitude: (-122.368 * Math.PI) / 180,
        height: 1_500,
      },
      computeViewRectangle: () => undefined,
      moveEnd: { addEventListener() {}, removeEventListener() {} },
    },
  };
  const requests = [];
  const policy = { checks: 0 };
  const summaryService = {
    async summarize(context) {
      requests.push(context);
      return {
        ok: true,
        status: 200,
        data: { summary: `TRANSIT ${requests.length}` },
      };
    },
  };
  let count = 100;
  let onLayerChange = null;
  const hud = new IntelHUD(viewer, {
    summaryService,
    summaryPolicy: {
      canRequest() {
        policy.checks++;
        return canRequest();
      },
    },
  });
  hud.attachDataManager({
    getAll: () => [
      {
        id: 'transit',
        name: 'Transit',
        enabled: true,
        stats: { count, source: 'GTFS-RT', lastUpdate: Date.now() },
      },
    ],
    subscribe(fn) {
      onLayerChange = fn;
      return () => {
        onLayerChange = null;
      };
    },
  });
  t.after(() => {
    hud.destroy();
    t.mock.timers.reset();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  return {
    hud,
    requests,
    policy,
    listeners: () => visibility.size,
    /** One live-layer poll: new counts, and the lifecycle's refresh event. */
    poll() {
      count += 7;
      onLayerChange?.({ type: 'refresh-transition', layerId: 'transit' });
    },
    async tick(ms = SUMMARY_INTERVAL_MS) {
      t.mock.timers.tick(ms);
      await settle();
    },
    async setHidden(value) {
      documentRef.hidden = value;
      for (const fn of [...visibility]) fn();
      await settle();
    },
  };
}

test('a hidden tab requests no HUD summaries while live layers keep polling', async (t) => {
  await ensureGeoidReady();
  const h = hudHarness(t);
  h.hud.show();
  await settle();
  assert.equal(h.requests.length, 1, 'showing the HUD asks once');

  h.poll();
  await h.tick();
  assert.equal(h.requests.length, 2, 'a visible, stale summary refreshes');

  await h.setHidden(true);
  for (let minute = 0; minute < 3; minute++) {
    for (let i = 0; i < 4; i++) {
      h.poll();
      await h.tick();
    }
  }
  assert.equal(h.requests.length, 2, 'no summary calls from a hidden tab');

  await h.setHidden(false);
  assert.equal(h.requests.length, 3, 'one catch-up summary on return');
  assert.equal(h.requests.at(-1).enabledLayers[0].count, 100 + 7 * 13);

  await h.tick();
  assert.equal(h.requests.length, 3, 'the fresh summary is not repeated');
  h.poll();
  await h.tick();
  assert.equal(h.requests.length, 4, 'the visible cadence is unchanged');
});

test('returning to a tab whose summary is still current requests nothing', async (t) => {
  await ensureGeoidReady();
  const h = hudHarness(t);
  h.hud.show();
  await settle();
  assert.equal(h.requests.length, 1);
  await h.setHidden(true);
  await h.tick(4 * SUMMARY_INTERVAL_MS);
  await h.setHidden(false);
  await h.tick();
  assert.equal(h.requests.length, 1);
});

test('a hidden HUD asks nothing on return, and showing it later still asks once', async (t) => {
  await ensureGeoidReady();
  const h = hudHarness(t);
  await h.setHidden(true);
  h.hud.show();
  h.poll();
  await h.tick();
  assert.equal(h.requests.length, 0, 'showing the HUD in a hidden tab waits');
  h.hud.hide();
  await h.setHidden(false);
  assert.equal(h.requests.length, 0, 'a hidden HUD needs no summary');
  h.hud.show();
  await settle();
  assert.equal(h.requests.length, 1);
});

test('the summary policy still gates the catch-up request', async (t) => {
  await ensureGeoidReady();
  let allowed = true;
  const h = hudHarness(t, { canRequest: () => allowed });
  h.hud.show();
  await settle();
  assert.equal(h.requests.length, 1);
  await h.setHidden(true);
  const checks = h.policy.checks;
  h.poll();
  await h.tick(3 * SUMMARY_INTERVAL_MS);
  assert.equal(h.policy.checks, checks, 'a hidden tab does not consult it');
  allowed = false;
  await h.setHidden(false);
  assert.equal(h.policy.checks, checks + 1);
  assert.equal(h.requests.length, 1, 'a refusing policy still wins');
  allowed = true;
  await h.tick();
  assert.equal(h.requests.length, 2, 'and the next tick retries');
});

test('destroy removes the visibility listener', async (t) => {
  await ensureGeoidReady();
  const h = hudHarness(t);
  assert.equal(h.listeners(), 1);
  h.hud.destroy();
  assert.equal(h.listeners(), 0);
});
