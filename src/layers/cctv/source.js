import {
  ACTIVE_FRAME_REFRESH_MS,
  FRAME_ENDPOINT,
  MEDIA_ENDPOINT,
} from './sourcePolicy.js';
import { requestWithDeadline } from '../../sources/requestDeadline.js';

// The server may still be building the catalog from three live feeds.
export const CATALOG_TIMEOUT_MS = 30_000;
export const HEALTH_TIMEOUT_MS = 10_000;
function safeNumber(value, fallback = NaN) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function frameUrlFor(camera, refreshMs = ACTIVE_FRAME_REFRESH_MS) {
  const cadenceMs = Math.max(
    1000,
    safeNumber(refreshMs, ACTIVE_FRAME_REFRESH_MS),
  );
  const tick = Math.floor(Date.now() / cadenceMs);
  const params = new URLSearchParams({
    label: camera.name,
    city: camera.city,
    lat: camera.lat.toFixed(6),
    lon: camera.lon.toFixed(6),
    heading: String(Math.round(camera.headingDeg)),
    fov: String(Math.round(camera.fovDeg)),
    pitch: String(Math.round(camera.pitchDeg || -10)),
    ts: String(tick),
  });
  return `${FRAME_ENDPOINT}/${encodeURIComponent(camera.id)}?${params.toString()}`;
}
function mediaUrlFor(camera) {
  return `${MEDIA_ENDPOINT}/${encodeURIComponent(camera.id)}?ts=${Math.floor(Date.now() / 15000)}`;
}
/** Supply catalog/health records and the existing registered camera URL families. */
export function createCctvSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  // A deadline bounds the request and its body, so a stalled server cannot
  // hold the read open; the caller's signal still cancels it.
  /**
   * @param {string} path
   * @param {string} key
   * @param {number} timeoutMs
   * @param {{signal?: AbortSignal}} [options]
   */
  function read(path, key, timeoutMs, { signal } = {}) {
    return requestWithDeadline(
      async (/** @type {AbortSignal} */ requestSignal) => {
        const response = await fetchImpl(path, {
          cache: 'no-store',
          signal: requestSignal,
        });
        if (!response.ok)
          throw new Error('Camera source HTTP ' + response.status);
        const payload = await response.json();
        requestSignal.throwIfAborted();
        if (!Array.isArray(payload?.[key]))
          throw new Error('Malformed camera ' + key + ' snapshot');
        return payload;
      },
      { signal, timeoutMs },
    );
  }
  return {
    getCatalog(options) {
      return read('/api/cctv/sources', 'sources', CATALOG_TIMEOUT_MS, options);
    },
    getHealth(options) {
      return read('/api/cctv/health', 'cameras', HEALTH_TIMEOUT_MS, options);
    },
    getFrameUrl: frameUrlFor,
    getMediaUrl: mediaUrlFor,
    /** Read one current frame through the registered frame endpoint. */
    async getFrame(camera, { signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(frameUrlFor(camera), {
        cache: 'no-store',
        signal,
      });
      if (!response.ok) throw new Error('Camera frame HTTP ' + response.status);
      const bytes = new Uint8Array(await response.arrayBuffer());
      signal?.throwIfAborted();
      const type = response.headers.get('content-type') || '';
      return { contentType: type.split(';')[0].trim().toLowerCase(), bytes };
    },
  };
}
