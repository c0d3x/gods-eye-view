import { createBoundedCache } from '../common/bounded-cache.js';
import { readResponseBytesCapped } from '../common/http.js';
import { makeCostRateLimiter } from '../common/rate-limit.js';
import { googleServerApiKey } from '../places/google-key.js';
import { mediaTypeKind } from './camera-fetch.js';
import {
  CCTV_FRAME_FETCH_TIMEOUT_MS,
  CCTV_FRAME_MAX_BODY_BYTES,
} from './constants.js';

/**
 * Street View requests per minute per client when GEV_RATELIMIT_GOOGLE_PER_MIN
 * is unset: the Places default (GOOGLE_DEFAULT_PER_MIN in places/google.js).
 */
export const STREET_VIEW_DEFAULT_PER_MIN = 120;

/** How long a Street View fallback frame is reused. The imagery is static,
 * while the CCTV panel re-polls each camera every 10–60 s. */
export const CCTV_STREET_VIEW_CACHE_TTL_MS = 30 * 60 * 1000;

/** Street View frames kept at once, about 10 MB of 960x540 JPEGs. */
export const CCTV_STREET_VIEW_CACHE_MAX_ENTRIES = 64;

/**
 * The CCTV frame route's Google Street View fallback. Server-side call, never
 * reaches the browser — prefers GOOGLE_MAPS_SERVER_API_KEY (#33: a key scoped
 * to Street View Static/Places, restricted by server IP rather than HTTP
 * referrer) and falls back to the browser-exposed GOOGLE_MAPS_API_KEY for
 * setups that haven't split the two yet.
 *
 * Every Street View image is billed, and the CCTV panel re-polls each camera
 * every 10–60 s, so:
 * - successful frames are cached by pose: the location rounded to 5 decimals
 *   (about a metre), heading, field of view and pitch. Google is asked for the
 *   same rounded location, and failures are not cached;
 * - only a cache miss calls Google, and each miss counts against the client's
 *   Street View budget. It reads GEV_RATELIMIT_GOOGLE_PER_MIN like Places, but
 *   is a separate budget, so busy cameras can't starve the Places lookups.
 *   Once it is spent the fallback returns `{ ok: false, rateLimited: true }`.
 *
 * @param {object} [options]
 * @param {() => string} [options.resolveApiKey]
 * @param {typeof fetch} [options.fetchImpl]
 */
export function createStreetViewFallback({
  resolveApiKey = googleServerApiKey,
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  const frames = createBoundedCache({
    maxEntries: CCTV_STREET_VIEW_CACHE_MAX_ENTRIES,
    ttlMs: CCTV_STREET_VIEW_CACHE_TTL_MS,
  });
  // Built on first use, after the standalone environment has loaded.
  // undefined = not built yet; null = the explicit 0 opt-out.
  /** @type {((key: string) => boolean) | null | undefined} */
  let limiter;
  /** @param {string} key */
  const allow = (key) => {
    if (limiter === undefined)
      limiter = makeCostRateLimiter(
        process.env.GEV_RATELIMIT_GOOGLE_PER_MIN,
        STREET_VIEW_DEFAULT_PER_MIN,
      );
    return !limiter || limiter(key);
  };

  /**
   * @param {object} pose
   * @param {number} pose.lat
   * @param {number} pose.lon
   * @param {number} pose.heading
   * @param {number} pose.fov
   * @param {number} pose.pitch
   * @param {string} pose.rateLimitKey The client's rate-limit key.
   * @returns {Promise<{ok: true, body: Buffer, contentType: string} | {ok: false, rateLimited: true} | null>}
   */
  return async function streetViewFallback({
    lat,
    lon,
    heading,
    fov,
    pitch,
    rateLimitKey,
  }) {
    const apiKey = resolveApiKey();
    if (!apiKey || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const params = {
      location: `${lat.toFixed(5)},${lon.toFixed(5)}`,
      heading: String(Number.isFinite(heading) ? heading : 0),
      fov: String(Number.isFinite(fov) ? Math.max(20, Math.min(120, fov)) : 80),
      pitch: String(
        Number.isFinite(pitch) ? Math.max(-40, Math.min(20, pitch)) : 0,
      ),
    };
    const cacheKey = `${params.location}|${params.heading}|${params.fov}|${params.pitch}`;
    const cached = frames.get(cacheKey);
    if (cached) return cached;
    if (!allow(rateLimitKey)) return { ok: false, rateLimited: true };
    try {
      const sv = new URL('https://maps.googleapis.com/maps/api/streetview');
      sv.searchParams.set('size', '960x540');
      for (const [name, value] of Object.entries(params))
        sv.searchParams.set(name, value);
      sv.searchParams.set('source', 'outdoor');
      sv.searchParams.set('return_error_code', 'true');
      sv.searchParams.set('key', apiKey);

      const svResp = await fetchImpl(sv.toString(), {
        headers: { 'User-Agent': 'gods-eye-view-cctv-proxy/1.0' },
        signal: AbortSignal.timeout(CCTV_FRAME_FETCH_TIMEOUT_MS),
      });
      const svType = svResp.headers.get('content-type') || '';
      if (!svResp.ok || mediaTypeKind(svType) !== 'image') {
        await svResp.body?.cancel().catch(() => {});
        return null;
      }
      const bytes = await readResponseBytesCapped(
        svResp,
        CCTV_FRAME_MAX_BODY_BYTES,
      );
      return frames.set(cacheKey, {
        ok: true,
        body: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        contentType: svType,
      });
    } catch {
      return null;
    }
  };
}
