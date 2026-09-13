import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aisKeyFingerprint } from '../vite.config.js';

test('the AIS key fingerprint moves when the key does, and never carries the key', (t) => {
  const saved = process.env.AISSTREAM_API_KEY;
  t.after(() => {
    if (saved === undefined) delete process.env.AISSTREAM_API_KEY;
    else process.env.AISSTREAM_API_KEY = saved;
  });

  delete process.env.AISSTREAM_API_KEY;
  assert.equal(aisKeyFingerprint(), null);

  process.env.AISSTREAM_API_KEY = 'secret-key-a';
  const first = aisKeyFingerprint();
  assert.match(first, /^key-\d+$/);
  assert.equal(aisKeyFingerprint(), first, 'the same key keeps its name');

  process.env.AISSTREAM_API_KEY = 'secret-key-b';
  const second = aisKeyFingerprint();
  assert.match(second, /^key-\d+$/);
  assert.notEqual(second, first, 'a new key gets a new name');
});
