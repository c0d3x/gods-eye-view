import assert from 'node:assert/strict';
import test from 'node:test';
import { readCappedResponseText } from '../server/providers/common/http.js';

test('a body without a stream is measured in bytes, not characters', async () => {
  // Six characters, twelve bytes.
  const unstreamed = {
    headers: new Headers(),
    body: null,
    text: async () => 'é'.repeat(6),
  };
  assert.deepEqual(await readCappedResponseText(unstreamed, 10), {
    tooLarge: true,
    text: '',
  });
  assert.deepEqual(await readCappedResponseText(unstreamed, 12), {
    tooLarge: false,
    text: 'é'.repeat(6),
  });
});

test('a streamed body is read whole under the cap and refused past it', async () => {
  assert.deepEqual(await readCappedResponseText(new Response('ok track'), 8), {
    tooLarge: false,
    text: 'ok track',
  });
  let cancelled = false;
  const endless = new Response(
    new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  assert.deepEqual(await readCappedResponseText(endless, 4096), {
    tooLarge: true,
    text: '',
  });
  assert.equal(cancelled, true, 'the read stops at the cap');
});

test('a declared length past the cap is refused before reading', async () => {
  const declared = new Response('small', {
    headers: { 'content-length': String(1024 * 1024) },
  });
  assert.deepEqual(await readCappedResponseText(declared, 1024), {
    tooLarge: true,
    text: '',
  });
});

test('a failure other than size is not mistaken for an oversized body', async () => {
  const broken = new Response(
    new ReadableStream({
      pull(controller) {
        controller.error(new Error('connection reset'));
      },
    }),
  );
  await assert.rejects(
    readCappedResponseText(broken, 1024),
    /connection reset/,
  );
});
