/**
 * The nightly QA workflow runs the track regression and the default
 * harnesses on a slow SwiftShader runner. These are the fork's fixes for that
 * runner (#50); an upstream sync that replaces a harness drops them silently,
 * so each one is checked here.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (file) =>
  readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

const NAVIGATION_TIMEOUT_MS = 90_000;

/** The scripts the nightly runs: test:track, then the default harnesses. */
function nightlyScripts() {
  const workflow = read('.github/workflows/qa.yml');
  const defaults = workflow.match(/^\s+default: ([\w -]+)$/m)?.[1].split(' ');
  assert.ok(defaults, 'qa.yml names its default harnesses');
  const track = JSON.parse(read('package.json')).scripts['test:track'];
  assert.equal(track, 'node scripts/track-regression.mjs');
  assert.match(workflow, /run: pnpm run test:track/);
  return [
    'scripts/track-regression.mjs',
    ...defaults.map((name) => `scripts/${name}.mjs`),
  ];
}

/** The text of each `page.goto(...)` and `page.reload(...)` call. */
function navigations(source) {
  const calls = [];
  for (const match of source.matchAll(/\bpage\.(?:goto|reload)\(/g)) {
    let depth = 0;
    let end = match.index;
    for (; end < source.length; end++) {
      if (source[end] === '(') depth++;
      else if (source[end] === ')' && --depth === 0) break;
    }
    calls.push(source.slice(match.index, end + 1));
  }
  return calls;
}

const number = (text) => Number(text.replaceAll('_', ''));

/** The default navigation timeout a script sets, resolving a named constant. */
function defaultNavigationTimeout(source) {
  const argument = source.match(/setDefaultNavigationTimeout\(([\w]+)\)/)?.[1];
  if (!argument) return null;
  if (/^[\d_]+$/.test(argument)) return number(argument);
  const constant = source.match(
    new RegExp(`const ${argument} = ([\\d_]+);`),
  )?.[1];
  return constant ? number(constant) : null;
}

test('the nightly runs the track regression and the three default harnesses', () => {
  assert.deepEqual(nightlyScripts(), [
    'scripts/track-regression.mjs',
    'scripts/qa-application.mjs',
    'scripts/qa-firstrun.mjs',
    'scripts/qa-map-source-tray.mjs',
  ]);
});

test('every app navigation in the nightly allows 90 s', () => {
  for (const file of nightlyScripts()) {
    const source = read(file);
    const calls = navigations(source);
    assert.ok(calls.length > 0, `${file} navigates`);
    const fallback = defaultNavigationTimeout(source);
    for (const call of calls) {
      // A blank page loads at once; it never waits on the dev server.
      if (call.includes("'about:blank'")) continue;
      const explicit = call.match(/\btimeout: ([\d_]+)/)?.[1];
      const timeout = explicit ? number(explicit) : fallback;
      assert.ok(
        timeout !== null && timeout >= NAVIGATION_TIMEOUT_MS,
        `${file}: ${call} allows ${timeout ?? 'the 30 s default'}`,
      );
    }
  }
});

test('the navigation reader finds explicit and default deadlines', () => {
  const source = [
    'const LIMIT_MS = 90_000;',
    'page.setDefaultNavigationTimeout(LIMIT_MS);',
    "await page.goto(link('(1)'), { waitUntil: 'load' });",
    'await page.reload({ timeout: 60000 });',
  ].join('\n');
  assert.equal(defaultNavigationTimeout(source), 90_000);
  assert.deepEqual(navigations(source), [
    "page.goto(link('(1)'), { waitUntil: 'load' })",
    'page.reload({ timeout: 60000 })',
  ]);
  assert.equal(defaultNavigationTimeout('page.goto(url);'), null);
});
