import assert from 'node:assert/strict';
import test from 'node:test';
import { GevRealtimeController } from './gevRealtime.js';

function eventHub() {
  return {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
  };
}

// Outside Vite the GEV_REALTIME_DEBUG_LOG define is absent, which is the
// same as the log being off.
test('the voice controller posts no debug records while the log is off', (t) => {
  const previous = { document: globalThis.document, window: globalThis.window };
  Object.assign(globalThis, {
    document: {
      ...eventHub(),
      visibilityState: 'visible',
      activeElement: null,
    },
    window: eventHub(),
  });
  t.after(() => Object.assign(globalThis, previous));
  const posted = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    posted.push(String(url));
    return new Response(null, { status: 204 });
  });

  const controller = new GevRealtimeController({
    ui: {
      root: { dataset: {}, querySelectorAll: () => [], remove() {} },
      status: {},
      detail: {},
    },
    runner: async () => ({}),
  });
  controller.debugLog('test.event', { token: 'secret', note: 'hello' });

  assert.deepEqual(posted, []);
  assert.equal(controller.getDiagnostics().debugLog.enabled, false);
});
