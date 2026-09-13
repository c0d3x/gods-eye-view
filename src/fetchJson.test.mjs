import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fetchChecked, fetchJson } from './fetchJson.js';

/** A fetch that never answers; it rejects only when its signal aborts. */
function hangingFetch(t) {
  return t.mock.method(
    globalThis,
    'fetch',
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => reject(init.signal.reason),
          { once: true },
        );
      }),
  );
}

test('fetchJson parses an ok response and passes fetch options on', async (t) => {
  const upstream = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ ok: true }),
  );
  assert.deepEqual(await fetchJson('/api/example', { cache: 'no-store' }), {
    ok: true,
  });
  const [, init] = upstream.mock.calls[0].arguments;
  assert.equal(init.cache, 'no-store');
  assert.ok(init.signal instanceof AbortSignal, 'every call has a deadline');
});

test('a non-2xx status rejects with the status', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('down', { status: 503 }),
  );
  await assert.rejects(fetchJson('/api/example'), {
    message: 'HTTP 503',
    status: 503,
  });
});

test('the deadline rejects a call that never answers', async (t) => {
  hangingFetch(t);
  await assert.rejects(fetchChecked('/api/example', { timeoutMs: 20 }), {
    name: 'TimeoutError',
  });
});

test("the caller's signal still cancels the call", async (t) => {
  hangingFetch(t);
  const controller = new AbortController();
  const pending = fetchJson('/api/example', { signal: controller.signal });
  controller.abort(new Error('left the page'));
  await assert.rejects(pending, /left the page/);
});

/** The source text of a call's arguments, from just after its "(". */
function callArguments(text, start) {
  let depth = 1;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'" || char === '"' || char === '`') {
      index = closingQuote(text, index);
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index);
    }
  }
  throw new Error('unbalanced call');
}

function closingQuote(text, open) {
  for (let index = open + 1; index < text.length; index += 1) {
    if (text[index] === '\\') index += 1;
    else if (text[index] === text[open]) return index;
  }
  throw new Error('unterminated string');
}

const CLIENT_FILES = [
  'locations.js',
  'data/cctv.js',
  'data/flights.js',
  'data/radio.js',
  'data/rocketLaunches.js',
  'data/traffic.js',
  'voice/gevRealtime.js',
];

test('client fetch calls have a deadline, or say why not', () => {
  const bare = [];
  for (const file of CLIENT_FILES) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/(?<![\w.])fetch\(/g)) {
      const lineStart = source.lastIndexOf('\n', match.index) + 1;
      const line = source.slice(lineStart, source.indexOf('\n', match.index));
      // Skip mentions of fetch() in comments.
      if (/^\s*(\/\*|\*|\/\/)/.test(line)) continue;
      const args = callArguments(source, match.index + 'fetch('.length);
      if (/\bsignal\b/.test(args)) continue;
      const above = source.slice(0, lineStart).split('\n').slice(-4).join('\n');
      if (/\/\/ Not fetchJson:/.test(above)) continue;
      bare.push(`${file}:${source.slice(0, match.index).split('\n').length}`);
    }
  }
  assert.deepEqual(bare, [], 'use fetchJson, pass a signal, or say why not');
});
