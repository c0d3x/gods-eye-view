import assert from 'node:assert/strict';
import test from 'node:test';
import { initKeySetup } from '../keySetup.js';
import { KEY_SETUP_OPEN_EVENT, keyRequiredDetail } from '../keySetupRequest.js';
import { ShellFeedback } from './shellFeedback.js';

function fakeElement() {
  const classes = new Set();
  return Object.assign(new EventTarget(), {
    dataset: {},
    hidden: true,
    textContent: '',
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    querySelector: () => null,
    setAttribute() {},
    remove() {},
  });
}

function withShellGlobals(nodes, run) {
  const saved = {
    document: globalThis.document,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  globalThis.document = Object.assign(new EventTarget(), {
    hidden: false,
    getElementById: (id) => nodes.get(id) || null,
  });
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};
  try {
    return run(globalThis.document);
  } finally {
    Object.assign(globalThis, saved);
  }
}

const enabling = {
  id: 'firms',
  name: 'NASA FIRMS',
  requiresKeyId: 'firms',
  lifecycleState: 'enabling',
  stats: { loading: true },
};
const keyless = {
  id: 'firms',
  name: 'NASA FIRMS',
  requiresKeyId: 'firms',
  enabled: true,
  lifecycleState: 'enabled',
  stats: { loading: false, keyRequired: true, error: 'KEY REQUIRED' },
};

function settleKeyless(feedback, layers) {
  layers.current = [enabling];
  feedback._updateGlobalLoadingFeedback(0);
  feedback._updateGlobalLoadingFeedback(200);
  layers.current = [keyless];
  feedback._updateGlobalLoadingFeedback(300);
}

test('KEY REQUIRED shows ADD KEY where Provider Settings exists, and asks it to open', () => {
  const nodes = new Map(
    [
      'global-loading-status',
      'global-loading-detail',
      'global-loading-action',
      'key-setup',
    ].map((id) => [id, fakeElement()]),
  );
  withShellGlobals(nodes, (document) => {
    const layers = { current: [] };
    const feedback = new ShellFeedback({ readLayers: () => layers.current });
    settleKeyless(feedback, layers);
    const status = nodes.get('global-loading-status');
    const action = nodes.get('global-loading-action');
    assert.equal(status.dataset.state, 'needs-key');
    assert.equal(
      nodes.get('global-loading-detail').textContent,
      'Needs FIRMS_MAP_KEY',
    );
    assert.equal(action.hidden, false);

    let requests = 0;
    document.addEventListener(KEY_SETUP_OPEN_EVENT, () => requests++);
    action.dispatchEvent(new Event('click'));
    assert.equal(requests, 1);

    // Once the banner dwells out, the button goes with it.
    feedback._updateGlobalLoadingFeedback(300 + 60_000);
    assert.equal(status.hidden, true);
    assert.equal(action.hidden, true);

    feedback.destroy();
    action.dispatchEvent(new Event('click'));
    assert.equal(requests, 1, 'teardown releases the button');
  });
});

test('KEY REQUIRED offers no button where Provider Settings does not exist', () => {
  const nodes = new Map(
    [
      'global-loading-status',
      'global-loading-detail',
      'global-loading-action',
    ].map((id) => [id, fakeElement()]),
  );
  withShellGlobals(nodes, () => {
    const layers = { current: [] };
    const feedback = new ShellFeedback({ readLayers: () => layers.current });
    settleKeyless(feedback, layers);
    assert.equal(nodes.get('global-loading-status').dataset.state, 'needs-key');
    assert.equal(nodes.get('global-loading-action').hidden, true);
    feedback.destroy();
  });
});

test('Provider Settings opens on a key-setup request until it is torn down', async () => {
  const chip = fakeElement();
  const root = fakeElement();
  const documentRef = Object.assign(new EventTarget(), {
    getElementById: (id) =>
      ({ 'key-setup-chip': chip, 'key-setup': root })[id] || null,
  });
  const controller = new AbortController();
  const setup = await initKeySetup({
    documentRef,
    signal: controller.signal,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ keys: [], total: 1, setCount: 0 }),
    }),
  });
  assert.ok(setup, 'the surface initialised');
  assert.equal(root.hidden, true);
  documentRef.dispatchEvent(new CustomEvent(KEY_SETUP_OPEN_EVENT));
  assert.equal(root.hidden, false);

  setup.close();
  root.hidden = true;
  controller.abort();
  documentRef.dispatchEvent(new CustomEvent(KEY_SETUP_OPEN_EVENT));
  assert.equal(root.hidden, true, 'a destroyed surface ignores the request');
});

test('the banner names the key from the registry, and never guesses', () => {
  assert.equal(keyRequiredDetail('firms'), 'Needs FIRMS_MAP_KEY');
  assert.equal(keyRequiredDetail('google-maps-server'), '', 'hidden entry');
  assert.equal(keyRequiredDetail('no-such-key'), '');
  assert.equal(keyRequiredDetail(null), '');
});
