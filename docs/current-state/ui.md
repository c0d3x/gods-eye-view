# Interface, keyboard and accessibility

Part of the [runtime reference](../CURRENT-STATE.md): UI defaults, keyboard and focus, map stacks, status chips, panels and loading.

## UI/UX Runtime Defaults

- Z ladder: panels promote within 100–139 (renormalized on wrap), voice pill 150, toast 200, clean-view exit 300.
- Panel POSITION keys are versioned `v8` (`godsEyeView.v8.panelPos.<id>`); collapsed-state keys remain `v6`. The one-time position reset clears stale DISPLAY placements that could overlap the Context rail.
- Map Source lives in the bottom Visual Presets tray. The left accordion contains no MAP STACK panel, and the `k` panel token that addressed it is gone from the share registry, so legacy `ui=k...` state takes the ordinary unknown-token skip.
- A dock popover (Visual Presets, Location) auto-dismisses on mouse-away unless pinned. Focus inside the tray defers that dismissal only when the browser reports `:focus-visible` — keyboard focus and typed-into fields hold the tray open; a mouse-clicked tile does not, because Chromium focuses a `<button>` on press.
- GEV MIC control is a glass capsule (var(--glass-bg), blur(24px) saturate(1.4), 999px radius; panel radius in error state).
- The desktop right rail (`#right-context-rail`) owns `DISPLAY`, `CCTV`, its active parameter controls, and `GLOBAL CONTEXT` as one fixed responsive stack in that order. Its compact buttons use the same 176 px width as the left accordion and one consistent 50 px height, share the left stack's 52 px edge inset and measured top baseline across HUD variants, then constrain themselves against visible HUD/chrome rectangles and the remaining vertical corridor. `DISPLAY` is no longer draggable and legacy saved coordinates are ignored.
- The right rail is labeled **DISPLAY** (formerly "MOVE") and groups, in order, HUD, DETECT, Bloom, Sharpen, 3D, Clean-UI (HUD + DETECT promoted to the top). Its expanded controls retain the same compact 176 px width as the right-side tabs instead of growing to the wider Context detail-card width. It starts expanded on first run and respects the user's later `v6` collapse choice. Collapses/expands with directional chevrons (`◀` collapsed, `▶` expanded).
- Display and Context use matching 330 px expanded widths and matching compact tab dimensions. The parameter panel is part of Display's expanded content. DISPLAY may remain open beside one contextual panel; CCTV and Context are mutually exclusive. In Tactical HUD, expanding CCTV or Context hides the other contextual launcher while DISPLAY remains independently available. The most recently opened right-rail panel owns the constrained lane even when it appears later in DOM order; passive restoration and automatic disclosure do not replace that explicit owner. Minimal and other HUD layouts retain the collapsed launchers; when their active panel exceeds the measured corridor, the rail reserves sibling heights and gaps and scrolls the active panel internally.
- `STYLE PRESETS` and `LOCATIONS` start collapsed, expand on intentional hover/click, and auto-collapse after hover leave delay.
- Collapsed mini-status indicators show active style and active location/landmark.
- Detection mode is user-controlled and should persist when switching styles. Since 2026-08-22 it also STARTS on — Dense @ 75% for every style on a first run, Normal included — as a `GLOBAL_POST_DEFAULTS` baseline that does NOT set `_detectionUserOverridden`. Exception (unchanged): selecting a military style (CRT/NVG/FLIR) auto-enables the same Dense preset, but only until the user manually changes detection this session (`_detectionUserOverridden` gate), after which style switches never touch it.
- Detection runs in the bottom lane of the shared host's single world-overlay `postRender`
  listener (not `preRender`) to eliminate bounding-box drift at close zoom.
- **Detection takes NO continuous-render hold (2026-08-22, `src/data/detectionRenderDemand.js`).**
  It repaints on CHANGE and asks the governor for exactly one more frame while work that spans
  frames is still outstanding. This is load-bearing for the detection-on-by-default flip: the old
  unconditional `holdContinuousRender('detection')` would have pinned every idle first-run tab at
  60 fps, defeating the render governor. Measured on a parked scene with zero layers: **0 renders
  per 5 s with detection ON, identical to OFF**; reinstating the hold gives 301. Gated by
  `scripts/qa-perf.mjs` §1b, which also counts the PAINTER's own frames so a painter that had been
  disabled outright could not score a perfect idle. The invariants — each of which a live
  adversarial review found broken in the first cut:
  - **Every kind of outstanding work must terminate.** A predicate that can stay true forever is
    the hold under another name. Three qualify: the enable fade-in, label fades, and a solve the
    frame could not run.
  - **Label fades count in BOTH directions.** A newly selected label is `selected`; counting only
    the fade-out tail left it invisible on a parked scene until an unrelated frame arrived.
  - **Paint and demand share ONE monotonic timestamp** — the host frame's `frame.timestamp`
    (`performance.now()`, sampled once per frame). Re-sampling dropped the terminal frame of a fade
    (paint at 219 ms drew alpha 0.99545; a policy re-reading at 220 ms said "done"), and a wall
    clock that jumps backwards keeps demand alive until it catches up. Nothing in the draw pass may
    use `Date.now()`.
  - **A skipped paint DEFERS, never cancels.** The relief valve's skip and its follow-up request
    come from one decision (`detectionPaintSkipDecision`), so it cannot drop the only frame that
    was requested.
  - **A changed detectable set dirties the solve.** Detection PULLS candidates per paint but
    re-solves on a private 125 ms throttle, so a layer tick that swapped contact A for B could be
    spent on a paint that declined to re-solve. `markDetectionSourcesChanged()` is called from the
    manager's layer tick and visibility change, next to the render request each already makes —
    discrete events seconds apart, never per frame — and it deliberately does not request a frame
    itself, because the caller already did.
  - **AIR brackets stay prompt because the AIRCRAFT LAYERS hold the loop, not detection**
    (verified live 2026-08-23). Brackets — including the alpha-floored ones — are painted inside
    `_drawOverlay` from live positions and take no part in the sources-changed notification, so the
    obvious worry is a floored bracket sitting stale on a parked scene. It cannot: an AIR bracket
    exists only while an aircraft layer is enabled, and `flights.enable()` /
    `militaryFlights.enable()` each take a continuous-render hold for their own per-frame fleet
    animation. For exactly as long as there is anything to bracket, the scene renders every frame.
    Measured on a parked camera: `holds: ["flights"]`, `requestRenderMode: false`, and an
    outside-aircraft population change moved the painted bracket count with no camera input. This
    is a COUPLING, so `detectionRenderDemand.test.mjs` pins it — a later perf pass that strips those
    holds the way it stripped detection's would take bracket promptness with it, silently.
  - Known, pre-existing, and deliberately out of scope here: the overlay's backing store does not
    re-derive on a DPR change mid-session (`worldOverlay` sizing — untouched by this work).
- The detection MODE BANNER (`DENSE VIS:… SRC:… DENS:…% ELASTIC …ms`) is
  developer telemetry and is HIDDEN by default. It paints only under
  `?detectDebug=1` (the `trafficDebug` convention), resolved once per
  `initDetection`. The same numbers are always available from
  `getDetectionDiagnostics()`. On a zero-object frame the "armed, nothing in
  view" signal is carried by the scanlines and sparse focus ring, not the banner.
- The HUD summary's `NEAR <landmark>` callout is capped at 150 km (metro scale).
  Beyond that it falls through to the `SECTOR <lat> <lon>` readout. The POI
  catalogue covers eight cities, so a looser bound made the HUD announce
  landmarks on other continents.
- Panoptic mode shows labels on ALL items (no stride skipping). Tracked/selected items keep bounding box but suppress label (skipLabel flag). Tracked items get enlarged bounding boxes (56×44 vs default 22×14).
- The 3D aircraft toggle reveals `Proximity` and `All` modes and drives both commercial and military aircraft layers. It ships ON in `Proximity`, so the button paints lit and the mode row paints open from markup; the panel is therefore ~36 px taller than before, which Cockpit's Display/Radio strip absorbs through its existing primary-only corridor solver.
- The host-painted tracked-target readout sits above the post-FX layer and follows tracked aircraft/satellites or selected mapped installations using each layer's display-position contract.
- Cockpit entry is gated to the operational Contacts context bundle. The
  Context chooser must be in Contacts mode, Live Flights and Military Flights must both
  be enabled, and a civilian or military aircraft must be tracked. The visible
  Cockpit actions and the `C` shortcut use the same gate, so ordinary standalone
  flight-layer selection cannot enter a context-dependent cockpit.
- **Aircraft cockpit view:** selecting a commercial or military aircraft reveals a `COCKPIT` action (`C`). Cockpit mode temporarily releases Cesium's orbit-follow transform and drives a first-person camera from the tracked aircraft's existing smoothed display position and course. Its concave helmet-visor HUD shows callsign, UTC time, coordinates, curved roll/pitch guides, and a seven-division heading tape. Ambient commercial and military AIR contacts use a Cockpit near/far band selected by the shared Display 3D mode: Proximity admits at 150 km and retains to 185 km; All admits at 400 km and retains to 450 km. The shared 3D toggle now applies in Cockpit: Off keeps in-range contacts as rotating 2D aircraft silhouettes, while On lets a ready admitted glTF take over without a drawing gap. The Cockpit model cap remains 60 and can only lower the map budget; in-range contacts that are capped or still loading remain 2D silhouettes instead of degrading to out-of-range dots. Contacts outside the selected band use small rotation-free cyan-white pips for civilian aircraft and amber pips for military. The pilot's own airframe is not drawn in first person, and exiting clears the Cockpit band and restores normal map silhouettes/models. The normal left accordion remains available for Layers and Scenes and keeps the same 26vh HUD-aligned anchor used in map mode, independent of whether the bottom-left Contact card is expanded or collapsed; the right-rail CCTV and Context chooser are hidden to avoid duplicating or overlapping the cockpit presentation. When the intelligence HUD is enabled, its classification, scene summary, collection/orbit metadata, coordinates, and imaging-status text remain visible as reduced peripheral cockpit telemetry; the optical center and flight instruments stay clear, and turning the HUD off still hides it. Ground speed, exact heading, and rendered altitude form one compact lower-center instrument cluster, keeping the horizon and peripheral view open. A second live altitude tape hugs the inside-right visor rim: its rail and nine moving ticks are derived from the same responsive keyhole radius, remain 20 px inside the circular edge even on wide displays, fade deeply at both vertical ends, and move continuously behind a fixed current-altitude pointer; its interval tightens automatically near the surface and it is suppressed on narrow screens. Cockpit mode also has a weather-backed transparent volumetric-cloud pass derived from the supplied FBM/domain-warped R&D shader. It renders at no more than 520×320, uses 24 ray steps/three FBM octaves at 12 FPS, is clipped to the visor, fails clear when Open-Meteo is unavailable, and stops its animation completely on cockpit exit. It does not restore the prior CPU weather canvases, precipitation, scene fog, or any map-mode effect. When Contacts is active for the tracked aircraft, the compact `CONTACT` rail adds the 250 km subject window, four cohort counts, nearest observed/mapped example with relative bearing and distance, freshness, explicit uncertainty, and Previous and Next controls plus its own collapse control. The mirrored right rail is a three-page **cockpit briefing carousel**: source-backed live signals, location-matched regional headlines, and local place/current-weather context from OpenStreetMap Nominatim and Open-Meteo. It is manual-first: Previous, Next, and direct page controls are always available, and the visible `CYCLE OFF` / `CYCLE ON` control starts or stops the nine-second page cycle. The cycle pauses on hover or keyboard focus and stops while collapsed, hidden, or outside cockpit mode; live signal data continues refreshing either way. Empty news matches and unavailable news use compact text states rather than reserving an empty media frame; partial local data remains explicit. Article links open their original publisher, and no headline is treated as verified risk intelligence. On desktop both cockpit rails use the same width and share a bottom-aligned safe baseline in opposite corners above the peripheral MGRS/GSD/time telemetry, leaving both that text and the lower-center instrument cluster readable. They collapse independently to slim tabs without stopping live data updates. Narrow screens use separated top/bottom fallbacks. Empty-space globe clicks are inert while cockpit owns the camera; `C`, `Escape`, or `EXIT COCKPIT` explicitly exits and restores the same tracked entity and standard follow camera. Unknown feeds remain unknown, selection loss still exits safely without inventing a replacement track, and the cockpit never presents the summary as threat scoring or an all-clear. This is a desktop first-person presentation, not a WebXR session.
- **Cockpit left-panel clearance:** the Cockpit Contact card and peripheral HUD participate in the adaptive left accordion's live obstacle measurements, including live viewport-height changes. Expanding Layers or Scenes keeps the active panel in the available upper-left corridor with internal scrolling; it does not cover the Contact card, lower Cockpit controls, or Cesium credit line. Outside Cockpit the hidden card does not alter the normal corridor.
- **Cockpit Context scope:** the 250 km radius applies to the air/sea proximity cohorts. Installation counts come only from the currently loaded viewport and are labeled `CURRENT VIEWPORT ONLY` in the cockpit as well as the normal Context panel; neither surface presents them as a complete 250 km installation survey.
- **Cockpit camera anchor:** first-person mode does not write feed-boundary corrections directly into the camera. A cockpit-only inertial anchor advances from the selected aircraft's displayed course and speed, then converges toward the authoritative delayed track with correction capped below forward motion. The displayed kinematics are derived from the same consecutive fix segment as the rendered position, with raw feed speed/course used only as fallback; a transient zero/missing feed speed therefore cannot freeze a visibly moving aircraft after layer enable or a map/cockpit handoff. Rendered altitude continues to come from that interpolated track position. Late ADS-B fixes and short render stalls can remove drift without accelerating or reversing the view. Camera placement runs before scene update/culling at a bounded 20 Hz so a moving cockpit does not force Photoreal 3D Tiles to retraverse on every display frame; textual instruments update at 10 Hz and context/layout work at 4 Hz. Every far Cockpit contact pip shares one stable Cesium texture-atlas entry and skips unused screen-projected course calculations, while only in-range 2D aircraft silhouettes pay the screen-projected rotation cost; ambient glTF collections are hidden/retained rather than synchronously destroyed at cockpit entry, and context rails lay out only on explicit content/state changes and viewport resize. The deliberate 15/30-second layer interpolation delays and per-Cesium-frame position caches remain unchanged.
- **Cockpit route, vision, and view controls:** visible on-screen `COCKPIT`, `RESET`, and `EXIT COCKPIT` controls replace reliance on the `C` shortcut. RESET uses the same canonical globe route as the map and voice actions, exits Cockpit, and releases its camera ownership rather than exposing the hidden map-style top action. When the tracked commercial flight has a plausible ADSBDB route, the top of the right briefing rail shows a compact `FROM → TO` airport strip and the visor shows a centered estimated-destination chevron with its relative bearing; absent or implausible route data hides the strip and cue rather than guessing. The cockpit-local vision control is an interactive `PREV / CURRENT / NEXT` carousel over the inherited map preset, `CRT`, `NVG`, `FLIR`, and `NOIR`; its previous/next actions wrap, and activating the current value advances to the next style. The inherited entry is named directly, such as `NOIR`, and retains that map shader. There is no empty `NONE` entry. CRT, NVG, FLIR, and NOIR temporarily activate the existing Cesium post-process stages, while returning to the inherited entry or exiting Cockpit restores the pre-entry visual style. The regional-news page uses a free Google News RSS locality query first, with the existing GDELT query retained only as a fail-soft fallback; linked headlines remain reporting, not verified incidents or risk intelligence.
- **Cockpit weather status:** the earlier multi-canvas atmospheric compositor remains fail-closed and is not attached to the live viewer. Cockpit clouds are a separate transparent WebGL pass with a capped 520×320 framebuffer, 24 ray steps, three FBM octaves, and a 12 FPS ceiling. It defaults off and starts only when local storage explicitly contains the persisted `WX ON` opt-in (`'1'`). When opted in, observations refresh after five minutes or 25 km of aircraft movement, fail transparent when unavailable or clear, and stop on exit or disable. `WX OFF` governs atmospheric rendering only: the briefing still fetches source-backed Nominatim, headline, and Open-Meteo local-information data, aborting and replacing any in-flight request when the selected aircraft changes. No weather effect runs in map mode and no synthetic fallback is shown.
- **Cockpit trail visibility:** entering cockpit hides the selected aircraft's trail body and head so they cannot cross the first-person view; exit restores them. This cockpit-only presentation change does not alter the normal map-mode invariant that aircraft trails render through terrain using their depth-fail material.
- **Aircraft course slew:** civilian and military 3D models retain the 60°/s course limiter, but each rendered frame can consume at most 250 ms of accumulated slew time. A long tile/render stall therefore catches up over multiple visible frames instead of turning one delayed frame into a heading snap.
- **Manual-first cockpit briefing:** the right-side Live Signals / Regional News / Local Info carousel does not advance automatically on page load. Previous, Next, and direct page controls remain available; the visible `CYCLE OFF` / `CYCLE ON` toggle explicitly starts or stops the nine-second page cycle, which still pauses on hover/focus and while collapsed, hidden, or outside cockpit mode. Live signal data continues refreshing in either state.
- **Photoreal horizon blend:** Cesium's sky atmosphere remains enabled behind the hidden base globe, but its light intensity, saturation, and brightness are reduced from the library defaults so the distant Google Photorealistic 3D Tiles boundary blends into the sky instead of producing a bright cyan horizon seam.
   - **Cockpit direction and speed tapes:** plausible destination metadata now drives one translucent, isometric visor chevron labeled directly below with the estimated geographic bearing; the prior full geodesic dashed path is not rendered. A mirrored live ground-speed tape follows the inside-left keyhole rim using the same responsive curve, end fades, fixed pointer, and fractional tick motion as the altitude tape on the right. Speed values scroll upward as they increase while altitude values scroll downward. Its tick endpoints and current-speed pointer share the rail's inset-circle origin, so the markings stay attached to the visible curve rather than drifting inward with the text-label gutter.
- Voice control UI (`#gev-voice-control`) shows status states OFF / CONNECTING / LISTENING / EXECUTING / ERROR.

### Current Global Post Defaults

**Reasonable-defaults batch (2026-08-22), extended and partly revised
2026-08-23.** First-run defaults move together as one coherent console
presentation. Every one is a FIRST-RUN baseline only: a
share link or the operator's own hand still wins over it, and none of them sets
the `_detectionUserOverridden` / explicit-intent flags that would suppress a
separate landed behaviour. Pinned in `src/reasonableDefaults.test.mjs` (feather,
detection, OUTSIDE opacity) and `src/data/layerState.test.mjs` (3D).

**The 2026-08-24 defaults** (superseding the interim 08-23 values of 8%/3%):
the first-run look is Detection DENSE
`75%`, ELASTIC allocation, Fade `7%`, OUTSIDE opacity `1%`, scope feather `11%`,
and 3D fleet mode PROXIMITY, with `AIRCRAFT_BRACKET_FLOOR_ANCHOR` at `0.01` so
brackets keep their approved brightness exactly at the new OUTSIDE default. Two
terms that must never be conflated: scope FEATHER softens the black scope-mask
edge; detection FADE is the label/card fading band around the keyhole. The
OUTSIDE slider's `step` stays `1` so every low stop is reachable.

**Allocation, defined precisely** (matches
`src/data/labelArbiter.js` `allocateLayerQuotas`): **ELASTIC** begins with
roughly equal capacity across active layers and redistributes unused
entitlement (`labelArbiter.js:170`); **WEIGHTED** allocates using visible
demand with square-root demand scaling and semantic layer weights
(`labelArbiter.js:181`). First-run default: ELASTIC.

**A default has THREE surfaces, and a PARSE fallback that is not one of them.**
The value literals (engine constant, markup value, markup readout,
`GLOBAL_POST_DEFAULTS` in `src/ui/styleConfig.js`, the share generator's
starting state) must all move
together, because a fresh boot runs no restore and those literals ARE the startup
state. The `scf` / `ko` PARSE fallbacks deliberately do NOT move: they answer
what an OLD LINK that omits the field meant, and such a link was authored under
that era's default (`scf` → 35, `ko` → 5). Every link since carries both fields
explicitly, because the generator always writes them, so no era whose default
later changed depends on a fallback either way.

**They do NOT all persist the same way, and only one of them persists at all.**
Worth stating plainly, because "a default you can override" and "a default that
remembers" are different promises:

- **3D models** have durable storage — `gev:layer-state:v2` in local storage,
  written by `LayerStateCoordinator` on explicit intent. A session that stored a
  snapshot keeps whatever it stored, across tabs and restarts.
- **Detection mode/density and scope feather have NO storage key at all.** Their
  only durable carrier is the URL hash (`dm`/`dd`, `scf`), written on a 500 ms
  debounce. A same-URL reload therefore keeps them only if that debounce already
  fired; a bare URL or a new tab returns to these defaults. That is unchanged by
  this batch — it is simply what these controls have always done — but it is the
  reason "stored state wins" is true of the 3D toggle and not of the other two.

**Known edge (detection, pre-existing, deliberately not redesigned here):** a
hash-restored `dm=OFF` restores the MODE but not `_detectionUserOverridden`,
which is session-scoped. A recipient of an OFF link who then selects a military
style therefore gets the style's auto-enable, where the original author — who had
turned detection off by hand — would not have. The default flip makes this edge
easier to meet (detection is now on more often), but does not create it.

- Bloom: `OFF`, intensity slider at `100%`
- Sharpen: `ON`, intensity slider at `49%`
- HUD: `ON`, layout `tactical`
- **Detection: `DENSE` @ `75%`** — ON for EVERY style on a first run, Normal
  included (was `OFF` @ `50%`). It is literally the same frozen
  `MILITARY_DETECTION_PRESET { mode:'dense', densityPct:75 }` object the military
  styles and the Contacts context mode already apply (Contacts OWNS detection
  while active and restores the prior state on exit — `contactsDetectionPolicy.js`;
  Cockpit deliberately does not touch detection at all), read by
  `GLOBAL_POST_DEFAULTS`, so there is one tactical look rather than several that
  can drift. Fade opens at `7%` since the 2026-08-24 final lock (`16%` before it). Style-switch semantics are
  unchanged: CRT/NVG/FLIR still carry `detection: MILITARY_DETECTION_PRESET` and
  still yield to `_detectionUserOverridden`; Normal still has no
  `STYLE_PRESET_DEFAULTS` entry, so switching TO Normal touches nothing. A share
  link carrying `dm=OFF` still restores OFF.
- **Detection OUTSIDE opacity: `1%`** (moved `5% → 3% → 1%` on 2026-08-24).
  `KEYHOLE_OUTSIDE_OPACITY_DEFAULT` in `src/celestialRing.js`, mirrored by
  `#detection-opacity-slider`'s markup value AND readout,
  `GLOBAL_POST_DEFAULTS.detectionOutsideOpacityPct` in `src/ui/styleConfig.js`, and
  `_detectionOutsideOpacityPct` in `sharelink.js`. The slider's `step` is now
  `1`, so 1–4 % are reachable at all (at the previous step of 5 the entire
  sub-default range was one stop wide). `AIRCRAFT_BRACKET_FLOOR_ANCHOR` in
  `src/data/detectionPolicy.js` MOVES WITH IT — the AIR bracket floor is
  calibrated so `AIRCRAFT_BRACKET_ALPHA_FLOOR` (0.35) lands exactly at the
  default, and the mapping follows bracket brightness rather than slider
  position. The `ko` PARSE fallback stays at `5`.
- **Scope feather: `11%`** — a soft scope-mask edge (moved `0% → 8% → 11%`; `0%` hard crop for one day,
  `35%` before that). `SCOPE_FEATHER_RATIO_DEFAULT` in `src/scopeMask.js`,
  mirrored by `#scope-feather-slider`'s markup value AND readout and
  `_scopeFeatherPct` in `sharelink.js`. The slider is untouched and still spans
  0–100, and an explicit `0` is still the hard-crop path — pinned, so moving the
  default cannot quietly delete it. The `scf` PARSE fallback deliberately stays
  at `35`: a link predating `scf` was authored when 35 was what its author saw,
  and restoring the author's view is what a share link is for.
- **3D aircraft models: `ON`, mode `proximity`** — see the 3D Aircraft section
  above and the DISPLAY-rail entry below (was `OFF`).
- Style shader starting params: CRT/NVG/FLIR pixelation `1.2` (just above the native `1.0` floor); thermal/FLIR ships an optional Ironbow "Predator" palette (`palette` uniform, default `0` = accurate grayscale).

## Keyboard interaction and focus

- Enter on the map-source disclosure opens immediately. A short Space press
  opens it on key release. Either route focuses the selected source once visible;
  a bounded retry handles delayed opening transitions, and closing the tray or
  moving focus elsewhere cancels the handoff.
- Keyboard focus rings are a global interface state and stay visible when a
  button is active or selected. Visual Styles, Location suboptions, Context and
  mission actions, Cockpit utilities, native fields, and sliders use the same
  visible-ring contract.
- A short Space press on a focused control keeps its native key-release action.
  If it remains held for 500 ms, focus is checked again, the control is blurred,
  and push-to-talk starts; releasing a claimed hold cannot activate the old
  control. The same hold works on the map and page background. Text-entry
  controls remain protected.
- The Location disclosure is reachable with Tab or Shift+Tab and shows a
  keyboard focus ring. Its city, point-of-interest, search-toggle, and search
  field controls show inset rings, including selected items. Enter toggles its
  tray immediately, while Space does so on release; either route makes the revealed controls immediately reachable by Tab;
  Escape closes it and clears any unfinished search. Escape from a tray control
  returns focus to the disclosure; Escape on the disclosure clears focus after closing.
- Data Layers ON/OFF buttons show a visible keyboard focus ring without
  changing their enabled state or feed-status presentation.
- Display controls and shader-parameter sliders show keyboard focus in both
  the map panel and Cockpit Display. Arrow keys retain native range adjustment.
  The enabled CCTV camera dropdown shows keyboard focus as well.
- Tab reaches both Contacts and Space Missions in sequence in every Context
  state. Left/Right arrows also switch them; the focused tab has a distinct ring
  even when selected.
- Keyboard focus on a Space Missions roster item uses the same temporary globe
  rotation and mission-marker highlight as pointer hover. Focus alone does not
  select the mission; Enter or Space performs selection. Keyboard and pointer
  preview ownership remain independent when the pointer is parked over the list.
- Radio power controls in the full, compact, and Cockpit surfaces, Search Nearby
  Sites, and Clear Selected Layers remain focusable while lifecycle work is in
  progress. They announce busy/disabled semantics and ignore repeat activation
  until the operation settles, so async work cannot drop the keyboard ring.
- Normal-mode Contacts results preserve the focused action or contact by stable
  identity while live counts, distance order, and pages refresh. If that contact
  departs or rotates off the visible page, focus moves to a stable continuation
  point on the named explanatory note at the end of the list and remains there
  through later repaints. The following Tab proceeds beyond the results instead
  of restarting at Contacts or silently focusing another contact.
- Cockpit Live Signals updates existing contact buttons without replacing or
  disconnecting the focused one. Tab can continue through the briefing footer
  to Display and Radio. If the focused contact leaves the list, focus moves
  once to the current briefing tab; later refreshes do not reclaim it.
- Cockpit-only Display and Radio launcher icons show a complete inset keyboard
  ring in their collapsed and expanded states.
- Escape collapses the nearest expanded panel containing focus before any
  containing panel acts. Closing from panel content returns focus to that panel's
  disclosure; closing from the disclosure itself clears focus so the collapsed
  button does not retain its ring. This includes standard panels, nested
  Parameters, Cockpit Contact and Live Signals, and Cockpit Display/Radio utilities.
- The required bottom-left Data attribution control is a named popup button in
  the Tab order. Enter opens immediately and Space opens on release, then the
  credit lightbox focuses Close;
  Close, Escape, or backdrop dismissal restores focus to Data attribution.

## Map Source keyboard focus

Keyboard opening focuses the selected map-source tile, falling back to the first
only when no source is selected. A bounded retry handles delayed tray visibility.
Moving focus away, pointer interaction, closing the tray, or disposing the UI
cancels pending work; a later reopening cannot inherit an old focus request.

## Control names for assistive technology

Scope, Bloom, Sharpen and location search have explicit accessible names.
Generated style sliders use the same name as their visible parameter label.
The first-run suppression checkbox keeps its native wrapping label, so its
accessible name remains "Don't show this again". Control behavior is unchanged.

## Map Stack Switcher

- `src/mapStackController.js` switches between Google Photorealistic 3D (`photoreal`, the default when a Google or ion key is present), keyless Esri World Imagery (the zero-key default landing, with keyless terrain), Bing Aerial / Aerial-with-Labels via Cesium ion world imagery (require `CESIUM_ION_TOKEN`), and OSM tile fallback. Bing Road is **retired**: it is gone from `MAP_STACKS`, from the `set_map_stack` enum, and from the voice aliases (road phrasings now resolve to OSM, the one shipped road basemap). An old `map=bing-road` link is simply an unknown id and takes `setStack()`'s existing photoreal fallback with the Google 3D tile lit — pinned live in `scripts/qa-map-source-tray.mjs`.
- The bottom Visual Presets tray presents a **five-tile MAP SOURCE row** (`#map-stack-chips`, `src/mapStackChips.js`): Google 3D, Esri Satellite, Bing Aerial, Bing Labels, and OSM. The duplicate left `#stack-panel` is retired. The five tiles share one row on desktop and two rows on narrow screens, carry `aria-pressed` on the active source, and remain keyboard-reachable with a visible focus outline.
- The lit tile follows controller state, not the click: a rejected switch (no ion token) or a superseded one (rapid A→B) leaves the genuinely active source lit, and the tray heading keeps its short-label status readout (`...` while switching, amber on `lastError`).
- Ion stacks remain visible and keyboard-focusable when no ion token is configured, but expose `aria-disabled="true"` and do not switch. Their accessible label and tooltip quote `getStacks().unavailableReason` — the same string `setStack()` puts in the toast. OSM works keyless. The `ION` badge is gated on the stack's own `requiresIon`, so a `photoreal` chip unavailable because the Google tileset failed says so instead of falsely demanding an ion token.
- Stack choice participates in share links (`src/sharelink.js`) and falls back to the best available stack when the requested one is unavailable (keyless boots land on Esri; OSM takes over automatically if Esri is unreachable). Share-link restore, the `set_map_stack` voice tool, and the chip row all land on the same `_setMapStack()` path.

## Split-flap status chips

- The three status chips flip their LABELS over character by character when the text changes, like a departure board: `#global-loading-label` ("LOADING LIVE DATA" → "LOAD COMPLETE"), `#traffic-sync-label`, and `#cctv-sync-label` ("loading frames" → "camera grid ready"). All three route through `setSplitFlapText()` in `src/splitFlap.js`; there is no other writer of those three elements. The progress counters (`#*-sync-progress`, `#global-loading-detail`) are deliberately left as plain `textContent` — they tick several times a second, and flapping them reads as a slot machine.
- `#global-loading-label` doubles as the universal top-center status banner, so anything routed through `_showGlobalStatusNotice()` flaps as well — in particular the share-link restore notices, of which "Shared military flight could not be restored — feed unavailable" is the longest at 63 characters. That needs no special case: `planSplitFlap()` compresses the stagger to hold the 620 ms budget (26 ms → 6.9 ms per column at that length), every column is reserved for the whole cascade, and `element.textContent` is the complete notice at every instant, so the `aria-live` region announces the whole sentence rather than a fragment. A notice deferred minutes past boot is equally safe: `ensureHost()` re-validates the shell on every call, and the long-lived `Text` node is never replaced.
- **DOM text is the truth, and its node NEVER moves — do not "fix" this.** The first call upgrades a chip label into a permanent shell (`ensureHost`): a `.gev-flap-text` span holding one long-lived `Text` node, plus an `aria-hidden` `.gev-flap-cells` sibling. After that the ONLY text operation for the life of the chip is `node.data = next`. Nothing is reparented, so the label is never transiently empty and the `aria-live` region never sees a removal/reinsertion pair it could announce twice. `element.textContent` is the settled string at every instant, because the cells carry no text at all: both glyphs are CSS generated content (`::before` from `data-flap-prev` = outgoing, `::after` from `data-flap-next` = incoming), which never reaches `textContent`. This keeps QA pins honest and lets `_updateTrafficSyncChip`'s own `textContent !==` guard keep working. The shell is built on a tick where the text is NOT changing, so no real label change ever carries a structural mutation.
- **No animation loop, and exactly ONE `setTimeout` per change.** CSS `animation`/`transition` only, triggered once per text change and staggered through a per-cell `--gev-flap-delay`. The single timer is the settle that strips the cells; the width ease ends on a `transitionend`/`transitioncancel` listener, never a second timer. Idle cost is zero, there is no periodic work, and nothing requests a Cesium render or takes a render-governor hold. `setSplitFlapText` is a no-op on unchanged text, which is required — the chips are repainted by a 60 ms and a 500 ms ticker.
- **Only what was visible flaps away.** An interrupted cascade (A→B cut short by C) derives each column's outgoing glyph from `visibleGlyphs()` — what that column is actually SHOWING at that instant, which for a column whose stagger has not elapsed is still A, not the pending B. `FLAP_TURN_RATIO` must track the `gev-flap-out`/`gev-flap-in` keyframe crossover in style.css.
- **Columns never renumber mid-cascade — do not "optimise" this away.** For the whole cascade the board keeps one column per index of the LONGER string, each holding its own width; a column the new string does not reach flaps to a BLANK in place (`data-flap-next=" "`) rather than collapsing. Collapsing stacks the absolutely-positioned outgoing glyphs on one x AND lets a later glyph slide into an earlier column, which makes `visibleGlyphs()` lie and the interrupt rule flap the wrong glyph away. Pinned by "a cleared column holds its place instead of letting later glyphs slide left".
- Length changes are eased, never snapped, and the ease is placed so it never fights the flaps (`.gev-flap-sizing`): a GROWING label reserves its columns as the cells go in and eases at the START; a SHRINKING one holds full width for the whole cascade and eases at SETTLEMENT.
- Accessibility: the cells sit in an `aria-hidden` wrapper and the settled string is real text in the a11y tree, so the `aria-live` chips announce the label once per change rather than character fragments. No `aria-label` is used — ARIA prohibits naming a generic `<span>`. Because the text node is permanent and only its data changes, a label update is a single `characterData` mutation and settlement is none — node churn in a live region can double-announce.
- A chip hidden by clean-UI, recording mode, or an un-`.visible` (`opacity: 0`) traffic/CCTV chip swaps instantly instead of animating where nobody can see it; `prefers-reduced-motion: reduce` does the same.
- Kill switch: `SPLIT_FLAP_ENABLED` in `src/splitFlap.js`. Set it `false` and every chip returns to a plain instant swap with no other change.
- Regression surface: `src/splitFlap.test.mjs`.

## TR-3B conversion Easter egg

- With a contact tracked, CONTEXT ▸ CONTACTS shows a small 🛸 chip beside COCKPIT (`#tr3b-toggle`, gated by `CockpitView.syncTr3bToggle()` on a tracked contact — not on the cockpit entry policy). Pressing it converts that contact into a TR-3B and pressing it again restores the real aircraft. State lives in `src/data/tr3bRegistry.js`: a session-scoped module-level `Set` keyed by ICAO 24-bit address, shared across both flight layers the same way `militaryRegistry.js` is, so a conversion holds through a civil↔military handoff. It is deliberately NOT persisted (no localStorage, no share-link param, no schema change) and layer teardown deliberately leaves it intact — only a page reload clears conversions.
- The sprite is two hidden kinds (`tr3b`, `tr3bHot`) in `src/data/aircraftIcons.js`, authored in the same 96×96 nose-up pipeline as the eight class silhouettes, so the triangle points along the display course through the existing screen-projected rotation path with `alignedAxis` still `ZERO`. They are unreachable from `classifyAircraft()`. Variant selection rides the existing `irBoost` layer param, so under NVG/FLIR/surveillance the hull stays cold and the four emitters render hot; a style switch re-images only converted contacts, never the rest of the fleet.
- Both layers resolve every `aircraftIcon()` call through a local `_iconKind()` shim (identity for unconverted contacts), so no refresh path — poll reconciler, two-tier raster swap, presentation pass, tracked entity — can revert a conversion.
- The class label follows the conversion across every surface that reports one: tracked card, cockpit/`getTrackedInfo`, Contacts, and the analyst record's `aircraftClass` (`tr3b`, the style-independent id, so a query answers the same in FLIR as in Normal). Callsign, flight level, speed, and route stay live-feed truth.
- A converted contact is billboard-only. It is excluded from model eligibility at SELECTION time, so it never consumes a `MODEL_MAX` cap slot, with the handoff guard and the tracked-model regime guard kept as defence. The billboard stays shown, so the contact keeps satisfying the `getNearby` / `getDetectableObjects` visibility guards and still works in Contacts and Cockpit.
- Regression surface: `src/data/tr3bRegistry.test.mjs`.

## Panels and loading

- **Required attribution has two named keep-out rules (2026-08-20):** the
  Google/Cesium credit line must stay visible in every state, and below 900px
  two surfaces used to paint over it — the command dock's popover tray (any
  width ≤900px) and the right context rail, which goes edge-to-edge below
  720px and covered the credit with every dock panel closed. Both now yield;
  the credit itself never moves, shrinks, or hides. **The clearance is not a
  single constant:** `#command-dock` is anchored at `2vh` down to 721px and
  re-anchors to a flat `8px` at 720px while `#cesium-credits` keeps its `2vh`
  base, so anything reasoning "the 2vh terms cancel" is only true in the
  721–900px band. `src/creditAttribution.test.mjs` is a **fail-closed** cascade
  model: it flattens `style.css`, resolves each anchor by importance →
  specificity → source order, evaluates a 14×11 viewport grid, and fails
  loudly on any construct it cannot resolve (`!important`, `inset`/`margin`
  shorthands, unvetted custom properties, unparsable or nested media queries,
  or an unrecognized selector positioning one of these elements). Extend the
  model rather than working around it — a silent skip here ships a ToS
  violation.
- **Dock tray stacking is decided by ID count (2026-08-20):** the pinned-tray
  selectors `#command-dock.dock-has-two-pinned-trays …` carry one ID against
  five classes, so any narrow-width override written with two IDs outranks
  them and the upper tray silently loses `var(--dock-lower-pinned-height)`,
  landing on its pinned sibling. The ≤900px and ≤720px overrides therefore
  name the panel (`#location-bar` / `#control-panel`) to reach (2,5,0). Adding
  a new tray rule means checking it against the pinned variants, not just
  against the base rule.
- **LOCATION mini-status is data-only today (2026-08-20):** the collapsed
  readout now follows a free-text geocode search as well as preset pills
  (`src/locationStatus.js` owns the copy for both), and every other camera
  destination invalidates the searched label — `_stampNavigation` covers
  voice/reset/takeover/selection, and scene playback calls the public
  `clearSearchedLocation()` per shot. `#command-dock` still hides
  `.location-mini-status` with `display: none !important`, so none of this is
  on screen; a `display:none` subtree is also out of the accessibility tree,
  so nothing is announced. Unhiding it is a separate product decision.
- **`#active-style-name` has exactly one writer (2026-08-20):** the style-name
  mapping in `setStyle`. Location, search, and scene paths report where the
  camera is through the LOCATION surfaces, never the style slot.
- **Compact data-attribution panel:** the complete Cesium credit inventory
  remains available without taking over the viewport. Its expanded desktop
  panel is capped at 70dvh/36rem, the wrapped 12px credit list scrolls inside
  it, and narrow screens retain Cesium's full-screen surface with an internal
  scroller. The title, close control, links, and persistent Google/Cesium line
  remain unchanged and visible.
- **Minimal HUD right rail:** constrained focus layout keeps the collapsed
  CCTV and Context launchers visible and accessible while the expanded
  Display panel scrolls inside an explicit remaining-height budget. The rail
  reserves both launcher heights and inter-panel gaps without a self-reversing
  layout measurement. Tactical HUD instead gives the expanded Display, CCTV,
  or Context panel exclusive use of the rail and hides its collapsed siblings
  until the active panel is collapsed.
- **Display panel width:** across desktop HUD layouts, the expanded right-rail
  Display panel uses a 272 px glass-backed surface; its collapsed tab and
  narrow-screen layout retain their existing responsive widths.
- **Loading, reset, and Display completion:** every registered layer exposes
  one normalized manager loading contract. Enable and disable feedback remains
  lifecycle-authoritative, while manager-owned periodic updates publish
  refreshing, failure, and recovery without replacing a producer's more
  specific error or availability state. The shared presentation is delayed to
  avoid flashes, visible outside the rails, and retained in
  Cockpit. One continuous overlapping load interval retains the strongest
  terminal outcome (`failed`, then `cancelled`, then `complete`) until every
  participant settles, so a later success cannot mask an earlier failure.
  A participating producer's terminal error, unavailable status, or
  key-required state also outranks generic completion without requiring a
  separate manager failure event; AIS first-connect expiry therefore ends as
  `LOAD FAILED`, not `LOAD COMPLETE`.
  Slow disable work is labeled as turning live data off rather than
  as a completed load. Street Traffic's dedicated sync chip shows genuine
  work and one bounded completion; steady TomTom coverage, including 0%, does
  not keep it open. Mapped Installations reports its bounded camera-driven
  requests to the same shared surface, but full-globe `zoom-in` guidance is
  not presented as loading. Terminal completion, cancellation, and failure
  labels are centered in that surface without an empty detail slot. The circular `RESET GLOBE` action sits beside the top-center share
  control in map view; Cockpit hides the complete action group and provides a
  cockpit-styled `RESET` beside `EXIT COCKPIT`. Both resets share one route
  with the voice action, release continuous/POI/Cockpit/entity and
  Space Mission camera ownership, and returns to the 18,000 km globe frame.
  Reset preserves the selected Contact while invalidating delayed automatic
  refocus work; the normal Context `FOCUS` action is the explicit route back
  to that same flight or vessel after the globe view settles. Location
  navigation uses the same selection-preserving camera
  handoff once a city, landmark, coordinates, or search destination resolves;
  failed searches leave the current camera owner untouched, and Context Focus
  can return to the preserved Contact. Focus also restores the selected
  aircraft's canonical follow frame after a manual zoom-away.
  Visual presets retain the order Normal, CRT, NVG, FLIR, Anime, Noir, Snow.
  Configurable preset selection—including same-style reselection—opens the
  shared Parameters surface directly below Detection and scrolls it into
  view; share-link restoration
  does not force that disclosure. Presets remain in the map Display. The
  shared Parameters surface moves into Cockpit Display for the session and
  returns on exit, with slider values contained by the panel at its supported widths;
  the bottom Visual Presets tray owns the MAP SOURCE label, centered status,
  and five-tile source row. Its compact wing is a keyboard disclosure:
  Enter/Space opens and focuses Map Source, Escape closes and returns focus,
  and unavailable sources remain tabbable with their reason exposed. Expanded left-panel
  headers use the same container-owned background treatment without changing
  their collapsed launchers; a soft 28% cyan divider identifies expanded
  titles on both side rails.
  Cockpit portals HUD, Detection, the single shared Parameters surface, and
  3D controls, but not the visual-preset grid. Parameters follow the active
  Cockpit vision treatment and remain directly below Detection. Changing the
  top vision style does not close an open Display or Radio utility; explicitly
  opening Display still collapses Live Signals. Its left-side
  Data Layers and Contact interactions do not collapse an expanded
  Display or Radio utility. Presentation-only adaptive collapse is reconsidered after HUD
  and viewport changes, while explicit collapse remains the only persisted
  user intent.
  Display orders 3D immediately above Celestial and Clean UI immediately
  below it. The top-center action group places Clear Layers to the left of
  Share and Reset Globe to the right. Clear Layers turns off the currently
  selected manager-owned data layers, including an active Context choice,
  while retaining visual, HUD, map, and panel settings. A disabled layer may
  still release camera work that it owns through its normal teardown.
  Direct Data Layers entry into Space Missions excludes the new mission ON
  intent from its pre-entry snapshot. Its OFF control therefore leaves Space
  Missions off and restores Satellites to their exact pre-entry visibility
  and parameter state.
  The title and loading logos use a blue 10 px outer-eye stroke with a
  translucent slate fill, while the globe-and-cage gaze travels up to 34 SVG
  units toward the pointer for clearer feedback at the compact title size.
