# Formatting and component boundaries

Run `pnpm run format` to format the files listed in `files.includes` of
`biome.json` and `pnpm run format:check` to check that same list without
writing; `pnpm run lint` applies Biome's recommended lint rules and import
sorting to it and fails on warnings as well as errors. CI checks the entire
adopted list on Linux and Windows. Biome is pinned in the development
dependencies; use the installed version so local and CI output agree. The shared
configuration specifies two spaces, single quotes, semicolons and LF endings.
The Lefthook pre-commit hook formats, lints and sorts the imports of staged
files from the same list and leaves every other file untouched.

Add new reusable modules and their tests to the list as they are extracted.
Keep mechanical formatting in its own commit after behavior is stable. Existing
source-text regression assertions still apply; investigate failures and preserve
their behavioral coverage when a move or line wrap changes a tested shape.
Files outside the list retain their surrounding style until deliberately adopted.
The list names individual JavaScript and JSON files; `pnpm test` rejects globs,
duplicates, links and missing files. Biome does not format Markdown, so
documentation stays outside the list.

## Current component ownership

| Surface                                                   | Owns                                                                   | Receives from its caller                            |
| --------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------- |
| `gods-eye-view/infrastructure`                            | Datacenter/dam definitions and fresh layer construction                | Context, overlay and render operations              |
| `gods-eye-view/infrastructure/geojson`                    | Data loading, Cesium entities, selection handling and resource cleanup | A viewer and those same operations                  |
| `gods-eye-view/infrastructure/lod`                        | Pure visibility budgets and selection policy                           | Position/visibility records and camera measurements |
| `src/data/localGeojson.js`                                | Standalone compatibility wiring                                        | The application's existing shared services          |
| `src/main.js`, `src/editions/local/` and `vite.config.js` | Standalone startup and local Node services                             | Local configuration                                 |

The scoped package exports are browser source modules. Use their documented
exports instead of importing standalone startup or reaching into internal files.
The application owns the viewer, context store, overlay host and render scheduler;
layers use the supplied callbacks. See [the infrastructure contract](INFRASTRUCTURE-LAYERS.md).

`pnpm run check:boundaries` builds every declared package export, with app Vite
configuration disabled. `scripts/package-boundaries.json` lists each export's
component, owned modules and external runtime dependencies. A new export must be
classified. Imports outside the declared modules fail, including unused and
literal dynamic imports. Cesium stays external so the consuming application
supplies the same compatible instance as its viewer. Existing consumer tests
also check import-time inactivity and asset URLs under a non-root base.

These checks cover the declared exports, not every import in the application.
They check build-time imports, not arbitrary runtime-generated module URLs.
Keep runtime module discovery out of these exports. When extracting another
component, add its ownership and consumer tests together. Node services must use
separate entry points and their own checks when they become reusable; importing
them into a browser component is not supported. No Node service is exported yet.

`gods-eye-view/application` owns construction order, startup state, cancellation
and disposal of caller-supplied components. Its only owned module is
`src/app/application.js`. `gods-eye-view/application/viewer` separately owns the
standard Cesium viewer configuration in `src/app/viewer.js`; Cesium stays external.
Neither export imports standalone UI, layers, tools or configuration. See
[application construction](APPLICATION.md) for the contracts and current limits.

UI panels are moving out of `src/ui.js` into modules under `src/ui/` (#46),
one panel per commit, with the code unchanged. `src/ui/cockpitView.js` holds
the Cockpit view: StyleManager constructs its controller and disposes of it.
A StyleManager panel moves as a class of its own that is never constructed,
such as `RadioPanel` in `src/ui/radioPanel.js`: `adoptMethods()` from
`src/ui/adoptMethods.js` copies its methods onto StyleManager, where they run
on StyleManager's state as before. A panel's setup sits in its module, and so
does any teardown of its own, such as `_initRadioPanel()` and
`_disposeRadioPanel()`.
Tests that read UI code as text call `readUiSource()` from
`src/testing/uiSources.mjs`, which joins `ui.js` with every module in its
`UI_SOURCE_FILES` list; add each new module there. Individual source adapters
remain future extractions, to become smaller modules with explicit lifecycle
owners as their callers migrate.

## Server boundary

The dev server's code lives outside the browser tree: its modules under
`server/`, the route plugins `vite.config.js` installs from
`server/proxies/`, `server/ais/` and `server/realtime/`, and the helpers they
share under `server/lib/`. Those
helpers are the request guard, JSON responses, request bodies, capped
upstream reads, rate limits, fetch timeouts, caches and their disk limits,
camera fetching and the Google server key, each defined once. Server code
may import browser modules that are safe on both sides, such as the provider
catalog in `src/keySetupCatalog.js`. Browser code never imports
`server/`: `pnpm run check:boundaries` builds the app's browser graph from
`src/main.js` and fails when it reaches a module under `server/`.
