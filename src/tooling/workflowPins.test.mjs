import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const WORKFLOWS = new URL('../../.github/workflows/', import.meta.url);

/** `uses:` references in a workflow, except local actions. */
function actionReferences(text) {
  return [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(.+?)\s*$/gm)]
    .map((match) => match[1])
    .filter((reference) => !reference.startsWith('./'));
}

test('every workflow action is pinned to a commit SHA, with its version', () => {
  const files = readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name));
  assert.ok(files.length > 0, 'workflows exist');
  for (const name of files) {
    const references = actionReferences(
      readFileSync(new URL(name, WORKFLOWS), 'utf8'),
    );
    for (const reference of references) {
      // A tag such as @v7 can be moved to other code; a commit SHA can't.
      // Dependabot updates the SHA and the version comment together.
      assert.match(
        reference,
        /^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/,
        `${name}: ${reference}`,
      );
    }
  }
});

test('the reference check catches movable tags and short SHAs', () => {
  const pinned = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/;
  const [tag, short, bare, local] = actionReferences(
    [
      '      - uses: actions/checkout@v7',
      '        uses: actions/setup-node@8207627 # v7.0.0',
      '        uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86',
      '      - uses: ./.github/actions/local',
    ].join('\n'),
  ).concat([undefined]);
  assert.doesNotMatch(tag, pinned);
  assert.doesNotMatch(short, pinned);
  assert.doesNotMatch(bare, pinned, 'the version comment is required');
  assert.equal(local, undefined, 'local actions are skipped');
});

test('Dependabot updates the pinned actions', () => {
  const config = readFileSync(
    new URL('../../.github/dependabot.yml', import.meta.url),
    'utf8',
  );
  assert.match(config, /- package-ecosystem: github-actions\n\s+directory: \//);
});
