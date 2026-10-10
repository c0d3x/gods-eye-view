// FORK IDENTITY — this repository is c0d3x/gods-eye-view, a fork of
// bilawalsidhu/gods-eye-view.
//
// The package metadata, the code owners and the contact point the proxies give
// upstream APIs name the fork. The upstream project is still named where that is
// right: the credits to its author, its history, and its maintainer tooling.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fsp, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { OVERPASS_USER_AGENT } from '../../server/providers/overpass/constants.js';
import { createNominatimSearchProvider } from '../../server/providers/regional/place.js';
import { celestrakProxy } from '../../server/providers/space/celestrak.js';
import { PROJECT_URL } from '../data/projectUrl.js';
import { transitUpstreamHeaders } from '../data/transitProxy.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (file) =>
  readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const FORK = 'https://github.com/c0d3x/gods-eye-view';
const SELF = 'src/tooling/forkIdentity.test.mjs';

/** Files that name the upstream project throughout, and why. */
const UPSTREAM_FILES = [
  // Upstream's maintainer-only skills and their review procedure.
  /^\.agents\//,
  /^docs\/MAINTAINER_WORKFLOW\.md$/,
  // How this fork follows upstream.
  /^docs\/UPSTREAM-SYNC\.md$/,
  // Release history, and the third-party notices.
  /^CHANGELOG\.md$/,
  /^THIRD_PARTY_NOTICES\.md$/,
  // Fixture remote URLs for the Pinokio updater.
  /^src\/pinokioUpdatePreview\.test\.mjs$/,
];

/**
 * Links into upstream's history, which only resolve there: numbered issues and
 * pull requests, and permalinks pinned to a commit.
 */
const UPSTREAM_HISTORY =
  /https:\/\/github\.com\/bilawalsidhu\/gods-eye-view\/(?:(?:issues|pull)\/\d+|(?:blob|commit|tree)\/[0-9a-f]{40}\S*?)(?=[)\s]|$)/g;

/** The note near the top of the README and CONTRIBUTING. */
const FORK_NOTE =
  /\[bilawalsidhu\/gods-eye-view\]\(https:\/\/github\.com\/bilawalsidhu\/gods-eye-view\)/g;
const AUTHOR = /\[Bilawal Sidhu\]\(https:\/\/github\.com\/bilawalsidhu\)/g;

/** The credits, attribution and fork notes, file by file. */
const CREDITS = {
  'README.md': [
    FORK_NOTE,
    AUTHOR,
    /https:\/\/www\.youtube\.com\/@bilawalsidhu/g,
    /https:\/\/x\.com\/bilawalsidhu\/status\/\d+/g,
    // The Pinokio listing installs upstream; the README says so.
    /https:\/\/pinokio\.co\/apps\/github-com-bilawalsidhu-gods-eye-view/g,
  ],
  'CONTRIBUTING.md': [FORK_NOTE, AUTHOR],
  'docs/CURRENT-STATE.md': [/a fork of `bilawalsidhu\/gods-eye-view`/g],
  'docs/media/README.md': [
    /the existing public `bilawalsidhu\/gods-eye-view` repository/g,
  ],
};

test('the package metadata and code owners name the fork, and credit the author', () => {
  const manifest = JSON.parse(read('package.json'));
  assert.equal(manifest.homepage, `${FORK}#readme`);
  assert.equal(manifest.repository.url, `${FORK}.git`);
  assert.equal(manifest.bugs.url, `${FORK}/issues`);
  assert.equal(manifest.author, 'Bilawal Sidhu');
  assert.equal(read('.github/CODEOWNERS').trim(), '* @c0d3x');
});

test('the proxies give upstream APIs the fork as their contact point', async (t) => {
  assert.equal(PROJECT_URL, FORK);
  assert.equal(OVERPASS_USER_AGENT, `gods-eye-view/0.1 (+${FORK})`);
  assert.equal(
    transitUpstreamHeaders(null)['User-Agent'],
    `gods-eye-view-transit-proxy/1.0 (+${FORK})`,
  );

  const nominatim = [];
  const search = createNominatimSearchProvider({
    requestJson: async (_url, options) => {
      nominatim.push(options.headers);
      return [];
    },
  });
  await search('fork identity', '');
  assert.deepEqual(nominatim, [
    { 'User-Agent': `gods-eye-view/0.1 (+${FORK})`, Referer: FORK },
  ]);

  // CelesTrak refuses bulk groups without a User-Agent naming a contact point.
  t.mock.method(fsp, 'readFile', async () => {
    throw Error('no cache');
  });
  t.mock.method(fsp, 'mkdir', async () => {});
  t.mock.method(fsp, 'writeFile', async () => {});
  const celestrak = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    celestrak.push(options.headers);
    return new Response('ISS\n1 25544U fixture\n2 25544 fixture');
  });
  let handler;
  celestrakProxy().configureServer({
    middlewares: {
      use(_route, use) {
        handler = use;
      },
    },
  });
  const res = {
    headersSent: false,
    writeHead(status) {
      Object.assign(this, { status, headersSent: true });
    },
    end() {},
  };
  await handler({ url: '/stations', method: 'GET' }, res);
  assert.equal(res.status, 200);
  assert.deepEqual(celestrak, [
    { 'User-Agent': `gods-eye-view-celestrak-proxy/1.0 (+${FORK})` },
  ]);
});

test('the upstream project is named only in credits, history and its tooling', () => {
  // Tracked files and new ones Git does not ignore; binary files are skipped.
  const grep = spawnSync(
    'git',
    ['grep', '--untracked', '-I', '-n', '-e', 'bilawalsidhu'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  assert.equal(grep.status, 0, grep.stderr);
  const unexpected = [];
  for (const match of grep.stdout.split('\n').filter(Boolean)) {
    const [, file, line, text] = /^(.*?):(\d+):(.*)$/.exec(match);
    if (file === SELF || UPSTREAM_FILES.some((pattern) => pattern.test(file)))
      continue;
    let rest = text.replace(UPSTREAM_HISTORY, '');
    for (const pattern of CREDITS[file] || []) rest = rest.replace(pattern, '');
    if (rest.includes('bilawalsidhu'))
      unexpected.push(`${file}:${line}: ${text.trim()}`);
  }
  assert.deepEqual(unexpected, []);
});
