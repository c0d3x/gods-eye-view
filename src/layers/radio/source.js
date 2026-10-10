import { requestWithDeadline } from '../../sources/requestDeadline.js';
import { DIRECTORY_ENDPOINT, RADIO_UUID_RE } from './policy.js';

// The click count is fire-and-forget; its deadline keeps a stalled request
// from holding a connection.
export const CLICK_TIMEOUT_MS = 10_000;

/** Supply directory metadata and click reporting; audio stays with the broadcaster. */
export function createRadioSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getDirectory({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(DIRECTORY_ENDPOINT, { signal });
      if (!response.ok)
        throw new Error(`Radio directory returned ${response.status}`);
      const body = await response.json();
      signal?.throwIfAborted();
      return body;
    },
    async recordClick(id, { signal } = {}) {
      if (typeof id !== 'string' || !RADIO_UUID_RE.test(id))
        throw new Error('Invalid radio station id');
      await requestWithDeadline(
        async (/** @type {AbortSignal} */ requestSignal) => {
          const response = await fetchImpl(
            `/api/radio/click/${encodeURIComponent(id)}`,
            {
              method: 'POST',
              signal: requestSignal,
            },
          );
          requestSignal.throwIfAborted();
          if (!response.ok)
            throw new Error(`Radio click returned ${response.status}`);
        },
        { signal, timeoutMs: CLICK_TIMEOUT_MS },
      );
    },
  };
}
