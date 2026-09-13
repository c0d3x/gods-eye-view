# Vessels and cameras

Part of the [runtime reference](../CURRENT-STATE.md): live AIS and its health, vessel ownership and camera transfer, and CCTV focus.

## Live AIS Vessels

- Server-side `ws` websocket to `wss://stream.aisstream.io/v0/stream` maintained by Vite middleware; `AISSTREAM_API_KEY` never reaches the browser (AISStream has no browser CORS). The `ws` package is used rather than Node's built-in WebSocket specifically because only it can hard-abort a wedged socket (see the watchdog note in the delta block at the top).
- Browser polls same-origin `/api/ais-live` cache every 60s.
- The first enable in a session starts one 30-second client grace timer. Until
  an accepted vessel position arrives, `live`/`open`/`connecting` transport reports
  `LOADING`; the timer is not restarted by the 60-second poll. Expiry or a
  definitive transport/credential failure reports `UNAVAILABLE`. Accepted
  warm vessels survive later zero-position refreshes as stale/degraded data,
  while disable/re-enable owns a new timer and superseded responses remain
  inert.
- Client render cap `VITE_AIS_LIVE_MAX_ROWS` (default 12,000); type-colored ship icons (tanker/cargo/passenger/fishing/tug); screen-space label clustering caps active labels at `VITE_AIS_LIVE_LABEL_MAX_ROWS` (default 900).
- Click-to-inspect wired into the voice context store.

## AIS feed health and vessel ownership

- **AIS feed watchdog (2026-08-18):** feed liveness is judged by DATA, not
  socket state — AISStream can complete the handshake and then deliver
  nothing forever. `/api/ais-live` reports `live | stale | reconnecting |
  down | auth-failed` (plus the unchanged `missing-key`/`unsupported`) with
  `silentForMs`, `reconnectAttempt` and `nextAttemptAt`. Silence is REPORTED
  at 120s and ACTED ON at 300s; recovery walks a 5s/15s/60s/300s ladder and
  then stops at a terminal `down` with a slow 15-min retry running behind it
  (a retry never flips the chip back to "connecting" — only real data clears
  `down`). Liveness credit requires a frame that arrived on a still-owned
  socket AND decoded into a real AIS record: handshakes, malformed frames and
  error envelopes are never liveness, and orphan frames are dropped entirely.
  Failures are CLASSIFIED — auth rejections (error envelope, HTTP 401/403)
  are terminal with an hourly probe and an actionable chip, 429 honours
  `Retry-After` and otherwise enters at the slowest rung, and only genuine
  transport faults use the ladder; worst case is single-digit connection
  attempts per hour in every class. Degraded states stay visible in the chip
  even while cached vessels are still drawn.
  **Locked invariants — do not "fix" these:** teardown is `ws.terminate()`,
  never `close()` (the built-in WebSocket has no hard-abort and its `close()`
  never completes against a black-holed peer, leaking the single per-key
  connection); socket generations are monotonic for the module lifetime and
  never reused across a dispose, and every socket-map mutation is
  identity-checked (otherwise a pre-disposal close event orphans a
  post-disposal socket and two connections race for the one slot); durations
  use a monotonic clock, wall time only for display. Policy is a pure state
  machine (`server/ais/watchdog.mjs`) returning actions; the socket lifecycle
  is `server/ais/streamAdapter.mjs`, tested directly with mock sockets; the
  transport assumption is pinned in `server/ais/watchdogTransport.test.mjs`.
- **Honest live AIS health:** the vessel layer treats socket connection,
  first message receipt, raw payload rows, and accepted vessel positions as
  separate stages. Each enabled session owns one 30-second first-connect
  grace: an open or connecting socket with no accepted position reads
  `LOADING`, and polls do not restart that deadline. The first accepted
  position ends the grace and establishes freshness; expiry, missing
  credentials, rejected transport, or another definitive failure reads
  `UNAVAILABLE`. Disable/re-enable starts a new isolated session. A socket
  with no received message or no usable positions does not advance
  `lastUpdate` or replace warm accepted vessels;
  warm selection and trail state remain visible as stale/degraded. Late
  responses from disabled, destroyed, or replaced layer requests cannot
  mutate or finalize the current lifecycle. Layer stats expose transport
  status, message time, and raw/accepted row counts for diagnosis.
- **Cross-layer vessel ownership:** clicking a sibling-layer contact leaves
  the active vessel card, HUD, context, and trail unchanged while the sibling
  handles the pick, preventing two camera commands from one click. Starting entity tracking still clears vessel
  inspection; AIS itself never sets `viewer.trackedEntity`. Own unkeyed or
  evicted vessel-record picks and `gev-trail:*` remain no-ops. CCTV choices
  made from the panel dropdown do not currently emit a cross-layer event and
  therefore do not clear vessel inspection.
- **Vessel/fire camera transfer:** clicking an actionable AIS vessel sprite
  or painted card selects that MMSI and requests one close oblique camera
  transfer; re-clicking the selected vessel refocuses it. FIRMS detection
  sprites and actionable detection cards do the same using a refetch-stable
  identity that includes position, acquisition time, and source satellite.
  Aggregate fire cells remain non-actionable. Painted actionable cards are
  also mirrored into a named, focusable assistive-control list that exposes
  selected state and announces focus only after the backing record accepts
  activation. Global FIRMS cards reject far-side cells before
  filling the bounded overlay cohort; the shared overlay still owns final
  horizon culling. The UI validates world-focus
  requests before releasing tracking, refuses Cockpit-owned moves before any
  camera mutation, and releases follow owners before accepted flights.
  Sibling-owned picks win without clearing the vessel/fire selection or
  issuing a competing camera command. Deferred geocoding stamps intent but
  retains the current owner until a valid destination resolves; immediately
  before flight it rechecks shared navigation authority. Newer destinations,
  voice `move_camera`, `fly_route`, overhead framing, strongest-fire focus,
  vessel/aircraft/satellite tracking, reset, Cockpit entry, or teardown
  make older work and its UI completion inert. Teardown removes immediate
  camera-entry listeners before its first asynchronous restoration step and
  refuses any new immediate or deferred navigation after disposal begins.

## CCTV focus

- **CCTV world-click focus:** clicking an in-world CCTV icon or ambient card
  activates it and routes the camera flight through the panel FOCUS policy.
  Aircraft/satellite tracking releases outside cockpit; cockpit retains the
  view, keeps the CCTV activation, and surfaces the existing refusal toast.
  Auto-hop and programmatic camera activation remain activation-only. CCTV
  world clicks must stay within 6 px and 400 ms; drag-like or long gestures
  are inert, and re-clicking the already active camera emits no focus request.
  A clean empty-space click clears the active CCTV camera in place without
  moving the view or disabling the layer. Sibling-layer picks and ADJUST-mode
  interactions never trigger that clear. The resulting null selection remains
  stable across rendering and updates; configured auto-hop is held until a
  later explicit activation or AUTO HOP toggle-on.
- **CCTV focus and teardown:** explicit camera choices still activate during
  cockpit mode, but they retain aircraft tracking, suppress the view flight,
  and ask the user to exit cockpit. Layer enable is activation-only when a
  tracked entity or cockpit owns the view, with no flight or cockpit-exit toast.
  Voice select/next/previous/nearest actions report when tracking or cockpit
  refuses their requested flight without hiding the successful selection.
  Camera deactivation and layer disable both clear temporary probe clamps;
  disable re-arms the active record, re-enable restores nominal geometry without
  probing, and the next real activation re-runs the obstruction probe. Disable
  uses a direct hide sweep; obstruction hits retain the field-derived 12 m floor.
  Geometry-drain progress notifications are coalesced to roughly 300 ms or ten
  batches, whichever arrives first. Natural completion publishes its final
  state; disable publishes the terminal state explicitly when it cancels a drain.
  Coverage polylines are lazy: catalog init creates none, while enable in the
  default COVERAGE ON mode materializes the active camera and visible neighbor
  cohort (70 entities at the 14-camera cap). Activation always materializes the
  selected frustum, including COVERAGE OFF when projection remains on.
  Empty-space deselection removes the active projection and active-relative
  coverage emphasis but preserves the layer, coverage mode, ambient cards,
  catalog, panel settings, and viewer pose. With no active camera the panel
  exposes no stale dropdown/FOCUS/calibration target; NEXT starts at the first
  catalog entry and PREVIOUS starts at the last.
  While aircraft tracking or cockpit mode owns the view, the geometry drain
  rechecks ownership per batch and drops to two records every 250 ms. Enable
  focus decisions conservatively combine pre- and post-await ownership.
- Share-link camera restoration re-applies its settled pose and requests a
  render after the flight completes, ensuring Google Photorealistic 3D Tiles
  stream at a deep-link destination without requiring manual camera input.
