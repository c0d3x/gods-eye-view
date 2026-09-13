# Keys, launchers and the dev server

Part of the [runtime reference](../CURRENT-STATE.md): Google keys, authentication and launch, proxy failure responses, and proxy caches.

## Google browser and server keys

Local Places nearby/text search and the CCTV Street View fallback prefer
`GOOGLE_MAPS_SERVER_API_KEY`, falling back to `GOOGLE_MAPS_API_KEY` when the
server key is blank or absent. Only the browser key is injected into client
code. Both are optional and configured in the same ignored root `.env`, or
Pinokio's ignored `pinokio/ENVIRONMENT`, through Provider Settings or manual
editing. `.env.example` and `pinokio/_ENVIRONMENT` document the two entries.
The Street View headings tool uses the same server-first selection after
resolving environment overrides per variable; its explicit `--key` wins.

## Auth + Launch

- Recommended launcher: `./scripts/dev-fresh.sh` (also: `dev-secure.sh`, the same launcher pinned to 127.0.0.1, and `dev-cctv.sh` for CCTV source-pack tuning)
- A successful Pinokio install writes the owner-only `pinokio/.installed`
  marker. The nested launcher menu resolves that marker from its own directory:
  an absent marker exposes Install, a present marker exposes Start, and a
  running server with a captured ready URL exposes Open God's Eye View.
- Build gate: `pnpm run build`
- Network access: local-only by default (`HOST=localhost` in dev-fresh.sh); LAN is an explicit opt-in via `HOST=0.0.0.0` (launcher prints a key-exposure warning + LAN URL; see SECURITY.md)
- OpenSky default mode: OAuth (`OPENSKY_AUTH_MODE=oauth`; `anon` works without credentials)
- Google key expected in Keychain service `google-maps-api` (or `GOOGLE_MAPS_API_KEY`, or `.env`)
- OpenSky credentials expected in Keychain service `opensky-network` (or env, or `.env`); `OPENSKY_AUTH_MODE` and `OPENSKY_CREDENTIALS_FILE` read from `.env` too
- Optional-key precedence in `dev-fresh.sh` is uniform — explicit shell env, then `.env`, then Keychain: `OPENAI_API_KEY` (Keychain `openai-api`/`api-key` — voice + HUD summary), `AISSTREAM_API_KEY` (`aisstream-api`/`api-key` — live vessels), `CESIUM_ION_TOKEN` (`cesium-ion`/`token` — Bing stacks), `TOMTOM_API_KEY` (`tomtom-api`/`api-key` — live traffic flow), `FIRMS_MAP_KEY` (`firms-map`/`map-key` — live fires), `LL2_API_TOKEN` (`.env` only)
- An empty string is not "unset" on either side of the launcher, and both sides are handled. `scripts/read-dotenv-value.mjs` hides the requested key from `process.env` for the duration of the read (Vite's `loadEnv` otherwise lets an inherited empty export win over the parsed files) and restores it after. A key the launcher resolves to nothing is then removed from the dev server's environment outright (`env -u`), not merely omitted — the child inherits this shell's environment, and Vite backfills `.env` only over undefined variables, so an empty export in either place would shadow a configured key. `CCTV_CALTRANS_DISTRICTS` is the deliberate exception: empty is its documented Caltrans kill switch and is passed through as-is
- `.env` supported via `.env.example` template

### Proxy/Security Baseline

- CCTV proxy rejects client-specified upstream URLs (server-side source allowlist only).
- CCTV upstream still-image fetches use an explicit abort controller with an
  eight-second timeout; the timer is cleared on every success or failure path.
- OpenSky response cache stores successful upstream responses only; OAuth token refresh calls are coalesced.
- A cold OpenSky failure uses the current camera subpoint only to request a cached adsb.lol point fallback capped at 250 nm. A fresh OpenSky response or last-good cache wins; a nominally successful worldwide snapshot more than two minutes old prefers viewport-scoped adsb.lol when available, otherwise the stale source is reported honestly. The fallback is visibly source-labeled and is never presented as a worldwide snapshot.
- GBFS response size is capped; CCTV health map is bounded.
- Proxy error payloads are sanitized (no internal error details returned to clients).
- `OPENAI_API_KEY` is server-side only; the browser receives ephemeral Realtime client secrets from `/api/realtime/token`.
- `AISSTREAM_API_KEY` is server-side only; the browser reads the same-origin `/api/ais-live` cache.
- `/api/google/nearby-places` keeps the Google key out of Places requests issued for voice scene context.
- `/api/google/text-search` keeps the Google key server-side for view-biased Places recovery used by annotation resolution.
- `/api/overpass` is bounded by body/response caps, per-client/global rate limits, concurrency limits, mirror fallback, in-flight dedupe, cache bounds, and static validation that every selector is spatially bounded.
- `/api/military-installations` uses an independent limiter with the same 90-per-client/300-global one-minute bounds, so viewport installation refreshes never consume `/api/overpass` annotation/traffic capacity.
- `/api/route` proxies bounded OSRM route requests for annotation routes, with profile allowlisting, distance caps, response caps, caching, and sanitized "no route found" errors.
- Track endpoints: `/api/ais-live/track?mmsi=` (server-accumulated ring buffers; sub-route handled before the rows snapshot), `/api/opensky-track?icao24=` (OAuth, 60s cache, sanitized errors, independent OpenSky credit bucket), `/api/adsblol/trace?hex=` (60s cache, 5MB cap, ODbL attribution required in UI).
- Realtime debug logs redact API keys, bearer tokens, client secrets, and image data URLs before writing to disk; request bodies are size-capped.

## CCTV launcher and proxy failure responses

`scripts/dev-cctv.sh` delegates startup to `scripts/dev-fresh.sh`. It retains
its Austin source file, Austin preference, 36-camera Austin limit, and 48-camera
total limit, with environment overrides. Keys are optional; credential loading
and names-only provider provenance follow the normal launcher. The default
binding is localhost. An explicit `HOST=0.0.0.0` uses the same LAN warning as
normal startup.

The CelesTrak, Launch Library, terrain-height, and ADSBDB middleware return
fixed messages for unexpected failures. Launch Library retains its upstream
HTTP failure status and no-store policy but does not forward the upstream body.
Existing successful, in-flight, missing-data, and stale-cache behavior remains
in place. Failure diagnostics identify the service and, for Launch Library,
HTTP status without printing raw exception text or upstream bodies.

## Overpass proxy mirror rotation

- `/api/overpass` fans out across four public mirrors. `overpassPayloadIsData()` governs cache reads, writes, and stale fallback: only a 2xx that is neither rate-limited nor a body-level runtime error qualifies. Previously stored refusals are ignored on both fresh and stale reads, so upgrading does not require manually clearing the disk cache.
- HTTP refusals such as 406 now rotate alongside the existing network, rate-limit, and runtime-error cases. A refusal from one mirror no longer prevents reaching healthy alternatives or persists under the seven-day road/month-long boundary cache TTLs. Concurrent identical queries share one mirror sequence; if it fails, both the initiating and joined callers can use the same last-good data.
- A refusal every mirror agrees on is still reported with the first mirror's status and body, so a genuinely malformed query says what upstream said — but only after every mirror has had the chance to answer it. `fetchOverpassPayload` takes injectable endpoints and fetch so the rotation is tested without a live mirror (`src/overpassProxy.test.mjs`).

## Proxy caches

- **Terrain-height resilience:** `/api/terrain/heights` caches canonical
  5-decimal points individually, reconstructs reordered/overlapping batches
  in exact request order, and refreshes only missing or stale points. Network,
  429, and 5xx failures receive bounded jittered retries with `Retry-After`;
  stale real heights remain usable per point, while an uncached absent height
  still returns 502 rather than becoming a fabricated ground value. Client
  geoid fallbacks wait 60 seconds before retrying and self-heal to Re:Earth on
  the first later successful fetch.
- **Overpass cache admission:** `/api/overpass` parses and sanitizes requests,
  then checks fresh memory, identical in-flight work, and fresh disk entries
  before invoking its local 90/min limiter. Cache and single-flight responses
  therefore do not spend quota; upstream-bound misses retain the existing
  limiter, mirror, stale, and sanitization behavior.
