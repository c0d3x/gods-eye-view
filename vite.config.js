/**
 * Vite configuration for God's Eye View — a cinematic geospatial app.
 *
 * Installs the dev-server proxy middlewares that bypass CORS and add
 * caching/auth for upstream APIs. They live in server/proxies/:
 *   - celestrak.mjs — satellite TLE orbital elements
 *   - rocketLaunches.mjs — recent Launch Library 2 mission metadata
 *   - firms.mjs — live active-fire detections (VIIRS ×3, trailing 24 h)
 *   - terrainHeights.mjs — Re:Earth keyless point-height lookups (ellipsoidal ground)
 *   - adsbdb.mjs — aircraft type and route lookups
 *   - adsbLol.mjs — military aircraft tracking
 *   - trackBackfill.mjs — recent aircraft tracks from OpenSky and adsb.lol
 *   - googlePlaces.mjs — Google Places names around the view, for the voice agent
 *   - opensky.mjs — aircraft state vectors (OAuth / anon), with an adsb.lol regional fallback
 *   - gbfs.mjs — bike-share station feeds from allowlisted hosts
 *   - tomtom.mjs — live traffic-flow vector tiles (budget-governed, keyless-degradable)
 *   - overpass.mjs — OpenStreetMap road geometry queries and walking/driving routes
 *   - cctv.mjs — traffic-camera frames, media streams, and fallback SVG
 *   - militaryInstallations.mjs — bounded, cached OpenStreetMap features
 *   - regional.mjs — regional briefings and camera-local weather effects
 *   - radio.mjs — Radio Browser station directory and click counting
 *
 * The AIS relay, server/ais/relay.mjs, keeps one AISStream websocket open and
 * serves the live vessel positions and tracks it collects. The voice agent's
 * routes and its tool schema live in server/realtime/.
 *
 * Also exposes Cesium and Google 3D Tiles API keys to the
 * client via `import.meta.env.*` defines.
 *
 * @module vite.config
 */

import { googleServerApiKey } from './server/lib/googleServerKey.mjs';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import cesium from './scripts/cesium-vite-plugin.mjs';
import { parseEnv as parseDotenvText } from 'node:util';
import { readEnvironmentSource as readPinokioEnvironmentSource } from './scripts/pinokio-environment.mjs';
import { knownKeySetupEnvVars } from './src/keySetupCatalog.js';
import {
  admitKeySetupRequest,
  isKeySetupExternallyManaged,
  keySetupStatus,
  upsertDotenvValues,
  validateKeySetupUpdates,
} from './server/keySetupCore.mjs';
import { hardenCredentialFileReport } from './server/keySetupHardening.mjs';
import { resolveAllowedHosts } from './server/lib/allowedHosts.mjs';
import { isDebugLogEnabled } from './server/lib/debugLog.mjs';
import { coalesceProxyRequest } from './server/lib/coalesce.mjs';
import { PROJECT_URL } from './server/lib/projectUrl.mjs';
import { requiredFiniteQueryNumber } from './server/lib/queryParams.mjs';
import { readResponseBytesCapped, readResponseJsonCapped, readResponseTextCapped } from './server/lib/upstreamBody.mjs';
import { readBodyWithin } from './server/lib/requestBody.mjs';
import { createApiRequestGuard } from './server/lib/requestGuard.mjs';
import { radioBrowserProxy } from './server/proxies/radio.mjs';
import { diskCachePruners } from './server/lib/diskCacheLimits.mjs';
import { militaryInstallationsProxy } from './server/proxies/militaryInstallations.mjs';
import { overpassProxy } from './server/proxies/overpass.mjs';
import { regionalBriefProxy, weatherEffectsProxy } from './server/proxies/regional.mjs';
import { cctvProxy } from './server/proxies/cctv.mjs';
import { gbfsProxy } from './server/proxies/gbfs.mjs';
import { tomtomProxy } from './server/proxies/tomtom.mjs';
import { openSkyProxy } from './server/proxies/opensky.mjs';
import { googlePlacesContextProxy } from './server/proxies/googlePlaces.mjs';
import { aisLiveProxy } from './server/ais/relay.mjs';
import { openAiRealtimeProxy } from './server/realtime/openai.mjs';
import { adsbdbProxy } from './server/proxies/adsbdb.mjs';
import { adsbLolProxy } from './server/proxies/adsbLol.mjs';
import { celestrakProxy } from './server/proxies/celestrak.mjs';
import { firmsProxy } from './server/proxies/firms.mjs';
import { rocketLaunchesProxy } from './server/proxies/rocketLaunches.mjs';
import { terrainHeightsProxy } from './server/proxies/terrainHeights.mjs';
import { trackBackfillProxies } from './server/proxies/trackBackfill.mjs';
export {
  ADSBDB_CACHE_MAX_ENTRIES,
  adsbdbProxy,
} from './server/proxies/adsbdb.mjs';
export {
  launchLibraryRequestHeaders,
  LL2_CACHE_TTL_MS,
} from './server/proxies/rocketLaunches.mjs';
export {
  TERRAIN_CACHE_MAX_POINTS,
  terrainHeightsProxy,
} from './server/proxies/terrainHeights.mjs';
export {
  openAiRealtimeProxy,
} from './server/realtime/openai.mjs';
export {
  aisKeyFingerprint,
} from './server/ais/relay.mjs';
export {
  GOOGLE_PLACES_TIMEOUT_MS,
  googlePlacesContextProxy,
  keylessGooglePlacesResponse,
} from './server/proxies/googlePlaces.mjs';
export {
  OPENAI_TIMEOUT_MS,
} from './server/realtime/openai.mjs';
export {
  adsbLolFallbackAnchor,
  normalizeOpenSkyAuthMode,
} from './server/proxies/opensky.mjs';
export {
  CCTV_FRAME_FETCH_TIMEOUT_MS,
  CCTV_STREET_VIEW_CACHE_MAX_ENTRIES,
  CCTV_STREET_VIEW_CACHE_TTL_MS,
  cctvProxy,
  fetchCctvImageFromUpstream,
} from './server/proxies/cctv.mjs';
export {
  decodeRssText,
  regionalBriefHasAnySource,
  validRegionalPoint,
} from './server/proxies/regional.mjs';
export {
  fetchOverpassPayload,
  isOverpassBoundaryQuery,
  overpassPayloadIsData,
  readOverpassDisk,
  resolveOverpassPreflight,
  simplifyOverpassPayloadBody,
} from './server/proxies/overpass.mjs';
export {
  migrateMilitaryInstallationEntry,
  MILITARY_INSTALLATION_ELEMENT_CAP,
  militaryInstallationCacheKey,
  militaryInstallationDiskFresh,
  militaryInstallationDiskPath,
  militaryInstallationFailureReason,
  quantizeMilitaryInstallationBox,
  readMilitaryInstallationDisk,
  resolveMilitaryInstallationTier,
  validMilitaryInstallationBox,
  writeMilitaryInstallationDisk,
} from './server/proxies/militaryInstallations.mjs';
export {
  DISK_CACHE_LIMITS,
} from './server/lib/diskCacheLimits.mjs';

// These helpers now live in server/lib/; callers that import them from here
// keep working.
export {
  coalesceProxyRequest,
  googleServerApiKey,
  PROJECT_URL,
  readResponseBytesCapped,
  readResponseJsonCapped,
  readResponseTextCapped,
  requiredFiniteQueryNumber,
};
export {
  createRadioProxyMiddleware,
  isPublicRadioAddress,
  normalizeRadioBrowserStation,
  publicRadioHttpsUrl,
  publicRadioStation,
} from './server/proxies/radio.mjs';

/** Resolve __dirname for ESM context. */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Which launcher started this process, captured at MODULE LOAD — before the
 * config factory's loadEnv() copies dotenv files into process.env. Provider
 * Settings uses this to decide which credential store it owns, so it must
 * reflect the real launcher (scripts/pinokio-start.mjs sets it) and never a
 * value a project `.env` could inject.
 */
const LAUNCHER_AT_BOOT = process.env.GEV_LAUNCHER;

/**
 * Provider values present before Vite loads the checkout's dotenv files.
 * Memoized on globalThis: a panel save sets its values live on process.env and
 * then calls server.restart(), which re-evaluates this config IN-PROCESS.
 * Recomputing the snapshot there would classify the panel's own keys as
 * external (read-only) until the whole process is relaunched.
 */
const PROVIDER_ENV_AT_BOOT = globalThis.__GEV_PROVIDER_ENV_AT_BOOT ??= Object.freeze(Object.fromEntries(
  [...knownKeySetupEnvVars()].map((name) => [name, String(process.env[name] ?? '').trim()]),
));

/**
 * `dev-fresh.sh` resolves dotenv and Keychain values before it starts Vite, so
 * it supplies an explicit names-only provenance marker for values inherited
 * from its parent shell. Plain Vite launches use the raw boot snapshot above;
 * Pinokio deliberately treats its app-scoped ENVIRONMENT as authoritative.
 */
const DEV_FRESH_EXTERNAL_KEYS_AT_BOOT = new Set(
  String(process.env.GEV_KEY_SETUP_EXTERNAL_KEYS ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => knownKeySetupEnvVars().has(name)),
);

/**
 * Vite plugin: prune the per-query disk caches when the server starts.
 * Writes prune again, at most every ten minutes (see createCachePruner).
 *
 * @returns {import('vite').Plugin}
 */
export function diskCacheJanitor() {
  const pruneAll = () => {
    for (const pruner of Object.values(diskCachePruners)) void pruner.runNow();
  };
  return {
    name: 'gev-disk-cache-janitor',
    configureServer: pruneAll,
    configurePreviewServer: pruneAll,
  };
}

/**
 * In-app key setup ("POWER UP" panel) — dev-server only.
 *
 * GET  /api/setup/status → which keys are configured, as presence plus a
 *   source classification. Never a value or suffix. The panel renders itself entirely from
 *   this payload, so the key registry stays in one place (src/keySetupCatalog.js).
 * POST /api/setup/keys → validate {ENV_VAR: value} pairs and upsert them into
 *   the repo-root .env (created if absent), set process.env live, then restart
 *   the dev server so the client-exposed defines re-inject and the page
 *   reloads itself. Pasting a key in the app IS the whole setup — no
 *   hand-edited env files.
 *
 * Loopback-only on purpose: with HOST=0.0.0.0 the app can be shared on a LAN,
 * and a guest must be able to neither write the host's .env nor probe which
 * keys exist. Prod builds never register this middleware (apply: 'serve'), so
 * the panel's status fetch fails and the client removes the whole surface.
 */
export function keySetupEndpoint() {
  // A Provider Settings request carries a few keys; anything larger is refused.
  const KEY_SETUP_MAX_BODY_BYTES = 8 * 1024;
  const respond = (res, statusCode, payload) => {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json');
    // A credential-status response must never be cached by a proxy or the disk
    // cache, and the surface must never be framed (clickjacking a same-origin
    // REMOVE/replace past the Origin check).
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.end(JSON.stringify(payload));
  };
  // Which store this launch owns. A Pinokio-managed launch (marker set by
  // scripts/pinokio-start.mjs) writes the app-scoped pinokio/ENVIRONMENT that
  // applyPinokioEnvironment() treats as authoritative; every other launch
  // writes the repo-root .env that Vite's loadEnv reads. The panel never
  // touches a store some other workflow owns.
  // The launcher marker is read from the BOOT environment captured before
  // Vite's loadEnv merges dotenv files into process.env — otherwise a stray
  // `GEV_LAUNCHER=pinokio` line in someone's .env would silently redirect a
  // plain `npm run dev` to write the Pinokio store it never loaded.
  const pinokioManaged = () => LAUNCHER_AT_BOOT === 'pinokio';
  const storeName = () => (pinokioManaged() ? 'pinokio-environment' : 'env-file');
  const storePath = () => path.join(__dirname, ...(pinokioManaged() ? ['pinokio', 'ENVIRONMENT'] : ['.env']));
  // Read the store, distinguishing "no store yet" from "cannot read this
  // store". Only ENOENT means empty. Every other failure — a permission error,
  // an I/O fault, an undecodable file — must ABORT the save: upserting into a
  // wrongly-empty string and atomically replacing the file would destroy every
  // other provider key the user had configured.
  const readStore = () => {
    try {
      // The Pinokio launcher deliberately supports a UTF-16 ENVIRONMENT (a
      // Windows editor or the native Configure panel can write one). Reuse its
      // own encoding-aware decoder so a panel write can never mistake UTF-16
      // bytes for UTF-8, corrupt the file, and wedge the next launch. We always
      // write back UTF-8, which is exactly what the launcher normalizes to.
      if (pinokioManaged()) return readPinokioEnvironmentSource(storePath());
      return fs.readFileSync(storePath(), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return ''; // The first saved key births the file.
      const unreadable = new Error('the existing configuration could not be read, so nothing was changed');
      unreadable.code = 'GEV_STORE_UNREADABLE';
      throw unreadable;
    }
  };
  // Status must never fail because the store is unreadable — it reports the
  // LIVE environment, and an unreadable store only costs file/external
  // attribution. Persistence uses readStore() directly and refuses instead.
  const storeValues = () => {
    try {
      return parseDotenvText(readStore());
    } catch {
      return {};
    }
  };
  // The gate itself is pure and unit-tested (admitKeySetupRequest in
  // server/keySetupCore.mjs) — this just feeds it the request.
  const admit = (req) => admitKeySetupRequest({
    method: req.method,
    remoteAddress: req.socket?.remoteAddress,
    hostHeader: req.headers?.host,
    protocol: req.socket?.encrypted ? 'https:' : 'http:',
    origin: req.headers?.origin,
    contentType: req.headers?.['content-type'],
    proxyHeaders: req.headers || {},
    env: process.env,
  });
  // Is this env var supplied by a workflow OTHER than this panel's store? Boot
  // provenance closes the equal-value ambiguity: an exported X remains
  // external even when the editable store independently contains X.
  const isExternallyManaged = (name, inStore) => {
    const wasExternalAtBoot = pinokioManaged()
      ? false
      : LAUNCHER_AT_BOOT === 'dev-fresh'
        ? DEV_FRESH_EXTERNAL_KEYS_AT_BOOT.has(name)
        : PROVIDER_ENV_AT_BOOT[name] !== '';
    return isKeySetupExternallyManaged({
      effectiveValue: process.env[name],
      storedValue: inStore[name],
      wasExternalAtBoot,
    });
  };
  const providerStatus = () => {
    const inStore = storeValues();
    const status = keySetupStatus(process.env);
    for (const key of status.keys) {
      // 'file' = this panel's own store holds exactly this value (replace/remove
      // offered); 'external' = supplied by env/Keychain/another workflow
      // (read-only — the panel must never rewrite or delete it).
      key.managed = key.set
        ? (key.envVars.some((name) => isExternallyManaged(name, inStore)) ? 'external' : 'file')
        : null;
    }
    return { ...status, store: storeName() };
  };
  // Atomically replace the store's content: fresh same-dir temp created 0600
  // with the exclusive flag, fsync, rename over the target. Closes the window
  // where writeFileSync leaves a 0644 file holding a real key before any later
  // chmod, and the truncate-in-place data-loss path.
  const persistStore = (text) => {
    const filepath = storePath();
    // Never write THROUGH a symlink into a credential path.
    try {
      if (fs.lstatSync(filepath).isSymbolicLink()) {
        throw new Error('refusing to write a credential store that is a symlink');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error; // absent is fine — first save.
    }
    // Random suffix, not the pid: a stale temp from a failed rename would
    // otherwise make every later save in this process fail EEXIST forever.
    const tmp = path.join(
      path.dirname(filepath),
      `.${path.basename(filepath)}.${randomUUID().slice(0, 8)}.tmp`,
    );
    const fd = fs.openSync(tmp, 'wx', 0o600);
    let staged = false;
    try {
      // Restrict the EMPTY temp file BEFORE the secret touches it. On Windows
      // a fresh file inherits the directory's ACL (world-readable under a
      // C:-rooted Pinokio home) and the 0600 open mode is a no-op — and NTFS
      // renames carry the file object's ACL with it, so hardening the temp IS
      // hardening the final file. Ordering this before the write means a
      // hardening failure aborts with the previous store fully intact and the
      // secret never on disk unprotected — no rollback path to get wrong.
      const hardening = hardenCredentialFileReport(tmp);
      if (!hardening.ok) {
        console.warn(`[KeySetup] Could not restrict ${path.basename(tmp)} (${hardening.step}): ${hardening.detail}`);
        const error = new Error('could not restrict the credential file to your account; nothing was saved');
        error.code = 'GEV_HARDEN_FAILED';
        throw error;
      }
      // writeSync may write fewer bytes than asked; loop until the whole
      // buffer lands or a truncated store gets fsynced and renamed into place.
      const buffer = Buffer.from(text, 'utf8');
      let written = 0;
      while (written < buffer.length) {
        written += fs.writeSync(fd, buffer, written, buffer.length - written);
      }
      fs.fsyncSync(fd);
      staged = true;
    } finally {
      fs.closeSync(fd);
      if (!staged) fs.rmSync(tmp, { force: true });
    }
    try {
      fs.renameSync(tmp, filepath);
    } catch (error) {
      // Never strand a staged secret on disk when the swap itself fails.
      fs.rmSync(tmp, { force: true });
      throw error;
    }
  };
  return {
    name: 'gev-key-setup',
    // serve AND not preview: `vite preview` resolves with command 'serve' too,
    // so a bare apply:'serve' would still configure under preview. The endpoints
    // only install via configureServer (never configurePreviewServer), so they
    // are absent from preview today — but pinning apply here makes that a
    // guarantee rather than an accident of which hook a future edit uses.
    apply: (_config, { command, isPreview }) => command === 'serve' && !isPreview,
    configureServer(server) {
      server.middlewares.use('/api/setup/status', (req, res) => {
        if (req.method !== 'GET') return respond(res, 405, { error: 'Method not allowed' });
        const admission = admit(req);
        if (!admission.ok) return respond(res, admission.status, { error: admission.error });
        respond(res, 200, providerStatus());
      });
      server.middlewares.use('/api/setup/keys', (req, res) => {
        if (req.method !== 'POST') return respond(res, 405, { error: 'Method not allowed' });
        const admission = admit(req);
        if (!admission.ok) return respond(res, admission.status, { error: admission.error });
        // Past the cap, readBodyWithin stops buffering and drains the rest, so
        // the 413 reaches the client before the connection closes. Destroying
        // the request instead reset the connection before any reply.
        readBodyWithin(req, KEY_SETUP_MAX_BODY_BYTES).then((read) => {
          if (!read.ok) {
            res.setHeader('Connection', 'close');
            return respond(res, 413, { error: 'Request too large' });
          }
          let parsed;
          try {
            parsed = JSON.parse(read.text || '{}');
          } catch {
            return respond(res, 400, { error: 'Invalid JSON' });
          }
          const verdict = validateKeySetupUpdates(parsed);
          if (!verdict.ok) return respond(res, 400, { error: verdict.error });
          // Neither a replace NOR a removal may touch an externally-supplied
          // credential (shell env, Keychain, another workflow). This backs the
          // UI's read-only "configured externally" state with a real contract —
          // and it must guard replace too, not just remove: a clickjacked or
          // scripted same-origin POST could otherwise overwrite the live value.
          const inStore = storeValues();
          for (const name of Object.keys(verdict.updates)) {
            if (isExternallyManaged(name, inStore)) {
              return respond(res, 409, {
                error: `${name} is configured outside Provider Settings and can only be changed where it was set`,
              });
            }
          }
          try {
            persistStore(upsertDotenvValues(readStore(), verdict.updates));
          } catch (error) {
            // The hardening failure carries its own honest, path-free message —
            // "saved world-readable" must never be reported as a generic write
            // error. Everything else returns a fixed message (a raw filesystem
            // error can carry an absolute path; that stays in the server log).
            if (error?.code === 'GEV_HARDEN_FAILED' || error?.code === 'GEV_STORE_UNREADABLE') {
              return respond(res, 500, { error: `The key was not saved: ${error.message}` });
            }
            return respond(res, 500, { error: `Could not write the ${storeName()} store` });
          }
          // Live for the server-side proxies immediately; the restart below is
          // what re-injects the client-exposed defines (Google, Cesium ion).
          // Removal sets '' rather than deleting: an empty value stays falsy
          // through loadEnv after restart, matching the Pinokio launcher's own
          // blank-field semantics.
          for (const [name, value] of Object.entries(verdict.updates)) {
            process.env[name] = value === null ? '' : value;
          }
          respond(res, 200, {
            ok: true,
            saved: Object.keys(verdict.updates),
            status: providerStatus(),
            restarting: true,
          });
          // One deliberate restart, after the response has flushed. Vite's own
          // .env watcher may fire too; a second queued restart is harmless.
          setTimeout(() => {
            server.restart().catch((error) => {
              console.warn('[KeySetup] Dev-server restart failed:', error?.message || error);
            });
          }, 250);
        }).catch((error) => {
          // The client went away mid-body, or the save failed unexpectedly.
          console.warn('[KeySetup] Request failed:', error?.message || error);
          if (!res.headersSent) respond(res, 500, { error: 'Provider Settings request failed' });
        });
      });
    },
  };
}

/**
 * Vite plugin: refuse cross-site requests before any `/api` route runs.
 *
 * `enforce: 'pre'` runs this plugin's server hooks before every other
 * plugin's, so its middleware precedes all the proxy routes; Vite's own CORS
 * and host checks still run first. `vite preview` gets the same guard, since
 * it serves several of the same routes. See server/lib/requestGuard.mjs.
 *
 * @returns {import('vite').Plugin}
 */
export function apiRequestGuard() {
  const install = (server) => {
    server.middlewares.use('/api', createApiRequestGuard());
  };
  return {
    name: 'gev-api-request-guard',
    enforce: 'pre',
    configureServer: install,
    configurePreviewServer: install,
  };
}

/**
 * Main Vite configuration factory.
 *
 * Loads .env files via Vite's loadEnv, registers Cesium + local proxy
 * plugins, configures the dev server host/port, and exposes selected
 * API keys to the client as import.meta.env defines.
 */
export default defineConfig(({ mode }) => {
  // Load only this checkout's dotenv files. Shell/Keychain values still win,
  // and no sibling workspace is consulted implicitly.
  const loaded = loadEnv(mode, __dirname, '');
  for (const [key, val] of Object.entries(loaded)) {
    if (process.env[key] === undefined) process.env[key] = val;
  }
  const env = { ...process.env };
  const allowedHosts = resolveAllowedHosts({ extra: env.GEV_ALLOWED_HOSTS });
  return {
    plugins: [
      apiRequestGuard(),
      diskCacheJanitor(),
      cesium(),
      openSkyProxy(),
      celestrakProxy(),
      tomtomProxy(),
      firmsProxy(),
      rocketLaunchesProxy(),
      terrainHeightsProxy(),
      adsbdbProxy(),
      overpassProxy(),
      militaryInstallationsProxy(),
      regionalBriefProxy(),
      weatherEffectsProxy(),
      cctvProxy(),
      radioBrowserProxy(),
      gbfsProxy(),
      adsbLolProxy(),
      aisLiveProxy(),
      trackBackfillProxies(),
      openAiRealtimeProxy(),
      googlePlacesContextProxy(),
      keySetupEndpoint(),
    ],
    server: {
      host: env.HOST || 'localhost',
      port: parseInt(env.PORT, 10) || 4173,
      // This machine's names plus GEV_ALLOWED_HOSTS, in every mode. LAN mode
      // too: Vite accepts IP addresses anyway, and the Host check is what
      // stops DNS rebinding from reaching the API routes.
      allowedHosts,
      // No CORS. Vite's default lets any localhost origin read what this
      // server returns: API results, the Realtime token, served files. The
      // app itself only ever calls its own origin.
      cors: false,
      fs: {
        // Pinokio keeps optional credentials in this ignored local file. The
        // app's own logs and caches, and local Claude settings, stay private.
        deny: [
          '.env',
          '.env.*',
          '*.{crt,pem}',
          '**/.git/**',
          '**/ENVIRONMENT',
          '**/.gev-logs/**',
          '**/.gev-cache/**',
          '**/.claude/**',
        ],
      },
      // Framing protection belongs on the APP DOCUMENT, not on API responses:
      // a browser evaluates frame-ancestors against the framed page's own
      // navigation response. Without this, a hostile page could frame
      // `/?setup=1`, align a lure over Provider Settings, and have the framed
      // app issue a perfectly same-origin credential write that passes every
      // Host/Origin check. These headers apply to everything this dev server
      // serves, which is what makes that attack impossible rather than unlikely.
      headers: {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'",
      },
    },
    preview: {
      // Preview would inherit server.cors; set it explicitly all the same.
      cors: false,
    },
    // Expose selected API keys to the browser via import.meta.env.*
    define: {
      'import.meta.env.GOOGLE_MAPS_API_KEY': JSON.stringify(env.GOOGLE_MAPS_API_KEY),
      'import.meta.env.CESIUM_ION_TOKEN': JSON.stringify(env.CESIUM_ION_TOKEN),
      // Whether the browser posts voice debug records (see openAiRealtimeProxy).
      'import.meta.env.GEV_REALTIME_DEBUG_LOG': JSON.stringify(isDebugLogEnabled(env.GEV_REALTIME_DEBUG_LOG)),
    },
    build: {
      // The Cesium engine bundle is inherently large; raise the warning ceiling
      // so the build log isn't dominated by an expected chunk-size notice.
      chunkSizeWarningLimit: 1500,
    },
    // satellite.js ships an optional WASM propagator whose worker uses
    // top-level await, which only module workers support.
    worker: {
      format: 'es',
    },
  };
});
