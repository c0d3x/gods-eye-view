/**
 * Panel-position storage migration: positions saved under any older
 * `godsEyeView.v<N>.panelPos.*` version trigger the layout-reset notice once
 * and are then deleted, without touching current or unrelated keys.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  retireSupersededPanelPositions,
  takePanelLayoutResetNotice,
} from './panelLayoutStorage.js';
import { readUiSource } from './testing/uiSources.mjs';

/** A Map-backed stand-in for the Web Storage API. */
function memoryStorage(entries = {}) {
  const items = new Map(Object.entries(entries));
  return {
    get length() {
      return items.size;
    },
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => {
      items.set(key, String(value));
    },
    removeItem: (key) => {
      items.delete(key);
    },
    sortedKeys: () => [...items.keys()].sort(),
  };
}

/** Keys a current (v8) install keeps: positions, collapsed states, others. */
const CURRENT = {
  'godsEyeView.v8.panelPos.control-panel': '{"left":10,"top":20}',
  'godsEyeView.v6.panelCollapsed.control-panel': 'true',
  'gev:detection-allocation:v1': '{}',
};
const MARKER = 'godsEyeView.v8.layoutResetNotified';
const keptAfterMigration = [...Object.keys(CURRENT), MARKER].sort();

test('v6 positions trigger the notice once, then are deleted', () => {
  const storage = memoryStorage({
    ...CURRENT,
    'godsEyeView.v6.panelPos.control-panel': '{}',
    'godsEyeView.v6.panelPos.location-bar': '{}',
  });
  assert.equal(takePanelLayoutResetNotice(storage, 'v8'), true);
  assert.deepEqual(storage.sortedKeys(), keptAfterMigration);
  assert.equal(takePanelLayoutResetNotice(storage, 'v8'), false);
});

test('v7 positions trigger the notice too', () => {
  const storage = memoryStorage({
    ...CURRENT,
    'godsEyeView.v7.panelPos.location-bar': '{}',
    'godsEyeView.v7.layoutResetNotified': '1',
  });
  assert.equal(takePanelLayoutResetNotice(storage, 'v8'), true);
  assert.deepEqual(storage.sortedKeys(), keptAfterMigration);
});

test('a first run or an up-to-date layout shows no notice', () => {
  const fresh = memoryStorage();
  assert.equal(takePanelLayoutResetNotice(fresh, 'v8'), false);
  assert.deepEqual(fresh.sortedKeys(), [MARKER]);

  const current = memoryStorage(CURRENT);
  assert.equal(takePanelLayoutResetNotice(current, 'v8'), false);
  assert.deepEqual(current.sortedKeys(), keptAfterMigration);
});

test('keys left behind after an earlier notice are still deleted, silently', () => {
  // Earlier builds set the v8 marker but only looked for v6 positions, so
  // v7 positions, and every older key, stayed behind.
  const storage = memoryStorage({
    ...CURRENT,
    [MARKER]: '1',
    'godsEyeView.v7.layoutResetNotified': '1',
    'godsEyeView.v7.panelPos.hud': '{}',
    'godsEyeView.v6.panelPos.hud': '{}',
  });
  assert.equal(takePanelLayoutResetNotice(storage, 'v8'), false);
  assert.deepEqual(storage.sortedKeys(), keptAfterMigration);
});

test('only older versions are superseded, compared as numbers', () => {
  const entries = {
    'godsEyeView.v8.panelPos.hud': '{}',
    'godsEyeView.v9.panelPos.hud': '{}',
    'godsEyeView.v10.panelPos.hud': '{}',
    'godsEyeView.v6.panelCollapsed.hud': 'false',
    'godsEyeView.v7.someOtherSetting': 'x',
    'otherApp.v1.panelPos.hud': '{}',
  };
  const storage = memoryStorage(entries);
  assert.deepEqual(retireSupersededPanelPositions(storage, 'v8'), {
    hadOldPositions: false,
    removed: [],
  });
  assert.deepEqual(storage.sortedKeys(), Object.keys(entries).sort());

  const older = memoryStorage({ 'godsEyeView.v9.panelPos.hud': '{}' });
  assert.deepEqual(retireSupersededPanelPositions(older, 'v10'), {
    hadOldPositions: true,
    removed: ['godsEyeView.v9.panelPos.hud'],
  });
});

test('a malformed version is refused instead of deleting every position', () => {
  const storage = memoryStorage(CURRENT);
  assert.throws(
    () => retireSupersededPanelPositions(storage, '8'),
    /Bad panel position version/,
  );
  assert.throws(() => takePanelLayoutResetNotice(storage, undefined));
  assert.deepEqual(storage.sortedKeys(), Object.keys(CURRENT).sort());
});

test('the UI saves positions in the format this module retires, and shows the notice', async () => {
  const source = readUiSource();
  assert.match(source, /const PANEL_POSITION_STORAGE_VERSION = 'v\d+';/);
  assert.match(
    source,
    /`godsEyeView\.\$\{PANEL_POSITION_STORAGE_VERSION\}\.panelPos\.\$\{panelId\}`/,
  );
  assert.match(
    source,
    /import \{ takePanelLayoutResetNotice \} from '(?:\.\.?\/)+panelLayoutStorage\.js';/,
  );
  const start = source.indexOf('  _maybeNotifyLayoutReset() {');
  assert.notEqual(start, -1, '_maybeNotifyLayoutReset is defined');
  const body = source.slice(start, source.indexOf('\n  }\n', start));
  assert.match(
    body,
    /takePanelLayoutResetNotice\(localStorage, PANEL_POSITION_STORAGE_VERSION\)/,
  );
  assert.match(body, /this\s*\._showToast\(\s*'Panel\s*layout\s*updated/);
});
