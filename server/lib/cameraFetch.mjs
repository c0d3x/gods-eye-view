/**
 * Fetches server-registered camera URLs without letting a camera host steer
 * the request somewhere else. Redirects are followed by hand, and every hop
 * that isn't the operator's own configured origin must resolve to public
 * addresses, with the connection pinned to them. Also decides which media
 * types the CCTV proxy relays.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { raceAbort } from './fetchWithTimeout.mjs';
import { requestPinned, resolvePublicAddresses } from './publicAddress.mjs';

/** Redirects followed before giving up. */
export const CAMERA_MAX_REDIRECTS = 3;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const PLAYLIST_TYPES = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
]);

/** A camera redirect that isn't followed: too many, or no usable target. */
export class CameraRedirectError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'CameraRedirectError';
  }
}

/**
 * What a camera response's Content-Type carries: 'image' for raster images,
 * 'video' for video and HLS playlists, or null for anything the proxy must
 * not relay, such as HTML, SVG or an unknown type.
 * @param {string | null} contentType
 * @returns {'image' | 'video' | null}
 */
export function mediaTypeKind(contentType) {
  const essence = String(contentType ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (essence.startsWith('image/')) {
    // SVG is an image type that can carry script.
    return essence.startsWith('image/svg') ? null : 'image';
  }
  if (essence.startsWith('video/') || PLAYLIST_TYPES.has(essence)) {
    return 'video';
  }
  return null;
}

/**
 * Fetch a camera URL, following up to `maxRedirects` redirects by hand.
 *
 * A camera from the local config (CCTV_SOURCES_FILE or CCTV_SOURCES_JSON) may
 * sit on a private network, so its own origin is fetched as configured. Any
 * other hop, and every hop of a camera from a live feed, must resolve only to
 * public addresses, and the connection is pinned to them. Throws
 * PrivateAddressError or CameraRedirectError when a hop is refused.
 *
 * @param {string | URL} url The registered camera URL.
 * @param {object} [options]
 * @param {Record<string, string>} [options.headers]
 * @param {AbortSignal} [options.signal]
 * @param {boolean} [options.localConfig] The URL came from the local config.
 * @param {typeof dnsLookup} [options.lookup]
 * @param {typeof fetch | null} [options.fetchImpl] Makes each request in
 *   place of the pinned request (and of fetch() for the configured origin).
 *   The address checks still run. For tests.
 * @param {number} [options.maxRedirects]
 * @returns {Promise<Response>}
 */
export async function fetchCameraResponse(
  url,
  {
    headers = {},
    signal,
    localConfig = false,
    lookup = dnsLookup,
    fetchImpl = null,
    maxRedirects = CAMERA_MAX_REDIRECTS,
  } = {},
) {
  const registered = new URL(url);
  let target = registered;
  for (let hop = 0; ; hop += 1) {
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new CameraRedirectError('Camera URL is not http or https');
    }
    if (target.username || target.password) {
      throw new CameraRedirectError('Camera URL carries credentials');
    }
    const init = { method: 'GET', headers, signal, redirect: 'manual' };
    let response;
    if (localConfig && target.origin === registered.origin) {
      response = await (fetchImpl ?? fetch)(target, init);
    } else {
      const addresses = await raceAbort(
        resolvePublicAddresses(target.hostname, lookup),
        signal,
      );
      response = fetchImpl
        ? await fetchImpl(target, init)
        : await requestPinned(target, init, addresses);
    }
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    try {
      await response.body?.cancel();
    } catch {
      // Already closed.
    }
    const location = response.headers.get('location');
    if (!location) {
      throw new CameraRedirectError('Camera redirect has no Location');
    }
    if (hop >= maxRedirects) {
      throw new CameraRedirectError('Camera redirected too many times');
    }
    try {
      target = new URL(location, target);
    } catch {
      throw new CameraRedirectError('Camera redirect has an invalid Location');
    }
  }
}
