import assert from 'node:assert/strict';
import test from 'node:test';
import { requiredFiniteQueryNumber } from './queryParams.mjs';

test('a finite number parses; missing, blank and other values are null', () => {
  const params = new URLSearchParams(
    'lat=12.5&zero=0&blank=%20&word=abc&inf=Infinity',
  );
  assert.equal(requiredFiniteQueryNumber(params, 'lat'), 12.5);
  assert.equal(requiredFiniteQueryNumber(params, 'zero'), 0);
  assert.equal(requiredFiniteQueryNumber(params, 'missing'), null);
  assert.equal(requiredFiniteQueryNumber(params, 'blank'), null);
  assert.equal(requiredFiniteQueryNumber(params, 'word'), null);
  assert.equal(requiredFiniteQueryNumber(params, 'inf'), null);
});
