# World overlay: labels and cards

Part of the [runtime reference](../CURRENT-STATE.md): the overlay host and its migrations, label conventions, and card ownership.

## Overlay host

- **World-overlay host and Phase 2–6 source migrations:**
  `src/overlays/worldOverlay.js` owns one shared DPR-aware text/card canvas,
  one detection blend surface, and one world-overlay post-render
  scheduler. Both surfaces share the same sizing, clear, projection,
  and teardown paths. The host includes bounded per-source/per-collision-domain
  arbitration, horizon/viewport culling, shared keyhole fading, cached UI
  exclusions, cockpit source gating, pooled hit
  rectangles, and development diagnostics. **UI exclusion is a per-rectangle
  PLACEMENT PREFERENCE over currently visible chrome — it clips no canvas and
  vetoes no entry.** Rectangles are never coalesced into bounding unions
  (that requirement existed only for even-odd canvas holes, and the host
  punches none). Exclusion strength is decided per element by its EFFECTIVE
  stacking level (the outermost positioned ancestor carrying a z-index, i.e.
  the stacking context that competes with `#world-overlay-root`): chrome ABOVE
  the host — map panels z90-1000, the dock, the cockpit windows inside
  `#cockpit-hud` z145 — is a soft preference, so an entry with no
  collision-free placement keeps its full placement set and simply renders
  beneath that chrome. Chrome at or BELOW the host keeps an absolute veto:
  `#intel-hud` is z2, under both host surfaces (detection z5, cards z6), so a
  kept placement there would paint over HUD text. Placement runs two passes —
  prefer variants clear of all chrome, else variants clear of the below-host
  chrome, else drop the entry. Cockpit line art (rims, arcs, rails, toplines, readouts) is not
  in the inventory at all: the AR-HUD model puts world-space content beneath
  the cockpit's screen-space HUD by z-order. Its empty-host path performs no
  post-setup layout reads or canvas work under resize/mutation noise; removed
  entry records are pruned, and text measurement uses a host-lifetime,
  1,024-entry LRU. Steady-state rendering reuses arbiter output, placement,
  paint-item, and paint-rectangle storage; track display text is rebuilt only
  when its title or detail changes. DOM mutations only flag exclusions dirty,
  with selector/layout scans deferred until there is overlay paint work, and
  host teardown severs pooled record/entry references before releasing every
  pool. A custom paint-lane contract gives source-owned batched painters the
  same DPR-sized context, per-frame view-projection matrix, ellipsoid
  occluder, keyhole geometry, and cached UI rectangles without transferring
  their selection policy into the host. Datacenters and Dams now publish card
  entries into that host on their
  existing 450 ms screen-grid cadence. Each source retains two deterministic
  contenders per grid cell and publishes at most 160 entries. The legacy
  700/900 winner ceilings are no longer the effective shipped caps; active
  `ambient-card` source budgets sum to a bounded 1,150-card shared lane: two
  96-card infrastructure budgets, FIRMS' shipped 18-card cohort, AIS's
  existing configured 900-row absolute ceiling, and CCTV's shipped 40-card
  ambient maximum. Runtime AIS demand still
  derives from its shipped 118 px grid: 112 candidates at the 1600×900
  allocation viewport and 170 at full HD; its existing 150 px greedy
  separation usually admits fewer. The host owns final cross-source declutter
  without letting source count grow beyond the pre-migration source bounds.
  Cards use the infrastructure name plus available operator/capacity for
  datacenters or river for dams. Their native Cesium points, stems, polygons,
  selection/picking, terrain sampling, and enable/disable lifecycle remain in
  `localGeojson.js`; it creates no native label graphics.
  The bundled public-release snapshots omit contact-oriented fields and note
  values containing email or phone identifiers. Runtime cards and entity
  context do not depend on those fields; geometry, identity, name,
  operator/capacity/river metadata, and ODbL attribution remain intact.
  Stem position and
  polyline properties are constant between initialization, camera `moveEnd`,
  and successful near-surface ground samples rather than per-frame callbacks
  or every 450 ms visibility pass. Unchanged or sub-0.5 m tips do not call
  `setValue`, and each record alternates between two preallocated two-position
  stem arrays so real tip changes notify Cesium without steady-state allocation.
  Shared placement records retain the raw anchor plus one signed integer
  leader offset; painters apply that offset without materializing four pairs
  of computed doubles per entry. The arbiter's spread distances and compact
  placement-availability masks live in pooled numeric buffers. Because solve
  occupancy only grows, few-placement identities whose complete set is
  blocked are dismissed once instead of being returned and re-spread; the
  authoritative collision lookup remains the final semantic check. Protected
  entries that cannot separate completely choose the placement with the least
  total protected-rectangle overlap rather than stacking on the first option.
  Cards use the host's shared keyhole fade and global detection fade/opacity
  controls with no source-local edge constants; cached keyhole geometry is
  invalidated by live tuning as well as canvas size, so Fade changes reach the
  next frame. Outside opacity defaults to the shipped floor (5 % when this
  landed; 1 % since the 2026-08-24 final lock, 3 % on 08-23). The
  `KEYHOLE_OUTSIDE_OPACITY_DEFAULT` change from 0 to 0.05 also affects
  detection: callouts and brackets previously hard-culled outside the keyhole
  now paint at the OUTSIDE default (1% since the 2026-08-24 final lock;
  aircraft brackets hold the 0.35 readable floor) and consume ambient budget
  viewport-wide under the same
  fade-don't-cull principle; this remains pending visual review. Cards
  also reproduce the former
  `scaleByDistance` curve (1.0× at 250 km to 0.62× at 9,000 km).
  Mapped Military Installations create no empty native labels; selected names
  remain in the tracked readout. Submarine-cable labels moved into the shared
  host on 2026-08-18 (Option 2, superseding the Phase-5 Option-1 native
  exception): the same nearest-160 bounded cohort now publishes
  `ambient-label` entries on a dirty sweep with exactly two dirty
  conditions — camera `moveEnd` / layer enable / load completion, plus a
  motion fallback that samples the camera at most once per 2 s and only
  re-arms past 250 m of travel since the last swept position, so tracked
  and orbit cameras (which never emit `moveEnd`) cannot starve the sweep
  while a parked camera still costs zero. The former 500 ms timer path was
  removed in the same-day perf round — timer-driven stem re-sizes rebuilt
  the 2,629-instance batched stem primitive mid-motion. The 2,629 reference
  stems are staticized constants (no per-frame `CallbackProperty`), and an
  unchanged cohort is never republished so a parked camera stays
  governor-idle at the source level.
  The 2026-08-18
  host fix extends that to the HOST level: chrome mutation observation is
  scoped (body childList filtered to inventory-chrome add/remove;
  per-occluder attribute observation element-only, no subtree) and the
  right-rail allocator writes `--right-panel-allocated-height` only on real
  change, so parked idle with ANY live overlay source measures 0 postRender
  fires / 5 s — empty-scene control parity (pre-fix ~56-61; dams
  cross-checked at 0). Genuine chrome changes (occluder add/remove,
  own-attribute flips, resizes) still invalidate;
  `qa-cables-overlay.mjs` gates idle at ≤6 / 5 s.
- **Phase 6 detection consolidation:** `src/data/detection.js` retains its own
  `LabelArbiter` instance and existing 125 ms solve cadence, density/altitude
  budgets, layer quotas, Elastic/Weighted allocation, manual scalar matrix
  projection, tier palette, batched bracket paths, callout painter,
  acquire/keyhole fades, sparse focus ring, banner, scanlines, suspension, and
  diagnostic object. It no longer creates or sizes a canvas, clears pixels,
  builds a camera matrix or UI inventory, observes layout, or attaches a
  render listener. The host creates and lifecycle-manages
  `#world-overlay-detection-surface`, DPR-sizes it through the same frame path
  as `#world-overlay-canvas`, and invokes detection against its
  plain source-over context. Detection writes the exact shipped theme
  `mixBlendMode` and `filter + drop-shadow(...)` strings to that provided
  element, preserving scene-level CRT/NVG/FLIR glow and once-per-layer
  filtering. The surface is host-owned but **parented into `#cesiumContainer`
  at `z-index:5`**, not into `#world-overlay-root`: the root is a stacking
  context (`z-index:6`), i.e. an isolated blending group, and a surface inside
  it has its `mix-blend-mode: screen` silently discarded by the browser
  instead of compositing against the WebGL scene. z-index (5 under the root's
  6) keeps it beneath ambient-through-tracked host paint.
  The >22 ms odd-frame relief valve is restored: the host does not clear the
  detection surface on a held frame, while unrelated shared lanes repaint,
  and `throttleSkipCount` remains a live diagnostic. Detection `data-*` fields
  now live on `#world-overlay-canvas`, while the StyleManager diagnostic API
  remains unchanged. Disable and suspension deactivate only the detection
  lane, leaving unrelated host entries intact; teardown unregisters the lane
  before the host is destroyed. The production-shaped allocation gate covers
  5,000 visible Dense observations at 2,500 km under the unchanged 154
  B/observation/frame ceiling. The host owns one world-overlay `postRender`
  listener; the repository has five `postRender` listeners total (host,
  celestial ring, annotations SVG, missions frame tick, and traffic).
- **World-label accounting:** All intended label/card migrations use the
  shared host. The former native `LabelGraphics` exception for cable reference
  labels was retired on 2026-08-18; cable text may render over tile geometry,
  so **zero native world-label creation sites remain**. The mission replay DOM vehicle, awareness
  compass, annotation SVG callouts, and host-owned detection isolation target
  are explicit exceptions; the awareness ring and cockpit contact pips are
  non-text out-of-scope surfaces. Annotation callout text, geometry, leaders,
  and behavior retain their tested presentation; a future annotation style
  system is outside this phase. `src/overlays/worldOverlayTokens.js` is the single home for
  shared world-overlay, CCTV-thumbnail, and detection-theme presentation
  constants. Former source renderers own no canvas, DPR, or world-overlay
  listener path; the duplicate detection rounded-rectangle helper and dead
  tactical compatibility helpers are gone. No temporary dual-renderer flag
  existed to remove. `activeCameraCardEnabled` remains a product
  presentation control, and `_detectionUserOverridden` remains the documented
  style-switch persistence state. Browser/GPU performance comparison remains
  operator-side; the final accounting records only comparable population
  reductions and deterministic Node allocation/solve measurements. Those
  allocation gates are calibrated on Node.js 24.14.x; `package.json` permits
  supported product runtimes on Node 24 or 26, while the allocation runner
  separately enforces Node 24 for these two calibrated probes. Each probe
  compiles synchronously and discards explicit-GC
  transition chunks before applying the unchanged byte ceilings. The unit
  runner executes ordinary test files with Node's default parallelism, then
  runs only the two explicit-GC allocation microbenchmark files sequentially
  and one at a time with `--expose-gc`, so unrelated tests cannot perturb their
  calibrated budgets and each isolated test process has the same GC contract
  as its measurement worker.
  A worker spawn, exit, output, or availability failure is a failing gate, not
  a passing skip.

## Labels

- **Ambient contact labels (2026-08-20):** detection callsign callouts paint
  on the shared normal-blend world-overlay canvas as their own host lane
  (`detection-callouts`) — NOT on the screen-blended sensor surface. `screen`
  can only lighten, so a dark backing plate drawn there is a no-op over sunlit
  ground and the text dissolves into the imagery. Brackets, the scanline wash
  and the mode banner stay on the sensor surface; the callout lane registers
  in the same `detection` slot, so callouts keep their z-position beneath every
  ordinary overlay card and beneath the tracked readout. Plate fills come from
  per-theme `calloutPlate` / `calloutPlateSpace` tokens (~63% / ~73% of the
  tracked card's `CARD_PLATE_ALPHA`), resolved once per style change; space-tier
  contacts take the heavier one. Rows are pooled, and an empty field must clear
  the replay buffer or the final callsigns strand on the canvas. **Do not move
  callouts back onto the sensor surface, and do not merge the plate tokens into
  `labelBg`** — that token is the scanline wash and shifting it retunes the
  sensor texture. Plates are additionally **backdrop-selective (2026-08-21)**:
  `skyBackdropFactor()` (`src/data/iconOrientation.js`, exact scaled-space
  ellipsoid silhouette) feathers the plate FILL ALPHA to `SKY_PLATE_SCALE`
  (0.18×) for labels above the horizon — sky backdrops read as near-bare text,
  terrain backdrops keep the full plate — across a smoothstep band of
  `HORIZON_FEATHER_RAD` (~1.09°/side). Only the plate alpha feathers; text,
  tier accents, leaders, brackets, and the tracked readout card are untouched.
  **The test is TWO-REGIME, and only the first regime is a ray test
  (2026-08-22).** Above the ellipsoid, `1` means the view ray genuinely misses
  the planet and the function is the exact complement of the occluder. **At and
  below the ellipsoid the horizon is EYE LEVEL** — the local geodetic
  horizontal plane through the camera — and that is NOT a ray-miss test: from a
  −18 m camera the ray to a contact 900 m up crosses the ellipsoid and still
  reads sky, deliberately, because the ellipsoid it crosses is not a surface
  anyone can see. It is reached by clamping the tangent cone's half-angle at
  90°, the continuous limit of the same formula (the horizon dip goes to zero
  at the surface), and is the convention Cesium's `EllipsoidalOccluder` already
  uses there, so the two stay sign-consistent. This is not an edge case:
  coastal airports sit at NEGATIVE ellipsoid height (JFK ramp ≈ −30 m, geoid
  ≈ −34 m), so a ground-level cockpit is genuinely inside the ellipsoid and
  **must not** be treated as degenerate — doing so put a full plate behind
  every label on an empty sky. Fail-closed now covers only unanswerable input
  (null, zero-length ray, non-finite camera, camera at the planet's centre).
  Note the pairing: from such a camera the occluder culls every contact BELOW
  eye level before detection sees it, so ground-backed labels only reappear
  once the camera clears the ellipsoid. Rendered proof:
  `scripts/qa-cockpit-plates.mjs`.
- **Phase 5 earthquake labels:** Earthquake disc ellipses and pickable
  entities remain Cesium-native, but their magnitude text is now an
  `ambient-label` source in the shared world-overlay host. The source formats
  `M#.#` text and depth-band accent colors, publishes only the 96 largest
  current events with stable id tie-breaking, and declares a 48-winner
  ambient-label budget. Host keyhole fading, horizon culling, UI exclusion,
  and final collision apply. Disable/destroy clear and hide the source; real
  earthquake entities carry no native label graphic.
- **Phase 5 bikeshare selection:** The selected station keeps its native cyan
  point highlight, while its station name, availability counts, capacity, and
  operational warnings now publish as one protected selected-lane host card.
  The card reads the point's authoritative Cartesian directly, declares zero
  ambient quota, and therefore cannot be evicted by ambient budgets. Shared
  keyhole fading, horizon culling, UI exclusion, and selected-card paint
  order apply. Clear, disable, and destroy remove the host entry; the selected
  Cesium entity carries no label graphic.
- **Phase 5 ISS and tracked-satellite labels:** The ISS path and large red
  point remain native, while persistent `ISS` text is a one-entry moving
  ambient-label host source. Its getter reads the already-propagated point
  cache, preserving the 1 Hz fleet epoch and eliminating the former second ISS
  propagation. Satellite tracking continues to publish exactly one protected
  tracked-lane card through `gevLabelModel` and `_trackedDisplayCached`; the
  tracked entity is point-only. Tracking ISS suppresses the ambient entry and
  untracking restores it, preventing duplicate ISS text. Disable, orbit-text
  preference changes, catalog rebuild, and destroy clear/hide the source.
- **Phase 5 active CCTV projection label:** The active camera's monitor plane
  remains native Cesium geometry, while its camera-name label is one protected
  selected-lane host entry. The entry closes over the same cached
  `positions.label` Cartesian updated whenever the plane geometry moves, so
  label and plane retain a single placement authority. Only the active,
  projection-visible camera publishes; hide, disable, runtime destruction,
  and state clear remove the source. Monitor-plane entities carry no native
  label graphic.
- **Phase 5 tracked civil aircraft label:** A tracked flight's Cesium entity
  is a billboard-only camera target with no native label. The flight source
  retains callsign/registration fallback, flight-level/altitude, speed, stale
  state, airline/type, and plausible-route formatting in `gevLabelModel`; the
  one protected tracked-lane host card renders that complete model. Its
  position getter reads only `_trackedDisplayCached`, the same authoritative
  Cartesian already consumed by the tracked visual and camera, and never
  advances dead reckoning from the host frame.
- **Aircraft label convention (both flight layers, 2026-08-18):** every civil
  and military label surface resolves **callsign → registration → icao24**
  (`_contactLabel()` in `aircraftLayerCore.js`, which both layers share) —
  tracked readout, detection card, `getNearby`,
  `getDetectableObjects`, `getAllPositions().label`, `getTrackedSubject`, the
  analyst record, the Context subject/nearest list, the Cockpit signal list,
  and the `track_entity` voice narration. Registration is aircraft IDENTITY,
  not route, so unlike origin/destination it is **not** routePlausible-gated.
  Identity stays `icao24` on every keyed surface (`getNearby().icao24`, the
  detection `sourceId` declutter hashes, and the `id` that `trackById` and the
  Context cohorts resolve) — only the displayed string follows the chain.
  Because adsbdb enrichment can answer *after* selection, the Context subject
  re-resolves its label each refresh (`resolveSubjectLabel()`) instead of
  freezing the selection-time snapshot.
- **Phase 5 tracked military aircraft label:** The military tracking entity
  is likewise billboard-only and label-free. Its source-owned model retains
  callsign/registration fallback, stale cue, aircraft type, registration,
  operator, altitude, and speed, rendered as the sole protected tracked-lane
  card with the amber military accent. Its getter reads only the military
  `_trackedDisplayCached` publisher, keeping the host, visual, and camera on
  one dead-reckoned frame sample.
- **Phase 5b Space Mission labels:** Launch markers publish through a bounded
  48-candidate / 24-winner ambient-label source. Selecting a mission clears
  that overview and publishes its launch-site, stage re-entry, payload
  position, and orbit annotations as protected selected-lane entries; every
  source-formatted line and accent remains intact. Static entries reuse the
  mission geometry Cartesians, the payload getter reads its per-frame live
  cache, and catalog-backed orbit text reads the cache updated with the ring
  matrix. Refresh, deselect, disable, and destroy replace or clear the real
  sources. Mission Cesium entities carry no label graphics, and the shared
  host replaces the former quadratic label overlap pass.
- **Phase 5 cable depth-testing decision (2026-08-02, REVISED 2026-08-18 →
  Option 2):** the 2026-08-02 ruling kept submarine-cable reference labels
  native (`disableDepthTestDistance: 0`) as the sole approved world-label
  exception so photorealistic tiles could occlude label text. On 2026-08-18
  that exception was retired after performance measurement: the native
  path evaluated 5,258 `CallbackProperty` channels per frame across 2,629
  reference entities and re-batched a 160-label `LabelCollection` per sweep,
  costing the layer ~9.5 ms/frame during camera motion (≈42 → ≈59 fps
  measured headless at a mid-Atlantic orbit). Cable text is now a bounded
  nearest-160 `ambient-label` host cohort (`telegeographySubmarineCables.js`
  publishes on the dirty sweep — `moveEnd`/enable plus the 2 s/250 m motion
  fallback for tracked and orbit cameras — skipping identical
  cohorts); stems/points stay Cesium-native, depth-tested, and pickable, so
  only TEXT lost tile occlusion — the same trade every other host label
  already shipped: labels may render on top of tiles. The dedicated
  `submarine-cables` allocation row gates
  the new source at 17,015 B/frame median (106.3 B/candidate, Node 24)
  under a 19,000 budget, and the all-live aggregate row was recalibrated
  with the cable cohort folded in (164,711 B/frame median, 190.6
  B/candidate, 182,000 budget); the intermediate phase rows keep their
  historical pre-cable composition. `load()` carries a load-generation
  ownership token (the militaryAwareness activationId pattern): a stale
  aborted load bails after every await and never clears a successor's
  lifecycle, so rapid toggle/destroy sequences cannot double-add data
  sources.
  The 639-candidate Phase-5b row (353 painted, 133,769 B/frame, 209.3
  B/candidate) remains as an intermediate historical gate; as of the
  2026-08-18 recalibration the all-live aggregate — every shared-host
  source including Radio and the migrated cable cohort — is 864 candidates
  / 398 painted at 164,711 B/frame (190.6 B/candidate) under a 182,000
  budget. The image-inclusive ceiling remains attributable to CCTV, while
  the isolated mission row measures 108.2 B/candidate/frame under the
  shared 154 ceiling.
  FIRMS severity/source formatting, its pre-existing 150 px greedy selector,
  selected-fire semantics, and LOD distance limits stay in `firmsHeatmap.js`;
  `firmsLabels.js` is formatting-only. FIRMS entries use the host's tactical
  card painter, vertical above/below placement, severity top rule, shared UI
  exclusion/clip, horizon culling, distance-alpha channel, and always-on
  `edgeFade: 'keyhole'` policy. Selected fires are protected in the selected
  lane and bypass both the 18-card ambient cohort and distance fade while
  excluding ambient cards from their footprint. Disable and destroy clear
  the source rather than leaving a stale host entry. This is not a
  pixel-for-pixel port: global collision/UI avoidance can choose fewer cards,
  host horizon culling is explicit, and ordinary map mode now retains the
  shared Outside floor instead of bypassing edge fade through the former
  cockpit/celestial gate.

## Cards

- **Deterministic card stacking:** CCTV, FIRMS, vessel, and tracked-target
  cards use the shared world-overlay canvas. Detection paints through the
  same host/frame contract onto one host-owned blend surface beneath that
  canvas — parented into `#cesiumContainer` so its `screen` blend still
  reaches the WebGL scene. The exact detection, ambient-label, ambient-track,
  ambient-card, thumbnail, selected, and tracked lane sequence is binding;
  the detection callback runs first and z-index preserves its shipped z5
  position below the z6 cards.
- **Vessel card ownership:** `aisLiveVessels.js` retains the 800 ms visibility
  pass, 118 px one-winner grid, priority ranking, 150 px greedy separation,
  type/detail formatting, and the AIS positions produced by its unchanged sea
  datum path. It publishes ambient tactical cards and one protected selected
  card into the host. `vesselLabels.js` is formatting/policy-only: no vessel
  canvas, projection, paint loop, or post-render listener remains. Ambient
  vessels share `ambient-card`; the selected entry paints in the selected lane,
  bypasses the ambient cohort/distance fade, and its protected rectangle
  excludes sibling ambient cards. Tracked readout still excludes AIS, avoiding
  a duplicate card for the same selection. Disable and destroy clear the host
  source. This is not a pixel-for-pixel port: shared cross-source collision,
  UI exclusion, and horizon culling can admit fewer cards than the isolated
  canvas, and the shared always-on keyhole policy now applies the shipped
  Outside floor in ordinary map mode instead of using the interim active-mask
  gate.
- **Tracked-readout ownership:** `trackedReadout.js` is now a presentation-model
  bridge only; it owns no canvas, projection, post-render listener, layout,
  keyhole fade, or paint path. Civilian flights, military flights, satellites,
  and mapped installations write explicit `gevLabelModel` objects and expose
  `gevDisplayPosition` getters backed by their layer-owned frame/display cache.
  Selected AIS vessels continue using the vessel source's protected selected
  card, so they do not create a duplicate tracked readout. The host registers
  the active readout in the protected tracked lane with a zero ambient quota;
  protected semantics bypass that quota and reserve the painted footprint
  against ambient cards. Moving sources never fall back to a fresh
  `entity.position.getValue()` in post-render. Annotation fade queries the
  host's actual `getOverlayPaintRect('tracked', trackedId)` after layout and
  unions it with the tracked billboard extent. Untrack, context clear, and UI
  destroy clear/hide the source. This is not a pixel-for-pixel port: placement
  is host-rounded, cross-source/UI exclusion and horizon culling now apply,
  accents are source-stable rather than detection-theme-derived, and the old
  screen-coordinate deadband was removed in favor of the authoritative layer
  frame cache.
  Civilian and military poll reconciliation refreshes this model after fresh
  kinematics and again when a missed poll enters the `STALE` grace period.
  Satellite pre-render propagation refreshes its altitude line from the same
  per-frame SGP4 sample used by the tracked dot and camera.
- **CCTV thumbnail ownership:** `cctv.js` retains the 20/28/40 zoom selection,
  40-card shipped maximum, 112 px source declutter, eviction grace, frame
  fetching/cadence/retry, stable slot cache, last-success persistence, hover
  pinning, and activation. `cctvCards.js` is now source policy plus pure
  lifecycle helpers only; it owns no canvas, post-render subscription,
  Cesium projection, layout solve, paint pass, or hit store. The shared host
  paints its exact 96×54 thumbnail inside the 104×77 shipped chrome, applies
  the same 1.0→0.45→0.35 altitude scale and 7,500→9,500 m fade, shared
  keyhole fade, full UI exclusions, and tracked/protected footprint
  exclusion. Ambient entries paint nothing before their first successful
  frame; a user-pinned entry retains the documented immediate empty-chrome
  exception, and later failures never clear the last successful frame. The
  active camera is excluded from the 40-card ambient quota and has no host
  card by default: its monitor plane is the active representation. The
  product option `cctvLayer.setCardPresentationOptions({
  activeCameraCardEnabled: true })` may publish it through the retained
  protected path. CCTV leaders use the source cyan, remain vertical at the
  camera anchor except for the off-card edge clamp, and counter-scale to one
  CSS pixel through the altitude transform. Card hits come from
  `hitTestWorldOverlay` after a
  scene pick miss with no canonical scene-object ID. CCTV billboard ownership
  is proven by the owning collection/object rather than a bare upstream ID,
  so an independent sibling with a colliding ID still wins. As a completed,
  narrowly extended ownership hardening step, property-bearing Entity picks
  must also be the exact stored CCTV coverage/projection object; copying the
  `cctvCameraId` property cannot impersonate a camera. Card hits pass through the
  6 px / 400 ms gesture guard
  before activation and the existing click-to-fly event. CCTV cards are not
  sprite-focus-dimmed. Disable/destroy clear and hide the host source, stop
  pacing, detach in-flight image handlers, and empty source caches.
