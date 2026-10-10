// knip's configuration: what counts as an entry point, and which files make
// up the project. knip-baseline.json switches off, per file, the issue types
// upstream's code has today (see scripts/knip-baseline.mjs).
import { existsSync, readFileSync } from 'node:fs';

const BASELINE = new URL('./knip-baseline.json', import.meta.url);

/** @type {import('knip').KnipConfig} */
export default {
  entry: [
    'src/**/*.worker.{js,mjs}',
    'scripts/**/*.mjs',
    'tools/*.mjs',
    'pinokio/*.js',
    '**/*.test.mjs',
  ],
  project: [
    '*.js',
    'build/**/*.js',
    'src/**/*.{js,mjs}',
    'server/**/*.{js,mjs}',
    'scripts/**/*.mjs',
    'tools/**/*.mjs',
    'pinokio/**/*.js',
  ],
  // QA harnesses import modules from the dev server by URL path.
  paths: { '/src/*': ['./src/*'] },
  ignoreIssues:
    process.env.KNIP_BASELINE === 'off' || !existsSync(BASELINE)
      ? {}
      : JSON.parse(readFileSync(BASELINE, 'utf8')),
};
