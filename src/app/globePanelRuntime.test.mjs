import assert from 'node:assert/strict';
import test from 'node:test';
import { panelRuntime } from './globePanelRuntime.js';

/** The parts of a panel element the runtime touches. */
function element() {
  const listeners = new Map();
  return {
    hidden: true,
    textContent: '',
    isConnected: false,
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) || []), listener]);
    },
    click() {
      for (const listener of listeners.get('click') || []) listener();
    },
    remove() {},
  };
}

/**
 * The panel page around the runtime: its three elements, the host behind
 * window.parent, and window.open. `deliver` posts a message from the host.
 */
function stubPanel(t) {
  const elements = { status: element(), open: element(), expand: element() };
  const posted = [];
  const opened = [];
  const listeners = [];
  const parent = { postMessage: (message) => posted.push(message) };
  const saved = { window: globalThis.window, document: globalThis.document };
  globalThis.window = {
    parent,
    addEventListener: (type, listener) => {
      if (type === 'message') listeners.push(listener);
    },
    postMessage() {},
    open: (...args) => opened.push(args),
  };
  globalThis.document = {
    baseURI: 'https://host.example/panel/',
    body: { clientWidth: 400 },
    getElementById: (id) => elements[id],
    addEventListener() {},
  };
  t.after(() => {
    globalThis.window = saved.window;
    globalThis.document = saved.document;
  });
  panelRuntime({
    appBaseUrl: 'https://app.gods-eye-view.invalid/',
    loadTimeoutMs: 0,
    panelBase: '/panel/',
    panelHeight: 520,
    panelKey: 'test-key',
    protocolVersion: '2026-01-26',
    toolName: 'panel_request',
    workerPreludePath: 'cesium/worker-prelude.js',
  });
  const deliver = (data) => {
    for (const listener of listeners) listener({ source: parent, data });
  };
  const showView = (url) =>
    deliver({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { structuredContent: { view: { camera: {} }, url } },
    });
  return { elements, posted, opened, deliver, showView };
}

test('the Open button never follows a link that is not http or https', (t) => {
  const panel = stubPanel(t);
  for (const url of [
    'javascript:alert(document.domain)',
    'data:text/html,<script>alert(1)</script>',
    'not a url',
  ]) {
    panel.showView(url);
    assert.equal(panel.elements.open.hidden, true, url);
    panel.elements.open.click();
  }
  assert.equal(
    panel.posted.some((message) => message.method === 'ui/open-link'),
    false,
  );
  assert.deepEqual(panel.opened, []);
});

test('the Open button asks the host to open the app, and opens it itself if refused', async (t) => {
  const panel = stubPanel(t);
  const url = 'http://localhost:4173/#v=2&lat=59.9&lon=10.7';
  panel.showView(url);
  assert.equal(panel.elements.open.hidden, false);
  panel.elements.open.click();
  const ask = panel.posted.find((message) => message.method === 'ui/open-link');
  assert.deepEqual(ask.params, { url });
  panel.deliver({ jsonrpc: '2.0', id: ask.id, error: { code: -32601 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(panel.opened, [[url, '_blank', 'noopener']]);
});
