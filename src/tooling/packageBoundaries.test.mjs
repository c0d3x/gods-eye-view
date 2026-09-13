import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkPackageBoundaries,
  checkServerBoundary,
} from '../../scripts/check-package-boundaries.mjs';

async function fixture(
  t,
  entry = 'export const value = 1;',
  extraExports = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'gev-boundaries-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'scripts'));
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'boundary-fixture',
      type: 'module',
      exports: { './feature': './entry.js', ...extraExports },
    }),
  );
  await writeFile(
    path.join(root, 'scripts/package-boundaries.json'),
    JSON.stringify({
      feature: { exports: ['./feature'], modules: ['entry.js'], external: [] },
    }),
  );
  await writeFile(path.join(root, 'entry.js'), entry);
  return root;
}

test('a declared browser export builds without running app setup', async (t) => {
  const root = await fixture(t);
  await writeFile(
    path.join(root, 'vite.config.js'),
    "throw new Error('must not load app config');",
  );
  assert.deepEqual(await checkPackageBoundaries(root), [
    { name: 'feature', exports: 1, modules: 1 },
  ]);
});

test('an unclassified package export fails the boundary gate', async (t) => {
  const root = await fixture(t, undefined, { './another': './another.js' });
  await assert.rejects(
    checkPackageBoundaries(root),
    /exactly one boundary group/,
  );
});

test('even an unused import of application code violates ownership', async (t) => {
  const root = await fixture(
    t,
    "import { app } from './startup.js'; export const value = 1;",
  );
  await writeFile(path.join(root, 'startup.js'), 'export const app = 2;');
  await assert.rejects(checkPackageBoundaries(root), /unowned module.*startup/);
});

test('Node builtins cannot enter a browser export', async (t) => {
  const root = await fixture(
    t,
    "import fs from 'node:fs'; export const value = fs;",
  );
  await assert.rejects(checkPackageBoundaries(root), /unowned module|browser/);
});

test('dynamic imports obey the same component ownership rule', async (t) => {
  const root = await fixture(
    t,
    "export const load = () => import('./startup.js');",
  );
  await writeFile(path.join(root, 'startup.js'), 'export const app = 2;');
  await assert.rejects(checkPackageBoundaries(root), /unowned module.*startup/);
});

async function browserFixture(t, app) {
  const root = await mkdtemp(path.join(tmpdir(), 'gev-server-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'));
  await mkdir(path.join(root, 'server'));
  await writeFile(path.join(root, 'src/main.js'), "import './app.js';");
  await writeFile(path.join(root, 'src/app.js'), app);
  await writeFile(path.join(root, 'src/shared.js'), 'export const shared = 1;');
  await writeFile(
    path.join(root, 'server/secret.mjs'),
    "import { shared } from '../src/shared.js'; export const secret = shared;",
  );
  return root;
}

test('browser code shares modules with the server without importing it', async (t) => {
  const root = await browserFixture(
    t,
    "import { shared } from './shared.js'; export default shared;",
  );
  const report = await checkServerBoundary(root);
  assert.equal(report.name, 'browser');
  assert.ok(report.modules >= 3, `${report.modules} modules`);
});

test('the server boundary fails when browser code imports server/', async (t) => {
  const root = await browserFixture(
    t,
    "import { secret } from '../server/secret.mjs'; export default secret;",
  );
  await assert.rejects(
    checkServerBoundary(root),
    /Browser code imports from server\/: src\/app\.js → server\/secret\.mjs/,
  );
});

test('a dynamic import of server/ fails the same way', async (t) => {
  const root = await browserFixture(
    t,
    "export const load = () => import('../server/secret.mjs');",
  );
  await assert.rejects(
    checkServerBoundary(root),
    /src\/app\.js → server\/secret\.mjs/,
  );
});

test("the app's browser code never imports server/", async () => {
  const report = await checkServerBoundary(
    fileURLToPath(new URL('../../', import.meta.url)),
  );
  assert.ok(report.modules > 100, `the check walked ${report.modules} modules`);
});
