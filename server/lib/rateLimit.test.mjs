import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_GOOGLE_REQUESTS_PER_MINUTE,
  DEFAULT_OPENAI_REQUESTS_PER_MINUTE,
  resolveRateLimit,
} from './rateLimit.mjs';

test('the defaults are 30 OpenAI and 120 Google requests a minute', () => {
  assert.equal(DEFAULT_OPENAI_REQUESTS_PER_MINUTE, 30);
  assert.equal(DEFAULT_GOOGLE_REQUESTS_PER_MINUTE, 120);
});

test('unset or blank values use the default', () => {
  for (const value of [undefined, null, '', '   ']) {
    assert.deepEqual(resolveRateLimit(value, 30), {
      perMinute: 30,
      status: 'default',
    });
  }
});

test('a number of at least 1 sets the limit', () => {
  assert.deepEqual(resolveRateLimit('45', 30), {
    perMinute: 45,
    status: 'configured',
  });
  assert.deepEqual(resolveRateLimit(' 45 ', 30), {
    perMinute: 45,
    status: 'configured',
  });
  assert.deepEqual(resolveRateLimit('45.9', 30), {
    perMinute: 45,
    status: 'configured',
  });
  assert.deepEqual(resolveRateLimit('1', 30), {
    perMinute: 1,
    status: 'configured',
  });
});

test('0 and off turn the limit off', () => {
  for (const value of [
    '0',
    '0.0',
    'off',
    'OFF',
    'false',
    'no',
    'none',
    'unlimited',
  ]) {
    assert.deepEqual(
      resolveRateLimit(value, 30),
      { perMinute: null, status: 'disabled' },
      value,
    );
  }
});

test('anything else keeps the default instead of removing the limit', () => {
  for (const value of ['abc', '-5', '0.5', 'Infinity', 'NaN', '10/min']) {
    assert.deepEqual(
      resolveRateLimit(value, 120),
      { perMinute: 120, status: 'invalid' },
      value,
    );
  }
});
