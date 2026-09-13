import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { readBodyWithin } from './requestBody.mjs';

function requestFrom(chunks, headers = {}) {
  const req = Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
  req.headers = headers;
  return req;
}

test('reads a body within the cap', async () => {
  assert.deepEqual(await readBodyWithin(requestFrom(['{"a":', '1}']), 16), {
    ok: true,
    text: '{"a":1}',
  });
  assert.deepEqual(await readBodyWithin(requestFrom([]), 16), {
    ok: true,
    text: '',
  });
});

test('a declared length over the cap is refused up front', async () => {
  const req = requestFrom(['x'.repeat(17)], { 'content-length': '17' });
  assert.deepEqual(await readBodyWithin(req, 16), {
    ok: false,
    tooLarge: true,
  });
});

test('a streamed body over the cap is refused and the rest discarded', async () => {
  const req = requestFrom(['0123456789', '0123456789', 'more']);
  assert.deepEqual(await readBodyWithin(req, 16), {
    ok: false,
    tooLarge: true,
  });
  // The remainder is drained rather than left waiting on the socket.
  if (!req.readableEnded) await once(req, 'end');
  assert.equal(req.readableEnded, true);
});

test('a stream error rejects', async () => {
  const req = new Readable({
    read() {
      this.destroy(new Error('connection reset'));
    },
  });
  req.headers = {};
  await assert.rejects(readBodyWithin(req, 16), /connection reset/);
});
