# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). It records
public product changes; for the authoritative description of current runtime
behavior, see [`docs/CURRENT-STATE.md`](docs/CURRENT-STATE.md).

## [Unreleased]

### Added

- `pnpm run knip` finds files, exports and dependencies that nothing uses, and
  CI runs it. Its first pass found 63 exports nothing imported: ten were dead
  code and are gone, and the rest are now private to their modules.

- `pnpm run typecheck` runs TypeScript over the JSDoc types of the files that
  opt in with `// @ts-check`, for now the package boundaries and the shared
  context store, and CI runs it. The data layer contract and the context store
  have typedefs.

- Bug report and task templates on the New issue page, with a link to
  private vulnerability reporting. CONTRIBUTING explains how to run one test
  file and how to set up the QA harnesses, the README's project tree matches
  the repository again, and KNOWN-ISSUES lists only open issues.

- The setup doctor (`pnpm run doctor`) checks more of what breaks a setup, and
  says how to fix each problem: the pnpm version against `packageManager`,
  whether `node_modules` matches `pnpm-lock.yaml` and the lockfile matches
  `package.json`, whether `ws` loads, whether the dev server's port is free,
  Lefthook's Git hook, Chrome for the QA scripts, and the OpenSky settings
  (the auth mode, a client ID without its secret, the credentials file, and a
  username and password OpenSky no longer accepts). It lists the optional TfL
  app key too, and a `.node-version` file names Node 24.14.0 for version
  managers.

### Changed

- `pnpm run typecheck` also checks the server: every module under `server/`,
  `vite.config.js`, and the shared browser modules they import, against Node's
  type declarations (`@types/node`, pinned to the Node 24 line the app
  supports), in strict mode. The fixes for what it found change types, not
  behavior.

- The nightly QA run covers the first-run launcher and Map Source tray
  harnesses again. Their timing-sensitive checks now hold under
  SwiftShader's software rendering: a longer navigation deadline, a
  long-Space check that hears the key repeat anywhere on the page and
  waits for the hold to claim the key, focus-ring checks that wait for
  the Data Layers list to stop reflowing, and a notice-dwell check that
  keeps to its own clock. The track regression's corridor check allows
  for the display clamp's cell hysteresis.

- Biome formats and lints every JavaScript file in the repository, and the
  config JSON. `biome.json` names its scope by glob instead of listing files,
  so new modules are covered as they are added; the bundled data in
  `src/data/local_data` keeps its own layout. Adopting the rest of the code
  took Biome's lint fixes, among them optional chains, template literals,
  block bodies for `forEach` callbacks and the removal of functions nothing
  called. The formatting-only commits are listed in `.git-blame-ignore-revs`.

- `src/ui.js` is split into modules under `src/ui/`, one per panel, view
  or control, with the code unchanged. `ui.js` keeps StyleManager's
  construction and wiring, and goes from 10,513 lines to 1,308. The cockpit
  signal tests now drive the real Cockpit controller instead of code cut
  out of `ui.js` as text.

- The EGM96 geoid grid behind the app's height corrections loads as a
  0.9 MB compressed data file instead of a 2.8 MB JavaScript module, and the
  Natural Earth region and marine outlines and the San Francisco
  neighborhoods load as data files too. The browser no longer parses 5.6 MB
  of data as JavaScript. Geoid heights are the same as before, and the
  `egm96-universal` dependency is gone.

- The Live Flights and Military Flights layers share one implementation,
  `src/data/aircraftLayerCore.js`, which `flights.js` and `militaryFlights.js`
  configure for their feeds. The two files had been near-copies of each
  other, so a fix to one often missed the other. Formatted with Biome, the
  two copies come to 10,659 lines; the core and both configurations are
  7,363, and both layers behave as before.

- Turning on the Datacenters or Dams layer no longer freezes the globe. The
  layer read its bundled dataset and built every feature in one step, which
  blocked input and rendering for about 180 ms with the 4,351 datacenters. It
  now loads in slices of 500 features and lets the browser draw and handle
  input between them.

- The voice stack loads right after startup instead of with it, which takes
  about 120 kB (35 kB gzipped) off the JavaScript the app parses before first
  paint. The mic control appears once it arrives.

- `vite.config.js` now holds only configuration and plugin wiring; it was
  7,800 lines. Every route plugin is a module under `server/proxies/`: radio,
  Overpass and routes, CCTV, military installations, regional briefs and
  weather effects, GBFS, OpenSky, TomTom, Google Places, CelesTrak, rocket
  launches, FIRMS, terrain heights, adsbdb, the adsb.lol military feed and
  the track backfill. The AIS relay behind `/api/ais-live` lives in
  `server/ais/` with its socket adapter and watchdog, the voice agent's
  routes and tool schema in `server/realtime/`, and Provider Settings in
  `server/keySetupEndpoint.mjs`. The helpers they share (capped upstream
  reads, request coalescing, the disk cache limits and the rest) live in
  `server/lib/`. Routes and responses are unchanged, and every `/api` route
  now has at least one test, including those that had none: the
  installations, route, regional brief, weather effects, GBFS, OpenSky,
  TomTom, adsb.lol, track backfill and Provider Settings status routes, and
  the AIS relay's reconnect and backoff, watchdog tick and shutdown.

- Server code no longer lives in the browser tree. The Provider Settings
  core, its credential-file hardening, the terrain-heights resolver, the
  AISStream adapter and its watchdog moved to `server/`; the provider catalog
  the browser also reads is now `src/keySetupCatalog.js`. The dev server's
  shared helpers (JSON responses, request bodies, rate limiting and the Google
  server key) each exist once, in `server/lib/`, and
  `pnpm run check:boundaries` fails when browser code imports from `server/`.
  An oversized HUD summary request now gets 413 instead of 400.

- `docs/CURRENT-STATE.md`, 2,806 lines of current behavior, subsystem
  reference and dated notes, is now the index of ten subsystem pages under
  `docs/current-state/`, none longer than 500 lines. Links to it still land
  on the index. Its dated milestone notes moved into this changelog's July
  2026 history.

- Repository metadata, the clone commands, CODEOWNERS and the contact point
  the server gives CelesTrak and Nominatim now name this fork,
  `c0d3x/gods-eye-view`. The README notes that it is a
  fork of `bilawalsidhu/gods-eye-view`, and that the Pinokio listing still
  installs the upstream project.

- Installing the dependencies no longer downloads Chrome, which only the QA
  scripts, `pnpm run test:track` and `tools/cesium-render.mjs` use. Run
  `pnpm run qa:setup` to download Puppeteer's Chrome for Testing, or set
  `PUPPETEER_EXECUTABLE_PATH` to a Chrome you have. `vite` and `ws` move from
  devDependencies to dependencies, since the app runs on the Vite dev server,
  so `pnpm install --prod` is enough to run it.

- `.env.example` lists every variable the server reads. The AISStream URL,
  the Caltrans and TfL camera packs and the TfL app key were missing, and two
  CCTV flags that nothing reads are gone. TESTING.md documents the test and
  QA variables, and a test fails when the code reads a variable documented in
  neither.

- `scripts/dev-secure.sh` (`pnpm run dev:secure`) is now `dev-fresh.sh` pinned
  to 127.0.0.1, whatever `HOST` says. Its old copy of the launcher refused to
  start without a Google Maps key, ignored `.env` and most keys, and had
  drifted from the normal launcher. The launcher and the setup doctor now read
  the macOS Keychain through one table of items, in
  `scripts/lib/credentials.mjs`.

### Removed

- Drop OpenSky's Basic-auth modes. OpenSky's API accepts only OAuth2 client
  credentials now, so `OPENSKY_AUTH_MODE=basic` and `auto` could no longer
  work. Both now mean `oauth`, with a warning, and the proxy and the launcher
  no longer read `OPENSKY_USERNAME` or `OPENSKY_PASSWORD`.

### Fixed

- Cockpit's altitude readout for a military aircraft shows the altitude the
  aircraft reports, as it does for a civil one, instead of the height the
  globe draws it at. The military layer read a field its records never had,
  so the readout fell back to the render height, which includes the geoid.

- The unit-test runner fails a run in which a test file stopped early. Node
  counts such a file as passing, with only the tests it reached; one run
  silently skipped 30 of the AIS layer's 73 tests. The runner now lists any
  queued test that never finished and fails the run, and no longer passes
  `--test-force-exit`, which ends a file's process as soon as Node decides its
  tests are done.

- The OpenSky proxy read a missing rate-limit header as zero. A 429 without a
  retry-after header cooled down for 30 seconds instead of 2 minutes, and a
  snapshot without `X-Rate-Limit-Remaining` stayed cached for 5 minutes
  instead of 9 seconds.

## [0.2.0] - 2026-09-13

Security hardening, fixes, Vite 8, Cesium 1.145 and new CI checks.

### Added

- Publish tagged releases. Pushing a `vX.Y.Z` tag runs the CI checks, checks
  the tag against `package.json` and publishes a GitHub Release whose notes
  are that version's section of this changelog. A manual run previews the
  notes without publishing, and CONTRIBUTING lists the release steps.

- Run the browser QA nightly, and on demand from the Actions tab. The QA
  workflow starts the dev server without keys, runs `pnpm run test:track`
  and a list of QA harnesses headless with SwiftShader, and keeps their
  screenshots. Every harness now finds the app at `GEV_QA_URL` (default
  `http://localhost:4173`) instead of its own hard-coded port; `--url` still
  overrides it.

- Scan the code and the supply chain. CodeQL analyzes the JavaScript and the
  GitHub workflows on every push to main and weekly, OpenSSF Scorecard checks
  the repository's practices weekly, and both report under Security → Code
  scanning. Dependency review checks every push to main and every pull
  request for new dependencies with known vulnerabilities.

- Measure test coverage in CI. The Node 24 job runs its tests under Node's
  coverage and writes the line, branch and function totals to the job
  summary, by area, with the largest source files no test loads and the
  least-covered ones; lcov.info is kept as an artifact for 30 days.
  `pnpm run test:coverage` does the same locally. There is no threshold yet.
  Coverage makes the Node 24 job about a minute slower, so it is now CI's
  longest, at a little over two minutes.

- Separate optional Google server credentials for Places and Street View from
  the browser key, contributed by Tom-Neverwinter (#110). Provider Settings,
  Pinokio's app-specific credential handling and setup diagnostics recognize
  both keys. The Street View tool prefers the server key across environment
  and `.env` sources. Existing single-key and keyless setups remain supported.

- Datacenter and dam factories are available through scoped package exports with
  explicit context, overlay and render callbacks. The standalone app uses the
  same implementation and bundled datasets.

### Changed

- Run the allocation microbenchmarks in their own CI job, in parallel with
  the test jobs, instead of after the Node 24 job's tests, so push CI
  finishes about half a minute sooner. `pnpm test` still runs everything,
  and `pnpm run test:allocations` runs only the microbenchmarks.

- Give every unit test a 60-second deadline, and stop a timed-out test's
  leftover timers or sockets from keeping the run alive, so a hung test
  fails within a minute instead of holding CI until the job's time limit.
  The Windows job also runs the Provider Settings hardening tests, including
  the one that applies a real DACL with Windows' own tools, which every other
  job skips.

- Sort imports in the adopted files with Biome's organize-imports assist,
  checked by `pnpm run lint` and applied by the pre-commit hook.

- Enable Biome's recommended lint rules for the adopted files. `pnpm run lint`
  in CI and the pre-commit hook fail on warnings as well as errors. Fix the
  findings: unused layer parameters, conditions that read better as optional
  chains, a `forEach` callback that returned a value and a test variable that
  shadowed the global `escape`.

- Replace vite-plugin-cesium with a local Vite plugin that keeps its behavior:
  development serves Cesium's unminified build at `/cesium/`, and builds load
  the global `Cesium.js`, rewrite `cesium` imports to it and copy its runtime
  files. The build no longer depends on Rollup 2 or the deprecated
  sourcemap-codec package.

- Upgrade Vite 6 to 8, CesiumJS 1.138 to 1.145, satellite.js 6 to 7 and mgrs to
  their latest releases, and CI's checkout and setup-node actions to v7. Vite
  now bundles workers as ES modules, which satellite.js's optional WASM
  propagator requires even though the app does not use it. The Cesium 1.139–1.145
  breaking changes do not touch any API the app uses.

- Replace Prettier with Biome for the adopted formatting scope, now listed in
  `biome.json`, and manage dependencies with pnpm 11 instead of npm. Installing
  sets up a Lefthook pre-commit hook that formats staged adopted files, and
  Dependabot opens weekly grouped updates for npm packages and GitHub Actions.
  Biome does not format Markdown, so the two adopted documents left the scope.

- Extract application lifecycle and viewer exports. Split standalone startup into
  scene setup, controls, layer registration, tools and loading UI. Startup failure
  and terminal shutdown release acquired resources and cancel delayed work.

- Adopt Prettier tooling contributed by RohanDaCoder (#227), with an explicit
  file scope, pinned formatter and Linux/Windows CI checks. Format the reusable
  infrastructure modules and their consumer tests. Package boundary checks keep
  those exports separate from app startup and local Node services.

- Datacenter and dam marker stems use bounded, zoom-dependent active sets with
  stable selection during camera motion. Close-up stems scale to the actual
  camera distance; source totals and submarine cables remain unchanged.

- CCTV testing uses the normal launcher for keyless startup, credential loading,
  localhost binding, and explicit LAN-exposure warnings while retaining its
  smaller source-pack limits.

- Visual presets explain their effects on hover. Unavailable map sources name
  missing credentials and Provider Settings, while configured-but-failed
  Google 3D routes explain the failure without asking for another key.

### Fixed

- Earthquake refreshes validate the complete feed and build the replacement
  entities before clearing the previous snapshot. Malformed rows and duplicate
  rendered IDs keep the last good entities, overlays, count and timestamp and
  report a malformed response; unknown magnitude is excluded from M2.5+
  rendering. Non-object or array-valued properties reject the response instead
  of being treated as an unknown magnitude.

- Launch payloads with missing records now say PAYLOAD DATA UNAVAILABLE.
  Missing names use Unnamed payload; absent or invalid mass stays unknown
  instead of appearing as 0 KG.

- Move focus out of the first-run launcher before hiding it. It set
  `aria-hidden` while the button you had just used still held focus, so
  Chrome logged a warning and a screen reader could be left on hidden
  content. When the launcher steps aside for another surface, focus leaves
  it first there too, and the closing card is now `inert`.

- Stop downloading the 2.8 MB geoid grid during startup. The HUD asked for it
  on its first update, and the flight, military and vessel layers as soon as
  they were turned on, while the globe was still loading. They now fetch it
  once the page is idle, five seconds at most, and show uncorrected heights
  until it arrives, as they already did while it loaded.

- Stop re-propagating satellites whose element sets have decayed. SGP4
  fails for good on a decayed or malformed TLE, and satellite.js then
  returns no position, but the layer read one anyway: every such satellite
  threw, and was caught, on every tick. A satellite that fails is now skipped
  until the next TLE refresh, and the layer's stats count them. The fleet
  loops also reuse their scratch positions instead of allocating per
  satellite.

- Turning a layer off now cancels its refresh. The manager's timed refreshes
  had no cancellation signal, so an earthquake or fire refresh still loading
  when its layer was turned off went on to draw its results. Each time a
  layer is turned on it gets a signal that turning it off aborts; the
  earthquake and fire layers pass it to their fetches and draw nothing once
  it is aborted.

- A layer that only lacks its API key no longer ends a load as LOAD FAILED.
  The status banner reads KEY REQUIRED, names the key ("Needs
  FIRMS_MAP_KEY"), and on a local dev server offers an ADD KEY button that
  opens Provider Settings. NASA FIRMS on a first run without a key was the
  common case. A real failure in the same load still reads LOAD FAILED.

- Stop the Satellites layer from keeping the render loop busy while it shows
  nothing. It held continuous rendering whenever it was on, and Space
  Missions keeps it on with its dots and orbit rings hidden, only to look up
  orbits. It now holds only while its dots or rings are shown or a satellite
  is being followed.

- Give the app's own API calls a deadline and a status check. The geocoder
  parsed a failed response as if it had succeeded, and it and nine other
  calls (CCTV sources and health, flight type lookups, rocket launches and
  their satellite catalog, the TomTom status check, the radio click count and
  the voice connection) could wait forever. A shared fetchJson helper covers
  most of them; the rest take a deadline directly.

- Keep the military-aircraft registry from growing all session. It kept
  every military aircraft the adsb.lol feed had ever listed. An aircraft no
  poll has listed for six hours now drops out, and the registry holds at most
  4,096, forgetting the least recently seen first.

- Show the "panel layout updated" notice to everyone whose saved panel
  positions were reset. It only looked for positions saved under the v6
  storage key, so anyone coming from v7 never saw it, and positions saved by
  older layouts stayed in localStorage for good. Positions saved under any
  older version now bring up the notice once and are then deleted.

- Keep keyboard focus rings whole in scrolling panels. Tabbing to a control
  at the top or bottom of a scrolling list scrolled it flush with the edge,
  which cut off its ring on that side: the scene controls, saved shots and
  Provider Settings rows. Focusable controls now keep a 6-pixel scroll
  margin. An audit of every control found that each one gets a visible ring.

- Saving keys in Provider Settings on Windows no longer fails when the dev
  server runs under PowerShell 7. Before writing a key, the server checks
  that the credential file is restricted to your account. That check used
  Windows PowerShell's Get-Acl, which loaded PowerShell 7's copy of its
  module from the inherited module path and failed, so the save was
  refused. The check now reads the ACL through .NET without that path, and
  a refused save logs which step failed.

- Fix what CodeQL's first scan found. The synthetic CCTV frame's clock
  ended in a stray period instead of a Z, and regional news titles decoded
  `&amp;` before the other entities, so a title escaped twice was decoded
  twice. The AIS stream notices a key change without keeping a hash of the
  key, the voice debug log's session IDs come from
  `crypto.getRandomValues()`, the local screenshot sink answers errors with
  plain text on 127.0.0.1 only, and a CCTV QA harness passes camera IDs to
  the page as arguments instead of splicing them into code.

- Complete the first-run, view-target prewarm, cockpit-plates and floor-hold
  browser harness renderer portability fixes contributed by Tom-Neverwinter.
  macOS retains Metal; other platforms default to SwiftShader. Cockpit renderer
  assertions and evidence labels follow the actual selected mode. Floor-hold
  explicitly selects its measured 2D billboard mode and keeps its mesh and terrain assertions; software runs are not real-GPU evidence.
  First-run QA now checks the existing attribution Escape-close/focus-return
  behavior while preserving the launcher-underneath regression checks.

- Local GeoJSON layers share concurrent loads, cancel pending fetches on destruction,
  discard late results, and remove their entity-context records on teardown.

- Unchanged local infrastructure overlays no longer sustain idle rendering.
  Ground samples wait for visible terrain to settle and cannot place a marker
  below its loaded surface; roofs and valid below-sea-level heights are retained.
  Already sampled markers also follow higher terrain as close-up tiles refine.

- Keyboard focus rings now survive active/selected button styles across the
  interface. Visual Styles, Location cities and points of interest, search,
  Context/mission actions, Cockpit utilities, and sliders retain a distinct
  focus indicator.

- A short Space press activates a focused control only on key release. Holding
  Space for 500 ms blurs that control before push-to-talk starts, and release is
  then consumed so it cannot also activate the old control. The same hold works
  from the map or page background; text-entry controls remain protected.

- The Location disclosure is reachable with Tab and shows keyboard focus;
  its city, point-of-interest, and search controls do too. Escape from inside
  the tray returns focus to its disclosure and discards any unfinished search;
  Escape on the disclosure itself closes the tray and clears that focus.

- Data Layers ON/OFF buttons show a keyboard focus ring independently of
  their enabled and feed-status colors.

- Display buttons, layout selectors, mode buttons, and sliders show a visible
  keyboard focus ring, including the controls used in Cockpit Display. Enabled
  CCTV camera dropdowns also show keyboard focus.

- Context tabs keep a distinct keyboard ring when selected. Their existing
  Left/Right arrow navigation continues to switch Contacts and Space Missions,
  and both choices remain reachable through ordinary Tab navigation.

- Tabbing through the Space Missions roster now drives the same temporary globe
  rotation and mission-marker highlight as pointer hover, without selecting the
  mission. Keyboard and pointer previews no longer cancel each other.

- Radio power controls, Search Nearby Sites, and Clear Selected Layers retain
  keyboard focus while their async work is busy. They expose that busy state to
  assistive technology and ignore repeated activation until the work settles.

- Live Contacts results retain keyboard focus by contact identity when counts,
  distance order, or pages refresh. If a focused contact departs or rotates off
  the visible page, focus moves to the named explanatory note at the end of the
  list and survives later refreshes there, so the next Tab proceeds beyond the
  list instead of restarting at Contacts or silently selecting another contact.

- Cockpit Live Signals retains keyboard focus during live updates and contact
  reordering, allowing Tab to continue to Display and Radio. If the focused
  contact leaves the list, focus moves to the current briefing tab.

- Cockpit-only Display and Radio launchers show complete inset focus rings.

- Escape collapses the nearest expanded panel containing keyboard focus and
  returns focus to that panel's disclosure when closing from its contents.
  Escape on the disclosure itself closes without leaving the collapsed control
  focused. Cockpit Contact and Live Signals panels follow the same nesting rule.

- Cesium's bottom-left Data attribution control and lightbox Close control are
  in the Tab order and support Enter and Space. Close, Escape, and backdrop
  dismissal restore focus and synchronize the disclosure state.

- Map Source keyboard opening retries focus until the selected tile is visible.
  Leaving the disclosure, pointer interaction, or closing the tray cancels the
  pending handoff so delayed work cannot pull focus back.

- Scope, Bloom, Sharpen, location search and generated style sliders expose
  explicit accessible names. The first-run checkbox retains its native label.

- FIRMS records a source as successful only after appending its rows, avoiding
  contradictory success/failure status if aggregation throws.

- Radio country filtering and voice country requests now resolve common English
  names and exonyms that `Intl.DisplayNames`' primary label omits, so requests
  like "play radio in Turkey" no longer fail closed (Turkey → Türkiye, plus
  Myanmar/Burma, UAE, Holland, Swaziland, East Timor, Cabo Verde, Vatican).
  Ambiguous names such as a bare "Congo" or "Korea" still fail closed.

- Mapped-site outages show their scheduled retry countdown and distinguish
  known Overpass rate limits, timeouts, and query failures. Search feedback no
  longer claims a refresh succeeded while the layer is unavailable or loading.

- Mapped installations retain valid ways and relations that provide bounds but
  no center. Invalid, inverted, and excessively wide bounds are rejected.

- Clicking a selected installation again or clicking elsewhere clears its
  selection; later refreshes no longer reclaim it after a click-away.

- The Overpass proxy now rotates to the next mirror on any non-2xx upstream
  response, not only on 5xx. `overpass-api.de` and its `lz4` alias answer 406 to
  the proxy's User-Agent while two of the configured mirrors answer 200 to the
  identical request, so the fan-out stopped at the first refusal with healthy
  mirrors untried. The refusal was also cached to memory and disk and served as
  data — boundary-class queries hold a month-long TTL — which affected every
  Overpass-backed feature: road geometry, annotation outlines and place lookup.

- Existing cached refusals are now ignored immediately, including during
  stale-data fallback. Concurrent identical requests share the same last-good
  fallback when all mirrors refuse, without duplicating upstream requests.

- CCTV cameras without a live feed no longer request a new, billed Google
  Street View image on every 10–60 second refresh. Street View fallback frames
  are cached for 30 minutes per camera pose, keeping at most 64, so repeated
  refreshes reuse the frame instead of asking Google again.

### Security

- Pin every GitHub Action in CI to a full commit SHA, with its version in a
  comment, instead of a tag such as `@v7` that can be moved to other code.
  Dependabot's weekly updates move the SHA and the comment together, and a
  test fails if a workflow uses an unpinned action.

- CelesTrak, Launch Library, terrain-height, and aircraft-enrichment failures
  return generic error messages. Related diagnostics omit raw exception details
  and upstream error bodies; response statuses and cache fallback remain intact.
  Includes the security fixes contributed by Tom-Neverwinter in PR #171.

- Refresh vulnerable transitive dependencies and update browser/image tooling
  to Puppeteer 25.10.0 and Sharp 0.35.4.
  Browser QA awaits the new asynchronous executable-path lookup.

- Refuse cross-site requests to the dev server's `/api` routes. While the
  server ran, a page from another website open in the same browser could call
  them. That could spend the configured Google and OpenAI quota and write to
  the voice debug log. Browser requests must now come from the app's own
  origin, and request bodies must be JSON; the Overpass proxy keeps its
  form-encoded queries. Scripts and other non-browser clients are unaffected.

- Rate-limit the routes that spend provider quota by default: 30 OpenAI and
  120 Google requests per minute per client IP. `GEV_RATELIMIT_OPENAI_PER_MIN`
  and `GEV_RATELIMIT_GOOGLE_PER_MIN` still change the limits, and `0` or `off`
  turns one off. An unreadable value now keeps the default instead of
  removing the limit. The CCTV Street View fallback, which had no limit, gets
  its own Google budget and shows the synthetic frame once it's spent.

- Turn off Vite's default CORS for the dev and preview servers. It let a page
  on any other localhost port read API responses, including the voice
  session's short-lived OpenAI token, and any file the server serves. The dev
  server also stops serving `.gev-logs/` (voice debug transcripts),
  `.gev-cache/` and `.claude/`, which were readable over HTTP.

- Make the voice debug log opt-in. Every voice session used to be recorded
  to `.gev-logs/realtime-conversations.jsonl`, trusting the browser to redact,
  with 8 MiB records, no size limit, a world-readable file and parser errors
  echoed back. It is now off unless `GEV_REALTIME_DEBUG_LOG=1`, and the
  browser posts nothing while it's off. When on, the server redacts every
  record, caps records at 256 KiB, rotates the file at 20 MB keeping one
  previous file, makes it readable only by your user, and returns generic
  errors.

- Keep Vite's Host check on in LAN mode. `HOST=0.0.0.0` used to turn it off,
  and local mode accepted any `.local` name. That left the API routes open to
  DNS-rebinding attacks while the server was reachable from the network. Both
  modes now answer only IP addresses, `localhost`, this machine's hostname
  and `<hostname>.local`, plus names listed in the new `GEV_ALLOWED_HOSTS`.

- Bound the server's caches. The terrain-heights cache kept every point any
  client asked for, and the adsbdb cache every aircraft and callsign. They
  now keep at most 20,000 points and 5,000 of each, dropping the oldest. The
  disk caches that gain a file per query are pruned by age and size at
  startup and after writes: Overpass 90 days and 64 MB, military
  installations 90 days and 32 MB, TomTom tiles one day and 64 MB. TomTom's
  daily request budget file is never removed.

- Put a deadline on every upstream call. Nine had none: the OpenSky token and
  states, CCTV media, adsb.lol, two OpenAI calls and two Google Places
  searches, so a stalled provider could hold a request open indefinitely. They
  now answer 504 when the deadline passes, and a call made for one browser
  request stops when that browser disconnects. The routes also stopped
  relaying OpenAI's, Google's and the data feeds' own error text, and
  exception messages, to the browser: they answer in their own words and log
  the details on the server.

- Harden the CCTV proxy. It relayed whatever a camera URL returned, HTML and
  SVG included, from the app's own origin, and it followed redirects
  anywhere, so a camera host could point it at a private address such as
  `169.254.169.254`. It now relays only images, video and HLS playlists,
  marked `nosniff` and with a sandboxing Content-Security-Policy. It follows
  at most three redirects itself: a camera from the Austin, Caltrans or TfL
  feeds, or a redirect away from a configured camera's own origin, must
  resolve to public addresses, and the connection is pinned to them. Cameras
  in your own `CCTV_SOURCES_FILE` or `CCTV_SOURCES_JSON` can still be on your
  network.

- Keep API keys out of process argument lists, where `ps` and process
  monitors can read them. `scripts/dev-fresh.sh` passed every configured key
  to `env` as a `KEY=value` argument until the dev server started, and
  `scripts/opensky-import-client.sh` passed the OpenSky client ID and secret
  to `security`. The launcher now exports the keys and starts the server
  itself, and the import script hands the values to `security -i` on stdin.

- Cap every upstream response the proxies read. CelesTrak, TomTom tiles,
  FIRMS, adsbdb, GBFS, the CCTV camera lists, CCTV and Street View frames and
  terrain heights were read whole, however large, and an AISStream message
  could be up to 100 MiB; it is now capped at 1 MiB. GBFS's deadline now
  covers the whole response, not just its headers.

- Answer an oversized Provider Settings save with 413. The server reset the
  connection instead, so the browser never learned why the save failed.

- Build the POI pills and the data-layer rows from DOM nodes. Both put a
  name into `innerHTML`; the names are local today, but a name from a remote
  source would have been parsed as markup.

- Turn on private vulnerability reporting for this repository, and point
  SECURITY.md at it instead of the upstream repository.

## [0.1.1] - 2026-09-01

Installation and live-data fixes.

### Changed

- Tightened the README opening around keyless setup, source freshness, modeled
  experiences, and the accessibility of the provider stack.

### Fixed

- Pinokio now recognizes its nested successful-install marker, so a completed
  one-click install exposes Start instead of returning to Install.
- The keyless `dev-fresh.sh` startup summary now names Esri World Imagery with
  keyless terrain and identifies OpenStreetMap as the fallback.
- All three VIIRS sources now reach the Active Fires layer. Merging a source's
  detections used argument spread, which exceeds the engine's argument limit on
  the two largest sources and dropped them entirely — leaving roughly a third of
  global detections while reporting each dropped source twice, once as
  successful with its real count and once as failed.
- `./scripts/dev-fresh.sh` no longer crashes on stock macOS bash 3.2 when no
  provider keys are exported: expanding the empty external-keys provenance
  array under `set -u` was fatal there. Launches with exported keys are
  unchanged.

### Security

- GBFS proxy body-size cap now measures the response in bytes
  (`Buffer.byteLength`) instead of JavaScript string length, so the
  `GBFS_MAX_BODY_BYTES` limit holds for multi-byte payloads and cannot be
  overrun by non-ASCII upstream responses.

## [0.1.0] - 2026-08-31

One-click install, keyless boot and Provider Settings.

### Added

- **One-click install** via Pinokio. Keyless boot lands on a live Esri World
  Imagery satellite globe with keyless terrain; OSM takes over automatically if
  Esri is unreachable, and the globe continues without terrain if its source is
  unavailable.
- **Provider Settings** (the POWER UP panel): add, replace, or remove API keys
  inside the app. Credential files are made owner-only before any secret is
  written — verified on macOS and Windows — and keys configured outside the
  panel are shown read-only, never rewritten.
- **Keyless capability responses**: the optional HUD summary and place-search
  endpoints return a deliberate "not configured" success instead of errors, and
  never consume rate-limit quota.
- `.gitattributes` normalizes line endings, so Windows clones pass the full
  test suite out of the box (#81 — thanks @ethanstoner).

### Changed

- README rewritten keyless-first around the provider ladder: zero keys → free
  Cesium ion (eligible personal, non-commercial use) → billing-enabled Google
  Maps.
- Browser-built data modules no longer import `node:fs`; a repo-wide boundary
  scan test keeps it that way (#83 — thanks @ethanstoner).
- Aircraft-identity voice answers explicitly cover operator, type, and route,
  and say so plainly when enrichment is unavailable instead of guessing.

### Security

- Provider Settings answers only local, unproxied requests and disables itself
  entirely whenever the server is shared. Public datacenter and dam datasets
  omit contact-oriented fields (see the dataset READMEs).

## Pre-release history

These entries predate the first tagged GitHub Release. They are kept as
project history and were never published as releases. The February 2026
entries used an earlier prototype numbering; the published releases started
again at 0.1.0.

### 2026-08-24

#### Added

- Added honest aircraft identity narration: callsign, operator, registration,
  type, and route come only from selected-contact context, and missing operator,
  route, or type enrichment is named explicitly.
- Added local, publication-compatible copies of the two README PNGs, with source
  records and third-party-license boundaries in `docs/media/README.md`.
- Added regression coverage for aircraft identity narration and optional-key
  loading feedback.

#### Changed

- First-run presentation now opens with Detection `DENSE` at 75%, `ELASTIC`
  allocation, Fade 7%, Outside 1%, scope feather 11%, and aircraft 3D models in
  `PROXIMITY`. Stored state and share links still override these baselines.
- The 17 selected README GIFs remain unchanged and are documented separately
  from the two owner-published PNGs.
- Bundled datacenter and dam snapshots now omit contact-oriented fields and
  note values containing email or phone identifiers. Feature geometry, names,
  operator/capacity/river metadata, counts, and ODbL terms are unchanged.
- Public documentation and the L9 release matrix no longer reference non-public
  planning material or repository history.

#### Fixed

- A missing optional FIRMS key no longer turns the complete Environmental
  mission into `LOAD FAILED`. The FIRMS row still reports `KEY REQUIRED`, while
  earthquakes continue to load. Real lifecycle and fetch failures retain
  failure priority.
- The mapped-installations layer retries after an unavailable request when it is
  enabled or the camera settles.
- Aircraft trails attach to the rendered aircraft transform and remain near the
  rear center across headings. Parked aircraft do not draw a moving head
  segment.
- Grounded aircraft keep validated floor evidence through temporary terrain
  outages and wait for measured photoreal-surface evidence before a 3D model
  takes over from its billboard.
- Cockpit altitude uses aviation MSL data rather than Cesium render height.

#### Security

- Production transitive dependencies resolve to patched DOMPurify and
  protobufjs releases without changing the Cesium version or application APIs.
- Production dependency audit reports no known advisories; remaining audit
  findings are confined to development and QA tooling.

### 2026-08-23

#### Added

- Added a first-run mission launcher for Contacts, Space Missions,
  Environmental, and manual exploration.
- Added terrain-validity gating and bounded last-known placement for grounded
  aircraft models.

#### Changed

- Environmental consistently presents both earthquakes and NASA FIRMS fires,
  with honest optional-key degradation.
- The tracked aircraft trail acceptance bar is visual: roughly rear-center,
  stable across headings, with minor hull overlap allowed and no conspicuous
  top, bottom, or lateral projection.

### 2026-08-18 to 2026-08-22

#### Added

- Added the four-source Map Source tray, share-link v2 state, cockpit/context
  voice parity, MSL altitude readouts, and close-range tracked aircraft models.
- Added the L9 release-candidate matrix, AIS feed watchdog, voice cost controls,
  satellite classes, and the shared world-overlay host.
- Added deterministic first-run, map-source, floor, overlay, tracking, and
  aircraft-model regression harnesses.

#### Changed

- Consolidated world labels, cards, tracked readouts, CCTV thumbnails, cable
  labels, mission labels, and detection presentation under shared allocation and
  lifecycle rules.
- Reduced idle rendering through the render governor and explicit scope mask.
- Improved cockpit layout, context restoration, keyless feed honesty, and
  aircraft 2D/3D handoffs.

#### Fixed

- Fixed degenerate depth picks, map-source restore states, route-camera motion,
  bright-ground label readability, grounded display flooring, and cross-layer
  tracking cleanup.
- Fixed stale overlay callbacks, parked-idle render leaks, cable-label sweep
  starvation, and several share-link state conflicts.

### 2026-08-02 to 2026-08-16

#### Added

- Added Global Context modes, Cockpit briefing surfaces, Radio context,
  satellite mission replay, and real per-class aircraft models with adjacent
  provenance records.
- Added a shared screen-space overlay system with bounded allocation for labels,
  cards, callouts, detection brackets, and selected-object presentation.

#### Changed

- Unified right-side product controls and responsive cockpit/map layouts.
- Migrated public-safe neighborhood geometry to DataSF and tightened safe local
  development defaults.
- Improved proxy resilience, annotation outline bounds, CCTV enable pacing,
  contact de-emphasis, and deterministic visual stacking.

### July 2026

#### Added

- Added live NASA FIRMS fires, optional live TomTom traffic, Caltrans and TfL
  CCTV packs, CCTV viewsheds and direct-manipulation calibration, citywide CCTV
  cards, Natural Earth regions, analyst queries, and voice routing QA.
- Added the end-to-end vertical-datum system for aircraft, vessels, CCTV,
  annotations, trails, and terrain-aware rendering.
- Added aircraft class silhouettes, path-derived display heading, ADSBDB
  enrichment, cached CelesTrak TLE lookup, and next-ISS-pass prediction.

#### Fixed

- Fixed elevated-airport aircraft placement, vessel sea-surface placement,
  close-zoom FIRMS anchors, antimeridian region framing, annotation resolution,
  cross-layer tracking ownership, and CCTV projection lifecycle issues.

#### Milestone notes

These dated notes moved here from `docs/CURRENT-STATE.md`.

- **2026-07-02 milestone:** the skylight aircraft/satellite/enrichment work and
  pre-ship hardening fixes landed.
  Runtime changes: **voice tools 17→20 at the 2026-07-02 milestone** (`next_iss_pass` + the 19 already on
  main), type-aware 8-class aircraft sprites + path-derived rate-limited display heading, adsbdb
  flight enrichment (cached proxy + route-plausibility gate), disk-cached CelesTrak TLE proxy,
  ISS pass prediction, and per-layer data attribution. Gate at close: unit 98/98, build clean,
  track 19/19, + five QA harnesses (heading 16/16, sprites 9/9, cctv 5/5, failstate 5/5,
  attribution 18/18). New modules: `src/data/{motionModel,aircraftMeta,aircraftClass,aircraftIcons,issPass,routePlausible,dataCredits}.js`.
  The live runtime now declares 28 voice tools; the 17→20 count above is retained only as milestone history.
- **Height-datum test surface:** `pnpm test` 184 unit · `pnpm run
  test:track` 43 tracking invariants · headless QA harnesses under
  `scripts/qa-*.mjs` incl. `qa-height-datum.mjs` (numeric heights) and
  `qa-floor-verify.mjs` (any-airport ground-truth oracle).
- **2026-07-16:** the FIRMS Active Fires layer is **LIVE** —
  the bundled 2026-05-25 snapshot (58 MB) is deleted; a new `/api/firms` proxy
  (vite.config.js) merges VIIRS NOAA-20/NOAA-21/Suomi-NPP NRT world CSVs
  (days=2 → trailing-24h clamp, 30 min memory+disk cache, single-flight,
  serve-stale-on-failure) behind server-side `FIRMS_MAP_KEY` (keyless → 503 +
  in-app KEY REQUIRED chip). Client polls 10 min (`src/data/firmsHeatmap.js`;
  adapter `src/data/firmsAdapt.js`, CSV parser `src/data/firmsCsv.js`).
  `/api/firms/status` reports cache age + MAP_KEY transaction usage.
- **2026-07-16:** Traffic supports optional live
  TomTom flow through the server-side, budget-governed `/api/tomtom` proxy;
  keyless installs retain the byte-identical white-dot simulation.
- **2026-07-22 (CCTV v3 Parts A+B):** replay, color-coded viewsheds,
  save-gated direct-manipulation calibration, `viewshed`/`adjust` voice
  actions, shared-floor E/N drag grounding, and bounded snapshot requests are
  integrated. Citywide static-plane LOD/pacing work remains outside runtime.

### June 2026

#### Added

- Added OpenAI Realtime voice control, scene-aware entity context, viewport image
  grounding, the AI HUD summary, live AIS vessels, infrastructure layers, map
  source switching, free-text navigation, and server-side data proxies.
- Added hybrid map annotations, 3D aircraft, panoptic detection, tracking
  harnesses, and public data attribution.
- Added MIT source licensing, security guidance, contribution guidance, data
  source notices, and third-party asset boundaries.

#### Changed

- Removed the experimental AI video-edit style and retained seven deterministic
  visual styles.
- Moved Realtime text-history trimming to the server-side retention policy while
  keeping only the latest viewport image in conversation context.

### Prototype 0.7.0 - 2026-02-18

- Added the Bikeshare Pulse layer and panoptic label improvements.
- Improved tracked-item boxes, post-render alignment, and CCTV projection
  quality.
- Removed the experimental shift-drag CCTV calibration interaction.

### Prototype 0.6.0 - 2026-02-10

- Added the initial multi-layer 3D globe experience, visual styles, live
  aircraft, satellites, earthquakes, CCTV, traffic, FIRMS, infrastructure, and
  performance controls.
- Added entity inspection, tracking, scenes, keyboard controls, and shareable
  views.

### Prototype 0.1.0 - 2026-02-09

- Initial project version.
