# Data layers

Part of the [runtime reference](../CURRENT-STATE.md): the active layers, infrastructure markers, FIRMS, installations, earthquakes and launches, and Space Missions.

## Active Data Layers in Runtime

Qualified Radio playback requests—category, station, country, coordinates, or
nearby place—always use station selection. Unqualified “turn on/start the radio”
requests use Play; a qualified Play-shaped tool call is normalized to Select so
its criteria cannot be silently ignored.

| Layer | Source | File | Proxy | Update Interval |
|-------|--------|------|-------|-----------------|
| Live Flights ✈️ | OpenSky Network; bounded adsb.lol regional fallback | `src/data/flights.js` | `/api/opensky` (OAuth + fallback) | 30s |
| Military Flights 🎖️ | adsb.lol /v2/mil | `src/data/militaryFlights.js` | `/api/adsblol/mil` | 15s |
| Live AIS Vessels 🚢 | AISStream websocket | `src/data/aisLiveVessels.js` | `/api/ais-live` | 60s (+800ms visibility pass) |
| Mapped Installations ⌖ | OpenStreetMap mapped context; on-demand Google Maps Places supplement | `src/data/militaryInstallations.js` | `/api/military-installations`, `/api/google/text-search` | viewport-driven + user search; while unavailable, auto-retry 30 s → 240 s backoff |
| Earthquakes | USGS | `src/data/earthquakes.js` | — | 60s |
| Satellites | CelesTrak | `src/data/satellites.js` | `/api/celestrak` | 120s |
| Space Missions (30d) | Launch Library 2 + CelesTrak | `src/data/rocketLaunches.js` | `/api/launches` + `/api/celestrak/active` | 5 min |
| Traffic | OSM Overpass (+ optional TomTom live flow) | `src/data/traffic.js` | `/api/overpass` + `/api/tomtom` | viewport-driven |
| CCTV | Austin + Caltrans (CA) + TfL London Open Data + Street View fallback | `src/data/cctv.js` | `/api/cctv` | 10s (active) |
| Radio | Radio Browser (public-domain station directory) | `src/data/radio.js` | `/api/radio/stations`, `/api/radio/click/:uuid` | 45 min directory refresh |
| Bikeshare 🚲 | GBFS (Lyft + BCycle) | `src/data/bikeshare.js` | `/api/gbfs` | 60s |
| Datacenters ▣ | OSM extract (bundled) | `src/data/localLayers.js` | — | static |
| Dams ▰ | OpenInfraMap/OSM extract (bundled) | `src/data/localLayers.js` | — | static |
| Submarine Cables ◠ | TeleGeography public map (bundled) | `src/data/telegeographySubmarineCables.js` | — | static |
| FIRMS Active Fires ▲ | NASA FIRMS live (VIIRS ×3 NRT, trailing 24h) | `src/data/firmsHeatmap.js` | `/api/firms` (`FIRMS_MAP_KEY`) | 10 min (proxy TTL 30 min) |

`src/data/militaryAwareness.js` remains registered internally as the Contacts
coordinator, but it is not a user-visible Data Layers entry. Its visible entry
point is the right-side `CONTEXT` chooser's `CONTACTS` mode.

At global scale, ambient Radio cluster badges are hard-opacity shared-host
entries: count/category updates and identity replacement do not run keyhole or
enter/exit ramps. Shared collision, viewport rejection, allocation, and horizon
culling can still remove an invalid placement, and Cesium still owns the cluster
point geometry and picks. Their 50,000 km line-of-sight range covers the
supported full-globe camera above 24,000 km, including farther horizon clusters.
Unclustered visible stations publish nearest-first ambient labels through that
same host, capped at 16 labels globally, 32 at intermediate zoom, and 48 nearby;
cluster and singleton candidates still share the Radio source's 64-entry ambient
cohort. Cesium continues to own each 13 px station point, horizon visibility,
and direct/nearby picking. Native points and shared-host text use one 50,000 km
interaction limit, so a painted singleton or cluster label always retains a
pickable point at its anchor throughout the supported high-global view. No
Radio entity uses native Cesium label text.

Delivery constraint: PR #10 is stack-only and unsafe standalone. PR #11 owns
the required Radio lifecycle/authority repair, so PR #10 must not merge or ship
unless PR #11 is included in the delivered stack.
Selected and singleton globe labels use the same compact 30-character
presentation: a credible explicit or leading-decimal frequency is rendered
first (`93.9 FM — Station`), otherwise the station name is ellipsized. Full
upstream names remain unchanged in the directory, player, and search state.
Fresh Radio sessions open on All stations while enable and restoration remain
silent. Directory refreshes retain cluster overlay identity for unchanged
represented membership and discard only identities containing removed stations.
When the user explicitly clicks Enable inside the expanded Radio section, the
Context panel performs one internal post-render scroll to reveal the station
filter and primary transport together without moving keyboard focus, the page,
or the globe. Compact controls, voice/tools, restoration, Data Layers, and
programmatic activation do not trigger this reveal.

Radio directory admission is atomic on both sides of the proxy boundary. A
refresh is healthy only when it reaches the minimum accepted-query and station
coverage; schema-valid responses with zero normalized stations count as failed
queries rather than inflating refresh health. Each specialist query also needs
an accepted station whose normalized tags match that requested category; rows
tagged only for another category remain usable catalog data but do not earn
specialist health credit. A partial cold result remains
usable but is explicitly `DEGRADED` and has no accepted catalog generation, while a
partial or malformed refresh cannot replace a warm catalog. The client likewise
rejects stale/future freshness metadata, incomplete rows, and empty catalogs as
a whole, preserving its last usable stations with `STALE`/`DEGRADED` state.
Every healthy admission publishes a monotonically increasing generation scoped
to a restart-stable `catalogInstance` token (a new server process starts a
fresh sequence — never read as a repeat or a regression) with a deeply
immutable station snapshot; stale/degraded warm responses retain the same
generation so tuner and cluster consumers can preserve exact station identity.
Generation semantics assume the app's actual single-process dev-server
deployment; concurrent replicas behind one origin are out of scope.
The client snapshot contains only the normalized station-field allowlist,
preserves object identity for an idempotent repeat of the same generation, and
degrades without replacement if a fresh response presents an older generation.
Snapshot records mark community metadata as untrusted, and Radio tool results
omit station names so directory text never becomes model instruction context.
One bounded country parser maps recognized ISO codes and English/common names —
including widely used exonyms the Intl display label omits (Turkey, Holland,
Burma, and similar) — through proxy metadata and final station selection, while
malformed, non-ISO, control-containing, ambiguous, and oversized inputs fail
closed. Literal or resolved
non-global IPv4/IPv6 targets are refused. Destroy fully releases the Radio audio
session, voice ducking/restoration, request state, filter, selection, volume,
accepted snapshot, and feed telemetry before re-initialization; monotonic
ownership tokens plus the session boundary keep late callbacks from a retired
session inert.
A tuner drag resolves previews against the single accepted snapshot captured at
pointer-down, even while a newer catalog is admitted. Release starts playback
only when the current same-ID record still exactly matches the frozen
presentation and stream metadata; removal or replacement reports the channel as
unavailable and never silently retargets the drag. A cold degraded fallback may
still populate the directory and globe, but its null accepted generation cannot
populate or begin the tuner.

Context entry and exit consider both rejected lifecycle promises and resolved
`false` manager results to be transaction failures. Entry awaits isolation and
restores the exact prior layer snapshot when isolation or activation fails;
when a direct Context shell fails after lifecycle work starts, reconciliation
waits outside the manager notification until that shell's queue settles, then
restores the complete snapshot rather than treating the in-flight layer as an
exclusion. An uncertain shell is retried and incomplete cleanup retains the
snapshot for a later restore. Direct-shell isolation and its compensating
rollback share one operation-scoped notification token, so an inner lifecycle
failure cannot announce separately from the outer blocked action. Context exit
waits for every sibling transition, retains the exact pending snapshot
after failed compensation, and can retry it later instead of silently reporting
a partial restore. User-facing Context chooser, direct Data Layer shell,
mapped-installation Search, rollback/exit, and Radio chip routes settle those
failures through the existing toast surface, release busy controls, and avoid
unhandled promises. A wrapped operation owns exactly one failure or blocked
notification; its synchronous manager event is suppressed only for that
operation, while unwrapped lifecycle failures retain the manager-level fallback.
The toast is a polite atomic status announcement.
When no tracked entity owns the follow camera, Radio Previous/Next and tuner
previews rotate to the requested broadcaster without changing zoom. A local
view whose optical center remains safely over the Earth, or a full globe already
contained in the viewport keyhole, uses one direct station flight and preserves
its initiating view angle. If a fit-capable Earth disc is clipped/off-center, or
a closer oblique view leaves the viewport center outside the Earth disc, Radio
first animates a centered north-up nadir composition, then focuses the latest
station from that canonical frame. Closer views keep their initiating altitude;
an extreme zoom-out is capped at 13,000 km so recovery returns to a useful
whole-globe scale instead of preserving an empty-space view. The two-stage navigation has one generation:
a playback fallback retargets it to the broadcaster that will play, while a newer
Radio action—including direct globe or non-moving voice selection—supersedes
older callbacks, and layer disable/destroy invalidates
the pending stages. While Flights, Military Flights, or any other
`viewer.trackedEntity` is active, Previous/Next and tuner previews continue to
change station and playback without cancelling or flying the camera. Tracking
acquired between the recenter and focus stages suppresses the later stage, and
a delayed fallback rechecks the same live ownership. Voice Radio navigation
remains non-moving; explicit station focus remains a separate user-requested
route and also yields to a live tracked entity.
The Radio tuner exposes the complete current filtered directory, up to 750
stations, in stable catalog and filter order. Needle progress is absolute across
that directory: the left, center, and right of the control resolve to the first,
middle, and last available station. Every position snaps to a real station, so
there are no selectable static gaps. During a drag, the bounded virtual tape
moves left as the needle moves right and travels faster than the needle without
creating DOM nodes for the complete directory. Camera movement never re-ranks or
rebuilds this order. Tuner-owned preview flights remain monotonic on the captured
strip, and release commits the frozen station before selection and playback
settle. That exact release clears older fallback ownership, so a broadcaster
failure cannot silently play a station left over from an earlier non-playing
cycle; the failed target retains its static/error handoff until Stop or another
explicit choice. Pointer cancellation instead cancels the active preview flight and
restores the exact pre-drag station ordering, absolute position, and frozen
presentation-only marker without starting a replacement camera flight,
committing, or autoplaying. That marker is restored even when an
accepted concurrent catalog removes the station or replaces its metadata, but
it never becomes current playback authority. The next accepted healthy catalog
refresh clears that presentation-only marker, including when the accepted
generation repeats and the immutable directory snapshot is intentionally kept
by identity. Every accepted filter action also clears and rebuilds the marker,
including a request for the already-active filter; a lifecycle-rejected filter
event leaves the restored marker and tuner band untouched. An accepted filter
action synchronously rebuilds the complete navigation pool after the layer state
notification, so Previous/Next and the tuner cannot observe an empty interim
directory. This restoration
also holds at either directory endpoint. Previous/Next traverses the same stable
pool and updates the absolute tuner position.
Cluster refresh identity follows the prior cluster contributing the greatest
absolute number of stations to the new cluster. This preserves majority identity
during merges instead of allowing a fully retained minority to win; deterministic
similarity and stable-ID tie breakers cover equal contributors and splits.
Every positive overlap participates in greatest-contributor discovery, so ratio
thresholds cannot discard a diffuse or one-station maximum. Inheritance is
bilateral mutual-best: a current cluster accepts only a greatest contributor and
a prior identity transfers only to a strongest split child. If that identity is
already claimed by an equal or stronger child, the later cluster receives fresh
identity instead of falling through to a historical minority. Disjoint clusters
also receive fresh identity; sequential fresh IDs are allocated in canonical
membership/station order so input permutations do not rename them.

Voice interprets “turn on/start the radio” as Radio Play, including when it is
combined with a camera action. Explicit “show/enable the Radio layer/markers”
remains a silent layer-only action and does not close the voice session.

Successful explicit user playback from Play/Resume, Previous/Next, the tuner,
or a globe station closes an active voice session only after Radio reaches
`playing`; a failed stream leaves voice active.
An interrupted or superseded voice turn aborts pending Radio location resolution
before it can enable the layer or select a station. Radio enable and disable are
abort-aware manager transactions: cancellation restores the authoritative
pre-transaction state only when the compensating lifecycle call succeeds and
emits no settled explicit-intent event for Context persistence. Failed
activation and teardown expose explicit `enabling` and `disabling` lifecycle
states while the manager retains the last authoritative visibility. The public
lifecycle vocabulary is `enabling`, `enabled`, `disabling`, and `disabled`, plus
a separate uncertainty bit. Radio controls present that phase and remain
non-interactive until the lifecycle is certain `enabled`; only a successful
transaction publishes the new `enabled` or `disabled` settlement. Radio's data
layer state, player message, compact status, launch controls, and generic Data
Layers row explicitly show `UNCERTAIN` when cleanup cannot establish authority;
their accessible labels name the uncertainty while Enable/Disable remains
available to reconcile it.
The Radio source, shared overlays, selected marker, and pick handler use the same
manager-owned presentation gate:
they remain hidden and inert throughout enabling, disabling, cancellation,
failure, and uncertain reconciliation, and activate only for certain `enabled`.
The same gate rejects direct station selection, Previous/Next cycling and its
camera/fallback preparation, tuner-static and category-filter mutation, volume
mutation, and every non-Pause playback toggle before fallback, selection, or
audio state changes. Voice volume and station-starting actions require a fresh
manager lifecycle read.
Every returned `control_radio` result, including status, failure,
cancellation, and a missing Radio module, exposes that same authoritative
`lifecycleState` plus `lifecycleUncertain`; the manager lifecycle record takes
precedence over the stable enabled fallback. Status only reads this state and
does not enqueue lifecycle or player work.
Generic `set_layer_visibility` results expose the same atomic `enabled`,
`lifecycleState`, and `lifecycleUncertain` summary for Radio on success,
fulfilled-false failure, rejection, cancellation, reversal, and missing-module
outcomes. Realtime suppression and settlement refresh all three fields together,
so dedicated and generic Radio routes cannot publish mixed lifecycle snapshots.
`disabled` is inert, while a transitional or uncertain shell is reconciled
through the manager and may proceed only after a fresh read confirms certain
`enabled`; false, rejection, or cancellation preserves the prior player state.
The existing immediate Stop/Pause authority is unchanged.
Cancelled-disable compensation reports failure and records whether lifecycle
state remains uncertain. Any same-target request made while state is uncertain
performs the real lifecycle work instead of taking the stable-state no-op, then
clears that reconciliation debt only after a confirmed enable or disable. A module-local
`AbortError` is a cancellation even while the caller signal remains live, while
that settled transaction releases its abort listener so the old caller cannot
disable a later successful retry. A resolved `false` from init, enable, first
update, or disable is a lifecycle
failure. Unrelated sibling tools remain independent, while each Radio control
captures the current playback-handoff epoch. A later Radio
Pause or Stop provisionally freezes prepared or already-started playback
handoff work without aborting active Select/Play auto-enable or an independent
explicit dedicated or generic Radio visibility ON. After semantic success it
cancels the active Select/Play lane and clears the frozen handoff. Semantic
failure leaves active work live and releases and resumes the frozen handoff.
Disable and generic OFF own visibility as well as playback and may cancel both.
These controls commit their authority only after semantic success, so a failed
stronger control cannot suppress a valid completed sibling. Pause uses the
production player's synchronous boolean contract; Stop and Disable additionally
handle their awaited failure paths. The control's function output is sent before a failed reservation releases,
so resumed playback cannot close the voice channel before the failure is
reported. Resumed handoffs own their attempt-scoped cleanup, so a stale predecessor
cannot clear the successor's in-flight result or block a later failed
reservation from resuming it again.
Generic `set_layer_visibility` Radio disable participates in the same ownership
domain as dedicated Radio controls, so an older Select cannot reverse it. Direct OFF
from either Radio control or the Data Layers row publishes intent before joining
the lifecycle queue and aborts in-flight voice work before an intermediate ON
event can settle. Every absolute manager visibility request also advances a
per-layer intent epoch and aborts the older absolute lifecycle transaction,
including a same-target request whose newer origin must own persistence. An
obsolete queued request never starts; obsolete in-flight cleanup keeps
presentation transitional and hidden, and only the latest request may adopt or
reconcile that state and publish settled visibility. The epoch is rechecked
after synchronous lifecycle-presentation callbacks, so a re-entrant newer
request prevents the older transaction from arming a timer or publishing a
settled visibility event. Superseding an uncertain same-target retry also keeps
the last authoritative enabled boolean until cleanup confirms the real module
state. Direct OFF also freezes
prepared or already-started playback handoff
until the manager queue settles; confirmed OFF discards that handoff, while a
failed OFF releases the reservation and resumes the valid prepared result. A
successful Stop cancels stale Radio work across older response ids as well as
its own response. If a Radio action has already completed its station mutation
before the later control succeeds, only its playback handoff is suppressed; its
result reads enabled state from the manager and audio state from the Radio
module. Voice Pause is a playback-only no-op while the layer is disabled; it
never enables Radio and reports a fulfilled-false pause as failure. A
newer-response or user-origin Stop still cancels stale handoff work.
Only a newer user turn or session teardown aborts the complete active-tool set.
A cancelled turn cannot publish a late Radio playback request. Dedicated Radio
controls and generic layer-visibility commands both forward cancellation.
Each explicit Radio play attempt owns one active audio element; replacement
retires the prior element, making its queued callbacks inert. Pause retires the
current stream and fallback attempt, so delayed callbacks from a replaced or
paused stream cannot change current state or start another station.
Pause and Stop settle attempt ownership and authoritative audio state before
synchronous playback-control observers run, so reentrant voice cleanup cannot
overwrite a released stream with a stale paused state. Layer
destruction likewise retains an enabled manager entry when module disable or
destroy fails semantically, preventing an active orphan and allowing retry.
When Context is collapsed, explicitly activating its Radio header icon reveals
the compact transport; hover and focus alone do not open it. When Context is
expanded, the icon instead expands and scrolls to the embedded Radio section.
Its accessible label, controlled region, and expanded state keep describing the
current route throughout enabling, enabled, disabling, and uncertain lifecycle
renders. Both routes preserve Radio power, playback, station, filter, and volume
state.

Bundled datasets live in `src/data/local_data/` with per-folder provenance READMEs; they are lazily loaded via `src/data/localGeojson.js` (Vite `?url` assets) when toggled on.

A bundled dataset that fails to load is a broken install, not a blip, so it is
never swallowed: `localGeojson.js` guards `response.ok`, reports `error` +
`lastUpdate` through `getStats()` (UNAVAILABLE chip, not a green ON over an
empty globe), and commits its Cesium data source only after setup completes so
a partial failure retries on the next enable. The two non-layer packs
(`naturalEarthRegions.js`, `neighborhoodPolygons.js`) have no stats contract to
report into, so they instead refuse to memoize a failure —
`src/data/retryableLoad.js` caches success permanently and retries a failed
load after a doubling cooldown (5 s → 5 min), which keeps one bad load from
silently demoting every later lookup for the session.

## Infrastructure marker visibility

Datacenter/dam registration uses fresh reusable factories with the application's
existing context, overlay and render functions. The scoped package exports do
not import standalone application globals; see
[the infrastructure interface](../INFRASTRUCTURE-LAYERS.md) for lifecycle and asset
requirements.

Local GeoJSON layers coalesce concurrent enables into one load. Disabling while
loading keeps the result hidden; destruction aborts the fetch and rejects late
parse/add results. Destruction and failed setup remove owned context records,
so replacing a layer cannot retain stale entities or listeners.

Datacenters and dams retain their full datasets while limiting active marker
stems per layer: 80 at camera heights of 3,000 km or above, 200 from 200 km,
and 420 below 200 km. Selection favors existing label priority and nearby
features, retains stable choices across small camera movements, and refreshes
during continuous motion. Disable/re-enable resets selection cleanly.
Close-up stem sizing uses camera-to-feature distance without a 5 km minimum.
Unchanged overlay entries do not request another frame; moved positions,
changed membership and re-enabling still publish. Ground sampling waits for
visible globe tiles to settle and uses valid loaded terrain as a floor while
retaining rooftop and below-sea-level elevations. A hidden globe does not
constrain photoreal geometry, and retry work remains bounded. Already sampled
nearby markers follow higher settled terrain on existing bounded walks, without
additional GPU samples or timers, when close-up tile detail refines the floor.
The submarine-cable renderer is unchanged. These limits bound active stem work;
they do not reduce the materialized entity count or establish an FPS gain.

## FIRMS source status

The FIRMS proxy records source success after appending its rows. If aggregation
throws, that source reports failure without a contradictory success entry.
The existing per-record append continues to support large feeds; sequential
fetching, trailing-24-hour filtering and partial-success caching are unchanged.

## Installations and map-source guidance

- On an uncached Overpass failure, mapped installations keep their existing
  30–240 second retry backoff. The top status and Contacts row explain the
  outage and scheduled countdown; an active retry says "Retrying mapped
  sites" and successful recovery clears the previous error. Known upstream
  rate limits, timeouts, and query failures are distinguished without exposing
  raw server errors. Failures from other loading layers retain precedence.
- Click a selected installation again or click elsewhere on the map to clear
  its selection. Clearing the installation does not clear another layer's
  newly selected contact, and refreshes do not revive the cleared site.
- Installation ways and relations without an explicit center use the midpoint
  of finite, ordered bounds spanning at most 10 degrees per axis. Explicit
  coordinates and centers retain precedence; invalid bounds are dropped.
- Visual-style buttons describe their simulated effects on hover. Unavailable
  map-source tooltips and toasts share provider guidance: missing credentials
  point to Provider Settings, while a configured Google 3D route that fails
  points to restrictions, quota, or connectivity. These hints do not expose keys.

## Earthquake and launch data

Earthquake refreshes validate the complete feed and construct replacement entities before clearing the previous snapshot. Malformed rows and duplicate rendered IDs retain the last good entities, overlays, count and timestamp and report a malformed response; unknown magnitude is excluded from M2.5+ rendering.

Non-object or array-valued properties reject the response instead of being treated as an unknown magnitude.

Launch payloads with missing records now say PAYLOAD DATA UNAVAILABLE. Missing names use Unnamed payload; absent or invalid mass stays unknown instead of appearing as 0 KG.

## Layer notes

- **The Street Traffic sync chip shows one percentage (2026-08-20):** the
  settled confirmation flash carries the layer's coverage figure and NO
  progress number. `reduceTrafficSyncFeedback` returns an empty
  `progressText` once the sync lands and `#traffic-sync-progress:empty`
  collapses the slot; the renderer writes the empty value rather than
  guarding on truthiness, or the busy `...` strands beside the settled label.
- **Space Missions dependency shutdown:** disabling a mission dependency or
  leaving the mode closes mission context and restores the exact pre-entry
  Satellite enabled state and presentation parameters. Restored parameters
  never re-show primitives while the Satellite layer is disabled.
- **Space Mission horizon occlusion:** mission dots and hover reticles apply
  their surface-anchor horizon state before Cesium draws or picks the frame,
  while shared-host labels use the same hidden-globe horizon contract. Rear-side
  markers therefore cannot remain from the prior camera frame, including in
  request-on-demand photoreal views; the conservative limb margin remains.
  Graphics that begin with Cesium's implicit visible default are enrolled in
  that pass on their first frame rather than bypassing the cull.
  Selecting a mission isolates its launch anchor until Show All / Deselect
  or the panel close control clears the selection.

## Not Currently in Runtime

- Weather radar (removed before OSS v1 after QA; no reliable visible payoff)
- General replay/timeline systems outside the Space Missions experience
- LiDAR explorer and paired-point CCTV calibration experiments
