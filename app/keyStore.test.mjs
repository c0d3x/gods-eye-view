import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyStoredKeys,
  createKeyStore,
  KEY_STORE_NAME,
} from './keyStore.mjs';

/** A reversible stand-in for safeStorage, so tests can see what was written. */
const fakeCipher = {
  encrypt: (/** @type {string} */ text) =>
    Buffer.from(`enc:${Buffer.from(text).toString('base64')}`),
  decrypt: (/** @type {Buffer} */ data) => {
    const text = data.toString();
    assert.ok(text.startsWith('enc:'), 'only encrypted data is read back');
    return Buffer.from(text.slice(4), 'base64').toString();
  },
};

/** @param {import('node:test').TestContext} t */
function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-key-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nested', 'provider-keys.enc');
  return { file, store: createKeyStore({ file, ...fakeCipher }) };
}

test('an empty store reads as no keys', (t) => {
  const { store } = tempStore(t);
  assert.equal(store.name, KEY_STORE_NAME);
  assert.equal(store.read(), '');
  assert.equal(Object.getPrototypeOf(store.values()), null);
  assert.deepEqual({ ...store.values() }, {});
});

test('saved keys are written encrypted, 0600, and read back', (t) => {
  const { file, store } = tempStore(t);
  store.write('OPENAI_API_KEY=sk-test-123\nTFL_APP_KEY=abc\n');
  const raw = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, /sk-test-123/, 'no key is on disk in plain text');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(
    { ...store.values() },
    {
      OPENAI_API_KEY: 'sk-test-123',
      TFL_APP_KEY: 'abc',
    },
  );
  store.write('OPENAI_API_KEY=\n');
  assert.deepEqual({ ...store.values() }, { OPENAI_API_KEY: '' });
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)),
    ['provider-keys.enc'],
    'no temporary file is left behind',
  );
});

test('a store that cannot be read throws instead of reading as empty', (t) => {
  const { file, store } = tempStore(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'not encrypted');
  assert.throws(() => store.read());
});

test('a failed encryption leaves the previous keys in place', (t) => {
  const { file, store } = tempStore(t);
  store.write('LL2_API_TOKEN=one\n');
  const failing = createKeyStore({
    file,
    encrypt: () => {
      throw new Error('Keychain unavailable');
    },
    decrypt: fakeCipher.decrypt,
  });
  assert.throws(() => failing.write('LL2_API_TOKEN=two\n'), /Keychain/);
  assert.deepEqual({ ...store.values() }, { LL2_API_TOKEN: 'one' });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['provider-keys.enc']);
});

test('stored keys, removed ones included, go into the environment', () => {
  const env = { OPENAI_API_KEY: 'old', PATH: '/usr/bin' };
  applyStoredKeys({ OPENAI_API_KEY: '', LL2_API_TOKEN: 'abc' }, env);
  assert.deepEqual(env, {
    OPENAI_API_KEY: '',
    LL2_API_TOKEN: 'abc',
    PATH: '/usr/bin',
  });
});
