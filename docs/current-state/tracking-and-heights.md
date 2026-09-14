# Aircraft tracking, trails and heights

Part of the [runtime reference](../CURRENT-STATE.md): motion and symbology, 3D aircraft, detection, trails, ground floors and tracked contacts.

## Motion & Symbology Correctness

- **Flights (commercial + military)** render one poll interval behind real time (30s/15s) and interpolate between two known feed-stamped fixes (OpenSky `time_position`; adsb.lol `receipt − seen_pos`). The display latency is an intentional product decision — do not "fix" it away. The whole fleet dead-reckons at ~12Hz (1m² write gating); aircraft get a 3-poll grace period (faded icon) before removal. When a position epoch pauses, both layers coast for at least 60 seconds of contact grace with an absolute five-minute ceiling. Source backoff marks each contact and the cockpit `STALE`; the cockpit then holds the exact layer position instead of continuing inertial flight. Repeated-position kinematic changes create a forward-only synthetic fix rather than mutating history, and grounded history is lifted only when no owned 3D model already controls its datum. A nominally successful worldwide OpenSky response whose own snapshot epoch is more than two minutes old prefers the existing 250-nm viewport-scoped adsb.lol fallback and labels the source/coverage accordingly when that upstream is available. If the fallback is also unavailable, the layer's freshness/error fields use the source epoch—never the cache receipt time—so the UI reports an old snapshot rather than “just now.”
- **World-space headings at every angle** (`src/data/iconOrientation.js`): aircraft/vessel icon rotation uses the camera right/up basis per tick (alignedAxis always ZERO), which is exact at screen center and for orthographic/nadir views and remains stable through >180° tracked orbits. Perspective rays vary across the viewport, so off-center contacts at oblique pitch can diverge from an exact finite-difference window projection; a regression test pins that known regime, and field evidence decides whether to adopt exact projection with the basis method as fallback. Fleet rotations refresh on camera-pose change; tracked entities per frame. Billboards are horizon-culled via a shared EllipsoidalOccluder.
- **Military/OpenSky reconciliation** (`src/data/militaryRegistry.js`): known-military ICAOs render amber in the flights layer (60s self-poll of the cached mil endpoint when the military layer is off) and are suppressed there while the military layer renders them.
- **Satellites**: 838-sat core catalog (stations/visual/GPS/GLONASS/Galileo/GEO), tracking lands ~726km out via `viewFrom` (tracked entity owns a point graphic so the tracking camera engages), rings realign via primitive modelMatrix (no per-second rebuild flicker), optional `setParams({catalog:'dense'})` Starlink mode.
- **Satellite classes** (`src/data/satelliteClass.js`): every satellite is classified from the CelesTrak group it was ingested with — no extra fetch and no heuristics — into STATION (warm white), NAV (cyan; GPS/GLONASS/Galileo deliberately share one color so the GNSS family reads as one thing), GEO (violet), VISUAL (muted blue-gray catch-all), and COMMS (dim slate, dense Starlink shell only). That module is the single source of truth for class, label, and color, so the dot, the card, and the legend swatch cannot disagree. Two deliberate palette rules: no class may sit in the 40–48° amber band, which is the app-wide known-military convention; and COMMS stays far below VISUAL in Rec.601 luminance so the dense shell stays separable when NVG/FLIR collapse the scene to one channel. The ISS keeps its long-standing red hero dot rather than the STATION color — it carries a permanent name label and its card still reads `STATION · ISS`. `satelliteClassOf` is the single owner of that ISS rule, so the card label and the legend tally can never disagree: during a stations-feed outage the ISS is ingested as `visual`, and both surfaces still file it under STATION.
- Class is also a **text field**, not just a color: `NAV · GPS` / `GEO` / `COMMS · STARLINK` / `STATION · ISS` leads the tracked card's detail block and replaces the raw CelesTrak tag on the detection-overlay label. Because that canvas composites above the post-FX chain, the class stays readable in NVG/FLIR after the in-scene dot colors are flattened.
- The satellites row in DATA LAYERS carries per-layer sub-controls (`DataLayerManager._syncRowControls`, the first consumer of the optional `getRowControls()` layer hook): a **DENSE** chip exposing the existing `catalog` param, and a swatch legend with live per-class counts. Default is the sparse core catalog. The chip is stateless — it declares the params to apply and the manager owns the write — so the Space Missions capture/restore path over the same param stays authoritative. Controls stay hidden while the layer is off. An explicit CORE or DENSE choice participates in versioned local and share-link state; temporary Space Missions overrides do not.
- **The DENSE chip reports the dense LOAD, not the catalog param.** The param flips synchronously while the Starlink shell takes seconds to arrive over a chunked load, and CelesTrak 502s that feed regularly. So the chip reads `DENSE ···` (busy, disabled) while loading, ACTIVE only once dense points are actually on screen, and `DENSE ✕` with the reason on hover when the load fails — a failure also reverts `catalog` to `core`, drops any partial chunk, and leaves the chip clickable to retry. A load is judged by points added, not by HTTP status: a 200 carrying an empty body, a passed-through HTML error page, or only TLEs the core catalog already owns fails with the same revert semantics as a 502. Any explicit request for `core` clears a latched error even when the mode does not change, so a Space Missions restore of an already-core snapshot never leaves the user with a failure they did not cause. Because the load settles asynchronously, the layer pushes a re-render through the optional `setRowControlsListener()` hook; nothing else would repaint that row before the 5-minute catalog refresh, so the count and legend would otherwise sit stale.
- **A dependency owner takes the row with it.** Space Missions borrows this layer for TLE lookup with `showPoints:false`; while points are hidden the layer returns empty row controls, so the legend never describes an empty sky and the chip cannot accept a write that the owner's restore would silently revert.
- The detection-overlay record cache (`_detectionObjects`) is cleared with the catalog on every rebuild: it stamps id/class at creation only, and a rebuild can re-tag a satellite when a partial CelesTrak outage changes which group wins dedupe.
- **FIRMS**: no ground clamping (zero 3D-tiles height sampling), ≤18 screen-decluttered ambient labels, click-to-inspect detail card, 2.5k/3k sprite budgets viewport-clipped by FRP.
- **CCTV v2 foundation:** a pitched
  frustum wireframe (4 corner rays + far-cap rectangle) with a monitor plane at the frustum's
  far cap, retargeting the existing video/canvas texture pipeline. Manual calibration only —
  auto-calibration and the drape mesh pipeline are deleted. A one-shot activation obstruction
  probe (`pickFromRay` on camera activation, clamping the plane short of the first hit) remains;
  ground placement is superseded by the shared-floor v3 behavior below. Calibration persists to
  `godsEyeView.cctv.calibration.v2` (wiped clean, no v1 import); a panel-only CAL badge shows
  `CALIBRATED`/`CURATED`/`RAW PRIOR` (no in-world tint). Panel is titled "CCTV" (not "CCTV
  MESH"). Staggered geometry/frame loading is active-first and uses 4 records per 120 ms normally,
  or 2 per 250 ms while tracking/cockpit owns the view (re-evaluated each batch), with coalesced progress
  notifications (roughly 300 ms or ten batches; natural completion and disable each publish their
  terminal state through their own completion paths) and a LOADING FRAMES
  chip and the preview-first auto-expanding panel are unchanged. Coverage polylines are created
  lazily instead of inserting five entities for every catalog camera during initialization: default
  COVERAGE ON enable creates the active/visible 14-camera cohort, and activation always creates the
  selected frustum even with COVERAGE OFF. **Field validation passed
  2026-07-04** (core look + downtown no-clip confirmed); that round fixed three findings: the
  ground clamp now lifts the cap *center* only so the wireframe stays a true pyramid welded to
  the plane (was a flattened fan / the ~47.5 m divergence — RESOLVED), re-selecting the active
  camera is a no-op (killed a click-flash), and texture swaps gate on canvas content (killed a
  periodic white flash). Coverage is now **metro-wide: 250 cameras** (`CCTV_AUSTIN_MAX_SOURCES`
  default 36 → 250, hard bound 300), filtered to `camera_status === TURNED_ON` (~815 live of
  1,003 rows). City packs (2026-07-04): Caltrans (districts 4/7/11/3 — SF, LA, San Diego,
  Sacramento; cap 300) and TfL London JamCams (cap 250) join Austin (cap 250) as keyless default
  sources — ~800 cameras total, all RAW PRIOR poses, stills-first.
- **CCTV v3 UX — viewshed + calibration gizmo** (built 2026-07-05 and field
  validated 2026-07-21): the COVERAGE toggle is a
  tri-state cycle `OFF → ON → VIEWSHED`; viewshed mode renders each visible camera's frustum
  as a translucent **color-coded volume** (golden-angle hue per camera, `cctvViewshed.js`)
  welded to the same 5 points as the wireframe — zero new scene queries or update cadences.
  The 7 calibration sliders are **deleted**: ADJUST mode puts a direct-manipulation **gizmo**
  on the active camera (`cctvGizmo.js` — heading/pitch rings, E/N/U arrows, range handle at
  the cap center, FOV handles on the cap edges; all 7 offset DOF), plus a click-to-edit
  **effective-pose readout** (HDG/PITCH/FOV/RANGE/HGT/ΔN/ΔE, absolute values). Persistence is
  now **save-gated**: edits are live but unsaved (`CAL · EDITED` chip) until SAVE CAL writes
  the v2 store. Do not add
  Translation arrows use a depth-test-free pickable tip so E/N/U ownership remains unambiguous even where shafts overlap
  other handles. Avoid hover effects that mutate gizmo polyline geometry (width) — the primitive rebuild blanks the pick buffer and eats the
  following click (root-caused 2026-07-05). Gizmo input checks the topmost, depth-test-free
  handle with `scene.pick` first and uses `drillPick` only as an overlap fallback; this keeps
  hover and press responsive on software GL without changing the real-GPU interaction. Frame serving is bounded independently from the
  10-second active refresh: upstream and Street View attempts abort after 8 seconds, and the
  panel/monitor plane keep at most one same-camera image request in flight. This prevents a
  slow provider from being cancelled and restarted forever while stale `SNAPSHOT · OK` health
  remains beside a pending preview. Street View fallback frames are cached per camera pose for 30
  minutes (64 frames at most), so refreshes reuse the static image instead of billing Google again.
  Grounding is shared with every other height consumer:
  CCTV warms/resolves `groundFloor.js` cells, reads `cachedGroundFloor()`, and delegates optional
  Google 3D refinement to the unchanged `meshFloorSampler.js`. During E/N gizmo movement the
  prior floor is frozen (constant elevation and zero transient samples); release or reset makes
  one resolution request at the committed anchor. U edits remain pure geometry and enforce the
  2 m minimum mount height above whichever shared floor wins, including a rooftop. Public camera
  state exposes `groundPriorM` as the immutable Re:Earth ellipsoidal datum reference; it is kept
  separate from live frustum geometry because Google-3D can refine the rendered ground to the
  photogrammetric mesh.
- **CCTV citywide ambient cards** (built 2026-07-29; shared-host migration
  2026-08-02): the LOD-selected nearby static cameras (20/28/40 by zoom,
  `cctvLod.js`) get **screen-space thumbnail cards** through the shared world-overlay host
  showing paced static frames — reselection on `camera.moveEnd` only, at most one frame fetch
  per second layer-wide, per-source cadences (Austin 5 min, TfL/Caltrans 3 min). Zero-flicker:
  a card renders nothing until its first frame, a drawn frame persists through failed fetches,
  and eviction grace (2-pass/5 s) stops budget-edge churn. Camera icons stay visible at every
  zoom. Eligible candidates are filtered to in-view stills with valid IDs,
  finite distances, and one deterministic representative per camera before
  ranking; videos, hidden/malformed rows, and duplicate outliers cannot alter
  the density scale or displace a valid winner. They are ranked with a
  deterministic 50/50 blend of eye distance and normalized screen-center offset
  before the existing 5×4 distribution pass, so the center wins contested
  density without removing peripheral coverage or changing the bounded count.
  The active camera keeps the v3 monitor plane and is excluded from the
  40-card ambient ring with no thumbnail by default. An explicit
  `activeCameraCardEnabled` presentation option can publish the retained
  protected-card path. Disable tears the tier down completely.
  Coverage/viewshed semantics unchanged.
- **Satellites**: orbit rings rotate about Earth's Z by ΔGMST every ~1s (exact inertial→ECEF compensation; no SGP4 re-runs); the tracked satellite propagates per frame with one shared epoch for dot/label/camera. Verified: ISS holds <1km perpendicular to its ring while tracked.
- **Space Missions (30d)**: recent launches render as bounded shared-host, horizon-occluded mission markers using Launch Library 2 v2.3 detailed records. Enabling the layer selects the unified right-side Context panel's Space Missions mode and enables the required satellite layer. Before applying its temporary dense/hidden Satellite mode, Space Missions snapshots the complete standalone Satellite parameter set and exact enabled-layer set. Disabling Space Missions from either Context or the left Data Layers rail restores those parameters and the exact prior enabled state, so a Satellite layer that was already on stays on while a mode-owned dependency returns off; enabling Satellites by itself remains independent. Selecting a mission isolates its launch-to-orbit transfer and dashed satellite orbit, fills that same panel with navigation/details, and animates a small phase-colored marker along the exact displayed Cartesian samples. Marker hit testing drill-picks through photorealistic tiles so the depth-test-free tactical dot remains reliably selectable; its text is non-interactive shared-host presentation. The selected pad is the camera's zoom pivot: the overview remains centered on its launch site, wheel zoom approaches that site instead of drifting elsewhere, and camera pitch progressively changes from global nadir to an oblique close 3D view. Its protected shared-host callout remains visible and expands to include both mission and launch-site names. `FOCUS` flies directly to a 12 km oblique frame around the selected launch site and retains the same anchored zoom/orbit behavior. `REPLAY ASCENT` resets the selected marker at the pad, frames it from an oblique third-person angle, and follows it through the mission-specific compressed ascent directly into one orbital lap at the default `1×` rate. A live `0.25×`–`4×` slider changes ascent and orbit playback speed; adjusting it mid-replay preserves the current path position and historical mission timestamp. Re-entry/recovery cannot be inserted into replay. At orbit insertion the camera smoothly pulls back over the first fifth of the orbital replay and pitches to a globe-scale nadir view while continuing to target the moving replay point. Replay Cancel, mission navigation, deselection, layer disable, and data refresh all release camera ownership. Reconstructed paths are one continuous 128-sample geodetic curve: horizontal departure begins near zero while altitude rises quickly, then the climb progressively bends toward insertion without the former hard 120 km corner. Unmatched orbit fallbacks are smooth planar inclined rings rather than longitude/latitude ground-track curves. The panel lists disclosed payload names, types, operators/manufacturers, mass, multiplicity, and destination when supplied; an empty LL2 payload collection is shown as `CLASSIFIED / MULTI-PAYLOAD`. Launcher, spacecraft, and recoverable payload stages appear in a compact stage table with serial/flight/reuse details, recovery outcome/type, destination, and final coordinates when those records exist; an empty recovery collection omits the section. Stage recoveries with confirmed coordinates use those coordinates; return-to-launch-site records use the pad; downrange-only records receive an explicitly labeled estimated endpoint along the ascent azimuth. Available endpoints render as static 2 px dashed descent/recovery paths with a fixed final-position dot and an estimated atmospheric-interface segment when applicable. The ascent is geodetically densified above the ellipsoid toward the orbit's nearest insertion point, then rendered with `ArcType.NONE`, so it neither cuts through Earth nor separates from the marker. Because LL2 does not normally supply continuous ascent telemetry, pad-to-insertion paths without upstream trajectory samples are labeled `RECONSTRUCTED ESTIMATE` / `ASCENT ESTIMATE`; only supplied trajectory samples receive the replay wording. Selected-orbit framing fits the complete ring, rear-side linework uses normal scene depth occlusion, and current distance, speed, and callout data come only from a launch-year-validated satellite match. Speed is the magnitude of the SGP4 inertial velocity vector at the same propagation epoch as position, displayed in km/s with km/h available as hover detail. Unavailable operator, site, launch-time, orbit, current-altitude, and speed values omit their detail rows instead of reserving panel space with placeholders. Newly launched payloads absent from the core operational groups use CelesTrak's cached active TLE feed as a lookup-only fallback; weak constellation-name matches are rejected. The replay callout maps compressed animation progress onto Launch Library's mission-relative timeline, showing the historical UTC date/time at the marker's current path position; unavailable timelines remain explicit. Matched live satellite positions propagate at one-second cadence and use a distinct green dot/callout with the current UTC date/time.
  When no mission is selected, the Context panel presents a scrollable newest-first roster of every launch in the rolling window, including the smaller 5 px operator-colored marker, provider, and launch date. Hovering or keyboard-focusing a row shows four compact cyan corner brackets on both that roster row and its corresponding globe dot, rotates the globe at the current zoom to center it, and gives its label declutter priority without selecting it; the globe label remains unbracketed. Selecting a roster row invokes the same mission isolation and full-orbit framing as clicking its globe marker. The replay vehicle is one screen-space SVG/CSS HUD overlay rather than separate Cesium billboard, label, and reticle graphics. It is hidden during ordinary Focus and manual close views, where the standard selected launch-site label remains visible, and exists only while ascent replay is active. Its fixed pixel scale is shared by ascent and insertion, so camera range never resizes the rocket on screen before the phase boundary. Generic Launch Library pad names are reduced to their identifying suffix, and replay timestamps use a cyan state title over unprefixed white UTC date/time values. `REPLAY ASCENT` holds the unframed cyan/white rocket at the pad for a real-time `T−10` countdown, transitions through `LIFTOFF`, and attaches six tapered cyan/white ellipse waves directly below it from liftoff through insertion to convey thrust without adding scene geometry. While replay is active, the single start button is replaced by compact Play, Pause, and Cancel icon controls. Pause freezes countdown or mission time, vehicle/stage positions, camera target, labels, and thrust-wave animation; Play resumes from that exact frame, and Cancel releases replay camera ownership. The rocket and thrust group rotates from the path's live screen-space tangent, so its nose follows the visible ascent curve while the adjacent text remains upright. The camera begins as a close oblique launch chase, then smoothly widens between roughly 120 and 420 km vehicle altitude into a higher oblique context view that keeps the moving rocket targeted while exposing the ascent bend and orbit connection. At insertion the rocket/thrust glyph is replaced by the fixed-size cyan orbit dot, which the camera follows through the existing globe-scale orbit pullback. The chase camera limits per-frame yaw changes across heading wraps so it cannot abruptly cross in front of the vehicle and make ascent read in reverse; the replay-speed slider affects mission playback but not countdown duration.
  Mission world text has no native `LabelGraphics`: overview launch markers publish at most 48 ambient candidates for a 24-winner budget, while selecting a mission clears that overview source and publishes its launch-site callout, stage re-entry annotations, live/estimated payload-position readout, and orbit annotation as protected selected-lane entries. The source retains the exact former strings and colors. Static anchors reuse the Cartesian values used to build their mission geometry; the moving payload entry reads the layer's per-frame live-position cache; catalog-backed orbit annotation positions are cached in the same one-second matrix update that realigns the orbit primitive. Keyhole edge fade, horizon culling, final collision placement, and UI exclusion are owned by the shared host. Deselect restores the bounded overview, and refresh, disable, and destroy replace or clear both mission sources.
  A selected mission renders its orbit as four repeating tactical sectors, each containing one prominent cyan dot followed by one hundred thin translucent dashes. The bright dots act as orbit anchors while the subdued dash field remains depth-tested against the globe and is shown only for the selected mission.
  Close selected-pad views add one static 500 m-radius cyan launch-zone ring with a low-opacity translucent fill over the sampled photoreal launch-site surface. The single scene primitive is created only for the visible selected site and is otherwise dormant. It appears during Focus, sufficiently close manual zoom, and the replay countdown, but is suppressed above 120 km camera altitude, beyond 180 km direct camera-to-pad range, for unselected missions, and whenever Space Missions is inactive. Focus establishes a launch-site-centered camera transform once; subsequent manual heading and pitch changes remain centered on that site without an automated per-frame correction. Surface mission markers and labels use an additional conservative globe-limb margin before the exact ellipsoid occluder boundary, preventing near-horizon visibility from alternating between frames.
- **AIS vessels**: chevron symbology (naval cyan base, type tints), world-space headings, MMSI-keyed reconciliation (selection survives refreshes; pinned 3 refreshes with STALE marker when absent), detection-overlay integration (`type: 'SEA'`), contextStore registration for voice Q&A. Empty-space clicks, id-less photorealistic-tile picks, and Escape dismiss the vessel card/HUD/context and clear its trail; picks owned by another layer (including `gev-trail:*`) and raw vessel-record picks without a live MMSI key are no-ops for vessel selection. Click and key handlers detach while the layer is disabled and reinstall on enable. Selecting another vessel replaces the selection and trail, and reconciliation clears a trail if its owning vessel is evicted.
- **Track trails**: server accumulates per-MMSI ring buffers (`/api/ais-live/track?mmsi=`, Float32+Uint32, 64 samples, 30s/25m thinning); aircraft backfill proxies `/api/opensky-track` (OAuth, own credit bucket) and `/api/adsblol/trace` (tar1090 readsb, ~24h history, ODbL — credit adsb.lol).
- Shared `src/data/pickRegistry.js` stops the two flight layers' click handlers from fighting over the camera.

## 3D Aircraft + Tracking

- **The TRACKED contact's 2D↔3D handoff is DEFAULT behaviour (2026-08-19), driven by camera distance alone.** It does NOT consult the DISPLAY-rail `3D` toggle, which continues to own the FLEET (the un-instanced draw-call budget stays the operator's decision). Policy lives in `src/data/trackedModelRegime.js` and is shared by both layers: enter below `TRACKED_MODEL_ENTER_ALT_M` = 150,000 m and hand back to the billboard only above `TRACKED_MODEL_EXIT_ALT_M` = 172,500 m. **The swap distance was set by playtesting on 2026-08-20:** a first pass at 1,000,000 m switched too early; 2D reads correctly at ~600 km and the handoff belongs at ~150 km. **Consequence, recorded on purpose:** the tracked contact now enters 3D NEARER than the FLEET does (`MODEL_ALT_CEIL_M` = 800,000 m, unchanged), so with the DISPLAY-rail `3D` toggle on, 150–800 km draws surrounding contacts as models while the selected one is still a glyph. Nothing double-draws (the fleet pass skips the tracked icao) and aligning the two is a fleet-side decision, deliberately out of scope. **The two thresholds are asymmetric on purpose:** a single threshold makes a tracked orbit sitting ON the boundary strobe billboard↔model as the camera's altitude wobbles across it. Do not collapse them. The latch is scoped per selection, so a new target re-evaluates against the ENTER ceiling rather than inheriting the previous target's exit band. Exactly ONE model is involved; it loads on demand when the regime opens, is HIDDEN (not released) on regime exit so re-entry has no load gap, and is released by the existing teardown on deselect/re-track/destroy. Cockpit and TR-3B suppression are unchanged. **Two invariants around it:** (a) the hysteresis latch AND the load-failure latch are per-selection state cleared by `_resetTrackedSelectionState()` in the tracking lifecycle (deselect / re-track / cross-layer / init / destroy) — the predicate's icao-change guard is defence only, since it needs a drawn frame while nothing is selected and the render governor's idle mode does not promise one; (b) on-demand loading is bounded at 3 attempts per selection with a 1.5 s backoff and one console warning naming the asset — the driver runs every `scene.preUpdate`, so an unbounded catch means a missing GLB spins load→reject at frame rate. The billboard stays the visual throughout a failed load.
- **Grounded 3D handoff is terrain-validity gated (2026-08-23).** A ready civilian or military glTF does not own the visual until `groundSnap` (`src/data/groundSnap.js`) can answer with a MEASURED photoreal-surface height. On success the layer writes `height + the model's measured belly offset` before revealing the model. Cache movement is measured on the WGS84 surface, not across altitude, so a stationary contact keeps its snap through poll-time vertical-datum changes. Model existence or GPU readiness alone never suppresses the billboard floor, and ordinary zoom/style/deselect transitions preserve a valid snap cache. **Two states, and the difference is the whole design.** COLD — nothing has ever resolved for this icao (tiles still streaming on first sight, sample failure, backoff after a first miss): there is no evidence of where the ground is, `heightFor` returns null, the model stays hidden and the depth-test-free 2D billboard remains opaque and floored. WARM — a snap resolved and then a >`MOVE_INVALIDATE_M` (50 m) taxi move stopped it answering directly: the measurement is DEMOTED to a bounded last-known rather than deleted, and it keeps answering while the resample is outstanding, so a taxiing aircraft does not pop 3D→2D→3D across a 2–30 s retry backoff. The bound is `HELD_SNAP_MAX_DRIFT_M` = 250 m from the spot the value was measured at, past which the hold is dropped rather than stretched and the contact is COLD again. It is spatial with no timer beside it (ground under a contact that has not moved does not change; what invalidates the value is the contact MOVING) and deliberately a quarter of the billboard chain's `HELD_FLOOR_MAX_DRIFT_KM` — that hold only ever RAISES a sprite, while a held snap IS the model's placement, so its error shows in both directions. A fresh sample releases the hold, and so does a ground flip (which already calls `forget`). **A loading model is HIDDEN, never zero-scaled:** admission sets `show = false` (Cesium's default is `true`, and an unplaced primitive would claim the visual at the identity matrix), and ownership is `ready && show` — Cesium 1.138's `Model.update` has no `show` guard, so hiding a primitive costs its load nothing.
- Commercial and military aircraft use the same high-level FLEET model regime: 2D billboards when zoomed out, optional glTF models when closer, controlled by the DISPLAY rail `3D` toggle and `Proximity` / `All` modes. Since 2026-08-16 (Hangar fleet) models are PER-CLASS: real CC-BY GLBs for light/bizjet/turboprop/widebody/helicopter/uav (`CLASS_MODEL_REAL` in `src/data/aircraftClass.js` — meters-baked, scale 1, per-model belly/radius; provenance in `public/models/README.md`), the shared `airplane.glb` for the remaining civilian classes, and the military layer maps weight classes (real GLBs / 747 heavies / `jet.glb` fastjets, per-model heading offsets, always flat amber). Textured civilians carry a HEAVY tint, not a light one: `MODEL_COLOR_BLEND_AMOUNT` is `0.94` in BOTH layers under Cesium's `ColorBlendMode.MIX`, so the class colour supplies 94% of the surface and the asset's own texture ~6%. The visual direction is clean light silhouettes with only a weak diffuse contribution from the approved textures, so liveries deliberately do NOT read. IR boost raises the blend to a full `1.0`. Under NVG/FLIR (map preset or Cockpit vision) models render unlit flat-white at full alpha and scene fog is disabled (fog otherwise blacks out distant models with the globe hidden); state restores on exit.
- The DISPLAY-rail `3D` toggle is the user-facing activation path for both aircraft layers. Their small approved GLBs build their render resources without Cesium's frame-spread job queue, preventing continuous Photorealistic 3D Tiles streaming from starving model readiness; model caps, tracking, camera, and fallback billboards are unchanged.
- **The `3D` toggle DEFAULTS ON in `proximity` on a first run.** Proximity is itself the budget — models appear only below `MODEL_ALT_CEIL_M` and only for the nearest `MODEL_MAX` in view — so the default costs nothing at globe scale, and `all` remains a deliberate opt-in. A fresh boot runs NO layer-state restoration (`LayerStateCoordinator.start()` returns early with neither a share payload nor stored state), so four independent initializers decide what a first-run operator sees and must agree: `booleanOption('models3d', 'e', true)` in `src/data/layerState.js`, `_models3dEnabled = true` in BOTH flight layers, `this._models3dEnabled = true` in `src/ui.js`, and the `active` / `visible` classes on `#models3d-toggle` / `#models3d-mode-row` in `index.html`. All four are pinned together in `src/data/layerState.test.mjs`. Explicit state still wins: because the codec omits default-valued options, `models3d: false` is now what travels in a link (`lo=…f.e.0`) and restores OFF at both aircraft layers. **Consequence for returning users:** a stored `gev:layer-state:v2` blob is a FULL options snapshot, so a session that wrote one before this change carries `models3d:false` and keeps 3D off until the operator flips it (or clears the key) — the durable snapshot is treated as the recipient's own state, by design.
- **Consequence of the flip on the recorded tracked/fleet inversion:** the 150–800 km band where surrounding contacts draw as models while the SELECTED one is still a glyph is now what an operator sees WITHOUT arming anything. The inversion itself is unchanged and still deliberate (see `src/data/trackedModelRegime.js`); only its reachability changed.
- Civilian and military 2D aircraft use the established distance scale: `3×` near
  the camera and a `0.5×` floor from 8,000 km outward. A standard 20 px ambient
  icon therefore remains about 10 px at globe altitude while retaining the
  established close-range silhouette. Any compact alternative requires
  before/after visual evidence.
- Fleet model eligibility is distance-based with on-screen priority and hard caps (`MODEL_MAX`, `MODEL_MAX_ALL`) to avoid draw-call explosions. Each model owns its own `modelMatrix`; shared scratch matrices are forbidden because they caused stacking/flicker.
- Tracked aircraft use standalone model primitives driven from the already-settled dead-reckoned display position, while the tracked Cesium entity remains billboard-backed so `viewer.trackedEntity` always has a ready bounding sphere.
- Flights and military layers mirror the same tracking invariants: no warm-up freeze/jump, altitude-scaled framing, trail head glued to the displayed plane, no pull-out when switching targets, and no cross-layer orphan when switching between commercial and military tracks.
- Regression surface: `pnpm run test:track` drives the real app headless with synthetic aircraft feeds and asserts the tracking invariants without depending on live OpenSky/adsb data. `src/data/trackedModelRegime.test.mjs` pins the tracked contact's threshold math, the enter/exit asymmetry, and the default-on / cockpit / TR-3B / deselect wiring in both layers.

## Panoptic Detection + Tracked Readout

- `src/data/detection.js` samples enabled layers through each layer's `getDetectableObjects()` contract and renders bounding boxes/labels from the shared host's sole Cesium post-render callback so boxes align with the final camera frame.
- Detection diagnostics count fading labels from the arbiter rows that are
  actually rendered. The label QA harness uses time-weighted label exposure for
  churn and requires conclusive solve/frame samples at both its 12,000-object
  pathological field and 5,200-object normal field without relaxing budgets.
- `src/data/detectionDraw.js` performs the batched, DPI-crisp canvas drawing for tier-colored labels, corner brackets, callouts, and distance-scaled tracked boxes. Unit tests cover label measurement and draw geometry.
- `src/data/trackedReadout.js` publishes a protected shared-host callout above tracked aircraft and satellites or selected mapped installations. It reads only each layer's cached display position—never a fresh entity position evaluation—preventing readout jitter against the rendered target. AIS selection remains in the vessel source's protected card path.

## Trails

- **The trail's acceptance bar is visual (2026-08-23):**
  the trail terminates roughly BACK-CENTRE on the aircraft; MINOR hull overlap
  is acceptable; there is no conspicuous top, bottom or lateral protrusion; it
  is stable across headings; and a parked aircraft draws no moving head
  segment. That is the bar a future change is judged against — NOT sub-metre
  precision. The pins below are tighter than the bar on purpose, because a
  measurable property is what a test can hold, but a pin's tolerance is not the
  product requirement and tightening one is not an improvement to the picture.
  Measured on live traffic at the shipped transform, the airliner anchor sits
  24.09 m aft (70 % of the model's rendered envelope, so inside it), 2.22 m
  below centre (6 %), and 2e-9 m off the centreline.
- **The tracked trail attaches to REAL HULL, aft and below (2026-08-23):**
  `MODEL_TRAIL_ANCHOR_NATIVE` (`src/data/modelVisualAnchor.js`) holds, per GLB
  and in RAW glTF coordinates (see the transform-chain entry below), the point
  of the hull's CENTRELINE PROFILE (its y = 0 slice) closest to the aft-belly
  AABB corner. It is NOT the corner: a bounding-box corner is empty
  space, 4.80 m off the nearest triangle on `airplane.glb` and 6.14 m on
  `jet.glb`, so the trail ended in mid air beside the aircraft. The head segment
  is drawn from a point behind the aircraft to this anchor, so the anchor must
  stay aft (83–96 % of each aft extreme) or the segment enters at the tail and
  stops inside the fuselage. `modelScale.test.mjs` reads the POSITION BUFFERS —
  real vertices and triangles, because accessor min/max cannot tell a corner
  from a surface — and re-derives on-hull, aft, lowest-at-its-station,
  on-centreline, and the construction itself. Re-measure, never re-guess.
- **The trail anchor rides CESIUM'S transform chain, not a hand-rolled one
  (2026-08-23 regression fix):** `MODEL_TRAIL_ANCHOR_NATIVE` stores RAW
  glTF coordinates and `modelAnchorWorld()` assembles
  `modelMatrix × components.transform × axisCorrection` — the same chain
  `ModelSceneGraph` renders with, built from Cesium's own exported
  `Axis.Y_UP_TO_Z_UP` / `Axis.Z_UP_TO_X_UP` and the model instance's own root
  transform. The anchors were previously PRE-CONVERTED by a single glTF
  Y-up → Z-up step (`[x,y,z]` → `[x,−z,y]`) and multiplied straight by
  `modelMatrix`; that is half the correction (the defaults also apply
  `Z_UP_TO_X_UP`, the complete mapping being raw `[x,y,z]` → `[z,x,y]`), and an
  aircraft's longitudinal axis is raw glTF X, so the aft offset landed on the
  RENDERED model's LATERAL axis. `modelMatrix` carries the heading, so both
  frames rotated together and the trail terminated a fuselage-length to one
  SIDE, swapping sides with the course. Measured live in each aircraft's own
  (aft, cross, up) frame: civil airliner (0.00, −81.47, −7.50) before,
  (81.47, 0.00, −7.50) after; rotorcraft (0.00, −73.67, −16.33) →
  (73.67, 0.00, −16.33). **Never pre-convert an anchor** — one transform,
  Cesium's, or a second hand-maintained convention drifts again. The pin sweeps
  headings 0/45/90/180/270/315 across every shipped asset plus a hovering
  rotorcraft and asserts NO lateral component, and it derives its reference axes
  from the ENU frame and the heading rather than through the function under
  test: the first version routed them through `modelAnchorWorld` and passed
  against the very bug it was written for, because a wrong transform rotates the
  anchor and its reference frame together.
- **A stationary contact draws no trail head, and the head end NEVER gives
  (2026-08-23):** grounded tracking starts a trail unconditionally, and on a
  contact that has not moved the last body point sits where the aircraft is — so
  the head segment became a line from inside the model out to its own anchor,
  through half the fuselage. `trailHeadStart()` decides where that segment
  starts being drawn: nothing while the last body point is no further from the
  model centre than the ANCHOR'S OWN STATION (every millimetre would be drawn
  forward of the attachment point, into the fuselage — a parked contact sits at
  exactly zero), the whole segment once it has cleared the model's rendered
  ENVELOPE, and between them the drawn start slides along the segment so the
  visible length grows CONTINUOUSLY from zero. Three earlier cuts are recorded
  because their shape matters: testing segment LENGTH against the radius HID
  real trail (58 m aft of `airplane.glb`'s 34.41 m envelope gives a 33.98 m
  segment, suppressed, though ~23.6 m of it is open air); CLIPPING at the
  envelope and keeping only what lay outside stopped a moving trail visibly
  SHORT of the aircraft, since a bounding sphere encloses a lot of empty space
  around a slender airframe; and a BOOLEAN containment test flashed 10.33 m of
  trail on and off across 2 cm of travel at the boundary, and again on any fix
  that fell back inside. The END is never cut — that end is the whole point.
  `radiusM` carries `computedScale`, so the verdict is the same at every camera
  distance, and any contact that has moved more than its own size (every
  airborne one: 30 s of flight is kilometres) gets bit-identical geometry to the
  containment rule this replaces.

## Heights and ground floors

- **Height-datum system (2026-07-08):** Caltrans + TfL camera packs (~900
  cameras) and the height-datum work fix entity heights on the
  ellipsoidal globe end-to-end (geoid module, keyless Re:Earth terrain for the
  OSM stack, ground-floor system with rendered-mesh sampling, always-visible
  sprites/trails, OpenSky credit governor). The 2026-07-08 CHANGELOG entry
  records the subsystem's architecture, invariants, residuals, and verification.
- **A held ground snap is dropped when measured ground contradicts it
  (2026-08-23):** the WARM hold described below answers on DISTANCE travelled,
  which is only a proxy for whether the value still describes the ground. A
  contact can taxi ~200 m onto a different surface INSIDE the 250 m bound, and
  since a miss preserves the hold, nothing would ever correct the burial. So
  `heldSnapM` (`src/data/groundSnap.js`) also consults `cachedMeshFloor` at the
  contact's CURRENT position: a measured floor more than
  `HELD_SNAP_CONTRADICTION_M` (5 m) ABOVE the held value drops the hold and the
  contact is COLD again, back to the floored 2D billboard. The rule is
  ONE-SIDED on purpose — it targets BURIAL. A cell reading BELOW a real sample
  is the floor chain's expected under-read (one-shot latch over ~111 m,
  neighbours lean lowest, `displayFloorHeightM` only ever raises), not evidence
  of anything, and a two-sided cut was disproved on the track rig by a planted
  cell 66.7 m below a real sample at the same spot. Accepted residual, stated
  with its condition: a DOWNHILL taxi floats, and the only correction on this
  path is a SUCCESSFUL resample — nothing guarantees one. On the OSM fallback
  `sampleHeight` misses forever, so the float persists for as long as the
  contact stays inside the 250 m bound, with no timer beside it and no vertical
  cap of its own beyond whatever the ground drops within that radius. It is
  accepted because it errs UPWARD and stays visible. Three boundaries are
  load-bearing — that one direction, MESH cells only
  (`cachedGroundFloor`'s DEM fallback is a DIFFERENT surface; the skin/DEM
  spread is what `MESH_FLOOR_BELOW/ABOVE_PRIOR_M` budget 15 m / 80 m for) and
  the contact's OWN cell only (a neighbour ~111 m away may be a terminal roof —
  `neighborFloorM` leans lowest for that reason — and must never be borrowed to
  DISCARD a real measurement). Do not widen either without re-arguing both.
- **A grounded contact HOLDS its floor through a terrain outage (2026-08-21):**
  when the Re:Earth proxy fails, the floor cells a grounded contact stands on
  never warm, and the un-clamped render height for a contact reporting no
  altitude at all is the GEOID — ~150 m below the ground at an inland field.
  Both steps now hold instead. At POLL time `geoidSurfaceLastResortM()`
  (`src/data/renderAltitude.js`) withholds the geoid guess from any contact
  that already has a `renderAltitudeM`, so the sentinel path holds that height;
  the guess is reserved for a genuine first sighting. At DISPLAY time
  `_heldDisplayFloorM()` (`src/data/aircraftLayerCore.js`) answers with the contact's own
  last resolved floor — valid within `HELD_FLOOR_MAX_DRIFT_KM` (1 km, one
  rollout's worth of travel) of the cell that supplied it — and otherwise with
  a resolved ADJACENT cell via `neighborFloorM()`, which takes the LOWEST of
  at least `NEIGHBOR_FLOOR_MIN_SAMPLES` (2) resolved neighbours and otherwise
  refuses. An earlier cut leaned HIGH, reasoning from "never below the visible
  surface"; that principle is about a contact's OWN measured ground and it
  inverts for a BORROWED cell, as playtesting confirmed — planes
  floating at terminal gates. The errors are not symmetric: too LOW is inert
  (`displayFloorHeightM` only ever raises, so an under-reading floor simply
  does not lift, bounded by one cell of grade), while too HIGH invents a
  position bounded by BUILDING height and a parked contact holds it — measured
  at 29.5 m of permanent float from a lone roof neighbour. A plane at a gate is
  on the apron, never on the roof. The honest residual is the mirror image: on
  a genuine slope the lowest neighbour under-reads, so the clamp lifts a little
  less than it could, which shows up as no lift rather than a wrong one and is
  corrected as soon as the contact's own cell warms. Both tiers are validated
  measurements out of the shared floor cache; with neither available the
  position passes through untouched, exactly as before. Adjacent-cell probes
  are throttled per contact (500 ms) and rationed no further: a probe is eight
  synchronous `Map` reads with no I/O — every DEM request is driven by
  `warmGroundFloor` from the poll loop, bounded there — and 200 synchronised
  all-cold contacts probing on the same tick measure 1.0 ms median / 1.2 ms worst on the all-cold workload (a noisier ad-hoc run of the same workload peaked at 2.1 ms), 1.4% of one 80 ms
  fleet tick (`scripts/qa-floorhold-probe-cost.mjs`). A global per-tick budget
  with a fairness queue was built over that and DELETED: it protected single-
  digit milliseconds and produced two starvation defects. Nothing can starve
  because there is no shared resource to be starved of.
  A floor that moves DOWN under a contact standing on a BORROWED one is
  APPROACHED exponentially (`FLOOR_EASE_TAU_MS`, 360 ms — ~20% of the
  remaining gap per fleet tick, hard-capped at `FLOOR_EASE_MAX_STEP` so a
  delayed or stalled tick cannot close more) from the value currently displayed, rather than
  interpolated from a fixed anchor over a fixed duration. The target moves: a
  second, lower neighbour can warm mid-approach, and re-evaluating a fixed
  anchor against a moved target jumps by the eased fraction of the change
  (measured at 100 m in one tick). Approaching from the displayed value has no
  such seam. Rises are always taken whole, including mid-approach, since an
  eased rise is time spent under the mesh; a change between two resolved floors
  keeps its existing timing. The hold state is retired the moment a contact
  stops being a grounded billboard (airborne or model-owned), but the floor
  itself is PARKED as a rehydration seed rather than destroyed: deleting it
  outright let an `on_ground` flap through a rotation cold-start the contact
  under the runway (observed with VIR138M at JFK). **A seed is a memory, not
  a reading**, and three bounds keep it honest. `HELD_FLOOR_MAX_DRIFT_KM`
  refuses it more than a kilometre from where it was measured.
  `FLOOR_SEED_GRACE_MS` (90 s, three polls) expires it on wall-clock age,
  judged BOTH while the contact is away and AGAIN at the moment it re-grounds —
  a contact that makes no calls in between (off the poll on a cruise, outside
  the corridor radius, tab hidden) never reaches the first check, and an
  earlier cut that only had that one reused a floor parked 198 s earlier. And
  the seed ranks BELOW the neighbour tier: two freshly resolved adjacent cells
  overrule it, which is what stops a contact re-grounding half a kilometre
  away from floating on the field it left (measured before that rule: a 200 m
  seed held over a 100 m/105 m neighbourhood, 100 m in the air). So a short hop
  back onto the same apron inside the grace window and the drift bound DOES
  reuse its floor — deliberately, and only while nothing fresh contradicts it.
  What starts clean is a genuine departure. A model→billboard handoff retires
  and rehydrates by exactly the same rules. What none of this fixes is the flap
  tick ITSELF: the display clamp passes airborne positions through by design
  (an airborne height is the fix-time clamp's job), and at a sea-level field
  the airborne fix IS baro + geoid N, ~4 m under the runway. That is an
  accepted one-tick transition residual, and
  `scripts/qa-floorhold-staircase.mjs` §F1 counts every tick so it stays
  visible: 1 of 23 ticks below the runway, all of it that airborne tick, 0 of
  22 grounded ticks — against 12 of 22 grounded and not recovering before the
  seed existed. **A third tier that read the rendered mesh
  where no DEM existed to validate it was built and REMOVED** — measured
  against a real GPU with the proxy down, it recorded a coarse-LOD 20.6 m for
  ground that is really ~122 m; `tilesLoaded` goes true while coarse tiles are
  what is loaded, so without a DEM prior there is nothing to tell a surface
  from a mis-hit. Gates: `scripts/qa-floorhold-mutations.mjs` (22 named
  defects, each reverted individually and required to go red) and
  `scripts/qa-floor-hold.mjs` (live, real GPU — the proxy is failed mid-run and
  the contact is measured against `scene.sampleHeight`). This floor-hold path
  currently applies to the flights layer; the military layer does not enable it.
- **2026-08-19 — display-time ground floor (flights layer).** A grounded
  contact's render height is picked once per poll from the floor of its FIX
  cell, but what renders is the dead-reckoned position, which drifts across
  cells for the whole segment and for hundreds of metres while a contact
  coasts on a stale feed. On a graded apron that buried sprites under the
  mesh (measured −15.5 m at KAUS; `qa-floor-verify` reported FAIL). The fleet
  pass and the tracked display path now re-floor the DISPLAYED coordinate
  against `cachedGroundFloor` — read-only, grounded contacts only, and never
  while a 3D model owns the visual (T7 ground-snap one-shot). The poll's floor
  warm/sample batch additionally collects each grounded contact's display
  CORRIDOR (the ground it is about to cross — toward its newest fix while
  interpolating, along its course while coasting), need-ranked and deduped so
  parked contacts never crowd out moving ones. Budget is charged only for cells
  with no floor yet — warm cells are still emitted, because the mesh sampler
  must see a cell again once its DEM prior lands — which gives a service bound
  that falls out of the policy: every contact is served within
  `ceil(contacts / budget)` polls. Sample spacing along a projected arc derives
  from its length (never a fixed count, whose spacing widens with speed), and
  the cell walk steps at an eighth of a cell, so any cell the path occupies for
  ~14 m of ground or more is collected. The corridor
  integrates the SAME constant-rate turn the dead-reckon does, so a
  sustained-turn taxi warms its arc rather than a straight tangent. Visual
  ownership — not model existence — decides when the clamp stands aside: a model
  owns the visual only while it is actually RENDERING (`ready && show`, the
  pair the billboard handoff itself consults), and the tracked path also
  requires `_trackedModelRegimeActive()`. So neither a retained-but-hidden
  model (3D off, zoomed out, cockpit) nor one still loading suppresses
  flooring while the billboard is what the user sees. **The visual/data split is deliberate**: visual
  consumers are floored at the per-frame cache, while `_describeFlight` — and
  so `findByQuery`, `getTrackedInfo`, `getTrackedSubject` — keeps reporting
  sensor truth (barometric `altitudeM`, fix-time `renderAltitudeM`), because a
  query or an altimeter should answer what the aircraft reported, not where its
  icon was nudged to clear the tiles. Residual, unchanged by this
  work: the floor is a ~111 m cell, so intra-cell relief (terminals, jet
  bridges) and contacts moving faster than the 30 s warm batch can still read
  metres low. `qa-floor-verify.mjs` now **exits non-zero on FAIL** (1 = FAIL,
  2 = INCONCLUSIVE); it previously exited 0 on every verdict, which is how the
  burial stayed invisible. It also honours `GEV_QA_URL` and puppeteer's
  pinned Chrome-for-Testing, like the other harnesses.

## Tracked contacts

- **The AIR bracket alpha floor SCALES with the OUTSIDE slider (2026-08-23):**
  `aircraftBracketAlphaFloor` (`src/data/detectionPolicy.js`) is piecewise
  linear through 0 → 0, **the default → 0.35**, and 100 % → 1.0. The default
  value reproduces the previously shipped flat 0.35 exactly at every keyhole
  alpha, so the approved bracket look is unchanged; a flat floor made every
  reachable stop below 35 % paint identically. `AIRCRAFT_BRACKET_FLOOR_ANCHOR`
  mirrors `KEYHOLE_OUTSIDE_OPACITY_DEFAULT` (kept Cesium-free on purpose), the
  two are pinned together, and **the anchor MOVES WITH THE DEFAULT** — both are
  `0.01` since the 2026-08-24 final lock (`0.03` on 08-23, `0.05` before). That pin is the
  tripwire for a default move: the mapping is pinned to bracket BRIGHTNESS,
  not slider position. The `detection-opacity-slider` `step` is **1** so low values are
  reachable — the mapping was always continuous from 0, but at the
  previous step of 5 the entire sub-default range was one stop wide. Both the
  markup and the ordering of 1–5 % are pinned in `detectionPolicy.test.mjs`.
- **Contact readout: foreign subjects and CONTACT LOST.** When the selected
  contact is not the tracked aircraft (a vessel, an installation, another
  aircraft), the panel stays up and keeps its label, cohort counts, nearest
  contact, distance and evaluated time live. Only the nose-relative direction
  arrow and BRG readout are dashed: those two are measured in the tracked
  aircraft's own frame while the rest of that row is measured from the
  selected contact, and rendering both live presents one mixed-frame reading
  as a single measurement.
  A contact that leaves its feed holds the panel in a `CONTACT LOST` state
  (`data-state="lost"`, the same panel-level cue mechanism as `uncertain`,
  in the amber the app already spends on unknown/stale inputs): the last
  rendered values stay on screen rather than being recomputed against a
  position that stopped updating, and Previous/Next stay operable so the
  operator can step off. It fires on two paths, and both retain the snapshot:
  an eviction-origin selection clear (`reason: 'evicted'` — the aged-out
  branch in `aircraftLayerCore.js` (both flight layers), AIS pin exhaustion, and a
  viewport refresh that drops a selected record), and a refresh whose
  presence check comes back absent. A DELIBERATE clear (click-away, Escape,
  voice stop, layer disable) still clears the subject and takes the panel
  down; an untagged clear defaults to deliberate.
- **Tracked-flight close-range feel:** the existing 150 m camera floor is
  unchanged, while the selected-only civilian and military model cap is now
  200 px so minimum range reads as close. Pointer travel over 6 px suppresses
  selection and empty-space untracking; duration over 400 ms suppresses only
  untracking, so a stationary slow press on a plane still selects it. Escape
  still releases tracking in place. The 200 px feel needs close-range field
  verification; fleet model sizing remains unchanged.
- **Distant-aircraft recession:** both civilian and military billboard fleets
  retain their locked class/ground scale and `NearFarScalar`, then multiply a
  limb-relative taper in the existing ~12 Hz tick. The taper is 1 below 0.5×
  geometric limb distance and smoothsteps to 0.45 scale plus a 0.35 alpha-haze
  factor at the limb. That treatment eases continuously back to identity from
  3,500–4,500 km camera height, avoiding a globe-view threshold pop. These
  values, the start ratio, blend band, composed floor, and write epsilon remain
  runtime tunings. No aircraft is count-culled or made fully transparent.
  Focus emphasis and limb haze multiply at one deadband-gated write site, and
  their product is clamped to 0.20 before freshness alpha is applied. Ambient
  fleet models receive that same composed alpha; class/ground/cockpit repaints
  preserve the current limb scale instead of dropping it for a tick.
- **Focus-aware contact de-emphasis:** civilian/military aircraft and
  satellites publish the selected target's padded screen bounds and camera
  distance from the same per-frame position cache already consumed by their
  tracked entity. Ambient flight sprites, AIS chevrons, CCTV icons, and
  satellite points then ease their own alpha where they compete with that
  target; no draw-order assumption participates. The always-visible rule is
  narrowly amended rather than removed: emphasis never falls below 0.25,
  contacts never blink or disappear, entry/exit use 6 px hysteresis, and
  writes use a 0.005 alpha deadband. Defaults are 18 px padding, 300 ms attack,
  600 ms release, an 8%-of-target-distance range hysteresis band, and
  `nearerBehavior: 'allow'`; `dim` and `partial` remain runtime/evidence
  tunings. Ambient overlap includes each sprite's own rendered extent. The
  gated AIS, CCTV, and satellite passes retain an active-emphasis count so a
  settled dim contact always completes its release after tracking ends.
- **Deterministic sprite stacking:** contact collections reassert the stable
  bottom-to-top order CCTV, FIRMS, bikeshare, AIS, military, then civilian
  flights after every relevant layer init/enable and immediately after FIRMS
  lazily registers its detection sprites. Always-visible contact
  depth settings are unchanged. Cesium OIT weighted blending may soften strict
  alpha layering on some GPUs, so the ordering remains a real-browser check.
