// @ts-check
/**
 * Client fetch helpers for the app's own API calls. Both check the status and
 * apply a deadline, and both reject on a non-2xx status (the error carries
 * `status`), when the deadline passes (a TimeoutError), or when the caller's
 * signal aborts.
 */

/** Default deadline for one call, body included. */
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

/**
 * fetch() with a deadline and an ok check; returns the Response.
 * @param {string | URL} url
 * @param {RequestInit & {timeoutMs?: number}} [options] fetch options, plus
 *   the deadline in milliseconds.
 * @returns {Promise<Response>}
 */
export async function fetchChecked(
  url,
  { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, signal, ...init } = {},
) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, {
    ...init,
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
  if (!response.ok) {
    throw Object.assign(new Error(`HTTP ${response.status}`), {
      status: response.status,
    });
  }
  return response;
}

/**
 * fetchChecked(), then the body parsed as JSON.
 * @param {string | URL} url
 * @param {RequestInit & {timeoutMs?: number}} [options]
 * @returns {Promise<any>}
 */
export async function fetchJson(url, options) {
  const response = await fetchChecked(url, options);
  return response.json();
}
