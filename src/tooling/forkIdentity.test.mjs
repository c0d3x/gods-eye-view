import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (file) =>
  readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const FORK = 'https://github.com/c0d3x/gods-eye-view';

/**
 * Where the upstream project, bilawalsidhu/gods-eye-view, may still be
 * named: the credits, the media attribution, the fork note and the upstream
 * Pinokio listing.
 */
const CREDITS = {
  'README.md': [
    /youtube\.com\/@bilawalsidhu/,
    /x\.com\/bilawalsidhu\/status\//,
    /fork of \[bilawalsidhu\/gods-eye-view\]/,
    /pinokio\.co\/apps\/github-com-bilawalsidhu-gods-eye-view/,
    /\[Bilawal Sidhu\]\(https:\/\/github\.com\/bilawalsidhu\)/,
  ],
  'CONTRIBUTING.md': [
    /\[Bilawal Sidhu\]\(https:\/\/github\.com\/bilawalsidhu\)/,
  ],
  'CHANGELOG.md': [/fork of `bilawalsidhu\/gods-eye-view`/],
  'docs/CURRENT-STATE.md': [/a fork of `bilawalsidhu\/gods-eye-view`/],
  'docs/media/README.md': [/bilawalsidhu\/gods-eye-view/],
};

test('the package metadata and code owners name the fork', () => {
  const manifest = JSON.parse(read('package.json'));
  assert.equal(manifest.homepage, `${FORK}#readme`);
  assert.equal(manifest.repository.url, `${FORK}.git`);
  assert.equal(manifest.bugs.url, `${FORK}/issues`);
  assert.equal(read('.github/CODEOWNERS').trim(), '* @c0d3x');
});

test('the server gives upstream APIs the fork as its contact point', () => {
  assert.match(
    read('vite.config.js'),
    new RegExp(`^export const PROJECT_URL = '${FORK}';$`, 'm'),
  );
});

test('the upstream project is named only in credits and attribution', () => {
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    { cwd: ROOT, encoding: 'utf8' },
  )
    .split('\n')
    .filter(
      (file) =>
        /\.(?:md|m?js|cjs|json|ya?ml|html|css|sh|txt)$|(?:^|\/)CODEOWNERS$/.test(
          file,
        ) &&
        file !== 'pnpm-lock.yaml' &&
        file !== 'src/tooling/forkIdentity.test.mjs',
    );
  assert.ok(files.length > 100, 'the scan reads the repository');
  const unexpected = [];
  for (const file of files) {
    read(file)
      .split('\n')
      .forEach((line, index) => {
        if (!line.includes('bilawalsidhu')) return;
        const credited = (CREDITS[file] || []).some((pattern) =>
          pattern.test(line),
        );
        if (!credited) unexpected.push(`${file}:${index + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(unexpected, []);
});
