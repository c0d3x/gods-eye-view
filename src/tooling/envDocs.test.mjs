import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (file) =>
  readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

/** Read by the code but set by the system or a launcher, not configured. */
const ALLOWED = new Map([
  ['HOME', "the user's home directory"],
  ['GEV_LAUNCHER', 'set by the launchers to say which one started the server'],
  [
    'GEV_KEY_SETUP_EXTERNAL_KEYS',
    'set by the launchers: keys supplied outside .env',
  ],
  ['PINOKIO_SHARE_CLOUDFLARE', 'set by Pinokio'],
  ['PINOKIO_SHARE_LOCAL', 'set by Pinokio'],
  ['PINOKIO_SHARE_PASSCODE', 'set by Pinokio'],
  ['PINOKIO_SHARE_VAR', 'set by Pinokio'],
]);

const READS = [
  /process\.env\.([A-Z][A-Z0-9_]+)/g,
  /process\.env\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/g,
  /(?<![\w.$])env\.([A-Z][A-Z0-9_]+)/g,
  /(?<![\w.$])env\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/g,
];

/** The environment variables a source file reads. */
function environmentReads(source) {
  const names = new Set();
  for (const pattern of READS) {
    for (const match of source.matchAll(pattern)) names.add(match[1]);
  }
  return names;
}

function trackedFiles() {
  return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

/** The dev server, its helpers, scripts and launchers. */
function serverSources() {
  return trackedFiles().filter(
    (file) =>
      /\.(?:m?js|cjs)$/.test(file) &&
      !file.endsWith('.test.mjs') &&
      (file === 'vite.config.js' ||
        /^(?:server|scripts|pinokio|tools)\//.test(file) ||
        /^src\/.*\.mjs$/.test(file)),
  );
}

function envExampleNames() {
  const names = new Set();
  for (const line of read('.env.example').split('\n')) {
    const match = /^#?\s*([A-Z][A-Z0-9_]+)=/.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

/** Names and `NAME_*` prefixes in TESTING.md's variables section. */
function testingNames() {
  const testing = read('TESTING.md');
  const start = testing.indexOf('## Test and QA environment variables');
  assert.notEqual(start, -1, 'TESTING.md documents the test variables');
  const names = new Set();
  const prefixes = [];
  for (const match of testing
    .slice(start)
    .matchAll(/`([A-Z][A-Z0-9_]+)(\*)?`/g)) {
    if (match[2]) prefixes.push(match[1]);
    else names.add(match[1]);
  }
  return { names, prefixes };
}

function undocumented(reads) {
  const configured = envExampleNames();
  const testing = testingNames();
  return [...reads]
    .filter(
      (name) =>
        !configured.has(name) &&
        !testing.names.has(name) &&
        !ALLOWED.has(name) &&
        !testing.prefixes.some((prefix) => name.startsWith(prefix)),
    )
    .sort();
}

test('every environment variable the code reads is documented', () => {
  const reads = new Set();
  for (const file of serverSources()) {
    for (const name of environmentReads(read(file))) reads.add(name);
  }
  assert.ok(reads.size > 40, 'the scan finds the reads');
  assert.deepEqual(undocumented(reads), []);
});

test('an undocumented read is caught', () => {
  const reads = environmentReads(
    "const a = process.env.GEV_NOT_DOCUMENTED; const b = env['OPENAI_API_KEY'];",
  );
  assert.deepEqual([...reads].sort(), ['GEV_NOT_DOCUMENTED', 'OPENAI_API_KEY']);
  assert.deepEqual(undocumented(reads), ['GEV_NOT_DOCUMENTED']);
});

test('every variable in .env.example is used by the code', () => {
  const code = trackedFiles()
    .filter(
      (file) =>
        /\.(?:m?js|cjs|sh|html)$/.test(file) && !file.endsWith('.test.mjs'),
    )
    .map((file) => read(file))
    .join('\n');
  const stale = [...envExampleNames()].filter(
    (name) => !new RegExp(`\\b${name}\\b`).test(code),
  );
  assert.deepEqual(stale, []);
});
