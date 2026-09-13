import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCostRateLimiter,
  createRateLimiter,
  DEFAULT_GOOGLE_REQUESTS_PER_MINUTE,
  DEFAULT_OPENAI_REQUESTS_PER_MINUTE,
  enforceRateLimit,
  RATE_LIMITER_MAX_KEYS,
  rateLimitKey,
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

test('a limiter allows max requests per key in each window', () => {
  let now = 1_000;
  const allow = createRateLimiter({ windowMs: 1_000, max: 2, now: () => now });
  assert.equal(allow('a'), true);
  assert.equal(allow('a'), true);
  assert.equal(allow('a'), false);
  assert.equal(allow('b'), true, 'each key has its own budget');
  now += 1_000;
  assert.equal(allow('a'), true, 'the window moved on');
});

test('the global backstop limits every key together', () => {
  const allow = createRateLimiter({
    windowMs: 1_000,
    max: 5,
    globalMax: 3,
    now: () => 0,
  });
  assert.equal(allow('a'), true);
  assert.equal(allow('b'), true);
  assert.equal(allow('c'), true);
  assert.equal(allow('d'), false);
});

test('a limiter forgets its oldest key past the key cap', () => {
  const allow = createRateLimiter({ windowMs: 60_000, max: 1, now: () => 0 });
  assert.equal(allow('first'), true);
  assert.equal(allow('first'), false);
  for (let i = 0; i < RATE_LIMITER_MAX_KEYS; i += 1) allow(`key-${i}`);
  assert.equal(allow('first'), true, 'the oldest key was dropped');
});

test('the client key is the socket address, never X-Forwarded-For', () => {
  const req = {
    socket: { remoteAddress: '203.0.113.9' },
    headers: { 'x-forwarded-for': '198.51.100.1' },
  };
  assert.equal(rateLimitKey(req), '203.0.113.9');
  assert.equal(rateLimitKey({ headers: {} }), 'local');
});

test('a cost limiter reads its variable, and 0 or off turns it off', () => {
  assert.equal(
    createCostRateLimiter('GEV_TEST_LIMIT', 30, {
      env: { GEV_TEST_LIMIT: 'off' },
    }),
    null,
  );
  const allow = createCostRateLimiter('GEV_TEST_LIMIT', 30, {
    env: { GEV_TEST_LIMIT: '2' },
  });
  assert.equal(allow('a'), true);
  assert.equal(allow('a'), true);
  assert.equal(allow('a'), false);
});

test('an unreadable limit keeps the default and warns once per variable', () => {
  const warnings = [];
  const options = {
    env: { GEV_TEST_TYPO: '10/min' },
    warn: (message) => warnings.push(message),
  };
  const allow = createCostRateLimiter('GEV_TEST_TYPO', 1, options);
  assert.equal(allow('a'), true);
  assert.equal(allow('a'), false, 'the default of 1 per minute applies');
  createCostRateLimiter('GEV_TEST_TYPO', 1, options);
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0],
    /GEV_TEST_TYPO="10\/min" is not a number, 0 or off; using the default of 1 per minute/,
  );
});

test('enforceRateLimit answers 429 with Retry-After once a client is over', () => {
  const allow = createRateLimiter({ windowMs: 60_000, max: 1 });
  const req = { socket: { remoteAddress: '127.0.0.1' } };
  const response = () => ({
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body) {
      this.body = body;
    },
  });
  assert.equal(enforceRateLimit(allow, req, response()), true);
  const refused = response();
  assert.equal(enforceRateLimit(allow, req, refused), false);
  assert.equal(refused.statusCode, 429);
  assert.equal(refused.headers['Retry-After'], '5');
  assert.deepEqual(JSON.parse(refused.body), { error: 'Rate limit exceeded' });
  assert.equal(
    enforceRateLimit(null, req, response()),
    true,
    'a limiter turned off lets every request through',
  );
});
