# Syncing with upstream

This repository, c0d3x/gods-eye-view, is a fork of
[bilawalsidhu/gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view).
It takes upstream's changes by merging upstream's `main` into its own `main`.
This guide describes how, and the rules that keep each merge small.

## The model

- **Upstream's files stay byte-identical where possible.** The fork's changes
  live in fork-owned modules, with small edits at upstream's call sites, so a
  merge rarely meets a fork change on the same lines. Examples:
  `src/data/projectUrl.js` (the contact point the proxies send),
  `build/cesium.js` (the Cesium Vite plugin) and the three baselines below.
  `git diff --stat upstream/main main` lists every file the fork changes; keep
  that list short.
- **The fork's tooling sits beside upstream's.** The fork installs with pnpm
  instead of npm, lints and formats with Biome, runs Biome on staged files
  through a Lefthook pre-commit hook, type-checks in strict mode, finds unused
  code with knip, and builds with Vite 8 and its own Cesium plugin.
  Upstream's code is not held to Biome, strict TypeScript or knip, and
  changing it to pass would make every sync conflict, so three baselines
  record what it fails today: `biome-baseline.json` switches off each Biome
  check for exactly the upstream files that fail it, `typecheck-baseline.json`
  lists the files with type errors, and `knip-baseline.json` switches off, per
  file, the issue types knip reports. Every other file, including each fork
  module, is held to all of the checks. Upstream still formats with Prettier
  through
  `scripts/format.mjs`; that script, `scripts/format-scope.json`,
  `scripts/format-runtime.json`, `.prettierrc.json` and `.prettierignore` stay
  in place, untouched, and the fork's scripts do not run them.
- **Every sync is a merge commit.** The fork never rebases onto upstream or
  rewrites `main`, so the merge records exactly which upstream commit the fork
  has, and the next merge starts from there.

## The upstream remote

Add the remote once, without tags:

```bash
git remote add upstream https://github.com/bilawalsidhu/gods-eye-view.git
git config remote.upstream.tagOpt --no-tags
```

`tagOpt --no-tags` stops `git fetch upstream` from copying upstream's release
tags into your clone. The fork numbers its own releases, so upstream's tags
collide with them or name versions the fork never released, and every version
tag pushed to `origin` starts the fork's Release workflow. For the same reason, **never run `git push --tags`**: it pushes every
tag in your clone, including upstream tags fetched before `tagOpt` was set.
Push a release tag by name, as [CONTRIBUTING.md](../CONTRIBUTING.md#releasing)
describes. `git ls-remote --tags origin` lists the fork's tags; delete a local
tag that is not among them with `git tag -d <tag>`.

To make an accidental push to upstream fail, you can also give the remote a
push URL that does not exist: `git remote set-url --push upstream no-push`.

## Merging

```bash
git switch main
git pull --ff-only origin main
git fetch upstream
git log --oneline main..upstream/main   # what the merge brings in
git merge --no-ff upstream/main
```

Name the merge `Merge upstream bilawalsidhu/gods-eye-view into the fork`, and
say in its body which upstream commits it brings in (for example "the 740
upstream commits since 493acfc, through upstream PR #986"), what stands out
among them, and how the conflicts were resolved. A large sync can be prepared
on a short-lived branch, with the merge followed by the commits that re-apply
fork changes, and then fast-forwarded onto `main`.

## Resolving conflicts

- **`package-lock.json`**: the fork deleted it, and upstream keeps changing it,
  so most merges stop on a modify/delete conflict. Keep it deleted
  (`git rm package-lock.json`), then run `pnpm install` to bring
  `pnpm-lock.yaml` up to date with upstream's `package.json`, and commit the
  lockfile with the merge.
- **`package.json`**: take upstream's new dependencies, scripts and exports.
  Keep the fork's `homepage`, `repository` and `bugs`, `packageManager`, its
  scripts (`lint`, `format` and `format:check` through Biome, `baseline`,
  `typecheck`, `knip`, `test:allocations` and `test:coverage`), Vite 8 without
  `vite-plugin-cesium`, and Cesium pinned at exactly `1.138.0`. Check
  `version` as well: an upstream release bump merges in like any other change,
  and the fork's version is its own.
- **Install scripts**: pnpm fails the install when a dependency has an install
  script that `allowBuilds` in `pnpm-workspace.yaml` has not reviewed. Decide
  for each new one and record why. When an upstream test imports a package
  that npm's flat layout hoists and pnpm does not, add it to
  `publicHoistPattern` there rather than changing the test.
- **Cesium**: the fork pins Cesium at 1.138.0 for upstream's Cyber Sonar,
  which patches Cesium's shaders and switches itself on only for the version
  in `CYBER_SONAR_CESIUM_VERSION` (`src/cyberSonarGpu.js`). Follow upstream
  when it moves Cesium and that constant together; otherwise upgrade Cesium
  only with a revalidation of those patches. Dependabot does not offer Cesium
  upgrades for the same reason.
- **`build/vite.js`**: upstream loads Cesium with `vite-plugin-cesium`, and the
  fork with `build/cesium.js`. Keep the fork's plugin when upstream edits
  that part.
- **Fork identity**: keep the fork's URLs. `src/tooling/forkIdentity.test.mjs`
  fails when a file names upstream's repository outside the credits, its
  history links and its maintainer tooling. A new contact header in
  upstream's code should use `PROJECT_URL` from `src/data/projectUrl.js`.
- **Docs**: take upstream's new content and keep the fork's changes, which are
  mostly the pnpm commands, the fork's links and the Biome instructions.
  `docs/CURRENT-STATE.md` is upstream's running log, and upstream adds a
  section at its top with each change; the fork changes little there, so
  merges of it stay clean.
- **`.github/`**: `ci.yml` is upstream's workflow with the fork's changes:
  pnpm, newer pinned actions, lint, type-check, knip, coverage and a separate
  allocation-budget job. Take upstream's changes to it in their pnpm form and
  keep the fork's. The Release, CodeQL, Scorecard, dependency review and
  nightly QA workflows, Dependabot, the code owners and the task issue form
  are the fork's own; keep them as they are. Upstream's other issue forms
  carry the fork's links and pnpm commands.

## After the merge

1. Run `pnpm run baseline`. It regenerates the three baselines, so upstream's
   new code is covered without changing it: `biome-baseline.json` through
   `scripts/biome-baseline.mjs`, `typecheck-baseline.json` through
   `scripts/typecheck.mjs --update` and `knip-baseline.json` through
   `scripts/knip-baseline.mjs`. Read the diff: only upstream files belong in
   a baseline. A fork file there means a fork change breaks a check; fix that
   instead.
2. Run the checks, and fix what fails before pushing:

   ```bash
   pnpm test
   pnpm run lint
   pnpm run format:check
   pnpm run typecheck
   pnpm run knip
   pnpm run build
   pnpm run check:boundaries
   ```

   Upstream's source-text tests read upstream's files. When one fails because
   of a fork change, update the fork change or the test minimally.
3. Where upstream now covers a fork change, such as a bug both fixed, drop the
   fork's copy in its own commit.
4. Push `main` to `origin`, without tags: `git push origin main`.
