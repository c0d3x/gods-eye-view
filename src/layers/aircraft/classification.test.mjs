import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MILITARY_REGISTRY_MAX_ENTRIES,
  MILITARY_REGISTRY_TTL_MS,
  createMilitaryRegistry,
} from './classification.js';

test('classification instances have independent identities, listeners and active states', () => {
  let requests = 0;
  const source = {
    getSnapshot() {
      requests++;
    },
  };
  const first = createMilitaryRegistry({ source });
  const second = createMilitaryRegistry({ source });
  let firstEvents = 0;
  let secondEvents = 0;
  first.onMilitaryLayerActiveChange(() => firstEvents++);
  second.onMilitaryLayerActiveChange(() => secondEvents++);
  first.registerMilitaryIcaos([' ABC123 ']);
  first.setMilitaryLayerActive(true);
  assert.equal(first.isMilitaryIcao('abc123'), true);
  assert.equal(second.isMilitaryIcao('abc123'), false);
  assert.equal(firstEvents, 1);
  assert.equal(secondEvents, 0);
  assert.equal(second.isMilitaryLayerActive(), false);
  assert.equal(requests, 0);
  first.dispose();
  second.dispose();
});

test('classification uses normalized identities and respects its polling interval and active layer', async () => {
  let time = 120000;
  let calls = 0;
  const registry = createMilitaryRegistry({
    now: () => time,
    source: {
      async getSnapshot() {
        calls++;
        return { records: [{ id: 'abc123' }] };
      },
    },
  });
  await registry.refreshMilitaryRegistryIfStale();
  await registry.refreshMilitaryRegistryIfStale();
  assert.equal(calls, 1);
  assert.equal(registry.isMilitaryIcao('abc123'), true);
  time += 60000;
  registry.setMilitaryLayerActive(true);
  await registry.refreshMilitaryRegistryIfStale();
  assert.equal(calls, 1);
  registry.setMilitaryLayerActive(false);
  await registry.refreshMilitaryRegistryIfStale();
  assert.equal(calls, 2);
  registry.dispose();
});

test('source replacement rejects an old response and disposal cancels the current request', async () => {
  let resolveOld;
  let resolveNew;
  let oldSignal;
  let newSignal;
  const registry = createMilitaryRegistry({
    source: {
      getSnapshot(query, { signal }) {
        oldSignal = signal;
        return new Promise((resolve) => {
          resolveOld = resolve;
        });
      },
    },
  });
  const old = registry.refreshMilitaryRegistryIfStale();
  const application = new AbortController();
  registry.configureSource(
    {
      getSnapshot(query, { signal }) {
        newSignal = signal;
        return new Promise((resolve) => {
          resolveNew = resolve;
        });
      },
    },
    { signal: application.signal },
  );
  const current = registry.refreshMilitaryRegistryIfStale();
  resolveOld({ records: [{ id: 'abc123' }] });
  await old;
  application.abort();
  resolveNew({ records: [{ id: 'def456' }] });
  await current;
  assert.equal(oldSignal.aborted, true);
  assert.equal(newSignal.aborted, true);
  assert.equal(registry.isMilitaryIcao('abc123'), false);
  assert.equal(registry.isMilitaryIcao('def456'), false);
  registry.dispose();
});

test('a failed classification source preserves known identities and makes no fallback request', async () => {
  let time = 120000;
  let calls = 0;
  const registry = createMilitaryRegistry({
    now: () => time,
    source: {
      async getSnapshot() {
        calls++;
        throw new Error('fixture source unavailable');
      },
    },
  });
  registry.registerMilitaryIcaos(['abc123']);
  time += 60000;
  await assert.doesNotReject(registry.refreshMilitaryRegistryIfStale());
  assert.equal(calls, 1);
  assert.equal(registry.isMilitaryIcao('abc123'), true);
  registry.dispose();
  assert.equal(registry.isMilitaryIcao('abc123'), false);
});

test('disposing a registry fed directly by its layer also clears classification', () => {
  const registry = createMilitaryRegistry();
  registry.registerMilitaryIcaos(['abc123']);
  registry.dispose();
  assert.equal(registry.isMilitaryIcao('abc123'), false);
});

test('classification prefers an explicit identity capability over positioned observations', async () => {
  const registry = createMilitaryRegistry({
    source: {
      getSnapshot() {
        assert.fail(
          'position snapshots must not replace an available identity capability',
        );
      },
      async getIdentities() {
        return ['abc123'];
      },
    },
  });
  await registry.refreshMilitaryRegistryIfStale();
  assert.equal(registry.isMilitaryIcao('abc123'), true);
  registry.dispose();
});

test('past the cap the registry forgets the least recently seen hexes, and lookups still work', () => {
  let time = 1_000_000;
  const registry = createMilitaryRegistry({ now: () => time });
  const hexes = Array.from(
    { length: MILITARY_REGISTRY_MAX_ENTRIES + 10 },
    (_, i) => `ae${i.toString(16).padStart(4, '0')}`,
  );
  const known = () =>
    hexes.filter((hex) => registry.isMilitaryIcao(hex)).length;
  registry.registerMilitaryIcaos(hexes.slice(0, MILITARY_REGISTRY_MAX_ENTRIES));
  assert.equal(known(), MILITARY_REGISTRY_MAX_ENTRIES);

  // The next poll lists the first hex again and ten new ones.
  time += 30_000;
  registry.registerMilitaryIcaos([
    hexes[0],
    ...hexes.slice(MILITARY_REGISTRY_MAX_ENTRIES),
  ]);

  assert.equal(known(), MILITARY_REGISTRY_MAX_ENTRIES);
  assert.equal(
    registry.isMilitaryIcao(hexes[0]),
    true,
    'listed again, so it is recent',
  );
  for (let i = 1; i <= 10; i++) {
    assert.equal(
      registry.isMilitaryIcao(hexes[i]),
      false,
      `${hexes[i]} was among the least recently seen`,
    );
  }
  assert.equal(registry.isMilitaryIcao(hexes[11]), true);
  assert.equal(registry.isMilitaryIcao(hexes.at(-1)), true);
  assert.equal(
    registry.isMilitaryIcao(hexes.at(-1).toUpperCase()),
    true,
    'lookups ignore case',
  );
  registry.dispose();
});

test('a hex no poll has listed for the TTL is forgotten; a short dropout is not', () => {
  const t0 = 1_000_000;
  let time = t0;
  const registry = createMilitaryRegistry({ now: () => time });
  registry.registerMilitaryIcaos(['AE1234', ' ae5678 ', '', null]);
  assert.equal(registry.isMilitaryIcao('ae1234'), true);
  assert.equal(registry.isMilitaryIcao(''), false, 'blank entries are skipped');

  // One poll without AE1234 keeps it military.
  time = t0 + 60_000;
  registry.registerMilitaryIcaos(['ae5678']);
  assert.equal(registry.isMilitaryIcao('ae1234'), true);

  // Unlisted for longer than the TTL, it drops out; ae5678 was listed since.
  time = t0 + MILITARY_REGISTRY_TTL_MS + 1;
  registry.registerMilitaryIcaos(['ae5678']);
  assert.equal(registry.isMilitaryIcao('ae1234'), false);
  assert.equal(registry.isMilitaryIcao('AE5678'), true);

  // An empty poll still prunes.
  time = t0 + 60_000 + 2 * MILITARY_REGISTRY_TTL_MS;
  registry.registerMilitaryIcaos([]);
  assert.equal(registry.isMilitaryIcao('ae5678'), false);
  registry.dispose();
});
