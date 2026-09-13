import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  CHANGE_TYPES,
  changelogSections,
  releaseNotes,
  releases,
  releaseTitle,
} from '../../scripts/changelog.mjs';

const CHANGELOG = readFileSync(
  new URL('../../CHANGELOG.md', import.meta.url),
  'utf8',
);

function compareVersions(a, b) {
  const [left, right] = [a, b].map((version) => version.split('.').map(Number));
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

test('the changelog opens with Unreleased, then releases newest first', () => {
  const sections = changelogSections(CHANGELOG);
  assert.equal(sections[0].heading, '[Unreleased]');
  const history = sections.findIndex(
    (section) => section.heading === 'Pre-release history',
  );
  assert.ok(history > 1, 'the pre-release history follows the releases');
  assert.equal(
    sections.length,
    history + 1,
    'history entries sit under one heading',
  );
  for (const { heading } of sections.slice(1, history)) {
    assert.match(heading, /^\[\d+\.\d+\.\d+\] - \d{4}-\d{2}-\d{2}$/);
  }
  const list = releases(CHANGELOG);
  assert.equal(list.length, history - 1);
  for (let index = 1; index < list.length; index++) {
    const [newer, older] = [list[index - 1], list[index]];
    assert.ok(
      compareVersions(newer.version, older.version) > 0,
      `${newer.version} before ${older.version}`,
    );
    assert.ok(
      newer.date >= older.date,
      `${newer.version} is dated after ${older.version}`,
    );
  }
});

test('Unreleased and each release use the standard change types, once each', () => {
  const sections = changelogSections(CHANGELOG);
  const history = sections.findIndex(
    (section) => section.heading === 'Pre-release history',
  );
  for (const { heading, body } of sections.slice(0, history)) {
    const types = [...body.matchAll(/^### (.+)$/gm)].map((match) => match[1]);
    // [Unreleased] is empty right after a release.
    if (heading !== '[Unreleased]') {
      assert.ok(types.length > 0, `${heading} has change types`);
    }
    for (const type of types)
      assert.ok(CHANGE_TYPES.includes(type), `${heading}: ### ${type}`);
    assert.equal(
      new Set(types).size,
      types.length,
      `${heading} repeats a change type`,
    );
  }
});

test("one release's notes can be extracted for the release workflow", () => {
  const notes = releaseNotes(CHANGELOG, 'v0.1.1');
  assert.match(notes, /^Installation and live-data fixes\./);
  assert.match(notes, /### Fixed/);
  assert.doesNotMatch(notes, /## \[0\.1\.0\]/);
  assert.throws(
    () => releaseNotes(CHANGELOG, '9.9.9'),
    /no section for 9\.9\.9/,
  );
});

test('the parser reads release bodies and skips the history', () => {
  const sample = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '### Added',
    '',
    '- New.',
    '',
    '## [1.2.0] - 2026-01-02',
    '',
    '### Fixed',
    '',
    '- Bug.',
    '',
    '## Pre-release history',
    '',
    '### Prototype 0.1.0 - 2025-01-01',
    '',
    '- Old.',
    '',
  ].join('\n');
  assert.deepEqual(releases(sample), [
    { version: '1.2.0', date: '2026-01-02', body: '### Fixed\n\n- Bug.' },
  ]);
});

test('a release is titled by its tag and summary line', () => {
  assert.equal(
    releaseTitle(CHANGELOG, '0.1.1'),
    'v0.1.1 — Installation and live-data fixes',
  );
  const bare =
    '## [Unreleased]\n\n## [1.2.0] - 2026-01-02\n\n### Fixed\n\n- Bug.\n';
  assert.equal(releaseTitle(bare, 'v1.2.0'), 'v1.2.0');
});
