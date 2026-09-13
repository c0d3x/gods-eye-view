# Security

God's Eye View is a local-first client for **public** data. It is built for exploration, demos, and learning — not as a hardened production service. This document explains the security model so you can run it safely and report issues responsibly.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for anything exploitable.

- Use GitHub's [private vulnerability reporting](https://github.com/c0d3x/gods-eye-view/security/advisories/new) (Security tab → "Report a vulnerability"), or
- Reach the maintainer directly via the contact on the GitHub profile.

Include repro steps and impact. We'll acknowledge, investigate, and credit you (if you'd like) once a fix ships.

## How secrets are handled

The golden rule: **secret-bearing API keys stay on the server side.** The dev/preview server (Vite middleware in `vite.config.js`) brokers every request that needs a private credential, so the browser never receives one.

| Key | Where it lives | How the browser uses it |
|-----|----------------|--------------------------|
| `OPENAI_API_KEY` | Server only | Browser fetches a short-lived **ephemeral** Realtime session token from `/api/realtime/token`; the real key never ships |
| `AISSTREAM_API_KEY` | Server only | Server holds the AISStream websocket; browser polls the same-origin `/api/ais-live` cache |
| OpenSky OAuth (`OPENSKY_CLIENT_ID/SECRET`) | Server only | Server mints + refreshes the token behind `/api/opensky` |
| `GOOGLE_MAPS_SERVER_API_KEY` (optional, #33) | Server only | Server calls Places (`/api/google/nearby-places`, `/api/google/text-search`) and the Street View fallback with this key; falls back to `GOOGLE_MAPS_API_KEY` when unset |

### Two deliberately client-side keys — restrict them

These are designed to be used directly in the browser (like a Mapbox public token). They are injected into the client bundle via Vite's `define`, so they **will** be visible in browser devtools. Scope and restrict them rather than trying to hide them:

1. **Google Maps API key** — loads Photorealistic 3D Tiles directly and powers GEV place search. **Restrict it** (HTTP referrer + API restriction to the required Google APIs) in the Google Cloud Console. An unrestricted key in a public deployment can be abused and billed to you.
2. **Cesium ion token** (`CESIUM_ION_TOKEN`, optional — for ion-hosted Google Photorealistic 3D Tiles, Bing world imagery, and world terrain) — used as `Cesium.Ion.defaultAccessToken` client-side. Use a public **`assets:read`** token with **URL restrictions** for any hosted deployment. The Community plan has eligibility and usage limits; a public token is not a secret, but it can still consume the account's quota.

> The Vite `define` block in `vite.config.js` controls exactly what reaches the client: only these two keys. Everything else stays server-side.

**Places and Street View never needed to be on that list** (#33): they're called from the server-side proxies in the table above, which use `GOOGLE_MAPS_SERVER_API_KEY` when it's set. Splitting it from the browser-exposed key lets each key's Google Cloud restriction actually match what it does — the browser key referrer-restricted to the APIs the client loads, the server key IP-restricted (never a referrer, since it never leaves your server) to Places + Street View Static — instead of one key that has to be either over-permissioned or broken for one of its two jobs. A single shared `GOOGLE_MAPS_API_KEY` still works if you don't split them; it just has to cover every API both sides use.

Never commit real keys. `.env` is gitignored; only `.env.example` (placeholder names) is tracked. On macOS `dev-fresh.sh` can read keys from the Keychain; plain Vite uses env vars or a local `.env`, and Pinokio uses its ignored app `ENVIRONMENT` file. The launcher hands keys to the dev server through its environment, and `scripts/opensky-import-client.sh` writes to the Keychain through `security -i` on stdin, so no key appears in a process's argument list, where `ps` would show it.

The official Pinokio launcher stores optional values in its ignored local
`pinokio/ENVIRONMENT` file and Vite explicitly denies that filename. Add,
replace, or remove those values through the in-app **POWER UP → Provider
Settings** panel; the server restricts the file before writing and restarts the
local app after a save. Do not submit credentials through Pinokio 8.0.40's
native Configure form: that release targets the wrong file for this nested
launcher layout and logs the submitted values. The ignored file is local
plaintext, not encrypted storage. The macOS Keychain remains the stronger local
option when launching through `./scripts/dev-fresh.sh`.

### Configuring separate Google keys locally

Terminal development uses one ignored repository-root `.env` for both
`GOOGLE_MAPS_API_KEY` (browser) and `GOOGLE_MAPS_SERVER_API_KEY` (server).
The tracked `.env.example` documents both without credentials. Vite injects
only the browser key; sharing an environment file does not expose the server
key. Both entries are available in Provider Settings. Pinokio saves them in
its ignored `pinokio/ENVIRONMENT` instead, with app values and blanks taking
precedence over inherited global values. An absent server key retains the
browser-key fallback for existing single-key setups.

## Server-side proxy hardening

The data proxies in `vite.config.js` are written so the browser cannot turn the server into an open relay:

- **No arbitrary-URL fetching.** The CCTV proxy fetches only server-registered camera URLs — clients cannot pass an upstream URL to fetch (SSRF mitigation). The Street View fallback does take the frame's position from the request, so it counts against the per-client Google throttle below, and its frames are cached by position. It follows at most three redirects itself (`server/lib/cameraFetch.mjs`). A hop may stay on the origin of a camera from your own `CCTV_SOURCES_FILE` or `CCTV_SOURCES_JSON`, which can be a camera on your network. Any other hop, and every hop of a camera from the Austin, Caltrans or TfL feeds, must resolve only to public addresses, and the connection is pinned to them. Only images (not SVG), video and HLS playlists are relayed, with `X-Content-Type-Options: nosniff` and a sandboxing Content-Security-Policy. Other proxies target fixed upstream hosts.
- **Radio is not an audio relay.** `/api/radio/stations` contacts only allowlisted Radio Browser HTTPS hosts and paths, rejects redirects, rejects any hostname with a loopback/private/link-local/metadata/non-public A or AAAA result, and pins each TLS connection to a validated address. It returns normalized public HTTPS stream URLs; `/api/radio/click/:uuid` applies the same destination policy and accepts only station IDs from the current bounded catalog. The browser then connects directly to the broadcaster after an explicit playback action, so the broadcaster sees the listener's IP address. GEV never proxies, caches, records, or redistributes audio.
- **Timeouts on every upstream call.** A stalled provider can't hold a request open: the proxies answer 504 when a call passes its deadline, and a call made for one browser request stops when that browser disconnects (`server/lib/fetchWithTimeout.mjs`). A live CCTV stream has no end, so its deadline covers only the response headers.
- **Sanitized errors.** Clients get the proxy's own messages, never a provider's error text or an exception message; the details go to the server log.
- **Response-size caps.** Every proxy stops reading an upstream response once it passes a fixed size for that route, so a misbehaving provider can't exhaust the server's memory. A live CCTV stream has no end; it is relayed as it arrives instead of being read into memory.
- **Coalesced OAuth refresh** and cached successful responses only (OpenSky).
- **Voice debug logging is off by default.** Set `GEV_REALTIME_DEBUG_LOG=1` to record voice sessions to `.gev-logs/realtime-conversations.jsonl` (gitignored, never served). The server redacts every record before writing it — API keys, bearer tokens, client secrets, Authorization values and image data URLs — so records that don't come from the app are covered too. Records are capped at 256 KiB, the file rotates at 20 MB keeping one previous file, and only your user can read the directory and file (0700/0600). While the log is off, `/api/realtime/debug-log` answers 404.

## Network exposure — the operator threat model

The dev server is a **key broker**: every server-side key above is spendable by anyone who can send HTTP requests to it. That shapes the defaults:

- **Local-only by default.** `./scripts/dev-fresh.sh` (and the Vite config itself) bind to `localhost`, so only your machine can reach the server.
- **Only this machine's names are answered, in LAN mode too.** Vite accepts IP addresses, plus `localhost`, this machine's hostname and `<hostname>.local`, plus any names in `GEV_ALLOWED_HOSTS`. Every other `Host` gets a 403, which is what blocks DNS-rebinding attacks on the API routes.
- **Cross-site requests are refused.** A guard in front of every `/api` route (`server/lib/requestGuard.mjs`) refuses requests that another site's page sends through your browser. A browser request must carry `Sec-Fetch-Site: same-origin` or `none`. A browser that doesn't send that header must send an `Origin` equal to the server's own. Request bodies must be JSON, apart from the Overpass proxy's form-encoded queries. Non-browser clients send neither header and pass, so the throttles below still matter.
- **No CORS, and private files stay private.** The dev and preview servers send no `Access-Control-Allow-*` headers (`cors: false`), so no other origin — not even another app on localhost — can read their responses. `server.fs.deny` keeps `.env` files, certificates, `.git/`, `pinokio/ENVIRONMENT`, the app's `.gev-logs/` and `.gev-cache/`, and local `.claude/` settings from being served.
- **LAN exposure is an explicit opt-in**: `HOST=0.0.0.0 ./scripts/dev-fresh.sh`. The launcher prints a prominent warning plus your LAN URL. Understand what opting in means: **every device on that network can drive the proxies and spend your OpenAI / Google / OpenSky / AISStream / TomTom / FIRMS quota** for as long as the server runs. Do this only on networks you trust.
- **App-level throttles (on by default):** `GEV_RATELIMIT_OPENAI_PER_MIN` (default 30) and `GEV_RATELIMIT_GOOGLE_PER_MIN` (default 120) cap the cost-bearing endpoints per client IP per minute. Google Places and the CCTV Street View fallback each get the Google budget. Over-limit requests receive a sanitized `429`, and a rate-limited CCTV frame falls back to the synthetic frame. `0` or `off` turns a throttle off; an unreadable value keeps the default. They are **per-IP, process-local, in-memory guards** — they reset on restart and are **not billing caps**.
- **Provider-side budgets are the real backstop.** For hard spend protection, configure limits where the money is: OpenAI platform usage limits, Google Cloud budget alerts + per-API quotas, and equivalent controls for any other keyed provider.
- **Pinokio LAN and Cloudflare sharing are refused.** The current supported
  Pinokio release re-reads sharing state when an app registers its Open URL and
  logs a successful tunnel-login passcode in its own notification and terminal
  stream. Before preflight, the launcher rewrites its app-scoped sharing controls
  to disabled values, clears any Pinokio-global passcode from the child, and
  pins the platform share trigger to a disabled sentinel. A stale or requested
  sharing value is therefore discarded rather than honored, and GEV starts on
  loopback only. Use a separately reviewed authentication proxy for remote
  access and keep provider-side quotas as the spend backstop.

## Supply chain

- **Reviewed install scripts.** `pnpm-workspace.yaml` lists every dependency allowed to run an install script, and pnpm fails the install when a new one appears.
- **Locked, delayed updates.** CI installs with `pnpm install --frozen-lockfile`. Dependabot proposes weekly grouped updates for npm packages and GitHub Actions, and waits seven days after a release before proposing it, so a compromised release has time to be pulled. Security updates aren't delayed.
- **Pinned CI actions.** Every GitHub Action in `.github/workflows/` is pinned to a full commit SHA, with its version in a comment, so a moved tag can't change the code CI runs; a test fails on an unpinned action. Workflows get a read-only token (`permissions: contents: read`), and checkouts don't keep it (`persist-credentials: false`).
- **Scanning.** CodeQL analyzes the JavaScript and the workflows on every push to `main` and weekly, and OpenSSF Scorecard checks the repository's supply-chain practices weekly; both report under Security → Code scanning. Dependency review checks what each push to `main` and each pull request adds, and fails on a dependency with a known vulnerability of moderate severity or higher.

## Scope & expectations

- The Vite server is a **development/preview** server. If you expose it beyond localhost, put it behind your own auth/proxy and review the bindings (see the threat model above).
- All data shown is from **public** sources. See [DATA_SOURCES.md](DATA_SOURCES.md). Respect each provider's terms and rate limits.
- The voice agent receives feed-sourced text (place names, callsigns) as scene context. It is instructed to act only via a fixed set of app-control tools and not to execute arbitrary instructions found in data, but treat model output as untrusted and keep the tool surface limited.

## Responsible use

This is an interface for signals that are **already public**. Use it accordingly: respect privacy, follow data providers' terms, and don't represent public-data inference as authoritative intelligence.
