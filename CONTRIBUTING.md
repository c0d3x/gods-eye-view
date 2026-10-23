# Contributing to God's Eye View

Thanks for being here. God's Eye View is an open foundation for live spatial intelligence in the browser, and it gets better when more people run it, break it, and extend it.

This repository, c0d3x/gods-eye-view, is a fork of
[bilawalsidhu/gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view),
the project Bilawal Sidhu created. It merges upstream's changes regularly;
[docs/UPSTREAM-SYNC.md](docs/UPSTREAM-SYNC.md) describes how, and
[Working on this fork](#working-on-this-fork) what that means for a change.

## Getting set up

Use Node.js 24.22.1 or later 24.x, or 26.12.1 or later 26.x (also enforced by
`package.json`), and pnpm 11.
Once pnpm is installed (for example with `npm install --global pnpm@11`), it
switches to the exact version pinned in `package.json`. Version managers that
read `.node-version` (fnm, mise, nodenv, asdf) take Node 24.22.1 from it; nvm
reads only `.nvmrc`, so use the commands below.

```bash
git clone https://github.com/c0d3x/gods-eye-view.git
cd gods-eye-view
nvm install 24.22.1
nvm use 24.22.1
pnpm install
pnpm run doctor
./scripts/dev-fresh.sh        # or: pnpm run dev (keys are optional)
```

No key is required to start: the app boots on keyless Esri World Imagery with
keyless terrain, and OSM takes over automatically if Esri is unreachable.
Google Maps provides direct photorealistic 3D and place search; Cesium ion
provides ion-hosted Google 3D plus optional Bing/world-terrain stacks.
On macOS the launcher pulls optional keys from
the Keychain; on any platform you can pass them as env vars or use a `.env`.
People who only want to run the app can install the upstream project through
Pinokio; the terminal path above is how to run this fork.

Open `http://localhost:4173`.

## Running tests

Before sending a PR run `pnpm run build`, `pnpm test`, and `pnpm run test:track` (dev server must be up) — **all three must stay green.** Also run `pnpm run lint`, `pnpm run format:check`, `pnpm run typecheck`, `pnpm run knip` and `pnpm run check:boundaries`; CI runs them too.

- `pnpm test` runs the unit suite, every `*.test.mjs` file under `src/` and `server/`, and then the allocation budgets, which only run on Node 24. `pnpm run test:allocations` runs only the budgets, and `pnpm run test:coverage` runs the suite without them and writes a coverage report to `coverage/`.
- To run one file, call Node's test runner on it: `node --test src/setupDoctor.test.mjs`. Add `--test-name-pattern="OpenSky"` to run only the tests whose names match.

### QA harnesses

`pnpm run test:track` and the QA harnesses in `scripts/qa-*.mjs` drive the dev server in headless Chrome.

1. Get Chrome once. pnpm skips Puppeteer's download at install time (see `pnpm-workspace.yaml`), so run `pnpm run qa:setup` to download Puppeteer's pinned Chrome, or set `PUPPETEER_EXECUTABLE_PATH` to a Chrome you have.
2. Start the dev server with `pnpm run dev`.
3. Run `pnpm run test:track`, or a single harness such as `node scripts/qa-application.mjs`.

Harnesses find the server in different ways, such as `QA_BASE_URL`, a `--url` argument or a positional URL, and most default to `http://localhost:4173`; each entrypoint's header says which. The QA workflow runs the track regression and a set of harnesses every night; start it by hand from the Actions tab to name other harnesses.

Besides CI, pushes to `main` and pull requests run dependency review. CodeQL scans every push to `main` and once a week, and OpenSSF Scorecard scans the repository every week.

## Checking a built app locally

Run `pnpm run build` followed by `pnpm run preview`. Preview serves the built
frontend and local data-provider APIs. Keep optional server credentials in the
ignored `.env`; browser keys are embedded during the build, so rebuild after
changing them. Provider Settings and `/api/setup/*` are development-only: edit
configuration through the development app or environment file. Unknown API
paths return JSON 404 responses. Vite preview is for checking a local build;
it is not a production server.

## Building the Mac app

`pnpm run app:build` packages the app with Electron, signs it and makes a
`.dmg`; `pnpm run app:smoke` launches the result and checks it;
`pnpm run app:dev` runs it from the repository; `pnpm run app:notarize` and
`pnpm run app:install` notarize and install it. The code lives in `app/`, the
commands in `scripts/app.mjs`, and [docs/MAC-APP.md](docs/MAC-APP.md) has the
details, including the environment variables that move the build and
Electron's downloads to another drive. The app's unit tests run with
`pnpm test`; building and the smoke test need a Mac.

## Feature regression gates

Those three are the baseline, not the whole story. Most features also have a
dedicated headless gate under `scripts/qa-*.mjs` that drives the real app and
asserts that feature's contract. **Run the gate covering whatever you touched**,
and say which one you ran in the PR.

Feature gates and a few supporting modules live under the same filename pattern:

```bash
ls scripts/qa-*.mjs            # gates and their supporting modules
head -40 scripts/qa-radio.mjs  # what this runnable gate proves and how to run it
```

Runnable gate entrypoints document what they assert and how to invoke them.
Most need a dev server; some also need a specific provider key or port. Follow
the entrypoint's header rather than assuming every matching file accepts the
same arguments. A few (`qa:map-source-tray`, `qa:panel-resize`,
`qa:street-level`, `qa:transit`) have a `pnpm run` alias.

If you aren't sure which gate covers your change, search `docs/CURRENT-STATE.md`
for the feature: it names the gate for many of them, and it's the authoritative
runtime reference either way. `scripts/qa-l9-matrix.mjs` aggregates the broader
release-candidate checks and selected harnesses; it does not replace the focused
gate for the feature you changed.

> **CI does not cover this for you.** The workflow runs the setup policy
> checks, the formatting and package-boundary checks, the unit suite and the
> production build, plus a Windows onboarding job. It runs neither
> `pnpm run test:track` nor any `qa-*.mjs` gate — both need a live dev server
> and a browser. Include the applicable local run in your PR's validation
> evidence.

## Share-link layer tokens

Every shareable layer owns an immutable token in `LAYER_STATE_REGISTRY` and
`src/data/layerStateTokenReservations.json`. Never change or reuse an existing
token: published v2 links are authored state, and the reservation remains even
if its layer is later removed.

New layers first use the remaining unreserved single-character digits (`0`
through `9`), then the two-character base-36 namespace (`00` through `zz`). On the
current published ledger, `0`, `1` and `2` are already owned, so the next
choices are `3` through `9`, then `00`. After rebasing onto the latest `main`, run
`pnpm run layer-token:next <layer-id>`, add that result to both the permanent
JSON reservation ledger and registry entry, and keep the exact registered-layer
count assertion up to date. The token is assigned against the merge-time base, not
claimed when a PR opens, so another merged layer may require rerunning the
command after a rebase. Never repurpose a published or retired token.
Run `pnpm run layer-token:check --base-ref origin/main` after the rebase;
this checks that every published assignment remains reserved and that new
assignments consume free digits before the two-character tokens, in order.
Pull-request CI runs the same check against `main`.

The helper reads the local ledger; it does not run during a rebase or edit files.
If another PR publishes your provisional token first, keep every published
registry entry and ledger reservation from the refreshed `main`. Temporarily
remove only your still-unpublished layer's registry entry and ledger row so the
local registry is valid again, then rerun `pnpm run layer-token:next <layer-id>`.
For example, if PR A publishes `0` while PR B still provisionally uses `0`,
PR B removes only its own provisional entry, reruns the helper, and receives
`3`. Put `3` on PR B's registry entry and ledger row, update its pinned count
and token tests, then rerun `pnpm run layer-token:check --base-ref origin/main`.
An invalid duplicate ledger can fail during module import before the helper
prints anything; never fix that by renaming or deleting PR A's published token.

## Good first contributions

The highest-leverage places to jump in:

- **🌆 Add a CCTV source pack.** Austin is the reference camera source. Adding another city means a clean public camera catalog with coordinates, attribution, and server-registered frame URLs (the proxy only fetches registered URLs — never client-supplied ones, see [SECURITY.md](SECURITY.md)). City packs are the best first lane.
- **🛰️ Add or improve a data layer.** Layer factories live in `src/layers/<family>/`, with source, record, controller and renderer owners implementing the layer interface (`init/enable/disable/update/destroy/getStats`, optional `getDetectableObjects`/`getStats`). Use an existing layer as a template.
- **🎙️ Extend voice control.** Voice arguments are defined in `src/voice/actionSchemas.js`, with server-side descriptions in `server/providers/openai/tools.js` and client-side execution in `src/voice/gevActions.js`. Keep the tool surface tight and the responses honest (confirm only what actually happened).
- **🎨 Add a visual style.** Styles are GLSL post-process shaders in `src/styles/`.
- **🐛 Fix bugs / improve the first-run experience.** See [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md).

## Architecture in one minute

- **No framework.** Vanilla JS + [CesiumJS](https://cesium.com/platform/cesiumjs/) + [Vite](https://vitejs.dev/).
- **Assembly lives in `src/app/`; standalone defaults live in `src/standalone/`.** UI controllers live in `src/ui/`, layer factories in `src/layers/`, portable sources in `src/sources/`, and application operations in `src/services/`. Existing `src/ui.js` and `src/data/<layer>.js` entries retain compatibility; new code belongs with its focused owner.
- Sources acquire records; renderers own Cesium resources. Import `gods-eye-view/layers/<family>/source` when only a source factory is needed. Common voice controls consume the session interface; protocol adapters own connection details.
- **Secrets stay server-side.** Anything needing a private key goes through a local proxy under `server/providers/`. The browser only ever sees the Google Maps key (which you restrict) and ephemeral tokens.
- `docs/CURRENT-STATE.md` is the authoritative runtime reference — read it first.

## Coding style

- ES modules, **2-space indent, single quotes, semicolons.**
- JSDoc on exported/public functions.
- Match the surrounding code — comment density, naming, and idiom.
- Prefer small, reviewable commits. Conventional-commit-style prefixes (`feat:`, `fix:`, `perf:`, `docs:`) are appreciated but not required.

## Formatting and reusable components

Run `pnpm run format` before submitting changes, then `pnpm run format:check`,
`pnpm run lint`, `pnpm run typecheck`, `pnpm run knip` and
`pnpm run check:boundaries`. Formatting and linting use
Biome, with its recommended lint rules and sorted imports, on the JavaScript
and config JSON that `files.includes` in `biome.json` names by glob, so new
modules and tests are covered without a list to update. `pnpm install` also
installs a Lefthook pre-commit hook that formats, lints and sorts the imports
of staged files; set `LEFTHOOK=0` to skip it for one commit. Keep mechanical
formatting separate from behavioral edits.

`pnpm run typecheck` runs TypeScript in strict mode over the JSDoc types of
the browser code (`jsconfig.json`) and the server code
(`server/jsconfig.json`), tests excluded: every parameter needs a JSDoc type,
a value that may be null or undefined has to be handled before it is used, and
a caught error has to be checked before it is read. `pnpm run knip` fails on
files, exports and dependencies that nothing uses; delete dead code, or tag an
export kept on purpose with `/** @public */`.

Upstream's code is formatted with Prettier and is not held to Biome, strict
TypeScript or knip, and the fork keeps upstream's files byte-identical so
upstream syncs stay small. Three baselines hold upstream's
code to what it passes today:

- `biome-baseline.json`, which `biome.json` extends, switches off each Biome
  check for exactly the upstream files that fail it; Biome's other checks
  still apply to those files.
- `typecheck-baseline.json` records how many type errors each file has. A
  file may not gain one, so a fork edit to an upstream file has to type the
  lines it adds or changes.
- `knip-baseline.json` switches off, per file, the issue types knip reports.

Every other file, including each fork module, is held to all of the checks.
`pnpm run baseline` regenerates the three baselines after an upstream merge
([docs/UPSTREAM-SYNC.md](docs/UPSTREAM-SYNC.md#after-the-merge)). Fork changes
must not grow them: fix a new finding instead of regenerating a baseline. CI
holds that rule with `pnpm run check:baselines --base <commit>`, which fails
when a baseline has a file, a rule, an issue type or a type error more than at
that commit, unless the change merges upstream. Shrinking one is always
welcome: when `pnpm run typecheck` notes that files have fewer type errors
than their counts, `pnpm run baseline` lowers the counts. When
you edit an upstream file that the Biome baseline exempts from formatting,
keep its Prettier style
(`node_modules/.bin/prettier --check <file>` confirms it). Upstream's own
Prettier script, `scripts/format.mjs`, and its `scripts/format-scope.json` and
`scripts/format-runtime.json` lists stay in place, unchanged; this fork's
scripts do not run them.

Reusable package exports own their state and receive application operations
through explicit callbacks. They must not import the standalone bootstrap or
local Node services. Update `scripts/package-boundaries.json` and consumer tests
when adding an export or expanding a component. See
[formatting and component boundaries](docs/CODE-BOUNDARIES.md) for the current
ownership and adoption process.

## Pull requests

1. Branch off `main`.
2. Keep `pnpm run build`, `pnpm test`, and `pnpm run test:track` green and avoid new console errors, plus the [feature gate](#feature-regression-gates) for the area you touched.
3. If you change runtime behavior, add an entry to `CHANGELOG.md` under `## [Unreleased]`, in its Added, Changed, Fixed or Security section, and update the doc that describes the behavior in the same PR. `docs/CURRENT-STATE.md` is upstream's running log: correct it where your change makes it wrong, and leave the rest to upstream.
4. If you add or change a data source, update [DATA_SOURCES.md](DATA_SOURCES.md) with its license and attribution. **Don't add data you don't have the right to redistribute** — fetch it at runtime instead.
5. Describe what you changed and how you verified it (screenshots welcome for anything visual).

## Working on this fork

- Keep upstream's files byte-identical where you can. Put fork behavior in a
  fork-owned module, next to the code it serves or under
  `server/providers/common/`, and keep the call-site edit in upstream's file
  small.
- Use upstream's helpers when upstream already has one that does the job.
- Don't reformat upstream code you aren't changing.
- Register a new module that belongs to an exported package group in
  `scripts/package-boundaries.json`; `pnpm run check:boundaries` says when.

## Issues

- Bug reports and feature requests use the forms on the New issue page.
  Report security problems privately instead, as [SECURITY.md](SECURITY.md)
  describes.
- Planned work is a **Task** issue: the problem, the fix, the checks that say
  it is done, and how to verify it. The pinned roadmap issue orders them.
- A commit that finishes an issue says `Fixes #<number>` in its message, so
  GitHub closes the issue when the commit reaches `main`.

## Releasing

Releases follow [Semantic Versioning](https://semver.org/): a minor version for
new features, a patch version for fixes only. The fork numbers and tags its
own releases, separately from upstream's.

1. Set `version` in `package.json`.
2. In `CHANGELOG.md`, move the entries under `## [Unreleased]` to a new
   `## [x.y.z] - YYYY-MM-DD` heading, with a one-line summary under it, and
   leave `## [Unreleased]` empty above it.
3. Commit to `main` and push.
4. Tag the commit and push only that tag: `git tag vX.Y.Z`, then
   `git push origin vX.Y.Z`. Never `git push --tags`, which would also push
   any upstream tags in your clone
   ([docs/UPSTREAM-SYNC.md](docs/UPSTREAM-SYNC.md#the-upstream-remote)).

The Release workflow runs the CI checks, checks the tag against
`package.json`, and publishes a GitHub Release titled with the tag and the
summary line, with that version's changelog section as its notes. Run it by
hand from the Actions tab with a version to preview the notes without
publishing anything.

## Maintainers

God's Eye View is maintained upstream by [Bilawal Sidhu](https://github.com/bilawalsidhu)
and [Sameh Khamis](https://github.com/samehkhamis) at
[Halfpixel](https://halfpixel.ai). This fork is maintained by
[@c0d3x](https://github.com/c0d3x), who reviews and merges contributions here.

## Ground rules

- This is a tool for **public** data. Don't add scraping of sources whose terms forbid it, private/paywalled datasets, or anything that misrepresents public-data inference as authoritative intelligence.
- Be decent to each other. Assume good faith, keep it constructive.

By contributing, you agree your contributions are licensed under the project's [MIT License](LICENSE).
