# Contributing to God's Eye View

Thanks for being here. God's Eye View is an open foundation for live spatial intelligence in the browser, and it gets better when more people run it, break it, and extend it.

## Getting set up

Use Node.js 24.14.x or 26.x (also enforced by `package.json`) and pnpm 11.
Once pnpm is installed (for example with `npm install --global pnpm@11`), it
switches to the exact version pinned in `package.json`. Version managers that
read `.node-version` (fnm, mise, nodenv, asdf) take Node 24.14.0 from it; nvm
reads only `.nvmrc`, so use the commands below.

```bash
git clone https://github.com/c0d3x/gods-eye-view.git
cd gods-eye-view
nvm install 24.14.0
nvm use 24.14.0
pnpm install
pnpm run doctor
./scripts/dev-fresh.sh        # or: pnpm run dev (keys are optional)
```

`pnpm run doctor` checks the toolchain, the installed packages, the dev
server's port, the Git hook and Chrome for the QA scripts, and says how to fix
each problem it finds.

No key is required to start: the app boots on keyless Esri World Imagery with
keyless terrain, and OSM takes over automatically if Esri is unreachable.
Google Maps provides direct photorealistic 3D and place search; Cesium ion
provides ion-hosted Google 3D plus optional Bing/world-terrain stacks.
On macOS the launcher pulls optional keys from
the Keychain; on any platform you can pass them as env vars or use a `.env`.
People who only want to run the app can instead install the repository directly
through Pinokio; the terminal path above remains the contributor path.

Open `http://localhost:4173`.

## Running tests

Before sending a PR run `pnpm run build`, `pnpm test`, and `pnpm run test:track` (dev server must be up) — **all three must stay green.** CI also runs `pnpm run lint`, `pnpm run format:check` and `pnpm run check:boundaries`.

- `pnpm test` runs the unit suite, every `*.test.mjs` file, and then the allocation budgets. `pnpm run test:coverage` runs the suite without the budgets and writes a coverage report to `coverage/`.
- To run one file, call Node's test runner on it: `node --test src/setupDoctor.test.mjs`. Add `--test-name-pattern="lockfile"` to run only the tests whose names match.

### QA harnesses

`pnpm run test:track` and the QA harnesses in `scripts/qa-*.mjs` drive the dev server in headless Chrome.

1. Run `pnpm run qa:setup` once. It downloads Puppeteer's Chrome for Testing, or, when `PUPPETEER_EXECUTABLE_PATH` names a Chrome you have, checks that file and downloads nothing.
2. Start the dev server with `pnpm run dev`.
3. Run `pnpm run test:track`, or a single harness such as `node scripts/qa-application.mjs`.

The harnesses look for the server at `GEV_QA_URL` (default `http://localhost:4173`), and a harness's `--url` overrides that for one run. [TESTING.md](TESTING.md) lists the variables that tune them. The QA workflow runs the track regression and a set of harnesses against a keyless server every night; start it by hand from the Actions tab to name other harnesses.

## Good first contributions

The highest-leverage places to jump in:

- **🌆 Add a CCTV source pack.** Austin is the reference camera source. Adding another city means a clean public camera catalog with coordinates, attribution, and server-registered frame URLs (the proxy only fetches registered URLs — never client-supplied ones, see [SECURITY.md](SECURITY.md)). City packs are the best first lane.
- **🛰️ Add or improve a data layer.** Each layer is one self-contained module in `src/data/<layer>.js` implementing the layer interface (`init/enable/disable/update/destroy/getStats`, optional `getDetectableObjects`/`getStats`). Use an existing layer as a template.
- **🎙️ Extend voice control.** Voice tools are declared server-side (`GEV_REALTIME_TOOLS` in `server/realtime/tools.mjs`) and executed client-side (`src/voice/gevActions.js`). Keep the tool surface tight and the responses honest (confirm only what actually happened).
- **🎨 Add a visual style.** Styles are GLSL post-process shaders in `src/styles/`.
- **🐛 Fix bugs / improve the first-run experience.** See [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md).

## Architecture in one minute

- **No framework.** Vanilla JS + [CesiumJS](https://cesium.com/platform/cesiumjs/) + [Vite](https://vitejs.dev/).
- **UI lives in `src/ui/`**, one module per panel, view or control, and **`src/ui.js`** builds it and wires the panels together. **Layer logic lives in `src/data/<layer>.js`.** Keep them separate.
- **Secrets stay server-side.** Anything needing a private key goes through a server-side proxy under `server/`. The browser only ever sees the Google Maps key (which you restrict) and ephemeral tokens.
- `docs/CURRENT-STATE.md` indexes the authoritative runtime reference, one page per subsystem under `docs/current-state/` — read it first.

## Coding style

- ES modules, **2-space indent, single quotes, semicolons.**
- JSDoc on exported/public functions.
- Match the surrounding code — comment density, naming, and idiom.
- Prefer small, reviewable commits. Conventional-commit-style prefixes (`feat:`, `fix:`, `perf:`, `docs:`) are appreciated but not required.

## Formatting and reusable components

Run `pnpm run format` before submitting changes, then `pnpm run format:check`,
`pnpm run lint` and `pnpm run check:boundaries`. Formatting and linting use
Biome, with its recommended lint rules and sorted imports, on every JavaScript
file in the repository and the config JSON. `files.includes` in `biome.json`
names them by glob, so new modules and tests are covered without a list to
update; the bundled data in `src/data/local_data` is left as it is.
`pnpm install` also installs a Lefthook pre-commit hook that formats, lints and
sorts the imports of staged files; set `LEFTHOOK=0` to skip it for one commit.
CI checks formatting, lint and package boundaries on Linux and Windows.

Reusable package exports own their state and receive application operations
through explicit callbacks. They must not import the standalone bootstrap or
local Node services. Update `scripts/package-boundaries.json` and consumer tests
when adding an export or expanding a component. See
[formatting and component boundaries](docs/CODE-BOUNDARIES.md) for the current
ownership and adoption process.

## Pull requests

1. Branch off `main`.
2. Keep `pnpm run build`, `pnpm test`, and `pnpm run test:track` green and avoid new console errors.
3. If you change runtime behavior, update the page under `docs/current-state/` that describes it (`docs/CURRENT-STATE.md` lists them) in the same PR, and add an entry to `CHANGELOG.md` under `## [Unreleased]`, in its Added, Changed, Fixed or Security section.
4. If you add or change a data source, update [DATA_SOURCES.md](DATA_SOURCES.md) with its license and attribution. **Don't add data you don't have the right to redistribute** — fetch it at runtime instead.
5. Describe what you changed and how you verified it (screenshots welcome for anything visual).

## Releasing

Releases follow [Semantic Versioning](https://semver.org/): a minor version for
new features, a patch version for fixes only. The fork continues upstream's
line: upstream's last release was v0.1.1, and the fork's first is v0.2.0.

1. Set `version` in `package.json`.
2. In `CHANGELOG.md`, move the entries under `## [Unreleased]` to a new
   `## [x.y.z] - YYYY-MM-DD` heading, with a one-line summary under it, and
   leave `## [Unreleased]` empty above it.
3. Commit to `main` and push.
4. Tag the commit and push the tag: `git tag vX.Y.Z`, then
   `git push origin vX.Y.Z`.

The Release workflow runs the CI checks, checks the tag against
`package.json`, and publishes a GitHub Release titled with the tag and the
summary line, with that version's changelog section as its notes. Run it by
hand from the Actions tab with a version to preview the notes without
publishing anything.

## Maintainers

God's Eye View is maintained by [Bilawal Sidhu](https://github.com/bilawalsidhu)
and [Sameh Khamis](https://github.com/samehkhamis) at
[Halfpixel](https://halfpixel.ai). Either maintainer can review and merge
contributions.

## Ground rules

- This is a tool for **public** data. Don't add scraping of sources whose terms forbid it, private/paywalled datasets, or anything that misrepresents public-data inference as authoritative intelligence.
- Be decent to each other. Assume good faith, keep it constructive.

By contributing, you agree your contributions are licensed under the project's [MIT License](LICENSE).
