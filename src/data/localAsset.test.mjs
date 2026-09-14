import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { readLocalAsset, readLocalJson } from './localAsset.js';

test('a file: URL is read from disk, as bytes or as JSON', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gev-local-asset-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'pack.json');
  await writeFile(file, '{"features":[1,2]}');
  const url = pathToFileURL(file);

  assert.deepEqual(
    [...(await readLocalAsset(url)).subarray(0, 2)],
    [0x7b, 0x22],
  );
  assert.deepEqual(await readLocalJson(url), { features: [1, 2] });
});

test('a file: URL resolves without waiting for the event loop', async (t) => {
  // Tests that wait out only microtasks rely on this, as they did when these
  // files were module imports.
  const dir = await mkdtemp(join(tmpdir(), 'gev-local-asset-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'pack.json');
  await writeFile(file, '[1]');
  let result = null;
  readLocalJson(pathToFileURL(file)).then((value) => {
    result = value;
  });
  for (let i = 0; i < 10 && result === null; i += 1) await Promise.resolve();
  assert.deepEqual(result, [1]);
});

test('any other URL is fetched, and a failed response is an error', async (t) => {
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return url.pathname.endsWith('/missing.json')
      ? new Response('not here', { status: 404 })
      : new Response('{"ok":true}');
  });

  assert.deepEqual(
    await readLocalJson(new URL('https://app.test/assets/pack.json')),
    { ok: true },
  );
  await assert.rejects(
    readLocalJson(new URL('https://app.test/assets/missing.json')),
    /\/assets\/missing\.json: HTTP 404/,
  );
  assert.deepEqual(requested, [
    'https://app.test/assets/pack.json',
    'https://app.test/assets/missing.json',
  ]);
});
