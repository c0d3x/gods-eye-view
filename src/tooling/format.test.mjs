import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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

/** Whether a repository path matches one of Biome's `files.includes` globs. */
function matchesGlob(file, glob) {
  const pattern = glob
    .split('**/')
    .map((part) =>
      part
        .split('*')
        .map((text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*'),
    )
    .join('(?:.*/)?');
  return new RegExp(`^${pattern}$`).test(file);
}

test('the Biome scope covers every tracked JavaScript file and no bundled data', async () => {
  const scope = config.files.includes;
  const inScope = (file) =>
    scope.some((glob) => !glob.startsWith('!') && matchesGlob(file, glob)) &&
    !scope.some(
      (glob) => glob.startsWith('!') && matchesGlob(file, glob.slice(1)),
    );
  const { stdout } = await run('git', ['ls-files'], { cwd: root });
  const tracked = stdout.split('\n').filter(Boolean);
  const code = tracked.filter((file) => /\.(?:js|mjs|cjs)$/.test(file));
  assert.ok(code.length > 500, `only ${code.length} tracked JavaScript files`);
  assert.deepEqual(
    code.filter((file) => !inScope(file)),
    [],
    'every tracked JavaScript file is formatted and linted',
  );
  for (const file of [
    'biome.json',
    'package.json',
    'scripts/package-boundaries.json',
  ]) {
    assert.ok(inScope(file), `${file} is formatted`);
  }
  assert.deepEqual(
    tracked.filter(
      (file) => file.startsWith('src/data/local_data/') && inScope(file),
    ),
    [],
    'the bundled data keeps its own layout',
  );
});

test('format check is read-only; write only changes files in scope and is repeatable', async (t) => {
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
  // The pre-commit hook passes every staged file; only files in scope change.
  const { dir, read } = await fixture(t);
  assert.equal(
    await format(dir, '--write', '--no-errors-on-unmatched', 'legacy.js'),
    0,
  );
  assert.equal(await read('legacy.js'), 'const untouched="yes"');
  assert.equal(await read('adopted.js'), 'const value="yes"\r\n');
});
