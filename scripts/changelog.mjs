/**
 * Reads CHANGELOG.md in the Keep a Changelog layout: `## [Unreleased]`, then
 * one `## [x.y.z] - YYYY-MM-DD` section per release, newest first.
 *
 * Usage: node scripts/changelog.mjs section|title <version>
 * prints one release's notes or title, as the release workflow publishes them.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The change types a section may use, in Keep a Changelog's order. */
export const CHANGE_TYPES = Object.freeze([
  'Added',
  'Changed',
  'Deprecated',
  'Removed',
  'Fixed',
  'Security',
]);

const RELEASE_HEADING = /^\[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/;

/**
 * Splits a changelog into its level-2 sections.
 * @param {string} text - The changelog.
 * @returns {{ heading: string, body: string }[]}
 */
export function changelogSections(text) {
  const sections = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      current = { heading: line.slice(3).trim(), lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return sections.map(({ heading, lines }) => ({
    heading,
    body: lines.join('\n').trim(),
  }));
}

/**
 * The released versions, in the order written.
 * @param {string} text - The changelog.
 * @returns {{ version: string, date: string, body: string }[]}
 */
export function releases(text) {
  return changelogSections(text).flatMap(({ heading, body }) => {
    const match = RELEASE_HEADING.exec(heading);
    return match ? [{ version: match[1], date: match[2], body }] : [];
  });
}

/**
 * One release's notes, without its heading.
 * @param {string} text - The changelog.
 * @param {string} version - `1.2.3` or `v1.2.3`.
 * @returns {string}
 */
export function releaseNotes(text, version) {
  const wanted = String(version).replace(/^v/, '');
  const release = releases(text).find((entry) => entry.version === wanted);
  if (!release) throw new Error(`CHANGELOG.md has no section for ${wanted}`);
  return `${release.body}\n`;
}

/**
 * A release's title: its tag, then the summary line under its heading when
 * there is one, as in "v0.1.1 — Installation and live-data fixes".
 * @param {string} text - The changelog.
 * @param {string} version - `1.2.3` or `v1.2.3`.
 * @returns {string}
 */
export function releaseTitle(text, version) {
  const [summary] = releaseNotes(text, version).split('\n');
  const tag = `v${String(version).replace(/^v/, '')}`;
  return summary && !summary.startsWith('#')
    ? `${tag} — ${summary.replace(/\.$/, '')}`
    : tag;
}

function main([command, version]) {
  if (!['section', 'title'].includes(command) || !version) {
    console.error('Usage: node scripts/changelog.mjs section|title <version>');
    process.exit(2);
  }
  const text = readFileSync(
    new URL('../CHANGELOG.md', import.meta.url),
    'utf8',
  );
  process.stdout.write(
    command === 'title'
      ? `${releaseTitle(text, version)}\n`
      : releaseNotes(text, version),
  );
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invokedPath) main(process.argv.slice(2));
