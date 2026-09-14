/**
 * adsb.lol proxy: /api/adsblol/mil serves military aircraft, cached for 12 s,
 * with a stale copy when adsb.lol fails.
 */

import {
  describeUpstreamFailure,
  fetchWithTimeout,
  upstreamErrorMessage,
  upstreamErrorStatus,
} from '../lib/fetchWithTimeout.mjs';
import { errorMessage } from '../lib/thrownErrors.mjs';
import { readResponseTextCapped } from '../lib/upstreamBody.mjs';

// Deadlines for the upstream calls made through fetchWithTimeout
// (server/lib/fetchWithTimeout.mjs), and caps on the responses they read.
const ADSBLOL_TIMEOUT_MS = 12_000;
const ADSBLOL_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Vite plugin: adsb.lol military aircraft proxy with 12 s response cache.
 *
 * Proxies GET /api/adsblol/mil to https://api.adsb.lol/v2/mil. On upstream
 * failure, serves a stale cached response if one exists.
 *
 * @returns {import('vite').Plugin}
 */
export function adsbLolProxy() {
  /** @type {string|null} Cached upstream JSON body. */
  let _cache = null;
  /** @type {number} Epoch-ms when the cache was populated. */
  let _cacheAt = 0;
  /** Response cache TTL (ms). */
  const CACHE_MS = 12000;
  return {
    name: 'adsblol-proxy',
    configureServer(server) {
      server.middlewares.use('/api/adsblol/mil', async (_req, res) => {
        try {
          const now = Date.now();
          if (_cache && now - _cacheAt < CACHE_MS) {
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
              'X-ADS-B-Cache': 'HIT',
            });
            res.end(_cache);
            return;
          }
          // Not tied to this client's connection: a finished call still
          // refreshes the shared cache.
          const upstream = await fetchWithTimeout(
            'https://api.adsb.lol/v2/mil',
            { headers: { 'User-Agent': 'gods-eye-view-adsblol-proxy/1.0' } },
            { timeoutMs: ADSBLOL_TIMEOUT_MS },
          );
          const body = await readResponseTextCapped(
            upstream,
            ADSBLOL_MAX_BYTES,
          );
          if (upstream.ok) {
            _cache = body;
            _cacheAt = now;
          } else {
            console.warn(
              `[adsb.lol Proxy] ${describeUpstreamFailure(upstream.status, body)}`,
            );
          }
          res.writeHead(upstream.status, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-ADS-B-Cache': 'MISS',
          });
          // Never relay adsb.lol's own error page or text.
          res.end(
            upstream.ok
              ? body
              : JSON.stringify({
                  error: upstreamErrorMessage('adsb.lol', upstream.status),
                }),
          );
        } catch (e) {
          console.error('[adsb.lol Proxy]', errorMessage(e));
          if (_cache) {
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'X-ADS-B-Cache': 'STALE',
            });
            res.end(_cache);
            return;
          }
          res.writeHead(upstreamErrorStatus(e), {
            'Content-Type': 'application/json',
          });
          res.end(JSON.stringify({ error: 'ADS-B proxy error' }));
        }
      });
    },
  };
}
