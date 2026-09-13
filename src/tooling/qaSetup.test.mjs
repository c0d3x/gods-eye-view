import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { puppeteerCli, qaSetupPlan } from '../../scripts/qa-setup.mjs';

const read = (file) =>
  readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const SCRIPT = fileURLToPath(
  new URL('../../scripts/qa-setup.mjs', import.meta.url),
);

const SPECIFIERS = [
  /\bimport\s+(?:[\w*{}\s,$]+\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bexport\s+[\w*{}\s,$]+\s+from\s+['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire(?:\.resolve)?\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bcreateRequire\([^)]*\)\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function localModule(base) {
  return [base, `${base}.js`, `${base}.mjs`, path.join(base, 'index.js')].find(
    (candidate) =>
      /\.m?js$/.test(candidate) &&
      existsSync(candidate) &&
      statSync(candidate).isFile(),
  );
}

/** The packages vite.config.js and the local modules it imports load. */
function devServerPackages() {
  const packages = new Set();
  const seen = new Set();
  const queue = [
    fileURLToPath(new URL('../../vite.config.js', import.meta.url)),
  ];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const pattern of SPECIFIERS) {
      for (const [, specifier] of source.matchAll(pattern)) {
        if (specifier.startsWith('.')) {
          const target = localModule(
            path.resolve(path.dirname(file), specifier),
          );
          if (target) queue.push(target);
          continue;
        }
        const name = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0];
        if (!name.startsWith('node:') && !builtinModules.includes(name)) {
          packages.add(name);
        }
      }
    }
  }
  return packages;
}

test('the dev server loads only dependencies, so pnpm install --prod runs it', () => {
  const { dependencies, devDependencies } = JSON.parse(read('package.json'));
  const loaded = [...devServerPackages()].sort();
  // vite.config.js imports vite, and the AISStream relay loads ws.
  assert.ok(loaded.includes('vite'), loaded.join(', '));
  assert.ok(loaded.includes('ws'), loaded.join(', '));
  assert.deepEqual(
    loaded.filter((name) => !dependencies[name]),
    [],
  );
  assert.equal(devDependencies.vite, undefined);
  assert.equal(devDependencies.ws, undefined);
});

test('installing the dependencies downloads no Chrome', () => {
  // Puppeteer's install script downloads Chrome, and pnpm runs only the
  // install scripts allowBuilds allows.
  assert.match(read('pnpm-workspace.yaml'), /^ {2}puppeteer: false$/m);
  assert.equal(
    JSON.parse(read('package.json')).scripts['qa:setup'],
    'node scripts/qa-setup.mjs',
  );
  assert.match(read('.github/workflows/qa.yml'), /run: pnpm run qa:setup/);
});

test('qa:setup downloads Chrome for Testing unless PUPPETEER_EXECUTABLE_PATH names one', () => {
  const exists = (file) => file === '/opt/chrome';
  assert.deepEqual(qaSetupPlan({ environment: {}, exists }), {
    action: 'install',
  });
  assert.deepEqual(
    qaSetupPlan({
      environment: { PUPPETEER_EXECUTABLE_PATH: ' /opt/chrome ' },
      exists,
    }),
    { action: 'use', executable: '/opt/chrome' },
  );
  assert.deepEqual(
    qaSetupPlan({
      environment: { PUPPETEER_EXECUTABLE_PATH: '/nowhere/chrome' },
      exists,
    }),
    { action: 'missing', executable: '/nowhere/chrome' },
  );
  assert.ok(existsSync(puppeteerCli()), 'the Puppeteer command line exists');
});

test('qa:setup keeps the Chrome PUPPETEER_EXECUTABLE_PATH names', () => {
  const run = (executable) =>
    spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, PUPPETEER_EXECUTABLE_PATH: executable },
    });
  const present = run(process.execPath);
  assert.equal(present.status, 0, present.stderr);
  assert.match(present.stdout, /nothing to download/);
  const missing = run(`${process.execPath}-missing`);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /names a missing file/);
});
