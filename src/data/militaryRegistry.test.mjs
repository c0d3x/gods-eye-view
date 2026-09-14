/**
 * Military-registry active-transition tests (pre-ship audit M2).
 *
 * Locks the setMilitaryLayerActive contract the flights layer's immediate
 * suppression/restore sweep depends on: listeners fire only on TRANSITIONS
 * (never on same-value sets), after the new state is committed, and a broken
 * listener can't break the toggle.
 *
 * Also locks the registry's bounds: a hex unseen for the TTL is forgotten,
 * and past the cap the least recently seen go first.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  _militaryRegistrySizeForTest,
  _resetMilitaryRegistryForTest,
  isMilitaryIcao,
  isMilitaryLayerActive,
  MILITARY_REGISTRY_MAX_ENTRIES,
  MILITARY_REGISTRY_TTL_MS,
  onMilitaryLayerActiveChange,
  registerMilitaryIcaos,
  setMilitaryLayerActive,
} from './militaryRegistry.js';

test('active-change listener fires on transitions only, with committed state', () => {
  const seen = [];
  const unsub = onMilitaryLayerActiveChange((active) => {
    seen.push({ active, committed: isMilitaryLayerActive() });
  });
  try {
    setMilitaryLayerActive(false); // same value (initial false) → no fire
    assert.equal(seen.length, 0);

    setMilitaryLayerActive(true); // transition → fire, state already committed
    assert.deepEqual(seen, [{ active: true, committed: true }]);

    setMilitaryLayerActive(true); // same value → no fire
    assert.equal(seen.length, 1);

    setMilitaryLayerActive(false); // transition back → fire
    assert.deepEqual(seen[1], { active: false, committed: false });
    assert.equal(seen.length, 2);
  } finally {
    unsub();
    setMilitaryLayerActive(false);
  }
});

test('unsubscribe stops delivery; throwing listeners never break the toggle', () => {
  let calls = 0;
  const unsubBroken = onMilitaryLayerActiveChange(() => {
    throw new Error('boom');
  });
  const unsubCounter = onMilitaryLayerActiveChange(() => {
    calls++;
  });
  try {
    setMilitaryLayerActive(true); // broken listener swallowed, counter still runs
    assert.equal(calls, 1);
    assert.equal(isMilitaryLayerActive(), true);

    unsubCounter();
    setMilitaryLayerActive(false);
    assert.equal(calls, 1); // unsubscribed → no more deliveries
  } finally {
    unsubBroken();
    unsubCounter();
    setMilitaryLayerActive(false);
  }
});

test('onMilitaryLayerActiveChange tolerates non-function listeners', () => {
  const unsub = onMilitaryLayerActiveChange(null);
  assert.equal(typeof unsub, 'function');
  unsub(); // no-op, must not throw
  setMilitaryLayerActive(true);
  assert.equal(isMilitaryLayerActive(), true);
  setMilitaryLayerActive(false);
});

test('past the cap the registry forgets the least recently seen hexes, and lookups still work', () => {
  _resetMilitaryRegistryForTest();
  const t0 = Date.now();
  const hexes = Array.from(
    { length: MILITARY_REGISTRY_MAX_ENTRIES + 10 },
    (_, i) => `ae${i.toString(16).padStart(4, '0')}`,
  );
  registerMilitaryIcaos(hexes.slice(0, MILITARY_REGISTRY_MAX_ENTRIES), t0);
  assert.equal(_militaryRegistrySizeForTest(), MILITARY_REGISTRY_MAX_ENTRIES);

  // The next poll lists the first hex again and ten new ones.
  registerMilitaryIcaos(
    [hexes[0], ...hexes.slice(MILITARY_REGISTRY_MAX_ENTRIES)],
    t0 + 30_000,
  );

  assert.equal(_militaryRegistrySizeForTest(), MILITARY_REGISTRY_MAX_ENTRIES);
  assert.equal(isMilitaryIcao(hexes[0]), true, 'listed again, so it is recent');
  for (let i = 1; i <= 10; i++) {
    assert.equal(
      isMilitaryIcao(hexes[i]),
      false,
      `${hexes[i]} was among the least recently seen`,
    );
  }
  assert.equal(isMilitaryIcao(hexes[11]), true);
  assert.equal(isMilitaryIcao(hexes.at(-1)), true);
  assert.equal(
    isMilitaryIcao(hexes.at(-1).toUpperCase()),
    true,
    'lookups ignore case',
  );
  _resetMilitaryRegistryForTest();
});

test('a hex no poll has listed for the TTL is forgotten; a short dropout is not', () => {
  _resetMilitaryRegistryForTest();
  const t0 = Date.now();
  registerMilitaryIcaos(['AE1234', ' ae5678 ', '', null], t0);
  assert.equal(_militaryRegistrySizeForTest(), 2, 'blank entries are skipped');

  // One poll without AE1234 keeps it military.
  registerMilitaryIcaos(['ae5678'], t0 + 60_000);
  assert.equal(isMilitaryIcao('ae1234'), true);

  // Unlisted for longer than the TTL, it drops out; ae5678 was listed since.
  registerMilitaryIcaos(['ae5678'], t0 + MILITARY_REGISTRY_TTL_MS + 1);
  assert.equal(isMilitaryIcao('ae1234'), false);
  assert.equal(isMilitaryIcao('AE5678'), true);
  assert.equal(_militaryRegistrySizeForTest(), 1);

  // An empty poll still prunes.
  registerMilitaryIcaos([], t0 + 60_000 + 2 * MILITARY_REGISTRY_TTL_MS);
  assert.equal(_militaryRegistrySizeForTest(), 0);
  _resetMilitaryRegistryForTest();
});
