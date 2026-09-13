import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { QA_DEFAULT_URL, qaUrl } from '../../scripts/lib/qaUrl.mjs';

const SCRIPTS = new URL('../../scripts/', import.meta.url);

function harnesses() {
  return readdirSync(SCRIPTS).filter(
    (name) => /^qa-.*\.mjs$/.test(name) || name === 'track-regression.mjs',
  );
}

test('the QA harnesses find the app at GEV_QA_URL, or the dev server default', () => {
  assert.equal(qaUrl({}), QA_DEFAULT_URL);
  assert.equal(qaUrl({ GEV_QA_URL: '' }), QA_DEFAULT_URL);
  assert.equal(
    qaUrl({ GEV_QA_URL: 'http://127.0.0.1:4300/' }),
    'http://127.0.0.1:4300',
  );
});

test('no QA harness hard-codes a port or reads the old QA_BASE_URL', () => {
  const names = harnesses();
  assert.ok(names.length > 30, 'the harnesses are found');
  for (const name of names) {
    const text = readFileSync(new URL(name, SCRIPTS), 'utf8');
    assert.doesNotMatch(
      text,
      /(?:localhost|127\.0\.0\.1):\d+/,
      `${name} names a port`,
    );
    assert.doesNotMatch(text, /QA_BASE_URL/, `${name} reads QA_BASE_URL`);
  }
});

test('every harness that opens the app takes its URL from qaUrl()', () => {
  for (const name of harnesses()) {
    const text = readFileSync(new URL(name, SCRIPTS), 'utf8');
    if (!text.includes('page.goto(')) continue;
    assert.match(
      text,
      /import \{ qaUrl \} from '\.\/lib\/qaUrl\.mjs';/,
      `${name} imports qaUrl`,
    );
  }
});
