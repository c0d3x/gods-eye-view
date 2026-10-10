import { requestWithDeadline } from '../../sources/requestDeadline.js';

// Above the server's own 20 s upstream deadline
// (server/providers/space/launch-library.js), so a slow Launch Library still
// gets the stale copy the server falls back to.
export const LAUNCHES_TIMEOUT_MS = 30_000;
// The whole active catalog: a couple of MB of TLE text.
export const ACTIVE_TLE_TIMEOUT_MS = 30_000;

/** Read launch records and their optional active-orbit catalog with explicit cancellation. */
export function createLaunchSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  /** The launch payload, and whether the proxy served it from a stale cache. */
  function getLaunchSnapshot({ signal } = {}) {
    return requestWithDeadline(
      async (/** @type {AbortSignal} */ requestSignal) => {
        const response = await fetchImpl('/api/launches', {
          signal: requestSignal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        requestSignal.throwIfAborted();
        if (!Array.isArray(payload) && !Array.isArray(payload?.results))
          throw new Error('Malformed launch snapshot');
        return {
          payload,
          stale: response.headers?.get?.('x-gev-cache') === 'STALE-ERROR',
        };
      },
      { signal, timeoutMs: LAUNCHES_TIMEOUT_MS },
    );
  }
  return {
    getLaunchSnapshot,
    async getLaunches(options) {
      return (await getLaunchSnapshot(options)).payload;
    },
    getActiveTle({ signal } = {}) {
      return requestWithDeadline(
        async (/** @type {AbortSignal} */ requestSignal) => {
          const response = await fetchImpl('/api/celestrak/active', {
            signal: requestSignal,
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const text = await response.text();
          requestSignal.throwIfAborted();
          return text;
        },
        { signal, timeoutMs: ACTIVE_TLE_TIMEOUT_MS },
      );
    },
  };
}
