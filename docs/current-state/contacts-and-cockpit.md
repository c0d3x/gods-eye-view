# Contacts, context and the cockpit

Part of the [runtime reference](../CURRENT-STATE.md): the Contacts coordinator, the Context, Cockpit and Radio contract, and cockpit behavior.

## Context / Contacts coordinator

- The internal Context coordinator is available in every visual style. Its dedicated right-side `CONTEXT` chooser exposes the neutral shell; the coordinator is not duplicated in Data Layers and does not enable a live-data dependency until a mode is selected.
- The expanded `CONTEXT` view offers mutually exclusive `CONTACTS` and `SPACE MISSIONS` modes. Selecting `CONTACTS` enables the context-owned Flights, Military Flights, AIS Vessels, and Mapped Installations dependencies only when they are not already user-enabled; selecting `SPACE MISSIONS` enables the recent-launch layer and its Satellite dependency. `CONTACTS` cycles the nearest supported contact of whatever type is selected. Satellites are deliberately excluded from those Awareness cohorts and keep their own tracking UX. Selecting the active mode again returns to the neutral chooser and releases only mode-owned dependencies.
- If a civilian or military aircraft is already tracked when `CONTACTS` becomes operational, that source-owned track is adopted as the Context subject before nearest-contact autofocus. Context rechecks the tracker after its dependencies settle, so a newer selection wins, while an explicit clear during activation prevents fallback from silently selecting a replacement. Cockpit entry remains unavailable until that Context transaction has settled, so its camera takeover cannot clear Cesium tracking before adoption. Adoption does not recreate tracking or transfer camera ownership; it initializes the normal 250 km ring, history, proximity results, and Cockpit Previous/Next state for the original aircraft.
- `SEARCH NEARBY SITES` retains the bounded OSM results and makes one user-initiated, view-biased Google Maps Places text search for “military installation.” Google results are source-stamped, deduplicated against OSM by rounded location/name, and remain mapped context rather than operational claims. If Places is unavailable or the API is not enabled for the supplied key, OSM context remains available.
- The expanded desktop header omits the redundant `ON` label; the active mode button carries state. Expanded Contact results also omit the duplicate `GLOBAL CONTEXT` / `CONTEXT ONLY` status row and begin with the selected subject and its 250 km scope. Global Context does not fabricate a selected-entity model preview: the provisional hand-authored aircraft wireframe was removed because it was not geometry extracted from the selected entity's actual asset.
- Dependency ownership is reversible: disabling Global Context releases only dependencies it enabled, while user-enabled layers remain on. This also removes the Military-layer suppression handoff when Global Context owned Military, allowing an already-enabled civilian Flights layer to resume its normal mixed rendering. If OpenSky is unavailable and has no last-good cache, Flights requests a capped 250 nm adsb.lol point snapshot around the current view anchor and labels that provenance explicitly; it never relabels military-feed rows as civilian data. If both inputs fail, Flights remains `UNKNOWN`.
- Space Missions is replay-isolated: Rocket Launches and Satellites are the only Data Layers permitted while the mode is active. Direct UI and voice entry capture the same pre-entry snapshot; internal dependency and restoration enables do not create a user-owned Context session. Entry waits for incompatible layers to shut down, direct incompatible enables are blocked before lifecycle work, and the entry gate remains active through the complete Rocket Launches enable. A newer same-target ON request takes ownership of the pending entry without releasing its isolation snapshot, including when it arrives while the prior request is awaiting the adoption guard. A caller abort, resource cancellation, newer OFF, or layer teardown waits for exact manager settlement and restores that snapshot without resurrecting Rocket Launches. If an abort lands after only part of a restore settles, Context completes the same exact target without the stale caller signal and then replays newer explicit layer intent. Dedicated Voice Context cancellation reports a stable cancelled result plus the current Context state; generic layer visibility additionally exposes manager phase, reason, successor, and lifecycle details. Once an exact voice visibility intent commits, a newer voice turn cannot relabel it as cancelled while Context settlement completes; pre-commit aborts remain cancellable and final lifecycle mismatches remain failures. Clear Selected Layers reserves its complete captured OFF set before sequential teardown; a newer absolute request of any origin supersedes only its layer reservation and remains authoritative. A rejected layer teardown retains the truthful enabled state, rolls already-stopped siblings back to the captured pre-entry set, and aborts replay; rapid exit/re-entry serializes the full Satellite enabled-state and parameter restore before a new snapshot is taken. Contacts remains additive and restores user-enabled layers normally.
- Enabled Data Layer controls report normalized feed health on the button (`LOADING`, `DEGRADED`, `STALE`, `FALLBACK`, or `UNAVAILABLE`) while the metadata line retains the source and reason. A partial CelesTrak group failure keeps the usable catalog and reports `DEGRADED`; a total outage keeps last-good catalog data visible but reports `UNAVAILABLE`.
- On activation it focuses the nearest currently observed aircraft across the civilian and military feeds, with military winning an exact distance tie; if none are available, it focuses an observed AIS vessel. The aircraft search is deliberately uncapped and one refresh-tick retry handles initially empty feeds. This is an attention-priority navigation shortcut, not a high-risk, affiliation, or threat classification.
- A selected aircraft, AIS vessel, or mapped installation gets a 250 km **context window** with nearby cohort counts, nearest examples, source labels, and stale/unavailable reasons. It emits `NEARBY` or `UNKNOWN`; no detection, engagement, affiliation, or sensor-activity conclusion is calculated.
- For a selected live aircraft or vessel, the context window refreshes from the existing tracker/feed position every 750 ms, so nearest distances and cohort counts follow the subject without introducing a duplicate poll loop.
- Aircraft cohort membership uses every locally loaded, selectable contact inside the 250 km window, including a plane hidden only by horizon culling or because its 3D model owns the visual. Counts and navigation therefore do not change with the current camera angle or billboard/model handoff.
- Nearby examples in the context panel are focus controls: they use their owning layer's existing selection/tracking path, then frame that contact. Static-installation distances use ellipsoidal surface distance so the count matches the ground-projected context disk.
- Context selection transfers camera ownership by subject type: selecting a civilian or military flight keeps that layer's moving follow camera, while selecting an AIS vessel or mapped installation first releases any prior aircraft tracker and performs only the source layer's one-time framing. The camera therefore remains user-controlled after non-aircraft selection instead of continuing to move with the previously selected plane.
- Selected AIS vessels use their layer-owned full-detail presentation model in the shared world-overlay host; mapped installations use the tracked-readout aesthetic. Both remain crisp above post-processing without duplicate selected labels; non-selected AIS cards retain their source-owned grid/visibility selection and are host-batched with other world cards.
- Space Mission ascent replay uses the compact rocket/thrust overlay only through orbit insertion. Once the replay enters its orbit phase, that vehicle glyph is replaced by a fixed-size cyan dot following the same orbit path and callout.
- While a subject is selected, an inner keyhole compass rotates against camera heading and up to three cyan shafted bearing arrows lock to its single faint tick-marked rim, with their labels inset just inside the circle. Labels explicitly separate the geographic bearing (`BRG`) from the contact's reported course (`CRS`) so the pointer direction is not confused with aircraft heading. They point toward the nearest observed/mapped examples; each cohort displays up to ten examples while retaining the complete locally loaded in-range cohort for navigation, with three visible at a time and a ten-second page rotation shared by the panel and arrows. This distinct neutral-context color avoids implying that all context indicators are military-flight symbols. `PREVIOUS`, `FOCUS`, and `NEXT` controls navigate selection history or the next nearby cohort example through the existing tracker. NEXT uses a cycle-scoped visited set and starts a deterministic new walk after exhausting the current candidates instead of re-admitting the nearest visited contact.
- Installations are viewport-bounded OSM map features (`military=airfield|naval_base|range|barracks|base` and `landuse=military`), capped to a 10° non-dateline request and 700 upstream features. The proxy caches five minutes and serves a one-hour stale fallback. Empty, stale, unavailable, and zoom-too-wide states remain visibly distinct.
- The selected-only visual is one static, unfilled blue circle. It marks the 250 km proximity context window only; it is not coverage or a radar/weapon envelope. Missing broadcasts and unmapped sites are explicitly not evidence of absence.
- The right rail's collapsed Display, CCTV, and Context controls use the same compact sizing language as the left rail's collapsed Data Layers and Scenes controls. These compact-state widths do not constrain expanded panel or child-content widths.

## Contacts

- **"Never answered yet" is a THIRD state, distinct from empty (2026-08-23):**
  `sourceState` in `src/data/militaryAwareness.js` treats a dependency that is
  busy AND has never produced an answer (`loading === true && !lastUpdate`) as
  unavailable, so the Contacts panel prints `?` and voice says "unknown". This
  is deliberately NOT "busy": a source that has answered once keeps its real
  count through every later refresh poll. It is a CONTRACT over the whole
  dependency list rather than a fix for one layer, and the dependencies reach
  it by different routes:
  - **AIS vessels is its reachable producer.** `enable()`/`update()` both
    resolve as soon as the first `/api/ais-live` poll answers, so the manager's
    lifecycle settles to `enabled` — but until the server-side socket delivers
    a position, `firstConnectPhase` stays `'loading'` and `getStats()` reports
    `loading: true`, `lastUpdate: null`, count 0, and an UNDEFINED status.
    Without the predicate that window prints an all-clear `0`.
  - **Mapped installations never reaches that window.**
    `militaryInstallations.enable()` is synchronous and the manager awaits
    `update()`, which owns the first Overpass fetch, so the lifecycle stays
    `enabling` for the whole fetch and the pre-existing `enabling` branch
    covers it. Confirmed live on :4272 across a held 17 s first fetch (34
    samples, `enabling` throughout, panel non-numeric) and across a failing
    one. Its `status: 'idle'` is not what saves it — the lifecycle is; the
    module has no `loading` status at all.

  Any new dependency that can be slow must report `loading` and `lastUpdate`
  honestly for the contract to hold, and must be pinned against the shape its
  own module really returns — a fixture that invents a status the module cannot
  emit guards nothing (that is exactly how a hole here survived a green suite).
- **Presence contract (`hasContact`).** `flights`, `militaryFlights` and
  `aisLiveVessels` each expose `hasContact(id)`: `true`/`false` in O(1) from
  the layer's own keyed map, or `null` when the layer holds no data and
  therefore cannot answer (disabled, or not yet loaded). Presence consumers
  MUST use it and must never infer absence from `getAllPositions`, which
  stops at its cap — the live flights layer routinely carries ~11k contacts
  against a 1,000-row cap, so "not in the returned rows" is not "gone".
  `null` leaves the previous verdict untouched, so a silent layer can never
  fabricate a CONTACT LOST cue.
- **Screen picks are validated before conversion (2026-08-21):** anything that
  comes back from `scene.pickPosition()` must clear
  `isPickedWorldPosition()` (`src/data/scenePick.js`) before it is converted
  to a Cartographic. The guard is a magnitude BAND — 6,000,000 m to
  1,000,000,000 m, plus finite components — not a null check, because a depth
  read over empty sky can return a Cartesian that Cesium mishandles three
  different ways: non-finite throws `DeveloperError: normalized result is not
  a number`, exactly `(0,0,0)` returns undefined, and a near-center value such
  as `(500,0,0)` converts SILENTLY into a point 6,378 km underground that
  reverse-geocodes as 0°, 0°. The floor sits ~346 km below the smallest real
  surface magnitude (WGS84 polar radius 6,356,752 m); the ceiling is ~24×
  geostationary, so no real contact is rejected. **A degenerate pick is a
  MISSED pick:** the cascade in `getViewTargetCartesian()` and
  `pickWorldFromScreen()` falls through to `pickEllipsoid` and then the globe
  ray, and callers receive the same `null` they already handle for a miss —
  there is no new sentinel. Two consumers had no owner for a throw and were
  hardened to match: the moveEnd view-target prewarm runs inside
  `requestIdleCallback` (now catches and reports once per viewer at
  `console.debug`), and `IntelHUD._updateSummary()` awaits its context INSIDE
  a guard, because every caller invokes it as `void this._updateSummary(...)`
  and a rejection there is ownerless. Gate:
  `scripts/qa-view-target-prewarm.mjs`.

## Context, Cockpit and Radio

- **Context, Cockpit, and Radio interaction contract:** explicit Contacts,
  Space Missions, and successful Cockpit actions reveal the Context panel, while
  restoration and replay preserve its prior collapsed state. Contacts uses the
  dedicated right-side chooser; the underlying Global Context coordinator is
  registered for lifecycle and restoration but is not duplicated in Data Layers.
  Inside Cockpit, the focused summary card is titled Contact in both visible
  copy and its accessible control labels.
  The top-center Cockpit vision cycle shows the inherited map preset name
  (for example, `NOIR`) followed by CRT, NVG, FLIR, and NOIR. That inherited entry
  leaves the selected map preset unchanged inside Cockpit. NONE is not offered
  in the cycle; CRT, NVG, FLIR, and NOIR temporarily override that preset, while returning to it or exiting
  Cockpit restores the captured map style and its exact shader intensities.
  Selecting a Cockpit vision treatment with configurable parameters opens
  Cockpit Display and reveals those parameters through the existing right-side
  accordion; an inherited parameterless Normal preset does not force it open.
  Expanded Cockpit Display uses a container-integrated header and soft 28% cyan divider
  matching the expanded left-side panel treatment; its collapsed launcher
  keeps the standalone glass surface and muted divider. Cockpit Display and
  Radio use right-rail chevrons: left to expand and right to collapse.
  Cockpit side surfaces use one expanded body per side: Display or Radio
  collapses Live Signals and vice versa. When both utilities close, Live
  Signals reopens unless the user explicitly collapsed it. Expansion notifications
  fire only on a real collapsed-to-expanded transition, preventing repeated close
  synchronization from re-entering the disclosure coordinator. Data Layers collapses
  Contact, while expanding Contact returns that panel to its visible
  launchers. Live viewport-height changes remeasure both utility lanes and
  keep their collapsed launchers inside the obstacle-free corridor above
  Contact and Live Signals. An expanded Data Layers panel is solved against the
  viewport rather than the Cockpit cards: the CONTACT card and the peripheral
  Intel HUD corners stop shortening its corridor while it is open, so it
  unfurls downward from its collapsed launcher position and renders over them
  (`#left-panel-stack` is z-index 147, above the Intel HUD readouts at 146 and
  the Cockpit HUD at 145), scrolling internally when the layer list is longer than
  the corridor. Cesium's credit line is never passable and still bounds the
  corridor. Layer toggles stay live from there, and collapsing returns the
  plain launcher. The map-only Clear, Share, and Reset Globe actions are hidden
  for the duration of Cockpit, both as a group and as individual controls.
  It uses the `radar` symbol; both tabs are reachable with Tab and Left/Right arrows switch between them. Its action row
  places the single Cockpit entry before Search Nearby Sites. Cockpit removes
  the duplicate floating map entry and topline exit; the bottom-center
  `EXIT COCKPIT` control (offset downward by a `-95px` bottom margin) plus `Escape`/`C` own exit, with entry/exit focus
  transfer and failure-safe shortcut routing. The exit control sits at the
  bottom-center compass position. A Cockpit-only control strip sits
  directly above Live Signals, anchored 12px under the REC readout it shares
  the right margin with and clamped to keep 8px above the briefing card,
  never rising past `max(96px, 12vh)`; Cockpit owns that anchor and
  republishes it every layout tick (the left accordion no longer donates its
  corridor). Its minimal Display popover exposes Intel HUD,
  Detection, Parameters, and 3D aircraft. During Cockpit, those existing
  standard Display controls move into the Cockpit popover and retain their normal
  nested interaction: HUD plus Tactical/Operator/Minimal layout, Detection plus
  Density/Allocation/Fade/Outside tuning, and 3D plus Proximity/All mode. The
  same nodes and state return to the map Display on exit, so Cockpit does not
  maintain a second control state. **Detection is owned by the CONTACTS
  session, not by Cockpit** (validated 2026-08-18): activating Contacts
  forces detection on at the shared military preset (`MILITARY_DETECTION_PRESET`
  — Dense @ 75%, the same frozen object the CRT/NVG/FLIR styles apply), and it
  then stays on for the whole session — cockpit enter, cockpit exit and
  third-person tracking are moves WITHIN Contacts and do not touch detection at
  all. A manual DETECT change during the session holds for the rest of it.
  Deactivating Contacts restores the pre-Contacts state, except that a map
  style chosen during the session keeps its own auto-enable preset (that rule
  is younger than the entry snapshot). The trigger lives on
  `_syncContactsDetection()`, called from `_syncContextModeButtons()` and gated
  on `!_contextModeChanging` so it fires at transaction settle, never at click
  — a failed activation cannot strand detection on. Policy in
  `src/contactsDetectionPolicy.js`. Detection continues to show surrounding
  aircraft in Cockpit while omitting only the active first-person subject's bracket;
  handoffs move that suppression to the new subject and exit restores the
  selected aircraft's map-view bracket. Remaining Cockpit bracket strokes render
  at 45% of their normal presentation opacity to reduce visor clutter; callouts,
  density, allocation, fade, and Outside tuning are unchanged and normal bracket
  opacity returns on exit. AIR presentation follows the same retained 3D mode:
  Proximity uses 150/185 km and All uses 400/450 km. With 3D off, in-range
  contacts remain rotating 2D silhouettes; with 3D on, ready admitted models
  take over under the Cockpit cap of 60. Loading/capped contacts remain 2D,
  out-of-range contacts use rotation-free dots, and exit restores map treatment.
  Its Radio popover exposes compact power,
  transport, station, and volume controls. Cockpit Previous/Next preserves
  selection, autoplay, and broadcaster fallback audio without starting the
  map-view station flights that compete with the first-person camera. These
  are a Cockpit-only accordion:
  each static header uses the left accordion's label and divider with a dedicated
  directional-chevron disclosure button and no full-row hover treatment. Only one
  utility body expands at a time. On desktop, its collapsed sibling remains
  visible whenever both controls fit above Live Signals; a constrained
  corridor gives the expanded utility the full height and temporarily hides
  that sibling, restoring it as soon as room returns. Collapsed Display
  matches the collapsed Data Layers launcher width. Expanded Display uses the
  standard map Display panel's 272 px width, glass shell, header surface, and
  internal spacing. Radio retains its independent compact and expanded widths.
  Display no longer follows the Data Layers corridor: that corridor is solved
  against left-lane obstacles and has nothing to say about the right margin,
  which dropped the strip into Live Signals below roughly 830 px of browser
  height. Cockpit owns the strip's anchor and republishes it on every layout
  tick — including the settling pass after HUD transitions and asynchronous
  map-provider swaps — hanging it 12 px under the REC readout, clamping it up
  to keep 8 px above Live Signals, and never letting it rise past
  `max(96 px, 12vh)`. The utility height is measured from that resolved top
  and floors on a launcher height rather than a fixed minimum, so expansion is
  bounded to the real corridor below the Cockpit topline and above Live
  Signals, including when a tall panel takes over the corridor. A hidden
  sibling is also removed from the accessibility tree, and focus transfers to
  the expanded utility if a layout transition hides the focused launcher. The
  shared map Display, Radio detail,
  ordinary Global Context, and Scenes surfaces stay hidden in Cockpit. Data
  Layers remains available. Its Cockpit-only stack paints
  above the curved speed and altitude rulers, matching the existing Context,
  Signals, Display, and Radio surface ordering without changing map-view
  stacking. Narrow mobile Cockpit
  viewports suppress the legacy layer stack, peripheral HUD, and secondary
  Context/briefing panes so the flight instruments and primary controls remain
  unobstructed. Outside Cockpit, Radio starts collapsed while off. When Context
  is collapsed, its Radio header icon opens compact controls whose explicit
  Enable/Disable action owns power; stable close and full-panel buttons own
  compact dismissal and one-way detailed expansion independently. When Context
  is already expanded, that same icon skips the floating compact card, expands
  the embedded Radio section, scrolls it into view, and moves keyboard focus to
  its disclosure control. The detailed panel's normal accordion control owns
  its collapse. Compact/detailed state and playback continuity remain shared.
  Radio volume in the full, compact, and Cockpit surfaces, plus Space Mission
  replay speed, use Display / Sharpen's muted 3px rail, circular cyan thumb,
  glow, and mono value treatment. Their larger transparent hit areas, keyboard
  focus indication, ranges, disabled states, and mission speed scale remain
  control-specific.
  Outside Cockpit, panel collapse state is independent. Multiple expanded
  panels in either desktop lane share the measured viewport-safe corridor.
  If a later panel would receive less than half its intrinsic height, the
  layout presents it as a collapsed, accessible launcher without overwriting
  the user's saved preference; the panel most recently opened by the user
  keeps the lane, so an older expanded sibling yields when necessary. In a
  constrained Tactical lane, later competing panels collapse to their
  launchers even when they would narrowly exceed that threshold. While the
  left lane remains constrained, every collapsed sibling launcher is hidden
  and the primary panel uses the complete safe corridor; the launchers return
  when that panel closes or the stack fits again. An expanded
  Tactical Display claims the right lane and hides every collapsed CCTV and
  Context sibling, including a layout-collapsed Context; those launchers
  return when Display releases the lane. Display itself remains the single
  scroll surface when a visual preset adds Parameters: those rows do not form
  a nested scroll surface. The bottom Visual Presets MAP SOURCE row keeps the
  `3D` status and four source tiles inside its padded tray; the row wraps
  from one row to two at 620 px, and live viewport changes keep the complete
  tray inside the screen.
  Adaptive remeasurement preserves the user's
  scroll position across Tactical, Minimal, and HUD Off layouts.
  During an active Scene run, Clear Selected Layers and Reset Globe remain
  hidden until playback stops or completes because the Scene transport owns
  layer and camera sequencing for that interval.
  The Cockpit Contact summary exposes Previous and Next contact navigation
  plus its collapse control; it does not offer a Focus action because the
  first-person Cockpit camera remains owned by the tracked aircraft.
  A voice Cockpit request that retargets to a filtered civilian or military
  contact carries voice selection authority through navigation, so the
  aircraft entered is also the durable target used by Copy Link and reload.
  Missing context values render as `—` with an accessible “Unavailable” name.
  Because the panel hosts its own Previous/Next controls, the ONLY condition
  that hides it is the absence of a context snapshot. Contact identity never
  gates visibility — hiding on a non-aircraft subject stranded the operator
  the moment Next landed on a vessel or an installation.
- **Context-flow hardening:** the cockpit left accordion stays below the HUD
  inside its measured safe top/bottom lane. Global Context focus guards exist
  only for the synchronous selection window, history survives same-layer
  reselection, and NEXT availability uses the same UNKNOWN-cohort gate as the
  navigation action. Contacts entry does not wait for unrelated serialized
  layer teardown; Space Missions waits for every incompatible live/current
  layer to settle off before replay data starts. A rejected teardown keeps
  that layer authoritatively enabled, restores any siblings already stopped,
  and aborts replay entry; the isolation
  guard remains active until Rocket Launches finishes enabling. Manually enabling
  another Data Layer is additive in both an active mode and the neutral shell:
  it does not exit Context, and the added layer joins the pre-entry snapshot
  when the session is eventually restored. Manually disabling a required mode
  dependency still exits and restores that union.
  While Space Missions is active, direct incompatible enables are refused
  before initialization or polling and explain that the mode must be exited.
  User entry alone owns the pre-entry snapshot; programmatic dependencies do
  not replace it, and rapid re-entry snapshots the pending settled restore
  target rather than partial manager state.
  Contacts-mode entry chooses the nearest aircraft to the current camera from
  one uncapped civilian-plus-military pool (military wins an exact distance
  tie), then falls back to the nearest AIS vessel. An initially empty set gets
  one retry on the next Awareness refresh tick rather than permanently losing
  automatic acquisition. Clearing a manually selected subject cancels that
  pending retry so an intentional deselection cannot acquire another contact.
  NEXT keeps a cycle-scoped visited set separate from PREVIOUS history. Once
  every current target is visited, it starts a deterministic new walk with the
  current subject retained as visited instead of re-admitting all candidates
  into a nearest-contact ping-pong. Expanded flight searches use the same reset
  rule. Vessel focus uses a 3 km bounding sphere at entry and during cycling.
  The user-facing mode is **CONTACTS**: it cycles the nearest contact of
  whichever supported type is selected (civilian or military plane, AIS vessel,
  or mapped installation). Satellites are explicitly outside the Awareness
  navigation cohorts and retain their independent tracking UX. The cockpit
  briefing opt-in is labeled `CYCLE OFF` / `CYCLE ON`, with state-specific help
  that distinguishes page cycling from continuously refreshed live data. The
  neutral standby summarizes both chooser modes, while the `CONTACTS` and cycle
  controls keep their short visible state as the accessible name and expose
  longer help only as a title.
- **Reversible Context handoff:** enabling Global Context snapshots the exact
  enabled-layer set and every runtime parameter it changes, then clears
  unrelated active Data Layers. Mode switches, required-dependency disables, direct
  disable, and teardown restore that pre-entry state before control leaves
  Context. Directly switching between Flights and Space Missions remains
  supported without losing the original snapshot. Contacts waits for the
  dependency releases it owns before restoring that snapshot, so the first
  Space Missions selection completes without a stale teardown superseding it.

## Cockpit

- **Cockpit left-panel chrome:** opening any left-stack panel fades the
  overlapping left pitch-rail glyphs out. The separately right-anchored pitch
  rail remains visible, and panel/context-card stacking is unchanged.
- **Cockpit context stacking:** the context card renders above visor glass,
  pitch/heading instruments, altitude/speed tapes, and the signal window.
  Topline vision and exit controls retain the highest in-cockpit layer.
- **Flights 3D/cockpit hardening:** the destination-direction cue is an
  inline SVG rather than a remotely loaded Material Icons ligature, so a
  blocked or late font can no longer expand the literal word `navigation`
  across the cockpit. The grounded `airplane.glb` belly offset is calibrated
  to the current asset's measured Y-up bounds (`0.063` native units).
  Contact Previous/Next and Live Signals aircraft handoffs now
  re-seed the first-person camera anchor at the selected flight immediately;
  bounded feed-correction smoothing remains scoped to the same aircraft.
  When NEXT has no flight inside the normal 250 km Context window, it searches
  both civilian and military feeds at successively doubled radii through
  16,000 km and transfers the cockpit to the closest available aircraft.
  Tracked cameras now share one ENU frame across Cesium and the close-range
  guard: switches relocate to the new aircraft, zoom stops 150 m short of
  crossing the target, and the icon/model, label, trail head, and camera are
  prepared from the same frame. The guard frames once and then leaves
  Cesium's EntityView as the sole continuous camera writer. The tracked
  entity remains a pure position/billboard target with no unused aircraft
  orientation input; 3D→2D handoffs seed the current screen-projected course,
  course projection uses the camera's right/up basis so it remains valid
  through the >180° rear half of a tracked orbit, and the host readout consumes
  that same settled frame cache without a second dead-reckon. Selected
  3D models are seeded at the tracked position before scene insertion and
  update before scene preparation from one frame-cached sample, retain real-world scale at
  ordinary ranges, cap at 200 px
  when very close for a continuous 2D→3D handoff, and use a 40 px selected
  model floor near the long-range 3D→2D cutoff so the glTF silhouette remains
  comparable to the selected billboard; ambient model sizing is unchanged.
- **Cockpit flight signals:** Live Signals shows the current and nearest
  flight names as larger clickable controls. Selecting a name transfers the
  active cockpit tracker to that flight; type and distance remain secondary
  text without repetitive event-category headings.
- **Ground-safe cockpit:** the first-person anchor and final camera position
  are clamped to the shared mesh-first rendered-surface floor with 12 m of
  clearance. In the photoreal stack, grounded entry keeps the existing safe
  map camera until that rendered mesh cell resolves instead of trusting a
  delayed/raw aircraft height as a temporary surface. Successful one-shot
  model ground snaps populate the same shared mesh cache, and repeated
  grounded source timestamps lift their stored history when the floor warms.
  Landing and taxi tracks therefore cannot place the camera below terrain or
  inside photoreal 3D Tiles.
- **Cockpit rolling telemetry:** the central speed, heading, and altitude
  values use per-digit vertical rolls when their displayed values change.
  Increasing and decreasing values move in opposite directions, and heading
  accounts for the 359°/000° wrap.
- **Cockpit route cue:** when reliable destination coordinates are available,
  the estimated-destination arrow occupies a fixed centered slot above the
  lower telemetry, follows the apparent ground-plane perspective, and rotates
  to show relative bearing within a legible ±120° steering range. Flights
  without destination enrichment omit the cue.
- The skylight feature set and six field-test hardening rounds shipped
  2026-07-03; **CCTV v2** shipped 2026-07-04.
  Voice tools are **28**. Global Context can be entered or exited directly,
  and Cockpit voice control supports status, entry from a selected or tracked
  aircraft (establishing Contacts first), exit, and filtered Previous/Next navigation through the full
  nearby-contact cohort. Contacts exposes source-honest counts inside its
  250 km subject window.
