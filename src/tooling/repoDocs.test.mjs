// CONTRIBUTOR DOCS — the README tree, KNOWN-ISSUES and the issue forms stay
// true to the repository.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (file) =>
  readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const exists = (file) => existsSync(new URL(`../../${file}`, import.meta.url));

/** The paths the README's project tree names, such as `src/data/local_data`. */
function treePaths(markdown) {
  const section = markdown.slice(markdown.indexOf('## 🔧 Under the Hood'));
  const block = /```\n([\s\S]*?)\n```/.exec(section)?.[1] ?? '';
  const paths = [];
  const stack = [];
  for (const line of block.split('\n')) {
    const match = /^((?:│ {3}| {4})*)([├└]── )?(\S+)/u.exec(line);
    if (!match) continue;
    const depth = match[1].length / 4 + (match[2] ? 1 : 0);
    stack.length = depth;
    stack.push(match[3].replace(/\/$/, ''));
    paths.push(stack.join('/'));
  }
  return paths;
}

test('every path in the README project tree exists', () => {
  const paths = treePaths(read('README.md'));
  assert.ok(paths.length >= 5, paths.join(', '));
  assert.ok(paths.includes('src/data/local_data'), paths.join(', '));
  assert.deepEqual(
    paths.filter((entry) => !exists(entry)),
    [],
  );
});

test('KNOWN-ISSUES lists only open issues', () => {
  const known = read('docs/KNOWN-ISSUES.md');
  const entries = known.split(/^### /m).slice(1);
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.match(entry, /^Status: Open\b/m, entry.split('\n')[0]);
  }
  assert.doesNotMatch(known, /^## Closed/m);
});

test('the New issue page offers the bug report, feature request and task forms', () => {
  const directory = new URL('../../.github/ISSUE_TEMPLATE/', import.meta.url);
  const forms = readdirSync(directory)
    .filter((file) => file.endsWith('.yml') && file !== 'config.yml')
    .sort();
  assert.deepEqual(forms, [
    'bug_report.yml',
    'feature_request.yml',
    'task.yml',
  ]);
  const types = new Set([
    'markdown',
    'textarea',
    'input',
    'dropdown',
    'checkboxes',
  ]);
  for (const form of forms) {
    const text = readFileSync(new URL(form, directory), 'utf8');
    for (const key of ['name', 'description', 'body']) {
      assert.match(
        text,
        new RegExp(`^${key}:(?: |$)`, 'm'),
        `${form} has ${key}`,
      );
    }
    assert.doesNotMatch(text, /\t/, `${form} indents with spaces`);
    const fields = [...text.matchAll(/^ {2}- type: (\S+)$/gm)].map(
      (match) => match[1],
    );
    assert.ok(fields.length > 0, `${form} has fields`);
    assert.deepEqual(
      fields.filter((type) => !types.has(type)),
      [],
    );
    const ids = [...text.matchAll(/^ {4}id: (\S+)$/gm)].map(
      (match) => match[1],
    );
    assert.equal(new Set(ids).size, ids.length, `${form} ids are unique`);
    // The commands a reporter is asked to run are the pnpm ones.
    assert.doesNotMatch(text, /(?<![\w-])npm(?![\w-])/, `${form} uses pnpm`);
  }
  // Vulnerabilities go to private reporting, as SECURITY.md asks.
  assert.match(
    readFileSync(new URL('config.yml', directory), 'utf8'),
    /url: https:\/\/github\.com\/c0d3x\/gods-eye-view\/security\/advisories\/new$/m,
  );
});
