import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readResponseBytesCapped,
  readResponseJsonCapped,
  readResponseTextCapped,
} from './upstreamBody.mjs';

/** A Response-shaped body that streams `chunks`, and records a cancel. */
function streamed(chunks, declared) {
  const encoder = new TextEncoder();
  const state = { cancelled: false };
  const queue = [...chunks];
  const body = new ReadableStream({
    pull(controller) {
      const chunk = queue.shift();
      if (chunk === undefined) controller.close();
      else controller.enqueue(encoder.encode(chunk));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  const headers = new Headers(
    declared === undefined ? {} : { 'content-length': String(declared) },
  );
  return { response: { headers, body }, state };
}

test('a text read within the cap returns the whole body', async () => {
  const { response } = streamed(['hel', 'lo']);
  assert.equal(await readResponseTextCapped(response, 5), 'hello');
});

test('a body declared past the cap is refused before it is read', async () => {
  const { response } = streamed(['x'], 999);
  await assert.rejects(readResponseTextCapped(response, 5), {
    code: 'RESPONSE_TOO_LARGE',
  });
});

test('a body streamed past the cap is refused and its stream cancelled', async () => {
  const { response, state } = streamed(['abc', 'def', 'ghi']);
  await assert.rejects(readResponseTextCapped(response, 5), {
    code: 'RESPONSE_TOO_LARGE',
  });
  assert.equal(state.cancelled, true);
});

test('a body without a stream is measured after it is read', async () => {
  const response = { headers: new Headers(), text: async () => 'hello!' };
  assert.equal(await readResponseTextCapped(response, 6), 'hello!');
  await assert.rejects(readResponseTextCapped(response, 5), {
    code: 'RESPONSE_TOO_LARGE',
  });
});

test('JSON is parsed only after the cap is enforced', async () => {
  assert.deepEqual(
    await readResponseJsonCapped(streamed(['{"a":', '1}']).response, 100),
    { a: 1 },
  );
  await assert.rejects(
    readResponseJsonCapped(streamed(['{"a":1}']).response, 3),
    { code: 'RESPONSE_TOO_LARGE' },
  );
});

test('bytes are read in full within the cap', async () => {
  const bytes = await readResponseBytesCapped(
    streamed(['ab', 'c']).response,
    3,
  );
  assert.equal(bytes.toString(), 'abc');
});
