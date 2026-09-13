# First run and share links

Part of the [runtime reference](../CURRENT-STATE.md): the first-run mission launcher and share-link state.

## First-run mission launcher

**2026-08-23 — first-run mission launcher** (`src/firstRunExperience.js`,
`#first-run-launcher`, styles at the tail of `style.css`). After startup
settles, a fresh session gets one card offering **Live Contacts · Space
Missions · Environmental · Explore manually**. No layer and no optional API
call happens until a tile is clicked. The right-hand DISPLAY rail
(`pp-toggles`) now starts **collapsed** on a first run rather than expanded —
a stored collapse state still wins, as before.

**The ENVIRONMENTAL tile is quakes AND fires** — live USGS earthquakes plus
NASA FIRMS active fires (`layerIds: ['earthquakes', 'local-firms']`), with the
tile subcopy naming both. **The launcher optimizes for the fully configured
experience:** it does not trim what it offers down
to the lowest-configured install. The mission does not branch on whether a key
is present — everyone gets the same tile.

Keyless, the honest surface is the **layer row**, which reads
`UNAVAILABLE · NASA FIRMS · LIVE · KEY REQUIRED`, and the earthquakes half
still delivers in full. The shared loading reducer now treats an explicitly
declared missing optional key as a configured terminal state rather than a
failed multi-layer mission, so the global chip completes without showing
`LOAD FAILED`. A genuine lifecycle or fetch failure still retains failure
priority.

**Acceptance changed with that ruling (2026-08-23).** `qa-firstrun` no longer
asserts "a keyless Environmental never shows a failure chip" — that stopped
being a launch requirement when the tile went back to promising both feeds.
The Environmental section now **branches on the observed key state** and says
which branch it took: KEYED asserts both datasets actually arrive and that no
LOAD FAILED banner appears while the mission runs; KEYLESS asserts the
layer-row honesty (`KEY REQUIRED`), the quakes half loading, and that the
deliberate missing-key state never becomes a global failure.

**An INFRASTRUCTURE tile is deliberately absent.** It was built, playtested,
and cut: one click enabling `local-datacenters` + `local-dams` +
`telegeography-submarine-cables` puts ~5,700 entities on a full-earth view and
the frame rate goes with them. The layers are unchanged and still reachable by
hand and by voice ("infrastructure mode" is still mapped). Do not re-add the
tile before the bundled-infra globe-LOD declutter lands — that is the real
fix, and it is post-launch work.

**Show policy — it is NOT one-shot.** Precedence, highest first: a share link
never sees it → `?welcome=0` suppresses → `?welcome=1` replays (past both
suppressions, for demos/support) → the durable
`localStorage['gev:first-run-mission:v1'] === 'suppressed'`, written **only**
by the "Don't show this again" checkbox → the per-session
`sessionStorage['gev:first-run-mission-session:v1'] === 'dismissed'`, written
by **every** close path (mission, Explore, ESC). So it returns each fresh
browser session until the visitor ticks the box; clearing storage un-ticks it,
which is accepted. Both stores fail open — an unreadable store still shows the
launcher rather than silently swallowing first launch.

**What a mission may persist (do not "simplify" this).** Layer enablement is
durable in this app (`gev:layer-state:v2`, written by
`LayerStateCoordinator._commitExplicit` only for origin `user`/`voice`/`tool`).
A mission enables **its own** layers at `origin: 'user'` — durable, exactly as
clicking those rows is, because picking the mission *is* that choice. The two
Context missions also expand the Context panel, as the visible tabs do; the
globe missions open no panel. Everything else is off limits: detection
mode/density, `gev:detection-allocation:v1`, 3D models, feather, and above all
`_detectionUserOverridden` — setting that flag means "the operator hand-edited
detection" and would silently disable the CRT/NVG/FLIR auto-preset contract for
the session. The full table is a comment block in the module and is pinned by
`src/firstRunExperience.test.mjs`.

**Voice is instruction-only.** Both globe missions are expressible with
shipped tools (`set_layer_visibility`'s enum already carries
`local-datacenters`, `local-dams`, `telegeography-submarine-cables`,
`local-firms`, `earthquakes`; `zoom_to_globe` supplies the camera), so
`GEV_REALTIME_TOOLS` is **byte-identical to `main`** and pinned by sha256 in
the unit suite. One instruction paragraph in `vite.config.js` teaches the
phrase mapping; deleting it is the complete rollback.

**ESC arbitration — three rules, do not collapse them into one.** (1) The
launcher **yields**: a MutationObserver watches `body` for the surfaces that
take the screen (`cockpit-mode`, `scene-playback-mode`, `recording-mode`,
`ui-clean-view` — `EXCLUSIVE_SURFACE_CLASSES`, kept in step with the CSS hide
rule by a unit pin), and session-dismisses rather than contesting the key; if
one is already up at init it **waits** instead of appearing over it. (2) A
surface can take the screen with **no class to watch** — the Cesium attribution
lightbox is full-screen at `z-index: 200` against the card's `175`, which left
the launcher measurable (`getClientRects()` non-empty) and buried, so ESC
dismissed a card nobody could see and burned the session flag. `isTopmost()`
therefore also **hit-tests the card's own centre** with `elementFromPoint`; any
overlay, classed or not, disarms the handler. Every inconclusive answer counts
as uncovered, so the guard can never be why ESC stops working. (3) A small
control that claims only the **key** (a disclosure, a popover) is not something
to yield to: whoever handles ESC first calls `preventDefault()` **and**
`stopImmediatePropagation()`, and the launcher skips `defaultPrevented` events.
`stopPropagation()` alone does **not** stop later listeners on the same
`document` — that is exactly how the compact Radio disclosure made one key
close the disclosure *and* dismiss the launcher.

**Accepted:** a surface class that never clears means no launcher for that page
load, with no timeout. None of the four classes is restored at startup, so an
already-blocked init is an error path, while a long recording or clean-view
session is ordinary — a "reveal anyway" timer would trade a benign no-show for
the card punching through a recording in progress. The no-show is benign: the
handler is inert, no session flag is written, the observer still reveals the
card if the class clears, and it returns next session either way.

**Blocked storage un-ticks the box.** "Don't show this again" is a claim about
the future, so a refused `setItem` reverts the checkbox and says so in the
status line instead of showing a saved preference that was never saved.

Gates: `node scripts/qa-firstrun.mjs --url <app>` (in-app checks across eight
independent sections) plus its `--teeth` negative control, which removes
the launcher and requires EVERY launcher-dependent section to go red — it
always exits non-zero, `1` meaning the control is healthy and `2` meaning it
is not. Plus the unit pins above.

## Share-link v2 layer state

- Generated share links use a deterministic v2 hash. Existing camera, visual,
  HUD, detection, post-processing, celestial, scope, and map-stack fields remain,
  with compact fields for enabled layers, allowlisted layer options, panel state,
  and the active preset's allowlisted shader controls. An absent layer field uses
  deterministic defaults; an explicit empty field means no enabled layers.
- The registry seals only after all 16 production layers register, and every
  layer has an explicit serialization disposition. Unknown enabled-layer tokens
  reject the layer payload; unknown option tokens are ignored. Restoration
  settles independently per layer so one failed or unavailable source cannot
  block its siblings.
- Stable visible options are limited to aircraft 3D mode, selected civilian and
  military flight IDs, Satellite catalog and selection, CCTV coverage/projection/
  auto-hop, and Radio filter/volume. Playback and tuning, live-data health,
  calibration, caches, lifecycle state, temporary Context ownership, and derived
  effects are deliberately excluded. Radio restore never selects or plays a
  station.
- Normal loads restore the last successful explicit UI, voice, or tool choice
  from versioned local storage. Any valid camera share wins for the current load
  without overwriting recipient preferences. Restore ownership is split by
  visibility, option/selection, camera, visual, map, and individual panel lane:
  a newer explicit action supersedes only the field it owns. In particular,
  navigation cannot turn unrelated layers off, and an option change cannot
  cancel the same layer's visibility transition. Every explicit HUD, detection,
  post-processing, scope, or celestial action from the UI, keyboard, voice, or
  public tool facade claims the visual lane before mutation. Invalid requests do
  not claim that lane or partially change controls.
  Direct globe pointer and wheel gestures supersede the delayed shared camera
  and selected-subject Follow without aborting unrelated layer visibility or
  display-option restoration.
- The initial restore has one terminal promise spanning the camera flight,
  visual/map/panel callback work, every production layer result, and the
  destination-scoped selected-subject Follow result. Hash writes remain
  suppressed and the startup screen continues to read `Restoring shared view...`
  until that aggregate settles. Destroy settles it as destroyed rather than
  permitting late mutation. A superseded shared visibility intent follows
  the authoritative successor chain to a terminal lifecycle result, including a
  same-target re-enable or opposite-target disable, before releasing the layer
  barrier. Flights, Military, and Satellite first-update
  fetches consume the manager AbortSignal; disable and destroy also abort their
  module-owned feed or dense-catalog requests.
- Only one Flights, Military, or Satellite tracking ID can be durable at once.
  Explicit selection clears the other families, Stop Tracking clears active and
  pending IDs, and ambiguous incoming multi-family selections fail closed rather
  than letting feed arrival order choose the camera owner.
- An explicit aircraft selection made inside Contacts promotes the owning
  Flights or Military layer from a mode-owned dependency into durable state, so
  leaving Context, reloading, or opening the link can restore it. Passive
  Contacts autofocus does not revoke a pending selected aircraft; the exact
  shared/local target wins when its feed row arrives.
- A shared Flights, Military, or Satellite subject that has not arrived yet
  publishes a persistent top-center `ACQUIRING` progress state while the
  existing deferred-restore latch and source-specific deadline remain active.
  Success, expiry/failure, cancellation, superseding intent, owner-layer
  disable, explicit navigation, and teardown all settle and clear that state;
  caller abort remains authoritative after the pending handoff. A latch that
  rejects its deferred selection emits only the terminal failure and never a
  false acquisition state. An unrelated manager failure preempts `ACQUIRING`
  for its full visible dwell; if acquisition is still owned afterward, the
  progress state resumes. A share-specific terminal failure that arrives while
  another failure is visible is queued, and its own fixed dwell starts only
  when that message reaches the screen. Only terminal failures use the existing
  fixed-dwell error presentation.
- Radio category persistence shares the live directory's bounded normalizer,
  including generated genre identifiers with spaces or `&` such as `Hip Hop`
  and `R&B`.
- Shared panel state starts from deterministic defaults and excludes responsive
  auto-collapse. Partial or malformed panel fields cannot import or overwrite
  recipient-local layout preferences.
- A fresh Cockpit entry temporarily collapses the standard left/right map
  panels and opens Cockpit's own Contact and Live Signals rails. This runs only
  on entry: Previous/Next preserves any panel the operator opens while already
  inside. Exit restores the exact standard-panel open/collapsed snapshot from
  before entry; Cockpit-only disclosure changes do not replace that map layout.
  Opening Data Layers while inside Cockpit temporarily collapses the Contact
  panel to prevent overlap. Closing Data Layers restores Contact only when that
  accordion action collapsed it; an operator's own Contact collapse remains
  authoritative.
  Voice selection of the nearest aircraft near a named place follows
  the requested-layer enable → location arrival → destination refresh → nearest
  airborne lookup → aircraft selection path, excludes on-ground records, and
  never enters Contacts or Cockpit unless either mode is named explicitly. The
  destination refresh also runs when the requested layer was already enabled.
  The lookup inspects the full loaded fleet and tracks by stable ICAO identity.
  That complete route is one atomic voice action, so Realtime sibling calls
  cannot race the nearest-aircraft query ahead of layer enablement. A healthy fallback feed is
  queried normally and its source is returned with the selection; fallback with
  no airborne records remains an honest no-data result, not an enable failure.
- Voice treats the parent Context panel and Contacts as separate intents. An
  explicit request to open Context expands only `global-context-panel`; it does
  not choose a mode. An explicit request to open Contacts expands that parent
  first, activates the Contacts sub-view, and returns the settled 250 km window.
  Its `aircraft` count is the exact civilian-plus-military total when both feeds
  can answer, or `unknown` when either component is unavailable.
- Cockpit's top vision switch cycles five rendered looks: the inherited map
  style, CRT, NVG, FLIR, and Noir. There is no empty `NONE` entry.

## Share-link Follow

- **Share-link selected-subject Follow (2026-08-20):** a copied v2 link adds
  an ephemeral `at` epoch-seconds field; ordinary live hash updates omit it.
  A shared Flights, Military Flights, or Satellites selection restores only
  after the base destination camera, ordinary layer restoration, and a new
  destination-scoped source refresh settle. The source module—not lifecycle
  success or the UI—owns the final presence decision: Flights and Military
  use the exact accepted snapshot, while Satellites waits for the applicable
  dense catalog and treats a partial CelesTrak catalog as unable to prove
  absence. A found subject starts the normal moving Follow at its current
  position regardless of link age. An authoritatively missing subject is
  `expired` only when copy age is strictly greater than 90 seconds for Flights,
  45 seconds for Military, or 5 minutes for Satellites; equality, missing or
  malformed time, and other non-found cases are unavailable. Feed/catalog
  failure has its own feed-unavailable message. These warnings use the
  universal top-center status banner and its standard failure dwell, beginning
  only after the shared-view startup cover clears. If
  teardown or disable invalidates an in-flight refresh, any selected-subject
  restore waiting behind it settles as cancelled instead of remaining pending.
  Terminal non-found cleanup compare-clears only the exact passive ID in memory and the live URL, never
  recipient local storage. A newer explicit selection, visibility request,
  destination, pointer gesture, wheel gesture, destroy, or source cancellation
  wins and suppresses late Follow/status work without cancelling unrelated
  shared layer visibility or options. Radio station selection remains outside
  the share payload; Radio restores only its allowlisted filter and volume.
