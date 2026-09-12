import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const biome = createRequire(import.meta.url).resolve(
  '@biomejs/biome/bin/biome',
);
const config = JSON.parse(
  await readFile(path.join(root, 'biome.json'), 'utf8'),
);

/** Run the pinned Biome formatter in a directory and return its exit code. */
async function format(cwd, ...args) {
  try {
    await run(process.execPath, [biome, 'format', ...args], { cwd });
    return 0;
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return error.code;
  }
}

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gev-format-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    path.join(dir, 'biome.json'),
    JSON.stringify({
      ...config,
      $schema: undefined,
      files: { includes: ['adopted.js'] },
    }),
  );
  await writeFile(path.join(dir, 'adopted.js'), 'const value="yes"\r\n');
  await writeFile(path.join(dir, 'legacy.js'), 'const untouched="yes"');
  return { dir, read: (name) => readFile(path.join(dir, name), 'utf8') };
}

test('the adopted scope lists unique regular files inside the repository', async () => {
  const scope = config.files.includes;
  assert.ok(Array.isArray(scope) && scope.length);
  assert.equal(new Set(scope).size, scope.length);
  for (const name of scope) {
    // Globs, negations and links would adopt files that nobody listed.
    assert.ok(
      name
        .split('/')
        .every((part) => /^[\w.-]+$/.test(part) && !/^\.\.?$/.test(part)),
      `Not a plain repository path: ${name}`,
    );
    assert.match(name, /\.(?:js|mjs|cjs|json|jsonc)$/, name);
    const file = path.join(root, name);
    assert.ok((await lstat(file)).isFile(), `Not a regular file: ${name}`);
    assert.equal(
      path.relative(root, await realpath(file)),
      path.normalize(name),
    );
  }
});

test('format check is read-only; write only changes adopted files and is repeatable', async (t) => {
  const { dir, read } = await fixture(t);
  assert.notEqual(await format(dir), 0);
  assert.equal(await read('adopted.js'), 'const value="yes"\r\n');
  assert.equal(await format(dir, '--write'), 0);
  assert.equal(await read('adopted.js'), "const value = 'yes';\n");
  assert.equal(await read('legacy.js'), 'const untouched="yes"');
  assert.equal(await format(dir), 0);
  assert.equal(await format(dir, '--write'), 0);
  assert.equal(await read('adopted.js'), "const value = 'yes';\n");
});

test('a named file outside the scope is left untouched', async (t) => {
  // The pre-commit hook passes every staged file; only adopted files change.
  const { dir, read } = await fixture(t);
  assert.equal(
    await format(dir, '--write', '--no-errors-on-unmatched', 'legacy.js'),
    0,
  );
  assert.equal(await read('legacy.js'), 'const untouched="yes"');
  assert.equal(await read('adopted.js'), 'const value="yes"\r\n');
});
