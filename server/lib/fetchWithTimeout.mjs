/**
 * Upstream request helpers for the dev server's proxies: a fetch with a
 * deadline that also stops when the client goes away, client-facing error
 * messages that never carry upstream or exception text, and a log line that
 * keeps those details for the server.
 */

/** An upstream call that passed its deadline. */
export class UpstreamTimeoutError extends Error {
  /** @param {number} timeoutMs */
  constructor(timeoutMs) {
    super(`Upstream did not answer within ${timeoutMs} ms`);
    this.name = 'UpstreamTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** The client that asked for an upstream call disconnected first. */
export class ClientGoneError extends Error {
  constructor() {
    super('Client disconnected');
    this.name = 'ClientGoneError';
  }
}

function clientGoneSignal(response) {
  const controller = new AbortController();
  response.once('close', () => {
    if (!response.writableEnded) controller.abort(new ClientGoneError());
  });
  return controller.signal;
}

/**
 * fetch() options with the headers as a plain object, the way the proxies
 * build them.
 * @typedef {RequestInit & {headers?: Record<string, string>}} UpstreamInit
 */

/**
 * fetch() with a deadline. Given the client's `response`, it is also aborted
 * when that client disconnects first. The deadline covers the whole exchange,
 * body included, unless `headersOnly` stops the clock once the headers
 * arrive, for streamed media.
 *
 * @param {string | URL} url
 * @param {UpstreamInit} init
 * @param {object} options
 * @param {number} options.timeoutMs
 * @param {import('node:http').ServerResponse} [options.response]
 * @param {boolean} [options.headersOnly]
 * @param {(url: string | URL, init: UpstreamInit) => Promise<Response>} [options.fetchImpl]
 *   Makes the request; fetch() by default. It gets the combined signal, and
 *   is abandoned once that aborts.
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(
  url,
  init = {},
  { timeoutMs, response, headersOnly = false, fetchImpl = fetch },
) {
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new UpstreamTimeoutError(timeoutMs)),
    timeoutMs,
  );
  timer.unref?.();
  const signals = [deadline.signal];
  if (init.signal) signals.push(init.signal);
  if (typeof response?.once === 'function') {
    signals.push(clientGoneSignal(response));
  }
  const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  try {
    const upstream = await raceAbort(
      fetchImpl(url, { ...init, signal }),
      signal,
    );
    if (headersOnly) clearTimeout(timer);
    return upstream;
  } catch (error) {
    clearTimeout(timer);
    // fetch rejects with the abort reason; rethrow it as-is so callers can
    // tell a timeout from a disconnect or a network failure.
    if (signal.aborted && signal.reason instanceof Error) throw signal.reason;
    throw error;
  }
}

/**
 * Settle as `promise` does, or reject with the signal's reason as soon as it
 * aborts. For work that takes no signal itself, such as a DNS lookup.
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal} [signal]
 * @returns {Promise<T>}
 */
export function raceAbort(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * The status to answer with when an upstream call failed: 504 for a
 * timeout, 502 for anything else.
 * @param {unknown} error
 */
export function upstreamErrorStatus(error) {
  return error instanceof UpstreamTimeoutError ? 504 : 502;
}

/**
 * A client-facing message for a failed upstream call, in our own words:
 * never the provider's error text or an exception message.
 * @param {string} provider For example 'OpenAI'.
 * @param {number | unknown} outcome The upstream HTTP status, or the error.
 */
export function upstreamErrorMessage(provider, outcome) {
  if (outcome instanceof UpstreamTimeoutError) {
    return `${provider} did not answer in time`;
  }
  const status = typeof outcome === 'number' ? outcome : Number.NaN;
  if (status === 400) return `${provider} rejected the request`;
  if (status === 401) return `${provider} rejected the API key`;
  if (status === 403) {
    return `${provider} refused the request; check the API key and its permissions`;
  }
  if (status === 404) return `${provider} could not find what was requested`;
  if (status === 429) return `${provider} rate limit or quota reached`;
  if (status >= 500) return `${provider} is unavailable`;
  return `${provider} request failed`;
}

/**
 * One line for the server log about a failed upstream response: its status
 * and, when the body carries one, the provider's own error message.
 * @param {number} status
 * @param {string} [bodyText]
 */
export function describeUpstreamFailure(status, bodyText = '') {
  let detail = '';
  try {
    const parsed = JSON.parse(bodyText);
    detail =
      [parsed?.error, parsed?.error?.message, parsed?.message].find(
        (value) => typeof value === 'string',
      ) || '';
  } catch {
    // Not JSON: the status has to do.
  }
  const line = detail
    .replace(/[^\x20-\x7e]+/g, ' ')
    .trim()
    .slice(0, 300);
  return line ? `HTTP ${status}: ${line}` : `HTTP ${status}`;
}
