/**
 * Per-client limits for the dev-server routes that spend provider quota.
 *
 * The limits are on by default. `GEV_RATELIMIT_OPENAI_PER_MIN` and
 * `GEV_RATELIMIT_GOOGLE_PER_MIN` change them, and `0` or `off` turns one
 * off. They are process-local, in-memory guards that reset on restart — not
 * billing caps.
 */

/** Requests per minute per client IP for the OpenAI routes. */
export const DEFAULT_OPENAI_REQUESTS_PER_MINUTE = 30;

/** Requests per minute per client IP for each Google route family. */
export const DEFAULT_GOOGLE_REQUESTS_PER_MINUTE = 120;

const DISABLED_WORDS = new Set(['off', 'false', 'no', 'none', 'unlimited']);

/**
 * Resolve one `GEV_RATELIMIT_*` value.
 *
 * Unset or blank uses the default. `0`, `off`, `false`, `no`, `none` and
 * `unlimited` turn the limit off. A number of at least 1 sets it, rounded
 * down. Anything else keeps the default and is reported as invalid, so a
 * typo cannot silently remove the limit.
 *
 * @param {string|undefined|null} value
 * @param {number} fallback Default requests per minute.
 * @returns {{perMinute: number|null, status: 'default'|'configured'|'disabled'|'invalid'}}
 */
export function resolveRateLimit(value, fallback) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  if (text === '') return { perMinute: fallback, status: 'default' };
  if (DISABLED_WORDS.has(text)) return { perMinute: null, status: 'disabled' };
  const number = Number(text);
  if (number === 0) return { perMinute: null, status: 'disabled' };
  if (Number.isFinite(number) && number >= 1) {
    return { perMinute: Math.floor(number), status: 'configured' };
  }
  return { perMinute: fallback, status: 'invalid' };
}
