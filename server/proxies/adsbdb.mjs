/**
 * adsbdb proxy: aircraft type and route lookups, cached in memory and on disk.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { createBoundedCache } from '../lib/boundedCache.mjs';
import { readResponseTextCapped } from '../lib/upstreamBody.mjs';

/** Routes and aircraft each kept by the adsbdb proxy; clients choose the keys. */
export const ADSBDB_CACHE_MAX_ENTRIES = 5_000;

/**
 * adsbdb.com enrichment proxy: callsign → route (airline + origin/destination
 * airports) and hex → aircraft type/registration. Free community API — cached
 * aggressively: ONE upstream request per new key ever (404s negative-cached),
 * persisted to disk so restarts don't re-hammer it. Adapted from skylight
 * (MIT) server/src/enrich/routes.ts.
 */
export function adsbdbProxy({
  cachePath = path.join(process.cwd(), '.gev-cache', 'adsbdb.json'),
} = {}) {
  const TTL_MS = 24 * 3600_000;
  const CACHE_PATH = cachePath;
  // Each store is keyed by client input, so it is capped (oldest lookups go).
  const makeStore = () =>
    createBoundedCache({ maxEntries: ADSBDB_CACHE_MAX_ENTRIES, ttlMs: TTL_MS });
  const cache = { routes: makeStore(), aircraft: makeStore() };
  let dirty = false;
  let loaded = false;
  const inflight = new Map();

  async function loadOnce() {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
      for (const kind of ['routes', 'aircraft']) {
        const saved = Object.entries(parsed?.[kind] ?? {})
          .filter(([, entry]) => fresh(entry))
          .sort(([, a], [, b]) => a.at - b.at);
        for (const [key, entry] of saved) cache[kind].set(key, entry);
      }
    } catch {
      /* first run */
    }
    setInterval(async () => {
      if (!dirty) return;
      dirty = false;
      try {
        await fsp.mkdir(path.dirname(CACHE_PATH), { recursive: true });
        const saved = {
          routes: Object.fromEntries(cache.routes.entries()),
          aircraft: Object.fromEntries(cache.aircraft.entries()),
        };
        await fsp.writeFile(CACHE_PATH, JSON.stringify(saved), 'utf8');
      } catch {
        dirty = true;
      } // retry next tick
    }, 15_000).unref?.();
  }

  const fresh = (e) => e && Date.now() - e.at < TTL_MS;

  function parseRoute(json) {
    const fr = json?.response?.flightroute;
    if (!fr?.origin || !fr?.destination) return null;
    const airport = (a) => ({
      code: a.iata_code || a.icao_code || '',
      name: a.municipality || a.name || '',
      lat: Number.isFinite(a.latitude) ? a.latitude : null,
      lon: Number.isFinite(a.longitude) ? a.longitude : null,
    });
    return {
      airline: fr.airline?.name || null,
      origin: airport(fr.origin),
      destination: airport(fr.destination),
    };
  }

  function parseAircraft(json) {
    const a = json?.response?.aircraft;
    if (!a) return null;
    return {
      typeCode: a.icao_type || null, // ICAO designator, e.g. "B738" — feeds classifyAircraft
      typeName:
        a.manufacturer && a.type
          ? `${a.manufacturer} ${a.type}`
          : a.type || null,
      registration: a.registration || null,
    };
  }

  function lookup(kind, key) {
    const store = kind === 'route' ? cache.routes : cache.aircraft;
    const cached = store.get(key);
    if (fresh(cached)) return Promise.resolve(cached.data);
    const ik = `${kind}:${key}`;
    if (!inflight.has(ik)) {
      inflight.set(
        ik,
        (async () => {
          try {
            const url =
              kind === 'route'
                ? `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(key)}`
                : `https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(key)}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
            if (res.ok) {
              const payload = JSON.parse(
                await readResponseTextCapped(res, 256 * 1024),
              );
              const data =
                kind === 'route' ? parseRoute(payload) : parseAircraft(payload);
              store.set(key, { at: Date.now(), data }); // data may be null — negative cache
              dirty = true;
              return data;
            }
            if (res.status === 404) {
              store.set(key, { at: Date.now(), data: null }); // known-missing — cache the miss
              dirty = true;
            }
            // other statuses: leave uncached so we retry later
            const entry = store.get(key);
            return fresh(entry) ? entry.data : null;
          } catch {
            const entry = store.get(key);
            return fresh(entry) ? entry.data : null; // network error → last fresh value, if any
          } finally {
            inflight.delete(ik);
          }
        })(),
      );
    }
    return inflight.get(ik);
  }

  return {
    name: 'adsbdb-proxy',
    configureServer(server) {
      server.middlewares.use('/api/adsbdb', async (req, res) => {
        await loadOnce();
        const send = (status, obj) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        try {
          const [, kind, rawKey] = String(req.url || '')
            .split('?')[0]
            .split('/');
          if (kind === 'route') {
            const cs = String(rawKey || '').toUpperCase();
            if (!/^[A-Z0-9]{2,8}$/.test(cs))
              return send(400, { error: 'invalid callsign' });
            const data = await lookup('route', cs);
            return send(
              200,
              data ? { found: true, ...data } : { found: false },
            );
          }
          if (kind === 'type') {
            const hex = String(rawKey || '').toLowerCase();
            if (!/^[0-9a-f]{6}$/.test(hex))
              return send(400, { error: 'invalid hex' });
            const data = await lookup('aircraft', hex);
            return send(
              200,
              data ? { found: true, ...data } : { found: false },
            );
          }
          return send(404, { error: 'unknown endpoint' });
        } catch (_err) {
          console.error('[adsbdb-proxy] request failed');
          return send(500, { error: 'adsbdb proxy error' });
        }
      });
    },
  };
}
