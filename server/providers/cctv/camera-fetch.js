/**
 * Fetches server-registered camera URLs without letting a camera host steer
 * the request somewhere else, and decides which media types the CCTV proxy
 * relays.
 *
 * A camera from the operator's own config (CCTV_SOURCES_FILE or
 * CCTV_SOURCES_JSON) may sit on a private network, so its own origin is
 * fetched as configured. Any other host, which is every host of a camera from
 * an open-data feed and every redirect target off the configured origin, must
 * resolve only to public addresses, and the connection is pinned to them.
 * Redirects are followed by hand, a hop at a time.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import {
  fetchPublicResponse,
  requestPinned,
} from '../common/public-address.js';

/** Redirects a media request follows before giving up. */
const CAMERA_MAX_REDIRECTS = 3;

/**
 * The request options a camera fetch passes on each hop.
 * @typedef {{method?: string, headers?: Record<string, string>, signal?: AbortSignal, redirect?: 'manual' | 'follow' | 'error'}} CameraRequestInit
 */

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const PLAYLIST_TYPES = new Set([
  'application/vnd.apple.mpegurl',
  'application/mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
]);

/**
 * Sent with every CCTV frame and media response. nosniff stops a browser
 * from reading a relayed body as another type, and the CSP turns scripts off
 * if one is ever opened as a page.
 */
export const CCTV_RELAY_SAFETY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
});

/** A camera redirect that isn't followed: too many, or no usable target. */
export class CameraRedirectError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'CameraRedirectError';
  }
}

/**
 * Types that file servers and object stores give video files they cannot
 * name. Browsers sniff a video element's bytes whatever the type, and the
 * relay's nosniff and sandbox headers keep such a body from rendering as a
 * page, so a video feed may send them.
 */
const UNTYPED_VIDEO_TYPES = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
  'application/mp4',
]);

/**
 * What a camera response's Content-Type carries: 'image' for raster images,
 * 'video' for video and HLS playlists, or null for anything the proxy must
 * not relay, such as HTML, SVG or an unknown type. For a video feed
 * (`videoFeed`), a missing or generic binary type counts as video.
 * @param {string | null | undefined} contentType
 * @param {{videoFeed?: boolean}} [options]
 * @returns {'image' | 'video' | null}
 */
export function mediaTypeKind(contentType, { videoFeed = false } = {}) {
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
  if (videoFeed && UNTYPED_VIDEO_TYPES.has(essence)) return 'video';
  return null;
}

/**
 * The transport for one camera request: never follows a redirect. A request
 * to `localOrigin`, the origin of a camera from the operator's own config, is
 * a plain fetch(); any other must resolve only to public addresses and is
 * pinned to them (PrivateAddressError otherwise).
 * @param {object} [options]
 * @param {string | null} [options.localOrigin]
 * @param {typeof dnsLookup} [options.lookup]
 * @param {typeof requestPinned} [options.request] Makes the pinned request;
 *   for tests.
 * @returns {(url: string | URL, init?: CameraRequestInit) => Promise<Response>}
 */
export function cameraTransport({
  localOrigin = null,
  lookup = dnsLookup,
  request = requestPinned,
} = {}) {
  return (url, init = {}) => {
    const target = new URL(url);
    const hop = { ...init, redirect: /** @type {const} */ ('manual') };
    if (localOrigin && target.origin === localOrigin) return fetch(target, hop);
    return fetchPublicResponse(target, hop, { lookup, request });
  };
}

/**
 * The HLS puller's transport (./stream.js): cameraTransport for every
 * playlist and segment request. Origins in `localOrigins`, those of HLS
 * cameras from the operator's own config, are fetched directly; any other
 * host must resolve only to public addresses.
 * @param {ReadonlySet<string>} localOrigins
 * @param {{lookup?: typeof dnsLookup, request?: typeof requestPinned}} [options]
 * @returns {(url: string | URL, init?: CameraRequestInit) => Promise<Response>}
 */
export function hlsCameraTransport(localOrigins, options = {}) {
  return (url, init) => {
    const { origin } = new URL(url);
    const localOrigin = localOrigins.has(origin) ? origin : null;
    return cameraTransport({ ...options, localOrigin })(url, init);
  };
}

/**
 * Fetch a camera URL, following up to `maxRedirects` redirects by hand. Each
 * hop must be http or https without credentials, and goes through
 * `fetchImpl`, which makes the request without following redirects
 * (cameraTransport by default).
 *
 * @param {string | URL} url The registered camera URL.
 * @param {object} [options]
 * @param {Record<string, string>} [options.headers]
 * @param {AbortSignal} [options.signal]
 * @param {(url: string, init: CameraRequestInit) => Promise<Response>} [options.fetchImpl]
 * @param {number} [options.maxRedirects]
 * @returns {Promise<Response>}
 */
export async function fetchCameraResponse(
  url,
  {
    headers = {},
    signal,
    fetchImpl = cameraTransport(),
    maxRedirects = CAMERA_MAX_REDIRECTS,
  } = {},
) {
  let target = new URL(url);
  for (let hop = 0; ; hop += 1) {
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new CameraRedirectError('Camera URL is not http or https');
    }
    if (target.username || target.password) {
      throw new CameraRedirectError('Camera URL carries credentials');
    }
    const response = await fetchImpl(target.href, {
      method: 'GET',
      headers,
      signal,
      redirect: 'manual',
    });
    if (!REDIRECT_STATUSES.has(Number(response?.status))) return response;
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
