import assert from 'node:assert/strict';
import test from 'node:test';
import { errorField, errorMessage } from './thrownErrors.mjs';

test('errorMessage reads the message of any Error', () => {
  assert.equal(errorMessage(new Error('boom')), 'boom');
  assert.equal(errorMessage(new TypeError('bad input')), 'bad input');
  assert.equal(errorMessage(new DOMException('slow', 'TimeoutError')), 'slow');
  assert.equal(errorMessage(new Error('')), '');
});

test('errorMessage is undefined for values that are not Errors', () => {
  for (const value of [undefined, null, 'boom', 42, { message: 'plain' }]) {
    assert.equal(errorMessage(value), undefined);
  }
});

test('errorField reads attached and inherited properties of an Error', () => {
  const error = Object.assign(new Error('gone'), {
    code: 'ENOENT',
    retryable: false,
  });
  assert.equal(errorField(error, 'code'), 'ENOENT');
  assert.equal(errorField(error, 'retryable'), false);
  assert.equal(errorField(error, 'missing'), undefined);
  assert.equal(
    errorField(new DOMException('stop', 'AbortError'), 'name'),
    'AbortError',
  );
});

test('errorField is undefined for values that are not Errors', () => {
  for (const value of [undefined, null, 'ENOENT', { code: 'ENOENT' }]) {
    assert.equal(errorField(value, 'code'), undefined);
  }
});
