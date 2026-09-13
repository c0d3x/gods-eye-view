import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const DOCS = fileURLToPath(new URL('../../docs/', import.meta.url));
const INDEX = path.join(DOCS, 'CURRENT-STATE.md');
const PAGE_DIR = path.join(DOCS, 'current-state');

const pages = () =>
  readdirSync(PAGE_DIR)
    .filter((file) => file.endsWith('.md'))
    .sort();
const files = () => [
  INDEX,
  ...pages().map((page) => path.join(PAGE_DIR, page)),
];

/** A Markdown file's relative link targets, without their anchors. */
function relativeLinks(file) {
  return [...readFileSync(file, 'utf8').matchAll(/\]\(([^)\s]+)\)/g)]
    .map((match) => match[1])
    .filter((target) => !/^(?:[a-z]+:|#)/i.test(target))
    .map((target) => target.split('#')[0]);
}

test('the runtime reference index lists every page under docs/current-state/', () => {
  const listed = relativeLinks(INDEX)
    .filter((target) => target.startsWith('current-state/'))
    .map((target) => target.slice('current-state/'.length))
    .sort();
  assert.ok(listed.length >= 5, 'the index lists the subsystem pages');
  assert.deepEqual(listed, pages());
});

test('no runtime reference page is longer than 500 lines', () => {
  for (const file of files()) {
    const count = readFileSync(file, 'utf8').trimEnd().split('\n').length;
    assert.ok(count <= 500, `${path.relative(DOCS, file)} has ${count} lines`);
  }
});

test('every relative link in the runtime reference resolves', () => {
  const broken = [];
  for (const file of files()) {
    for (const target of relativeLinks(file)) {
      if (!existsSync(path.resolve(path.dirname(file), target))) {
        broken.push(`${path.relative(DOCS, file)} → ${target}`);
      }
    }
  }
  assert.deepEqual(broken, []);
});

test('each page links back to the index', () => {
  for (const page of pages()) {
    assert.ok(
      relativeLinks(path.join(PAGE_DIR, page)).includes('../CURRENT-STATE.md'),
      page,
    );
  }
});
