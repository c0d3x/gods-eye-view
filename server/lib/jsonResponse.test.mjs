import assert from 'node:assert/strict';
import test from 'node:test';
import { writeJson } from './jsonResponse.mjs';

function response() {
  return {
    headersSent: false,
    writeHead(status, headers) {
      Object.assign(this, { status, headers, headersSent: true });
    },
    end(body) {
      this.body = body;
    },
  };
}

test('writeJson sends the status, a JSON content type and the body', () => {
  const res = response();
  assert.equal(writeJson(res, 201, { ok: true }), true);
  assert.equal(res.status, 201);
  assert.deepEqual(res.headers, { 'Content-Type': 'application/json' });
  assert.equal(res.body, '{"ok":true}');
});

test('writeJson adds the headers a route passes', () => {
  const res = response();
  writeJson(res, 200, [], { 'Cache-Control': 'no-store', 'X-Cache': 'HIT' });
  assert.deepEqual(res.headers, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Cache': 'HIT',
  });
  assert.equal(res.body, '[]');
});

test('writeJson leaves a response that already went out alone', () => {
  const res = response();
  writeJson(res, 200, { first: true });
  assert.equal(writeJson(res, 500, { second: true }), false);
  assert.equal(res.status, 200);
  assert.equal(res.body, '{"first":true}');
});
