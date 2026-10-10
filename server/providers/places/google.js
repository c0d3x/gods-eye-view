import {
  googleServerApiKey,
  keylessGooglePlacesResponse,
} from './google-key.js';
import { makeCostRateLimiter, clientKey } from '../common/rate-limit.js';
import { admitSameSite } from '../common/same-site.js';
import { readResponseTextCapped } from '../common/http.js';
import {
  ClientGoneError,
  describeUpstreamError,
  fetchWithTimeout,
  upstreamErrorMessage,
  upstreamErrorStatus,
} from '../common/fetch.js';
import {
  projectNearbyPlaces,
  projectTextSearchPlaces,
} from '../../../src/data/placeProviderPayloads.js';

// Construct lazily after the standalone environment has loaded.
// undefined = not built yet; null = the explicit 0 opt-out; fn = active limiter
let _googleRateLimiter;

/**
 * Requests/min/IP applied when GEV_RATELIMIT_GOOGLE_PER_MIN is unset. This is
 * the value the Pinokio build already ships (pinokio/_ENVIRONMENT), so the
 * packaged app keeps behaving exactly as it does today and only an
 * unconfigured server changes — from unlimited to what the product already
 * runs with. Places calls are user-driven (a search, a nearby lookup, an
 * installation probe) rather than polled, so this sits far above what the app
 * generates and bites only a caller enumerating the endpoint. `.env.example`
 * suggests a tighter 60 when the host is not localhost; that still applies.
 */
export const GOOGLE_DEFAULT_PER_MIN = 120;

/** Deadline for one Places search, body included. */
const GOOGLE_PLACES_TIMEOUT_MS = 10_000;

/** Largest Places answer read; a 20-place search is tens of KB. */
const GOOGLE_PLACES_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * Read a Places answer within the size cap. A failed answer is logged by its
 * status only: Google's error text stays out of the response and the log.
 * @param {Response} response
 * @param {string} label
 */
async function readPlacesAnswer(response, label) {
  const text = await readResponseTextCapped(
    response,
    GOOGLE_PLACES_MAX_RESPONSE_BYTES,
  );
  if (!response.ok)
    console.warn(`[places] ${label}: upstream HTTP ${response.status}`);
  try {
    const data = JSON.parse(text);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

/**
 * Answer a Places search that failed before Google's answer was read.
 * @param {import('node:http').ServerResponse} res
 * @param {unknown} error
 * @param {string} label
 */
function sendPlacesFailure(res, error, label) {
  if (error instanceof ClientGoneError) return;
  console.warn(`[places] ${label} failed: ${describeUpstreamError(error)}`);
  res.statusCode = upstreamErrorStatus(error);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(
    JSON.stringify({
      error: upstreamErrorMessage('Google Places', error),
      places: [],
    }),
  );
}

/** Google cost endpoints (nearby-places + text-search). Null only when set to 0. */
function googleRateLimiter() {
  if (_googleRateLimiter === undefined)
    _googleRateLimiter = makeCostRateLimiter(
      process.env.GEV_RATELIMIT_GOOGLE_PER_MIN,
      GOOGLE_DEFAULT_PER_MIN,
    );
  return _googleRateLimiter;
}

/** Validate raw lat/lon presence and WGS84 bounds before consuming request quota. */
export function validatePlacesCoordinates(searchParams) {
  const rawLat = searchParams.get('lat');
  const rawLon = searchParams.get('lon');
  if (rawLat === null || rawLon === null || !rawLat.trim() || !rawLon.trim()) {
    return { ok: false, error: 'lat and lon are required' };
  }
  const latitude = Number(rawLat);
  const longitude = Number(rawLon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { ok: false, error: 'Valid lat and lon are required' };
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return {
      ok: false,
      error: 'lat must be within [-90, 90] and lon within [-180, 180]',
    };
  }
  return { ok: true, latitude, longitude };
}

/** Nearby place labels and view-biased text search, with request-time key resolution. */
export function googlePlacesContextProxy({
  resolveApiKey = googleServerApiKey,
  fetchImpl = (...args) => fetch(...args),
  endpoints = {},
} = {}) {
  function install(middlewares) {
    middlewares.use('/api/google/nearby-places', async (req, res) => {
      // Gate first, like the OpenAI routes: a cross-site caller learns nothing
      // about this endpoint's method surface.
      if (admitSameSite(req, res)) return;
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Method not allowed', places: [] }));
        return;
      }

      // Keyless place context has no provider cost, so it resolves before the
      // paid-endpoint limiter can consume or exhaust quota (mirrors the HUD
      // summary route).
      const apiKey = resolveApiKey();
      const keyless = keylessGooglePlacesResponse(apiKey);
      if (keyless) {
        res.statusCode = keyless.statusCode;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(keyless.payload));
        return;
      }

      const requestUrl = new URL(req.url || '', 'http://localhost');
      const coordinates = validatePlacesCoordinates(requestUrl.searchParams);
      if (!coordinates.ok) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: coordinates.error, places: [] }));
        return;
      }
      const { latitude, longitude } = coordinates;

      // Per-IP throttle (GEV_RATELIMIT_GOOGLE_PER_MIN). On by default; 0 disables.
      // Inlined (not the shared helper) so the 429 body keeps this endpoint's
      // `places: []` contract that the client expects on every error response.
      const _grl = googleRateLimiter();
      if (_grl && !_grl(clientKey(req))) {
        res.statusCode = 429;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Retry-After', '5');
        res.end(JSON.stringify({ error: 'Rate limit exceeded', places: [] }));
        return;
      }

      const radiusM = Math.max(
        25,
        Math.min(5000, Number(requestUrl.searchParams.get('radiusM')) || 250),
      );

      try {
        const response = await fetchWithTimeout(
          endpoints.nearby ||
            'https://places.googleapis.com/v1/places:searchNearby',
          {
            method: 'POST',
            redirect: 'error',
            headers: {
              'Content-Type': 'application/json',
              'X-Goog-Api-Key': apiKey,
              'X-Goog-FieldMask': [
                'places.id',
                'places.displayName',
                'places.formattedAddress',
                'places.shortFormattedAddress',
                'places.location',
                'places.primaryType',
                'places.primaryTypeDisplayName',
                'places.types',
              ].join(','),
            },
            body: JSON.stringify({
              maxResultCount: 20,
              rankPreference: 'DISTANCE',
              locationRestriction: {
                circle: {
                  center: { latitude, longitude },
                  radius: radiusM,
                },
              },
            }),
          },
          { timeoutMs: GOOGLE_PLACES_TIMEOUT_MS, response: res, fetchImpl },
        );
        const data = await readPlacesAnswer(response, 'nearby search');
        const places = projectNearbyPlaces(data, latitude, longitude);

        res.statusCode = response.ok ? 200 : response.status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader(
          'Cache-Control',
          response.ok ? 'private, max-age=300' : 'no-store',
        );
        res.end(
          JSON.stringify({
            places,
            // Never Google's own error text: our words, by status.
            error: response.ok
              ? null
              : upstreamErrorMessage('Google Places', response.status),
          }),
        );
      } catch (error) {
        sendPlacesFailure(res, error, 'nearby search');
      }
    });

    // Text Search: resolve a named landmark/POI to a real coordinate, biased to
    // the view. Geocoding scatters obscure monument/POI names across the city;
    // a view-biased Text Search lands on the actual feature. Same key, field
    // mask, throttle, and `places: []` error contract as nearby-places above.
    middlewares.use('/api/google/text-search', async (req, res) => {
      // Paid like nearby-places, so gated the same way, first.
      if (admitSameSite(req, res)) return;
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Method not allowed', places: [] }));
        return;
      }

      // Keyless place context has no provider cost, so it resolves before the
      // paid-endpoint limiter can consume or exhaust quota (mirrors the HUD
      // summary route).
      const apiKey = resolveApiKey();
      const keyless = keylessGooglePlacesResponse(apiKey);
      if (keyless) {
        res.statusCode = keyless.statusCode;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(keyless.payload));
        return;
      }

      const requestUrl = new URL(req.url || '', 'http://localhost');
      const textQuery = String(requestUrl.searchParams.get('q') || '').trim();
      if (!textQuery) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({ error: 'q, lat and lon are required', places: [] }),
        );
        return;
      }
      const coordinates = validatePlacesCoordinates(requestUrl.searchParams);
      if (!coordinates.ok) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: coordinates.error, places: [] }));
        return;
      }
      const { latitude, longitude } = coordinates;

      // Per-IP throttle (GEV_RATELIMIT_GOOGLE_PER_MIN). On by default; 0 disables.
      // Inlined (like nearby-places) so the 429 body keeps the `places: []`
      // contract the client expects on every error response.
      const _grl = googleRateLimiter();
      if (_grl && !_grl(clientKey(req))) {
        res.statusCode = 429;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Retry-After', '5');
        res.end(JSON.stringify({ error: 'Rate limit exceeded', places: [] }));
        return;
      }

      const radiusM = Math.max(
        50,
        Math.min(50000, Number(requestUrl.searchParams.get('radiusM')) || 4000),
      );

      try {
        const response = await fetchWithTimeout(
          endpoints.textSearch ||
            'https://places.googleapis.com/v1/places:searchText',
          {
            method: 'POST',
            redirect: 'error',
            headers: {
              'Content-Type': 'application/json',
              'X-Goog-Api-Key': apiKey,
              'X-Goog-FieldMask': [
                'places.id',
                'places.displayName',
                'places.formattedAddress',
                'places.location',
                'places.viewport',
                'places.primaryType',
                'places.types',
              ].join(','),
            },
            body: JSON.stringify({
              textQuery,
              locationBias: {
                circle: {
                  center: { latitude, longitude },
                  radius: radiusM,
                },
              },
              maxResultCount: 5,
            }),
          },
          { timeoutMs: GOOGLE_PLACES_TIMEOUT_MS, response: res, fetchImpl },
        );
        const data = await readPlacesAnswer(response, 'text search');
        const places = projectTextSearchPlaces(data, latitude, longitude);

        res.statusCode = response.ok ? 200 : response.status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader(
          'Cache-Control',
          response.ok ? 'private, max-age=300' : 'no-store',
        );
        res.end(
          JSON.stringify({
            places,
            // Never Google's own error text: our words, by status.
            error: response.ok
              ? null
              : upstreamErrorMessage('Google Places', response.status),
          }),
        );
      } catch (error) {
        sendPlacesFailure(res, error, 'text search');
      }
    });
  }

  return {
    name: 'google-places-context-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
