import assert from 'node:assert/strict';
import test from 'node:test';
import {
  injectRuntimeConfig,
  RUNTIME_CONFIG_PATH,
  RUNTIME_KEYS,
  runtimeConfigFrom,
  runtimeConfigScript,
} from './runtimeConfig.mjs';

test('the runtime config carries the three browser keys and nothing else', () => {
  assert.deepEqual(RUNTIME_KEYS, [
    'GOOGLE_MAPS_API_KEY',
    'CESIUM_ION_TOKEN',
    'MAPILLARY_CLIENT_TOKEN',
  ]);
  assert.deepEqual(
    runtimeConfigFrom({
      GOOGLE_MAPS_API_KEY: ' AIza-test ',
      OPENAI_API_KEY: 'sk-server-only',
      AISSTREAM_API_KEY: 'server-only',
    }),
    {
      GOOGLE_MAPS_API_KEY: 'AIza-test',
      CESIUM_ION_TOKEN: '',
      MAPILLARY_CLIENT_TOKEN: '',
    },
  );
});

test('the script sets a frozen config and cannot close its element', () => {
  const script = runtimeConfigScript({ CESIUM_ION_TOKEN: '</script><b>x' });
  assert.doesNotMatch(script, /<\/script>/);
  /** @type {{__GEV_RUNTIME_CONFIG__?: Record<string, string>}} */
  const window = {};
  new Function('window', script)(window);
  assert.equal(
    window.__GEV_RUNTIME_CONFIG__?.CESIUM_ION_TOKEN,
    '</script><b>x',
  );
  assert.ok(Object.isFrozen(window.__GEV_RUNTIME_CONFIG__));
});

test('the config script is the first thing in <head>', () => {
  const html =
    '<!doctype html><html lang="en"><head class="x">\n<meta charset="utf-8"><script src="/cesium/Cesium.js"></script></head><body></body></html>';
  const result = injectRuntimeConfig(html);
  const at = result.indexOf(RUNTIME_CONFIG_PATH);
  assert.ok(at > result.indexOf('<head class="x">'));
  assert.ok(at < result.indexOf('<meta charset'));
  assert.ok(at < result.indexOf('Cesium.js'));
  assert.throws(
    () => injectRuntimeConfig('<html><body></body></html>'),
    /head/,
  );
});
