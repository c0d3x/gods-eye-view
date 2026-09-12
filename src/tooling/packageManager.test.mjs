import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);

test('dependencies are managed by a pnpm release that Dependabot can update', () => {
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  // Dependabot supports pnpm up to major version 11; a newer pin stops updates.
  assert.match(pkg.packageManager, /^pnpm@11\.\d+\.\d+$/);
  assert.ok(existsSync(new URL('pnpm-lock.yaml', root)));
});
