import assert from 'node:assert/strict';
import test from 'node:test';
import {
  looseIndexOf,
  looseSourcePattern,
  memberSource,
} from './uiSources.mjs';

// A member whose signature Biome wrapped, as it appears in the panel modules.
const SOURCE = `export class Panel {
  _stampNavigation({
    cancelPendingSelection = true,
    clearSearchedLocation = true,
  } = {}) {
    if (clearSearchedLocation) this.clearSearchedLocation();
    if (cancelPendingSelection) {
      this._cancelPendingSelection();
    }
  }

  setOrbit(enabled) {
    this._orbit = enabled;
  }
}
`;
const STAMP =
  '  _stampNavigation({ cancelPendingSelection = true, clearSearchedLocation = true } = {}) {';

test('looseSourcePattern matches a signature on one line and wrapped', () => {
  const pattern = new RegExp(looseSourcePattern(STAMP.trim()));
  assert.match(SOURCE, pattern);
  assert.match(STAMP, pattern);
  assert.doesNotMatch(
    '_stampNavigation({ cancelPendingSelection = false } = {}) {',
    pattern,
  );
});

test('looseSourcePattern escapes regex syntax', () => {
  const pattern = new RegExp(looseSourcePattern('a.b * c? | d$ / e+'));
  assert.match('a.b * c? | d$ / e+', pattern);
  assert.doesNotMatch('aXb * c? | d$ / e+', pattern);
});

test('looseIndexOf finds wrapped text at its exact indentation', () => {
  const stamp = looseIndexOf(SOURCE, STAMP);
  assert.equal(stamp, SOURCE.indexOf('  _stampNavigation('));
  assert.equal(looseIndexOf(SOURCE, `  ${STAMP}`), -1);
  assert.equal(
    looseIndexOf(SOURCE, '  setOrbit(enabled) {', stamp + 1),
    SOURCE.indexOf('  setOrbit('),
  );
  assert.equal(looseIndexOf(SOURCE, '  _stampNavigation(', stamp + 1), -1);
});

test('memberSource returns a member through its own closing brace', () => {
  const stamp = memberSource(SOURCE, STAMP);
  assert.ok(stamp.startsWith('  _stampNavigation({\n'));
  assert.ok(
    stamp.endsWith('      this._cancelPendingSelection();\n    }\n  }'),
  );
  assert.doesNotMatch(stamp, /setOrbit/);
  assert.equal(
    memberSource(SOURCE, '  setOrbit(enabled) {'),
    '  setOrbit(enabled) {\n    this._orbit = enabled;\n  }',
  );
});

test('memberSource returns an empty string for a missing member', () => {
  assert.equal(memberSource(SOURCE, '  setOrbit(enabled, animate) {'), '');
  assert.equal(memberSource(SOURCE, '    setOrbit(enabled) {'), '');
});
