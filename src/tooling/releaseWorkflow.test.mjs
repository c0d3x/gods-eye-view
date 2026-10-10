import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const release = read('.github/workflows/release.yml');

test('a version tag runs the CI checks before anything is published', () => {
  assert.match(release, /tags: \['v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+'\]/);
  assert.match(
    release,
    /checks:\n\s+name: CI checks\n\s+uses: \.\/\.github\/workflows\/ci\.yml/,
  );
  assert.match(release, /needs: checks/);
  assert.match(read('.github/workflows/ci.yml'), /^ {2}workflow_call:$/m);
});

test('the release is checked against package.json and noted from the changelog', () => {
  assert.match(release, /require\('\.\/package\.json'\)\.version/);
  assert.match(
    release,
    /node scripts\/changelog\.mjs section "\$VERSION" > release-notes\.md/,
  );
  assert.match(
    release,
    /node scripts\/changelog\.mjs title "\$VERSION" > release-title\.txt/,
  );
  assert.match(release, /--notes-file release-notes\.md --verify-tag/);
});

test('only a pushed tag publishes, and only that job may write', () => {
  assert.match(
    release,
    /- name: Publish the release\n\s+if: github\.event_name == 'push'/,
  );
  assert.match(release, /^permissions:\n {2}contents: read$/m);
  assert.equal(release.match(/contents: write/g)?.length, 1);
});
