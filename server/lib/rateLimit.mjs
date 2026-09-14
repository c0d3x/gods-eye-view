/**
 * Rate limits for the dev server's routes: fixed-window limiters that keep a
 * runaway client off the public mirrors, and per-client limits for the routes
 * that spend provider quota.
 *
 * The quota limits are on by default. `GEV_RATELIMIT_OPENAI_PER_MIN` and
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

/** Most client keys a limiter tracks; past it, the oldest is forgotten. */
export const RATE_LIMITER_MAX_KEYS = 2000;

/**
 * A fixed-window limiter: `max` requests per key in each `windowMs`, and at
 * most `globalMax` across all keys when it is set. It is a backstop, not a
 * security boundary: a runaway client can't hammer an upstream or grow this
 * process without bound.
 *
 * @param {{windowMs: number, max: number, globalMax?: number, now?: () => number}} options
 * @returns {(key: string) => boolean} Whether a request under `key` may go ahead.
 */
export function createRateLimiter({
  windowMs,
  max,
  globalMax,
  now = Date.now,
}) {
  /** @type {Map<string, number[]>} */
  const hits = new Map(); // key -> timestamps within the window
  /** @type {number[]} */
  let globalTimes = []; // every hit within the window, for the global backstop
  return function allow(key) {
    const time = now();
    globalTimes = globalTimes.filter((t) => time - t < windowMs);
    if (globalMax && globalTimes.length >= globalMax) return false;
    const recent = (hits.get(key) || []).filter((t) => time - t < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(time);
    hits.set(key, recent);
    globalTimes.push(time);
    // A key-rotating caller must not grow the map without bound.
    if (hits.size > RATE_LIMITER_MAX_KEYS) {
      const oldest = hits.keys().next().value;
      if (oldest !== undefined) hits.delete(oldest);
    }
    if (hits.size > 256) {
      for (const [entry, times] of hits) {
        if (!times.length || time - times[times.length - 1] > windowMs) {
          hits.delete(entry);
        }
      }
    }
    return true;
  };
}

/**
 * The key a request is limited under: the socket's peer address. Never
 * X-Forwarded-For, which the client controls: a rotating value would mint
 * fresh quota and grow the limiter.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {string}
 */
export function rateLimitKey(req) {
  return String(req.socket?.remoteAddress || 'local');
}

/** GEV_RATELIMIT_* variables already reported as unreadable. */
const reportedVariables = new Set();

/**
 * A limiter for a route family that spends provider quota, from a
 * `GEV_RATELIMIT_*` variable: N requests per client in a 60 s window, with a
 * backstop of 20N across clients so one busy host can't starve the rest.
 * `0` or `off` turns it off (null). An unreadable value keeps the default and
 * warns once per variable.
 *
 * @param {string} name The GEV_RATELIMIT_* variable to read.
 * @param {number} fallback Default requests per minute per client.
 * @param {{env?: Record<string, string|undefined>, warn?: (message: string) => void}} [options]
 * @returns {((key: string) => boolean)|null}
 */
export function createCostRateLimiter(
  name,
  fallback,
  { env = process.env, warn = console.warn } = {},
) {
  const raw = env[name];
  const { perMinute, status } = resolveRateLimit(raw, fallback);
  if (status === 'invalid' && !reportedVariables.has(name)) {
    reportedVariables.add(name);
    warn(
      `[RateLimit] ${name}=${JSON.stringify(String(raw).slice(0, 40))} is not a number, 0 or off; using the default of ${fallback} per minute.`,
    );
  }
  if (perMinute === null) return null;
  return createRateLimiter({
    windowMs: 60_000,
    max: perMinute,
    globalMax: perMinute * 20,
  });
}

/**
 * Apply a limiter to a request, answering 429 when the client is over it. A
 * limiter turned off (null) lets every request through.
 *
 * @param {((key: string) => boolean)|null} limiter
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {boolean} Whether the request may go ahead; false once a 429 went out.
 */
export function enforceRateLimit(limiter, req, res) {
  if (!limiter) return true;
  if (limiter(rateLimitKey(req))) return true;
  res.statusCode = 429;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Retry-After', '5');
  res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
  return false;
}
