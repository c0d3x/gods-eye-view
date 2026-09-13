# Application, operations and tooling

Part of the [runtime reference](../CURRENT-STATE.md): startup and shutdown, the render governor, operational notes, formatting and package checks, and the dependency baseline.

## Application startup and shutdown

The standalone entry now composes scene setup, controls, layer registration and
tools through the reusable application lifecycle. Map defaults, layer order,
share restoration, voice setup and the running debug handle retain their behavior.
The welcome card still waits for restoration and the loading-cover transition.

Startup failure cleans up acquired resources. Explicit application destruction
aborts construction, cancels pending playback/annotations and delayed welcome UI,
then releases controls, layers and the viewer. Destruction is terminal; the
standalone page must be reloaded to start again. The exported lifecycle and viewer
helpers do not import the standalone entry or discover configuration. See
[application construction](../APPLICATION.md).

## Performance and the render governor

**2026-08-08 — performance waves 1+2:** the app idles via an explicit render
governor (`src/renderGovernor.js` — hold/release from every per-frame
animator; discrete mutators call `governorRequestRender`). Any NEW
per-frame visual animation MUST register a hold; any new discrete scene
mutation MUST request a frame — `scripts/qa-perf.mjs` is the gate. The
circular scope is an explicit canvas (`src/scopeMask.js`, DISPLAY-rail
SCOPE toggle + FEATHER slider, hash keys `sc`/`scf`) — it is NOT the
six zero-intensity style stages anymore (those are disabled; see the
history note in `_initStages`). Hidden tabs stop the render loop.
The scope's OUTSIDE terminus is **altitude-adaptive** (2026-08-17): 0.94
at/above **10 Mm**, so
faint stars survive in the corners of a TRUE full-globe view, fading quickly
(smoothstep) to fully opaque by **7 Mm** — every working altitude below that
is solid black, because there the same 6% bleed reads as smeared geometry.
FEATHER is unaffected by the terminus ramp and there is NO new slider (its own
default later moved 35 → 0 on 2026-08-22, 0 → 8 on 2026-08-23, and 8 → 11 at
the 2026-08-24 final lock; see Current
Global Post Defaults); hash key
`sce` pins the terminus and is **clamped to 94..100 on BOTH parse and write**
(out-of-range clamps into the band; absent or non-numeric = the adaptive
default), so a shared link can neither freeze the ramp by accident nor carry
an unsupported sub-94 terminus. Repaints are gated on a quantized 0.005 alpha
step, so a full 20 Mm→ground descent costs 12 canvas repaints (the alpha span
sets that, not the altitude span) and a parked camera costs zero. That
quantization also means the PAINTED value plateaus at each end of the band:
measured, the painted terminus stays 0.94 from the top of the band down to
~9.63 Mm (first step), and is solid black from ~7.37 Mm (last step) rather
than exactly at the 10 Mm / 7 Mm clamp heights. SCOPE OFF costs less still:
no height sampling and no canvas work after the single clear on the disable
transition. The hard-crop (FEATHER 0) path honors the same terminus.

## Operational Notes

- **Earthquake discs are STATIC geometry.** Every quake is a `CLAMP_TO_GROUND`
  ellipse; a `CallbackProperty` axis re-tessellates its ground primitive every
  frame, which cost 32.4 ms/frame and 30 fps on the shipped 58-event feed. The
  axes are plain numbers, redefined only when a poll brings new data, and the
  former ±15% radius pulse is gone. Because nothing in the layer animates
  per frame, it holds NO continuous-render hold — the governor stays idle with
  earthquakes on, and the manager's `layer-tick` / `layer-visibility` requests
  carry new data to the screen. Pinned in `src/data/earthquakes.test.mjs`.
- **Geocode framing has an off-centre sanity gate.** A viewport that is both
  bigger than any city (>300 km diagonal) and not centred on its own geocoded
  location (anchor >15% of the diagonal from the centroid) is replaced by a
  40 km metro box on that location. This is what stops "Tokyo" — which geocodes
  as the PREFECTURE, islands and all — from framing open Pacific. `country`
  results are EXEMPT by decision (several have the same pathology from overseas
  territories; reframing a country is a product decision, not a bug fix), and an
  explicit `viewMode: 'overview'` ask bypasses the gate entirely so "show me an
  overview of Hawaii" still frames the whole administrative area.
- **Viewport framing is antimeridian-safe.** `flyToViewportBounds` pads from the
  short-way-round longitude span and wraps the padded edges, so a dateline-
  crossing box stays its true width. Raw subtraction inflated a 0.41° metro box
  to 86.7° and a 60° territory to 132°.
- CCTV calibration persists at `godsEyeView.cctv.calibration.v2` (v2 rebuild;
  the store was wiped clean, no import from the old `v1` key).
- CCTV v3 floor QA pins are: zero samples for heading-only edits; zero transient
  samples and constant elevation during E/N drag; one shared-floor resolution on
  release; late one-shot shared-cell work is permitted during viewshed idle. The
  A+B harness intentionally excludes citywide LOD assertions.
- Draggable panel positions persist at `godsEyeView.v8.panelPos.<panel-id>` (collapsed states at `godsEyeView.v6.panelCollapsed.<panel-id>`).
- Startup deletes panel positions saved under an older version (`src/panelLayoutStorage.js`), and the first load that finds any shows a one-time "Panel layout updated" toast. Collapsed states are versioned separately and are kept.
- Flight/military tracked entities cache dead-reckoned positions per frame to avoid callback desync flicker.
- Aircraft 3D-model and tracking invariants are covered by `pnpm run test:track`; run this before touching `flights.js`, `militaryFlights.js`, `detection.js`, or `trackedReadout.js`.
- Annotation resolver behavior is pinned by `src/annotations/annotationResolver.test.mjs`; re-run that suite before changing place-resolution scoring.
- Layer input handlers (click + keydown) are detached on disable for flights/military/satellites/AIS vessels.
- Traffic tile cache is capped and traffic layer supports explicit destroy cleanup.
- Traffic feed state is honest about simulation. `getStats().mode` is the
  CONFIGURED source ('live' = a TomTom key is present, 'sim' = keyless), NOT
  this instant's health — health rides on `error`. Keyless reads FALLBACK with
  `SIMULATED — add TomTom key for live` in both the sync chip and the panel
  meta line; an unreachable `/api/tomtom/status` reads
  `SIMULATED — traffic service unreachable`; a total flow-fetch failure in live
  mode sets `error` (DEGRADED · `SIMULATED — <reason>`) and zeroes the stale
  coverage number. `stats.loading` covers outstanding flow work as well as the
  road fetch, so a failure landing after the 250 ms paint race still ends the
  shared loading batch as LOAD FAILED. Harnesses must gate on `!stats.error`,
  never on `mode === 'live'` alone.
- Traffic runs in `sim` mode (white dots, hardcoded speeds) unless `TOMTOM_API_KEY`
  is configured (env or Keychain `tomtom-api`/`api-key`), which enables `live` mode:
  TomTom flow vector tiles via the budget-governed `/api/tomtom` proxy
  (`.gev-cache/tomtom/`, 120 s TTL, `TOMTOM_DAILY_TILE_BUDGET` default 40k/day),
  decoded client-side (`flowTiles.js`), matched onto Overpass roads
  (`flowMatch.js`), and rendered as green/amber/red dot color + speed/density
  scaling (`trafficFlowStyle.js`); closures spawn no dots; unmatched roads stay
  white. Road fetch bounds center on the camera look-at point (`trafficBounds.js`).
- Development captures opened with `?trafficDebug=1` mint an interaction anchor
  from the exact `camera.changed` event that arms each debounced load, then emit
  scheduling-correlated User Timing entries for production `response.json`, road
  parse, flow-race, dot construction, heat-line rebuild, and next-post-render
  boundaries. Every trace is paired with the exact camera-change that scheduled
  its load; mismatches are counted drops. Cesium's `moveEnd` remains a diagnostic
  mark only: it arrives about 500 ms after stillness, typically after fetch has
  begun, and fetch never waits for it. Production builds remove the flag, hooks,
  counters, and timing labels.
- Voice debug log: `tail -f .gev-logs/realtime-conversations.jsonl` (gitignored).

Replay chase-camera updates run in Cesium `preUpdate` before scene traversal, preventing 3D-tile refinement stutter when the mission replay speed is reduced. Replay Ascent first gives the selected launch site a five-second tile-preparation hold before displaying the T-minus countdown. Replay ascent duration is mission-specific: disclosed insertion, SECO, or separation timing is compressed into the replay, while sparse records use reconstructed path length with bounded fallback timing instead of a universal fixed duration. Replay transitions directly from ascent to orbit; stage re-entry/recovery remains static contextual linework and is never a camera-tracked playback phase. The screen-space rocket/thrust symbol renders at 50% of its 92 × 138 px design box, while the separate callout text remains unchanged. Successful/upcoming selected missions show a current orbit marker: green for a reliable TLE match or amber and explicitly estimated when no live match exists. Failed launches show their source status and suppress live/estimated orbit markers and fallback rings. A retained Launch Library orbit is labeled as the planned target, an absent ascent is reported as unavailable, and replay-only controls remain hidden unless the selected mission has a rendered track; authoritative supplied trajectory points remain visible when present. Mission orbit primitives realign by model matrix each tick from the same current-GMST frame as their marker, preventing ring/marker drift; their host annotation reads the position cache updated in that same tick. During depth-dominant ascent segments, the replay rocket retains its last valid path-facing rotation rather than snapping toward the camera. Mission selection and replay overlays never call photoreal `sampleHeight()` from the render loop; the launch-zone ground primitive and precomputed surface-safe replay path avoid remote tile-refinement probes that previously caused a one-second globe texture pulse. The shared host replaces the former mission-label visibility churn and quadratic overlap loop; the layer's remaining frame sweep only culls native point/billboard geometry and refreshes selected UTC copy when its displayed second changes. Replay samples uneven path vertices by cumulative distance and normalizes camera-yaw easing to frame time.

Orbit replay framing uses one combined bounding sphere for Earth and every sample of the selected orbit. The camera derives its final range from that full envelope, while its look-at target retains a radial bias toward the moving vehicle rather than collapsing onto the singular Earth-center frame. Compact-orbit launchers therefore remain tracked during camera rotation, and highly eccentric transfer orbits still keep both the globe and their distant apogee arc visible. The orbital camera stays on one side of the mission's 3D orbit plane and uses the vehicle radial as visual up, so forward motion remains screen-left through polar/local-heading wraps instead of alternating left and right. The fixed-size cyan orbit dot retains one pixel scale throughout the pullback. While replay owns the camera, the selected launch-site host label is suppressed so it cannot duplicate or overlap the replay vehicle's DOM callout; cancel/completion restores it.

Mission ascent paths use a long cubic insertion transition that matches the incoming climb direction and the sampled orbit tangent. Because a Cartesian cubic can otherwise chord through the ellipsoid for some inclined insertion geometries, every blended sample preserves the original climb's smooth minimum-altitude envelope. This removes the artificial right-angle insertion corner and corresponding rocket heading snap without allowing the ascent path to enter the globe.

Insertion is source-aware: catalog-backed missions propagate the matched satellite to the historical insertion epoch. Projected missions have no authoritative historical phase, so their orbital plane starts over the launch site and follows a plausible launch azimuth—south-southwest for western North American sites and polar missions, eastward otherwise. The projected insertion advances only by the disclosed ascent duration or a ten-minute fallback, producing one continuous downrange climb into the forward orbit tangent instead of using UTC as an arbitrary phase and correcting through a 180-degree hook.

The reconstruction does not add a full revolution around Earth: ordinary launch vehicles use a gravity turn and downrange acceleration before orbital insertion, rather than spiraling around the planet during powered ascent.

At close range, the selected launch site's 500 m highlight is a single material-backed `GroundPrimitive` classified against both terrain and photoreal 3D Tiles. It has no fixed world-space height offset, so the translucent disc and rim remain draped across the rendered launch-site surface during tile refinement. A small render-state polygon depth bias keeps coplanar ring fragments above the photoreal mesh at low oblique angles without making the geometry float or drift.

The Space Missions roster prioritizes data-rich records using available mission, orbit, payload, trajectory, timeline, and recovery fields; launch time remains the tie-breaker.

When no live catalog track is available, the mission view marks the approximate orbital ring as `PROJECTED ORBIT` in purple and renders the ascent-to-insertion transfer in green; catalog-backed satellite orbits remain cyan.

The replay vehicle is a smaller solid cyan silhouette without the former orange flame; its initial pad anchor uses photoreal terrain, globe height, or launch elevation fallback so it remains above the surface during tile loading. Replay begins at a close launch-complex range so pad detail remains visible before the camera widens into the ascent context view. Its initial camera heading is perpendicular to the ascent/orbit direction for a profile view, then eases into tangent tracking. Small screen-space reprojection changes are damped for the animated marker on both ascent and orbit, while large camera or phase changes snap to the authoritative path position.
Space Missions keeps the Satellite layer available for catalog/TLE matching but suppresses its standalone fleet points and orbit rings. While those visuals are hidden, their per-frame dense propagation, one-second core point-buffer rewrite, and one-second orbit-matrix rotation are suspended; selected mission telemetry continues to propagate independently. The selected mission's live or estimated satellite marker uses fractional wall-clock time, so it moves continuously rather than creating a once-per-second position discontinuity and one-frame photoreal globe LOD pulse.

During ascent replay, the camera, Cesium callbacks, and HTML vehicle overlay share one replay sample per rendered frame. The tracked overlay is projected directly from that shared position instead of applying a second screen-space lag filter, preventing the vehicle and globe from repeatedly advancing and snapping back.

After the initial broadside launch profile, the ascent chase camera stays in a rear-quarter view about 30 degrees off the vehicle's forward path bearing, widening smoothly toward 45 degrees as orbit context appears. Cesium's `HeadingPitchRange` already places the camera opposite the supplied heading vector, so replay does not add a second 180-degree inversion; the trajectory therefore travels away toward the horizon while remaining visibly offset from the screen centerline.

During orbit replay, the camera continues following the selected vehicle but eases its look-at target down toward the vehicle's sub-satellite globe anchor. The range expands when necessary for high-altitude missions, keeping both Earth and the tracked label visible through the full revolution. The active replay clock clamps at the final orbital sample rather than wrapping to ascent progress zero; replay completion therefore leaves the final globe/orbit framing in place and does not return to the launch site.

Reconstructed mission orbits use a small downrange launch-to-insertion arc, so their estimated ground track is not artificially drawn directly over the launch pad in top-down views. The ascent remains connected to the ring at its selected insertion point.
Collapsed right-rail controls use the same 176 px width as collapsed left-rail controls, while expanded right-side detail panels retain their independent widths. DISPLAY starts expanded only on first run and then respects persistence; DISPLAY may remain open beside CCTV or Context, while CCTV and Context remain mutually exclusive without persisting forced collapses. Selecting a dedicated Context mode opens its right-side surface and clears unrelated layers after first snapshotting their exact state. Final exit restores the original enabled set and changed parameters. Cockpit View hides the right-side CCTV control because CCTV is not part of the cockpit rail. Airborne cockpit altitude uses the tracked aircraft's reported aviation MSL altitude, never the potentially negative Cesium terrain/ellipsoid render height; confirmed grounded contacts display `0 ft` without rewriting that source field. A cold photoreal floor shows `ACQUIRING SURFACE` for at most five seconds, then uses the source target-height fallback instead of freezing the camera indefinitely.
Replay transport uses one Play/Pause toggle plus Cancel. During ascent only the active thrust ring is visible; stage-recovery handoff uses a pulsing dot.

## Scoped formatting and package checks

`pnpm run format`, `pnpm run format:check` and `pnpm run lint` run Biome, with
its recommended lint rules and import sorting, on the explicit adopted-file list
in `biome.json`, and a Lefthook pre-commit hook formats, lints and sorts the
imports of staged files from that list.
`pnpm run check:boundaries` checks the browser dependency graph of all current
package exports; infrastructure owns its three implementation modules and takes
Cesium from the consumer. CI runs these checks on Linux and Windows. The
standalone app, layer behavior and public export paths remain unchanged. See
[component ownership and adoption](../CODE-BOUNDARIES.md).

## Package management

Dependencies install with pnpm 11, pinned by `packageManager` in `package.json`,
from `pnpm-lock.yaml`. pnpm runs dependency install scripts only for packages
approved in `pnpm-workspace.yaml` and does not resolve releases published within
the last day. Dependabot opens weekly grouped updates for npm packages and
GitHub Actions after a seven-day cooldown; Biome and Cesium updates arrive in
their own pull requests.

## Tooling Snapshot

- `tools/cesium-render.mjs`: headless Cesium render capture via Puppeteer.
- `tools/streetview-panorama.mjs`: Street View tile panorama stitcher.
- `tools/streetview-headings.mjs`: heading sweep capture; supports neighbor traversal.
- `tools/pano-pinhole.mjs`: equirectangular-to-pinhole reprojection.
- `tools/sat-ortho.mjs`: Map Tiles ortho stitch and centered crop with georef corners.
- `scripts/track-regression.mjs`: headless real-app regression harness for aircraft tracking/model/detection invariants (`pnpm run test:track`).
- `scripts/qa-map-source-tray.mjs`: browser proof for the four-source Map Source
  tray — presentation, keyboard disclosure, responsive bounds, unpinned
  auto-dismiss, ACQUIRING status, and retired/unknown stack-id restore
  (`pnpm run qa:map-source-tray`; set `GEV_QA_URL` for another server). Add
  `--keyless` to force the no-ion-token expectations on a keyed server; both
  invocations are gates.
- `scripts/qa-l9-matrix.mjs`: the L9 release-candidate QA matrix in one command
  (`node scripts/qa-l9-matrix.mjs --url http://localhost:4173`). Orchestrates
  the `qa-*.mjs` fleet plus `track-regression` as subprocesses and adds
  repo/feed/in-browser probes; a check whose key the target lacks is SKIPPED
  with an OWNER-RUN tag rather than failed. Run with `--list` to print the
  manual checks it cannot automate.

## Dependency security baseline

The lockfile uses DOMPurify 3.4.15, protobufjs 8.8.0, PostCSS 8.5.28, and
nanoid 3.3.19. Cesium is on 1.145.0. Browser QA uses Puppeteer 25.10.0;
image-processing tools use Sharp 0.35.4. QA scripts await Puppeteer's asynchronous
executable-path lookup before testing or passing the path to Chrome. Supported Node versions remain
24.14.x and 26.x. Use `pnpm install --frozen-lockfile` to reproduce the checked-in dependency tree.
