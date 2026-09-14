/**
 * Vite configuration for God's Eye View — a cinematic geospatial app.
 *
 * This file holds configuration and plugin wiring only. The dev-server
 * routes that bypass CORS and add caching/auth for upstream APIs are plugins
 * under server/. The proxies live in server/proxies/:
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
 * routes and its tool schema live in server/realtime/, and the Provider
 * Settings routes in server/keySetupEndpoint.mjs.
 *
 * Also exposes Cesium and Google 3D Tiles API keys to the
 * client via `import.meta.env.*` defines.
 *
 * @module vite.config
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import cesium from './scripts/cesium-vite-plugin.mjs';
import { aisLiveProxy } from './server/ais/relay.mjs';
import { keySetupEndpoint } from './server/keySetupEndpoint.mjs';
import { resolveAllowedHosts } from './server/lib/allowedHosts.mjs';
import { isDebugLogEnabled } from './server/lib/debugLog.mjs';
import { diskCacheJanitor } from './server/lib/diskCacheLimits.mjs';
import { apiRequestGuard } from './server/lib/requestGuard.mjs';
import { adsbdbProxy } from './server/proxies/adsbdb.mjs';
import { adsbLolProxy } from './server/proxies/adsbLol.mjs';
import { cctvProxy } from './server/proxies/cctv.mjs';
import { celestrakProxy } from './server/proxies/celestrak.mjs';
import { firmsProxy } from './server/proxies/firms.mjs';
import { gbfsProxy } from './server/proxies/gbfs.mjs';
import { googlePlacesContextProxy } from './server/proxies/googlePlaces.mjs';
import { militaryInstallationsProxy } from './server/proxies/militaryInstallations.mjs';
import { openSkyProxy } from './server/proxies/opensky.mjs';
import { overpassProxy } from './server/proxies/overpass.mjs';
import { radioBrowserProxy } from './server/proxies/radio.mjs';
import {
  regionalBriefProxy,
  weatherEffectsProxy,
} from './server/proxies/regional.mjs';
import { rocketLaunchesProxy } from './server/proxies/rocketLaunches.mjs';
import { terrainHeightsProxy } from './server/proxies/terrainHeights.mjs';
import { tomtomProxy } from './server/proxies/tomtom.mjs';
import { trackBackfillProxies } from './server/proxies/trackBackfill.mjs';
import { openAiRealtimeProxy } from './server/realtime/openai.mjs';

/** Resolve __dirname for ESM context. */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
      port: parseInt(env.PORT ?? '', 10) || 4173,
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
      'import.meta.env.GOOGLE_MAPS_API_KEY': JSON.stringify(
        env.GOOGLE_MAPS_API_KEY,
      ),
      'import.meta.env.CESIUM_ION_TOKEN': JSON.stringify(env.CESIUM_ION_TOKEN),
      // Whether the browser posts voice debug records (see openAiRealtimeProxy).
      'import.meta.env.GEV_REALTIME_DEBUG_LOG': JSON.stringify(
        isDebugLogEnabled(env.GEV_REALTIME_DEBUG_LOG),
      ),
    },
    build: {
      rolldownOptions: {
        output: {
          // Until the layers load on first use (#42), the app loads all of
          // their code at startup. Splitting it by feature keeps every chunk
          // under Vite's 500 kB default and leaves the others cached when one
          // layer changes. A group also takes the modules it imports, so
          // shared code goes to whichever group claims it first: the overlay
          // host, then each layer family, then the rest of src/data and the
          // panels.
          codeSplitting: {
            groups: [
              {
                name: 'overlays',
                test: /[\\/]src[\\/]overlays[\\/]/,
                priority: 3,
              },
              { name: 'cctv', test: /[\\/]src[\\/]data[\\/]cctv/, priority: 2 },
              {
                name: 'radio',
                test: /[\\/]src[\\/]data[\\/]radio/,
                priority: 2,
              },
              {
                name: 'space',
                test: /[\\/]src[\\/]data[\\/](satellite|rocketLaunch|issPass)/,
                priority: 2,
              },
              {
                name: 'aircraft',
                test: /[\\/]src[\\/]data[\\/](aircraft|flights|militaryFlights)/,
                priority: 2,
              },
              {
                name: 'traffic',
                test: /[\\/]src[\\/]data[\\/](traffic|flow)/,
                priority: 2,
              },
              {
                name: 'bikeshare',
                test: /[\\/]src[\\/]data[\\/]bikeshare/,
                priority: 2,
              },
              {
                name: 'vessels',
                test: /[\\/]src[\\/]data[\\/](aisLive|vessel)/,
                priority: 2,
              },
              {
                name: 'military',
                test: /[\\/]src[\\/]data[\\/]military/,
                priority: 2,
              },
              { name: 'data', test: /[\\/]src[\\/]data[\\/]/, priority: 1 },
              { name: 'ui', test: /[\\/]src[\\/]ui[\\/]/, priority: 0 },
            ],
          },
        },
      },
    },
    // satellite.js ships an optional WASM propagator whose worker uses
    // top-level await, which only module workers support.
    worker: {
      format: 'es',
    },
  };
});
