import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import {
  CATALOG_TIMEOUT_MS,
  createCctvSource,
  HEALTH_TIMEOUT_MS,
} from '../layers/cctv/source.js';
import {
  ACTIVE_TLE_TIMEOUT_MS,
  createLaunchSource,
  LAUNCHES_TIMEOUT_MS,
} from '../layers/launches/source.js';
import { CLICK_TIMEOUT_MS, createRadioSource } from '../layers/radio/source.js';
import {
  createFlightSource,
  ENRICHMENT_TIMEOUT_MS,
} from './live/standalone.js';

const STATION = '00000000-0000-4000-8000-000000000001';

/** A server that accepts the request and never answers, abort or not. */
function stalledServer() {
  const signals = [];
  return {
    signals,
    fetchImpl: (_url, { signal }) => {
      signals.push(signal);
      return new Promise(() => {});
    },
  };
}

const CALLS = [
  {
    name: 'CCTV catalog',
    timeoutMs: CATALOG_TIMEOUT_MS,
    call: (fetchImpl, options) =>
      createCctvSource({ fetchImpl }).getCatalog(options),
  },
  {
    name: 'CCTV health',
    timeoutMs: HEALTH_TIMEOUT_MS,
    call: (fetchImpl, options) =>
      createCctvSource({ fetchImpl }).getHealth(options),
  },
  {
    name: 'launch feed',
    timeoutMs: LAUNCHES_TIMEOUT_MS,
    call: (fetchImpl, options) =>
      createLaunchSource({ fetchImpl }).getLaunches(options),
  },
  {
    name: 'active TLE catalog',
    timeoutMs: ACTIVE_TLE_TIMEOUT_MS,
    call: (fetchImpl, options) =>
      createLaunchSource({ fetchImpl }).getActiveTle(options),
  },
  {
    name: 'radio click count',
    timeoutMs: CLICK_TIMEOUT_MS,
    call: (fetchImpl, options) =>
      createRadioSource({ fetchImpl }).recordClick(STATION, options),
  },
  {
    name: 'adsbdb enrichment',
    timeoutMs: ENRICHMENT_TIMEOUT_MS,
    call: (fetchImpl, options) =>
      createFlightSource({ fetchImpl }).getEnrichment(
        { kind: 'type', id: 'abc123' },
        options,
      ),
  },
];

test('a stalled server cannot hold a client API call past its deadline', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    for (const { name, timeoutMs, call } of CALLS) {
      const server = stalledServer();
      const pending = call(server.fetchImpl, {});
      mock.timers.tick(timeoutMs - 1);
      assert.equal(server.signals[0].aborted, false, `${name} waits`);
      mock.timers.tick(1);
      await assert.rejects(pending, { name: 'TimeoutError' }, name);
      assert.equal(server.signals[0].aborted, true, `${name} cancels`);
    }
  } finally {
    mock.timers.reset();
  }
});

test('the caller can still cancel a client API call before its deadline', async () => {
  for (const { name, call } of CALLS) {
    const server = stalledServer();
    const controller = new AbortController();
    const pending = call(server.fetchImpl, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' }, name);
    assert.equal(server.signals[0].aborted, true, `${name} cancels`);
  }
});

test('a call that is already cancelled never reaches the server', async () => {
  for (const { name, call } of CALLS) {
    const server = stalledServer();
    const pending = call(server.fetchImpl, { signal: AbortSignal.abort() });
    await assert.rejects(pending, { name: 'AbortError' }, name);
    assert.equal(server.signals.length, 0, name);
  }
});
