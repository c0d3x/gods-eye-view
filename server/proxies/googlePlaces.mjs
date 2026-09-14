/**
 * Google Places context for the voice agent: /api/google/nearby-places and
 * /api/google/text-search name the places around the view. Without a key they
 * answer an empty, unconfigured result rather than an error.
 */

import {
  ClientGoneError,
  describeUpstreamFailure,
  fetchWithTimeout,
  upstreamErrorMessage,
  upstreamErrorStatus,
} from '../lib/fetchWithTimeout.mjs';
import { googleServerApiKey } from '../lib/googleServerKey.mjs';
import {
  createCostRateLimiter,
  DEFAULT_GOOGLE_REQUESTS_PER_MINUTE,
  rateLimitKey,
} from '../lib/rateLimit.mjs';
import { errorMessage } from '../lib/thrownErrors.mjs';
import {
  PROVIDER_JSON_MAX_BYTES,
  parseJsonObject,
  readResponseTextCapped,
} from '../lib/upstreamBody.mjs';

// The cost limiter (server/lib/rateLimit.mjs) for the Places routes, from
// GEV_RATELIMIT_GOOGLE_PER_MIN. Built on first request, not at module load:
// the config hook loads `.env` into process.env after this module is imported.
// The limiter is then cached, so its per-client window state persists.
/** @type {ReturnType<typeof createCostRateLimiter> | undefined} */
let _googleRateLimiter; // undefined = not built yet; null = disabled; fn = active limiter

/** Google Places endpoints (nearby-places + text-search), one shared budget. */
function googleRateLimiter() {
  if (_googleRateLimiter === undefined) {
    _googleRateLimiter = createCostRateLimiter(
      'GEV_RATELIMIT_GOOGLE_PER_MIN',
      DEFAULT_GOOGLE_REQUESTS_PER_MINUTE,
    );
  }
  return _googleRateLimiter;
}

/** Deadline for the Places calls made through fetchWithTimeout. */
export const GOOGLE_PLACES_TIMEOUT_MS = 10_000;

/**
 * Optional Google place context is an empty capability when no key is present,
 * not a server outage. Returning 200 keeps a deliberately keyless session out
 * of the browser error console while preserving an explicit configured flag.
 *
 * @param {unknown} apiKey
 */
export function keylessGooglePlacesResponse(apiKey) {
  if (String(apiKey ?? '').trim()) return null;
  return {
    statusCode: 200,
    payload: { configured: false, error: null, places: [] },
  };
}

/**
 * Vite plugin: nearby Google place labels for Realtime scene context.
 *
 * The Photorealistic 3D Tiles mesh does not expose rendered map labels as
 * Cesium feature metadata. Nearby Search supplies the names around the actual
 * screen-space target without exposing the Google API key in the request.
 *
 * @returns {import('vite').Plugin}
 */
export function googlePlacesContextProxy() {
  /** @param {import('vite').Connect.Server} middlewares */
  function install(middlewares) {
    middlewares.use('/api/google/nearby-places', async (req, res) => {
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Method not allowed', places: [] }));
        return;
      }

      // Keyless place context has no provider cost, so it resolves before the
      // paid-endpoint limiter can consume or exhaust quota (mirrors the HUD
      // summary route).
      const apiKey = googleServerApiKey();
      const keyless = keylessGooglePlacesResponse(apiKey);
      if (keyless) {
        res.statusCode = keyless.statusCode;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(keyless.payload));
        return;
      }

      // Per-IP throttle (GEV_RATELIMIT_GOOGLE_PER_MIN, on by default).
      // Inlined (not the shared helper) so the 429 body keeps this endpoint's
      // `places: []` contract that the client expects on every error response.
      const _grl = googleRateLimiter();
      if (_grl && !_grl(rateLimitKey(req))) {
        res.statusCode = 429;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Retry-After', '5');
        res.end(JSON.stringify({ error: 'Rate limit exceeded', places: [] }));
        return;
      }

      const requestUrl = new URL(req.url || '', 'http://localhost');
      const latitude = Number(requestUrl.searchParams.get('lat'));
      const longitude = Number(requestUrl.searchParams.get('lon'));
      const radiusM = Math.max(
        25,
        Math.min(5000, Number(requestUrl.searchParams.get('radiusM')) || 250),
      );
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            error: 'Valid lat and lon are required',
            places: [],
          }),
        );
        return;
      }

      try {
        const response = await fetchWithTimeout(
          'https://places.googleapis.com/v1/places:searchNearby',
          {
            method: 'POST',
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
          { timeoutMs: GOOGLE_PLACES_TIMEOUT_MS, response: res },
        );
        const text = await readResponseTextCapped(
          response,
          PROVIDER_JSON_MAX_BYTES,
        );
        if (!response.ok) {
          console.warn(
            `[Places] nearby search: ${describeUpstreamFailure(response.status, text)}`,
          );
        }
        /** @type {Record<string, any>} Parsed Places response. */
        const data = parseJsonObject(text);
        const seenPlaces = new Set();
        const places = Array.isArray(data.places)
          ? data.places
              .map((place) => {
                const placeLatitude = place.location?.latitude ?? null;
                const placeLongitude = place.location?.longitude ?? null;
                const types = Array.isArray(place.types)
                  ? place.types.slice(0, 8)
                  : [];
                return {
                  id: place.id || null,
                  name: place.displayName?.text || null,
                  address:
                    place.shortFormattedAddress ||
                    place.formattedAddress ||
                    null,
                  latitude: placeLatitude,
                  longitude: placeLongitude,
                  distanceM: approximateDistanceM(
                    latitude,
                    longitude,
                    placeLatitude,
                    placeLongitude,
                  ),
                  primaryType:
                    place.primaryTypeDisplayName?.text ||
                    place.primaryType ||
                    null,
                  types,
                  contextPriority: placeContextPriority(types),
                };
              })
              .filter((place) => {
                const key =
                  `${place.name}:${place.address || ''}`.toLowerCase();
                if (!place.name || seenPlaces.has(key)) return false;
                seenPlaces.add(key);
                return true;
              })
              .sort(
                (a, b) =>
                  b.contextPriority - a.contextPriority ||
                  a.distanceM - b.distanceM,
              )
              .map(({ contextPriority, ...place }) => place)
              .slice(0, 20)
          : [];

        res.statusCode = response.ok ? 200 : response.status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader(
          'Cache-Control',
          response.ok ? 'private, max-age=300' : 'no-store',
        );
        res.end(
          JSON.stringify({
            places,
            error: response.ok
              ? null
              : upstreamErrorMessage('Google Places', response.status),
          }),
        );
      } catch (error) {
        if (error instanceof ClientGoneError) return;
        console.warn('[Places] request failed:', errorMessage(error) || error);
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
    });

    // Text Search: resolve a named landmark/POI to a real coordinate, biased to
    // the view. Geocoding scatters obscure monument/POI names across the city;
    // a view-biased Text Search lands on the actual feature. Same key, field
    // mask, throttle, and `places: []` error contract as nearby-places above.
    middlewares.use('/api/google/text-search', async (req, res) => {
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Method not allowed', places: [] }));
        return;
      }

      // Keyless place context has no provider cost, so it resolves before the
      // paid-endpoint limiter can consume or exhaust quota (mirrors the HUD
      // summary route).
      const apiKey = googleServerApiKey();
      const keyless = keylessGooglePlacesResponse(apiKey);
      if (keyless) {
        res.statusCode = keyless.statusCode;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(keyless.payload));
        return;
      }

      // Per-IP throttle (GEV_RATELIMIT_GOOGLE_PER_MIN, on by default).
      // Inlined (like nearby-places) so the 429 body keeps the `places: []`
      // contract the client expects on every error response.
      const _grl = googleRateLimiter();
      if (_grl && !_grl(rateLimitKey(req))) {
        res.statusCode = 429;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Retry-After', '5');
        res.end(JSON.stringify({ error: 'Rate limit exceeded', places: [] }));
        return;
      }

      const requestUrl = new URL(req.url || '', 'http://localhost');
      const textQuery = String(requestUrl.searchParams.get('q') || '').trim();
      const latitude = Number(requestUrl.searchParams.get('lat'));
      const longitude = Number(requestUrl.searchParams.get('lon'));
      const radiusM = Math.max(
        50,
        Math.min(50000, Number(requestUrl.searchParams.get('radiusM')) || 4000),
      );
      if (
        !textQuery ||
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude)
      ) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({ error: 'q, lat and lon are required', places: [] }),
        );
        return;
      }

      try {
        const response = await fetchWithTimeout(
          'https://places.googleapis.com/v1/places:searchText',
          {
            method: 'POST',
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
          { timeoutMs: GOOGLE_PLACES_TIMEOUT_MS, response: res },
        );
        const text = await readResponseTextCapped(
          response,
          PROVIDER_JSON_MAX_BYTES,
        );
        if (!response.ok) {
          console.warn(
            `[Places] text search: ${describeUpstreamFailure(response.status, text)}`,
          );
        }
        /** @type {Record<string, any>} Parsed Places response. */
        const data = parseJsonObject(text);
        const places = Array.isArray(data.places)
          ? data.places
              .map((place) => {
                const placeLatitude = place.location?.latitude ?? null;
                const placeLongitude = place.location?.longitude ?? null;
                const types = Array.isArray(place.types)
                  ? place.types.slice(0, 8)
                  : [];
                // Places returns a lat/lng bounding box (low/high corners) framing the
                // place — no polygon, but enough to SIZE a fallback grounds disc to the
                // real feature instead of a blind constant. Normalize to plain numbers.
                const vp = place.viewport;
                const viewport =
                  Number.isFinite(vp?.low?.latitude) &&
                  Number.isFinite(vp?.low?.longitude) &&
                  Number.isFinite(vp?.high?.latitude) &&
                  Number.isFinite(vp?.high?.longitude)
                    ? {
                        low: {
                          latitude: vp.low.latitude,
                          longitude: vp.low.longitude,
                        },
                        high: {
                          latitude: vp.high.latitude,
                          longitude: vp.high.longitude,
                        },
                      }
                    : null;
                return {
                  id: place.id || null,
                  name: place.displayName?.text || null,
                  address: place.formattedAddress || null,
                  latitude: placeLatitude,
                  longitude: placeLongitude,
                  distanceM: approximateDistanceM(
                    latitude,
                    longitude,
                    placeLatitude,
                    placeLongitude,
                  ),
                  primaryType: place.primaryType || null,
                  types,
                  viewport,
                };
              })
              .filter((place) => place.name)
          : [];

        res.statusCode = response.ok ? 200 : response.status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader(
          'Cache-Control',
          response.ok ? 'private, max-age=300' : 'no-store',
        );
        res.end(
          JSON.stringify({
            places,
            error: response.ok
              ? null
              : upstreamErrorMessage('Google Places', response.status),
          }),
        );
      } catch (error) {
        if (error instanceof ClientGoneError) return;
        console.warn('[Places] request failed:', errorMessage(error) || error);
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

/** @param {string[]} types */
function placeContextPriority(types) {
  const typeSet = new Set(types);
  if (typeSet.has('historical_landmark') || typeSet.has('monument')) return 100;
  if (typeSet.has('tourist_attraction') || typeSet.has('museum')) return 90;
  if (typeSet.has('premise') || typeSet.has('street_address')) return 75;
  if (typeSet.has('point_of_interest')) return 60;
  if (typeSet.has('public_bathroom')) return 10;
  return 40;
}

/**
 * @param {number} latA
 * @param {number} lonA
 * @param {number} latB From the Places response; a missing or non-finite
 *   coordinate gives Number.MAX_SAFE_INTEGER.
 * @param {number} lonB
 */
function approximateDistanceM(latA, lonA, latB, lonB) {
  if (![latA, lonA, latB, lonB].every(Number.isFinite))
    return Number.MAX_SAFE_INTEGER;
  const latitudeScale = 111320;
  const longitudeScale = latitudeScale * Math.cos((latA * Math.PI) / 180);
  return Math.round(
    Math.hypot((latB - latA) * latitudeScale, (lonB - lonA) * longitudeScale),
  );
}
