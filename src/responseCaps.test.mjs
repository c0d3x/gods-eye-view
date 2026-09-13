import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { readResponseBytesCapped } from '../vite.config.js';

test('a byte read within the cap returns the whole body', async () => {
  const bytes = await readResponseBytesCapped(
    new Response(Uint8Array.from([1, 2, 3])),
    3,
  );
  assert.deepEqual(bytes, Buffer.from([1, 2, 3]));
});

test('a body declared or streamed past the cap is refused', async () => {
  const declared = new Response('x', { headers: { 'Content-Length': '99' } });
  await assert.rejects(readResponseBytesCapped(declared, 10), {
    code: 'RESPONSE_TOO_LARGE',
  });
  const streamed = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(4));
        controller.enqueue(new Uint8Array(4));
        controller.close();
      },
    }),
  );
  await assert.rejects(readResponseBytesCapped(streamed, 6), {
    code: 'RESPONSE_TOO_LARGE',
  });
});

test('vite.config.js reads every upstream body through a capped reader', () => {
  const source = readFileSync(
    new URL('../vite.config.js', import.meta.url),
    'utf8',
  );
  // The capped readers' own fallbacks for bodies that can't be streamed;
  // each checks the size right after reading.
  const fallbacks = new Set([
    'const text = await response.text();',
    'const text = await upstream.text();',
    'const bytes = Buffer.from(await response.arrayBuffer());',
  ]);
  const uncapped = source
    .split('\n')
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => !/^(\/\/|\*)/.test(line))
    .filter(({ line }) => /\.(text|json|arrayBuffer)\(\)/.test(line))
    .filter(({ line }) => !fallbacks.has(line))
    .map(({ line, number }) => `vite.config.js:${number}: ${line}`);
  assert.deepEqual(uncapped, []);
});
