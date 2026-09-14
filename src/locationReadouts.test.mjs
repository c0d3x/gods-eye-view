import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  looseIndexOf,
  memberSource,
  readUiSource,
} from './testing/uiSources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ui = readUiSource();
const director = fs.readFileSync(
  path.join(ROOT, 'src', 'scenes', 'director.js'),
  'utf8',
);

/** Source of the free-text LOCATION search handler (Enter on #location-search). */
function locationSearchHandler() {
  const start = ui.indexOf('searchAndFlyTo(this.viewer, query, {');
  assert.ok(start > 0, 'free-text location search handler is missing');
  const end = ui.indexOf('_beginWorldJumpTransition() {', start);
  assert.ok(end > start, 'could not bound the location search handler');
  return ui.slice(start, end);
}

test('the ACTIVE STYLE indicator is written from the style name and nothing else', () => {
  // A free-text location search used to write the searched CITY into the
  // top-right style slot, so the corner read "ACTIVE STYLE / TOKYO".
  const writes = [...ui.matchAll(/this\._styleIndicator\.textContent\s*=/g)];
  assert.equal(
    writes.length,
    1,
    'the style indicator must have exactly one writer',
  );
  assert.match(
    ui.slice(writes[0].index, writes[0].index + 160),
    /this\s*\._styleIndicator\s*\.textContent\s*=\s*displayNames\[\s*styleName,?\s*\]\s*\|\|\s*styleName\s*\.toUpperCase\(,?\s*\);/,
  );

  const handler = locationSearchHandler();
  assert.doesNotMatch(
    handler,
    /_styleIndicator/,
    'location search must not touch the style indicator',
  );
  assert.doesNotMatch(
    handler,
    /active-style-name/,
    'location search must not touch the style indicator',
  );
});

test('a free-text search records its destination for the LOCATION mini-status', () => {
  const handler = locationSearchHandler();
  // The destination has to be recorded BEFORE _setActiveLocation(null), whose
  // own refresh would otherwise repaint the readout as "Location: --".
  assert.match(
    handler,
    /this\._searchedLocationLabel = destination\.label[\s\S]{0,120}?this\._setActiveLocation\(null\);/,
  );
  assert.match(handler, /this\._updateLocationMiniStatus\(\);/);
});

test('the mini-status reads its copy from the shared formatter', () => {
  assert.match(
    ui,
    /import \{ locationMiniStatus \} from '(?:\.\.?\/)+locationStatus\.js';/,
  );
  const start = ui.indexOf('  _updateLocationMiniStatus() {');
  assert.ok(start > 0, '_updateLocationMiniStatus is missing');
  const body = ui.slice(start, ui.indexOf('\n  }', start));
  assert.match(
    body,
    /locationMiniStatus\(\{[\s\S]*?searchedLabel: this\._searchedLocationLabel,[\s\S]*?\}\)/,
  );
  // No second copy of the placeholder strings to drift out of sync.
  assert.doesNotMatch(body, /Location: --/);
});

test('selecting a preset location clears the superseded search label', () => {
  const start = ui.indexOf('  _setActiveLocation(locationId) {');
  assert.ok(start > 0, '_setActiveLocation is missing');
  const body = ui.slice(start, ui.indexOf('\n  }', start));
  assert.match(body, /if \(locationId\) this\._searchedLocationLabel = null;/);
});

test('any other camera destination clears the search label too', () => {
  // Voice navigation, the globe reset, camera takeover and entity selection
  // all funnel through _stampNavigation; without a clear there, a searched
  // label outlives the place it named.
  const stamp = memberSource(
    ui,
    '  _stampNavigation({ cancelPendingSelection = true, clearSearchedLocation = true } = {}) {',
  );
  assert.ok(stamp, '_stampNavigation is missing');
  assert.match(
    stamp,
    /if \(clearSearchedLocation\) this\.clearSearchedLocation\(\);/,
  );

  // The shared funnel is what the reset and voice seams actually reach.
  for (const seam of [
    'resetToGlobeView() {',
    'beginLocationNavigation() {',
    '_runExplicitNavigation(noun, navigate',
  ]) {
    const at = looseIndexOf(ui, seam);
    assert.ok(at > 0, `missing navigation seam "${seam}"`);
    assert.match(
      ui.slice(at, at + 900),
      /_stampNavigation\(/,
      `"${seam}" must stamp navigation`,
    );
  }

  // Public seam, so a camera owner that flies on its own can invalidate it.
  assert.match(
    ui,
    /\n {2}clearSearchedLocation\(\) \{\n[\s\S]{0,240}?this\._searchedLocationLabel = null;/,
  );
});

test('a deferred lookup that never flies leaves the readout standing', () => {
  // A geocode stamps navigation on the way OUT and resolves later. Clearing at
  // the stamp blanked a still-true readout whenever the lookup failed, was
  // superseded, or was refused — no camera ever moved. The deferred begin opts
  // out; the reassert seam, reached only once the flight is granted, clears.
  const begin = memberSource(
    ui,
    "  _beginDeferredNavigation(noun = 'location', { cancelPendingSelection = true } = {}) {",
  );
  assert.ok(begin, '_beginDeferredNavigation is missing');
  assert.match(
    begin,
    /stamp:\s*\(,?\s*\)\s*=>\s*this\s*\._stampNavigation\(\s*\{\s*cancelPendingSelection,\s*clearSearchedLocation:\s*false,?\s*\},?\s*\)/,
  );

  const reassert = ui.indexOf('  _reassertNavigationHandoff(generation) {');
  assert.ok(reassert > 0, '_reassertNavigationHandoff is missing');
  assert.match(
    ui.slice(reassert, reassert + 900),
    /release: \(\) => \{[\s\S]{0,320}?this\.clearSearchedLocation\(\);[\s\S]{0,200}?this\._releaseFollowCamera\(\)/,
  );

  // …and the policy only reaches `release` after its authority checks pass.
  const policy = fs.readFileSync(
    path.join(ROOT, 'src', 'navigationPolicy.js'),
    'utf8',
  );
  const fn = policy.slice(
    policy.indexOf('export function reassertNavigationHandoff'),
  );
  assert.match(
    fn,
    /if \(disposed \|\| generation !== currentGeneration\) return false;[\s\S]*?release\?\.\(\);/,
  );
});

test('scene playback invalidates the search label on every shot', () => {
  // The director drives viewer.camera itself and never reaches _stampNavigation.
  const start = director.indexOf(
    '  async _flyCamera(cameraState, durationSec, token) {',
  );
  assert.ok(start > 0, 'scene camera flight is missing');
  assert.match(
    director.slice(start, start + 700),
    /this\.styleManager\?\.clearSearchedLocation\?\.\(\);/,
  );
});
