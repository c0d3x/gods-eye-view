import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveGoogleServerKey } from './googleServerKey.mjs';

test('the server key wins over the browser key', () => {
  assert.equal(
    resolveGoogleServerKey({
      GOOGLE_MAPS_SERVER_API_KEY: ' server ',
      GOOGLE_MAPS_API_KEY: 'browser',
    }),
    'server',
  );
});

test('without a server key, the browser key serves the server calls', () => {
  assert.equal(
    resolveGoogleServerKey({ GOOGLE_MAPS_API_KEY: 'browser' }),
    'browser',
  );
  assert.equal(
    resolveGoogleServerKey({
      GOOGLE_MAPS_SERVER_API_KEY: '   ',
      GOOGLE_MAPS_API_KEY: 'browser',
    }),
    'browser',
  );
  assert.equal(resolveGoogleServerKey({}), '');
});

test('the environment overrides each default key on its own', () => {
  const defaults = {
    GOOGLE_MAPS_SERVER_API_KEY: 'dotenv-server',
    GOOGLE_MAPS_API_KEY: 'dotenv-browser',
  };
  assert.equal(resolveGoogleServerKey({}, defaults), 'dotenv-server');
  assert.equal(
    resolveGoogleServerKey(
      { GOOGLE_MAPS_SERVER_API_KEY: 'env-server' },
      defaults,
    ),
    'env-server',
  );
  assert.equal(
    resolveGoogleServerKey(
      { GOOGLE_MAPS_API_KEY: 'env-browser' },
      { GOOGLE_MAPS_API_KEY: 'dotenv-browser' },
    ),
    'env-browser',
  );
});
