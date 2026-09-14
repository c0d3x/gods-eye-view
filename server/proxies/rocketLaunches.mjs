/**
 * Launch Library 2 proxy: recent rocket launch metadata, cached and coalesced,
 * with a stale copy served when the service fails.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { coalesceProxyRequest } from '../lib/coalesce.mjs';
import { errorField } from '../lib/thrownErrors.mjs';
import { readResponseTextCapped } from '../lib/upstreamBody.mjs';

export const LL2_CACHE_TTL_MS = 15 * 60_000;

/** Build LL2 request headers without exposing its optional token client-side. */
export function launchLibraryRequestHeaders(token = process.env.LL2_API_TOKEN) {
  const normalized = String(token || '').trim();
  return {
    Accept: 'application/json',
    ...(normalized ? { Authorization: `Token ${normalized}` } : {}),
  };
}

/**
 * Proxy the public Launch Library 2 recent-launch feed server-side.
 * @returns {import('vite').Plugin}
 */
export function rocketLaunchesProxy() {
  const ttlMs = LL2_CACHE_TTL_MS;
  const maxResponseBytes = 12 * 1024 * 1024;
  const maxDiskCacheBytes = 24 * 1024 * 1024;
  const cachePath = path.join(
    process.cwd(),
    '.gev-cache',
    'launch-library-2-v2.3.json',
  );
  /** @type {{at: number, body: string}|null} */
  let cache = null;
  let diskLoaded = false;
  const inFlight = new Map();

  async function loadDiskCache() {
    if (diskLoaded) return;
    diskLoaded = true;
    try {
      const stat = await fsp.stat(cachePath);
      if (stat.size > maxDiskCacheBytes)
        throw new Error('cache file too large');
      const parsed = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
      if (Number.isFinite(parsed?.at) && typeof parsed?.body === 'string') {
        const body = JSON.parse(parsed.body);
        if (Array.isArray(body?.results)) cache = parsed;
      }
    } catch {
      /* first run or invalid cache */
    }
  }

  /** @param {{at: number, body: string}} entry */
  async function saveDiskCache(entry) {
    try {
      await fsp.mkdir(path.dirname(cachePath), { recursive: true });
      await fsp.writeFile(cachePath, JSON.stringify(entry), 'utf8');
    } catch (_error) {
      console.warn('[launch-library-proxy] cache write failed');
    }
  }

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {number} status
   * @param {string} body
   * @param {string} cacheState
   */
  function send(res, status, body, cacheState) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': status === 200 ? 'public, max-age=900' : 'no-store',
      'X-GEV-Cache': cacheState,
    });
    res.end(body);
  }

  async function refreshUpstream() {
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 86400000);
    const url = new URL('https://ll.thespacedevs.com/2.3.0/launches/');
    url.searchParams.set('net__gte', start.toISOString());
    url.searchParams.set('net__lte', end.toISOString());
    url.searchParams.set('limit', '100');
    url.searchParams.set('mode', 'detailed');
    const upstream = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      headers: launchLibraryRequestHeaders(),
    });
    const body = await readResponseTextCapped(upstream, maxResponseBytes);
    if (!upstream.ok) {
      throw Object.assign(new Error(`upstream HTTP ${upstream.status}`), {
        upstreamStatus: upstream.status,
      });
    }
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed?.results))
      throw new Error('malformed upstream response');
    const fresh = { at: Date.now(), body };
    cache = fresh;
    void saveDiskCache(fresh);
    return fresh;
  }

  /** @param {import('vite').Connect.Server} middlewares */
  function install(middlewares) {
    middlewares.use('/api/launches', async (req, res) => {
      if (req.method !== 'GET') {
        send(res, 405, JSON.stringify({ error: 'Method Not Allowed' }), 'NONE');
        return;
      }
      await loadDiskCache();
      const now = Date.now();
      if (cache && now - cache.at < ttlMs) {
        send(res, 200, cache.body, 'HIT');
        return;
      }
      const stale = cache;
      const request = coalesceProxyRequest(
        inFlight,
        'recent-launches',
        refreshUpstream,
      );
      try {
        const fresh = await request.promise;
        send(res, 200, fresh.body, request.shared ? 'INFLIGHT' : 'MISS');
      } catch (error) {
        // Log only a bounded status, never upstream bodies, URLs, or credentials.
        const upstreamStatus = errorField(error, 'upstreamStatus');
        const status =
          typeof upstreamStatus === 'number' && Number.isInteger(upstreamStatus)
            ? upstreamStatus
            : 502;
        if (!request.shared)
          console.warn(
            `[launch-library-proxy] refresh failed (HTTP ${status})${stale ? ' — serving stale cache' : ''}`,
          );
        if (stale) {
          send(res, 200, stale.body, 'STALE-ERROR');
          return;
        }
        send(
          res,
          status,
          JSON.stringify({ error: 'Launch Library 2 unavailable' }),
          'NONE',
        );
      }
    });
  }

  return {
    name: 'rocket-launches-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
