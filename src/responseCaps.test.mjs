import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { readResponseBytesCapped } from '../server/lib/upstreamBody.mjs';

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

/** The dev server's sources: vite.config.js and the modules under server/. */
function serverSources() {
  const modules = execFileSync('git', ['ls-files', 'server'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  })
    .split('\n')
    .filter((file) => file.endsWith('.mjs') && !file.endsWith('.test.mjs'));
  return ['vite.config.js', ...modules];
}

test('the dev server reads every upstream body through a capped reader', () => {
  // The capped readers' own fallbacks for bodies that can't be streamed; each
  // checks the size right after reading. The last two are not upstream HTTP
  // bodies: an AIS WebSocket frame, which aisFrameByteLength caps first, and
  // the terrain fetch's default reader, which the server replaces with
  // readResponseJsonCapped.
  const allowed = new Set([
    'const text = await response.text();',
    'const bytes = Buffer.from(await response.arrayBuffer());',
    "if (data && typeof data.text === 'function') return data.text();",
    'readJson = (res) => res.json(),',
  ]);
  const uncapped = serverSources().flatMap((file) =>
    readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
      .split('\n')
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(({ line }) => !/^(\/\/|\*)/.test(line))
      .filter(({ line }) => /\.(text|json|arrayBuffer)\(\)/.test(line))
      .filter(({ line }) => !allowed.has(line))
      .map(({ line, number }) => `${file}:${number}: ${line}`),
  );
  assert.deepEqual(uncapped, []);
});
