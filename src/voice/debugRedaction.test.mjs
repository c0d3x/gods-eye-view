import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isSecretLikeKey,
  sanitizeDebugString,
  sanitizeDebugValue,
} from './debugRedaction.js';

test('values under secret-like keys are redacted', () => {
  assert.deepEqual(
    sanitizeDebugValue({
      apiKey: 'a',
      api_key: 'b',
      Authorization: 'c',
      client_secret: { value: 'd' },
      accessToken: 'e',
      password: 'f',
      label: 'kept',
      count: 3,
    }),
    {
      apiKey: '[Redacted]',
      api_key: '[Redacted]',
      Authorization: '[Redacted]',
      client_secret: '[Redacted]',
      accessToken: '[Redacted]',
      password: '[Redacted]',
      label: 'kept',
      count: 3,
    },
  );
  assert.equal(isSecretLikeKey('event'), false);
});

test('credentials inside strings are redacted', () => {
  for (const [input, expected] of [
    [
      'use sk-proj-abcdefghijklmnopqrstuvwxyz0123',
      'use [Redacted OpenAI API key]',
    ],
    ['Authorization: Bearer abc.def-ghi', 'Authorization: [Redacted]'],
    ['Authorization: Basic dXNlcjpwYXNz', 'Authorization: [Redacted]'],
    ['sent Bearer abcdefghijklmnop', 'sent Bearer [Redacted]'],
    ['token ek_abcdefghijklmnopqrstuv', 'token [Redacted ephemeral key]'],
    ['{"client_secret":"shh"}', '{"client_secret":"[Redacted]"}'],
    [
      'key=AIzaSyA1234567890abcdefghijklmnopqrstuv',
      'key=[Redacted Google API key]',
    ],
    [
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXZhbHVl',
      'jwt [Redacted JWT]',
    ],
    [
      'see data:image/jpeg;base64,/9j/4AAQSkZJRg== here',
      'see [Redacted image data URL] here',
    ],
    ['a basic week_summary stays', 'a basic week_summary stays'],
  ]) {
    assert.equal(sanitizeDebugString(input), expected, input);
  }
});

test('image data URLs, long strings and deep nesting are cut down', () => {
  const image = 'data:image/png;base64,AAAA';
  assert.equal(
    sanitizeDebugString(image),
    `[Redacted image data URL, ${image.length} chars]`,
  );
  assert.equal(
    sanitizeDebugString('x'.repeat(50010)),
    `${'x'.repeat(50000)}...[Truncated 10 chars]`,
  );

  let value = 'leaf';
  for (let depth = 0; depth < 12; depth += 1) value = { next: value };
  let node = sanitizeDebugValue(value);
  let levels = 0;
  while (node && typeof node === 'object') {
    node = node.next;
    levels += 1;
  }
  assert.equal(node, '[MaxDepth]');
  assert.equal(levels, 11);
});

test('the input is left untouched and __proto__ keys are dropped', () => {
  const input = {
    token: 'secret',
    nested: { note: 'sk-proj-abcdefghijklmnopqrstuvwxyz0123' },
  };
  const copy = structuredClone(input);
  sanitizeDebugValue(input);
  assert.deepEqual(input, copy);

  const parsed = JSON.parse('{"__proto__":{"polluted":true},"event":"x"}');
  const result = sanitizeDebugValue(parsed);
  assert.deepEqual(result, { event: 'x' });
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
});
