/**
 * The mapped military-installation proxy (/api/military-installations):
 * allow-listed Overpass context for a bounded bbox, with memory and disk
 * caches that serve last-good data when every mirror is down.
 */

import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { coalesceProxyRequest } from '../lib/coalesce.mjs';
import {
  DISK_CACHE_LIMITS,
  diskCachePruners,
} from '../lib/diskCacheLimits.mjs';
import { requiredFiniteQueryNumber } from '../lib/queryParams.mjs';
import { createRateLimiter, rateLimitKey } from '../lib/rateLimit.mjs';
import { errorField, errorMessage } from '../lib/thrownErrors.mjs';
import { fetchOverpassPayload } from './overpass.mjs';

const _militaryInstallationsRateLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 90,
  globalMax: 300,
});

// ---------------------------------------------------------------------------
// Military-installation context proxy
// ---------------------------------------------------------------------------
// This narrow endpoint deliberately does not expose arbitrary Overpass QL to
// the browser. It returns only allow-listed mapped context and rejects global,
// cross-dateline, or oversized requests before touching public OSM mirrors.
const MILITARY_INSTALLATION_CACHE_MS = 5 * 60_000;
const MILITARY_INSTALLATION_STALE_MS = 60 * 60_000;
const MILITARY_INSTALLATION_MAX_CACHE = 80;
const MILITARY_INSTALLATION_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/**
 * Upstream element cap. A response that hits it exactly is SATURATED — Overpass
 * truncated, so off-viewport features from the snapped bbox may have crowded out
 * in-viewport ones. Callers re-ask for the exact viewport in that case.
 */
export const MILITARY_INSTALLATION_ELEMENT_CAP = 700;
/**
 * Disk-cache TTL for mapped installations (ms) — 30 days.
 *
 * Owner playtest 2026-08-18: "search nearby sites" was slow because every look
 * around paid a live Overpass round trip, and the 5-minute in-memory tier died
 * with the dev server. Mapped military features change on a survey timescale,
 * not a session one, so a month-old answer is still the right answer — the same
 * reasoning the Overpass proxy already applies to admin boundaries.
 */
const MILITARY_INSTALLATION_DISK_TTL_MS = 30 * 86_400_000;
/** Disk-cache directory for mapped installation payloads. */
const MILITARY_INSTALLATION_DISK_DIR =
  DISK_CACHE_LIMITS.militaryInstallations.directory;

/**
 * Cache-key grid step in degrees (~5.5 km).
 *
 * The browser sends the raw view rectangle, so every pixel of pan minted a new
 * key and a new upstream query. Snapping the bbox OUTWARD onto a coarse grid
 * makes neighbouring viewports share one entry, and because the snap only ever
 * grows the box, the cached answer is always a superset of what was asked for.
 */
const MILITARY_INSTALLATION_BBOX_STEP_DEG = 0.05;
const _militaryInstallationCache = new Map();
const _militaryInstallationInFlight = new Map();

/**
 * Snap a request bbox outward onto the shared installation cache grid.
 * @param {{south:number, west:number, north:number, east:number}} box
 * @param {number} [stepDeg]
 * @returns {{south:number, west:number, north:number, east:number}}
 */
export function quantizeMilitaryInstallationBox(
  box,
  stepDeg = MILITARY_INSTALLATION_BBOX_STEP_DEG,
) {
  // Round the ratio first: 29.9999/0.05 lands a hair under an exact grid line
  // in binary floating point, which would otherwise snap a whole cell too far.
  /**
   * @param {number} value
   * @param {number} grow
   */
  const snap = (value, grow) => {
    const cells = Number((value / stepDeg).toFixed(9));
    return Number(
      ((grow > 0 ? Math.ceil(cells) : Math.floor(cells)) * stepDeg).toFixed(6),
    );
  };
  return {
    south: Math.max(-90, snap(box.south, -1)),
    west: Math.max(-180, snap(box.west, -1)),
    north: Math.min(90, snap(box.north, 1)),
    east: Math.min(180, snap(box.east, 1)),
  };
}

/**
 * Stable disk/memory cache key for an installation bbox.
 *
 * The key's precision must match the precision of the bounds the QUERY uses, or
 * two different queries collide on one entry. Snapped boxes live on a 0.05 deg
 * grid, so 3 decimals is exact for them; an `exact=1` request carries the raw
 * viewport at 5 decimals and must be keyed at 5, otherwise two nearby exact
 * viewports would share an answer and the second would be missing the edge
 * strip it just exposed.
 * @param {{south:number, west:number, north:number, east:number}} box
 * @param {number} [decimals]
 */
export function militaryInstallationCacheKey(box, decimals = 3) {
  return [box.south, box.west, box.north, box.east]
    .map((value) => value.toFixed(decimals))
    .join(',');
}

/**
 * A cached installation answer and when it was fetched.
 * @typedef {object} MilitaryInstallationEntry
 * @property {Record<string, any>} payload
 * @property {number} cachedAt
 */

/**
 * Resolve the READ tiers for one installation request, in order: fresh memory,
 * then disk. Returns UPSTREAM when neither can answer.
 *
 * Disk is skipped while a request for this key is already in flight — the
 * caller joins that instead of paying a read. Exported so the tier ORDER is
 * testable against a real temp directory without a Vite server, mirroring
 * resolveOverpassPreflight.
 *
 * @param {object} options
 * @param {string} options.cacheKey
 * @param {Map<string, MilitaryInstallationEntry>} options.memoryCache
 * @param {Map<string, Promise<unknown>>} options.inFlight
 * @param {() => Promise<?MilitaryInstallationEntry>} options.readDisk
 * @param {number} [options.now]
 * @param {number} [options.cacheMs]
 * @returns {Promise<{source: 'HIT'|'DISK', entry: MilitaryInstallationEntry} | {source: 'UPSTREAM', entry: null}>}
 */
export async function resolveMilitaryInstallationTier({
  cacheKey,
  memoryCache,
  inFlight,
  readDisk,
  now = Date.now(),
  cacheMs = MILITARY_INSTALLATION_CACHE_MS,
}) {
  const cached = memoryCache.get(cacheKey);
  if (cached && now - cached.cachedAt <= cacheMs)
    return { source: 'HIT', entry: cached };
  if (inFlight.has(cacheKey)) return { source: 'UPSTREAM', entry: null };
  const disk = await readDisk();
  return disk
    ? { source: 'DISK', entry: disk }
    : { source: 'UPSTREAM', entry: null };
}

/**
 * Bring a stored installation entry up to the current payload shape.
 *
 * Entries written before the saturation guard shipped carry no `saturated`
 * field, and the disk TTL is 30 DAYS — so without this a cached, truncated
 * 700-element snapped response would keep skipping the exact-viewport retry for
 * a month, quietly starving in-view sites. Saturation is DERIVED from the
 * element count rather than invalidating those entries, so warm caches survive
 * the upgrade.
 * @param {?MilitaryInstallationEntry} entry
 * @returns {?MilitaryInstallationEntry}
 */
export function migrateMilitaryInstallationEntry(entry) {
  if (!entry?.payload || typeof entry.payload.saturated === 'boolean')
    return entry;
  const elements = Array.isArray(entry.payload.elements)
    ? entry.payload.elements
    : [];
  return {
    ...entry,
    payload: {
      ...entry.payload,
      saturated: elements.length >= MILITARY_INSTALLATION_ELEMENT_CAP,
    },
  };
}

/**
 * Whether a stored installation entry is still inside its TTL.
 * @param {any} entry Parsed disk-cache JSON, not yet validated.
 * @param {number} [maxAgeMs]
 * @param {number} [now]
 */
export function militaryInstallationDiskFresh(
  entry,
  maxAgeMs = MILITARY_INSTALLATION_DISK_TTL_MS,
  now = Date.now(),
) {
  if (
    !entry ||
    !Number.isFinite(entry.cachedAt) ||
    !Array.isArray(entry.payload?.elements)
  )
    return false;
  return now - entry.cachedAt <= maxAgeMs;
}

/**
 * Cache key -> stable disk-cache file path.
 * @param {string} cacheKey
 * @param {string} [dir]
 */
export function militaryInstallationDiskPath(
  cacheKey,
  dir = MILITARY_INSTALLATION_DISK_DIR,
) {
  return path.join(
    dir,
    `${createHash('sha1').update(cacheKey).digest('hex')}.json`,
  );
}

/**
 * Read a disk-cached installation entry. maxAgeMs Infinity = any age (the
 * serve-stale path when Overpass is down).
 * @param {string} cacheKey
 * @param {number} maxAgeMs
 * @param {string} [dir]
 * @returns {Promise<?MilitaryInstallationEntry>}
 */
export async function readMilitaryInstallationDisk(
  cacheKey,
  maxAgeMs,
  dir = MILITARY_INSTALLATION_DISK_DIR,
) {
  try {
    const entry = JSON.parse(
      await fsp.readFile(militaryInstallationDiskPath(cacheKey, dir), 'utf8'),
    );
    if (!militaryInstallationDiskFresh(entry, maxAgeMs)) return null;
    return migrateMilitaryInstallationEntry(entry);
  } catch {
    return null;
  }
}

/**
 * Persist one installation payload ATOMICALLY: serialize to a temp sibling,
 * then rename over the target. A crash or a full disk mid-write leaves the
 * PREVIOUS entry intact — an in-place overwrite would shred the last-good copy
 * and take serve-stale down with it, exactly when it is needed most.
 * @param {string} cacheKey
 * @param {MilitaryInstallationEntry} entry
 * @param {string} [dir]
 * @returns {Promise<boolean>} Whether the entry landed.
 */
export async function writeMilitaryInstallationDisk(
  cacheKey,
  entry,
  dir = MILITARY_INSTALLATION_DISK_DIR,
) {
  const target = militaryInstallationDiskPath(cacheKey, dir);
  // Same directory, so the rename is atomic on POSIX rather than a cross-device copy.
  const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(temp, JSON.stringify(entry));
    await fsp.rename(temp, target);
    if (dir === MILITARY_INSTALLATION_DISK_DIR)
      diskCachePruners.militaryInstallations.afterWrite();
    return true;
  } catch (err) {
    console.warn(
      '[Installations Proxy] disk cache write failed:',
      errorMessage(err) || err,
    );
    await fsp.rm(temp, { force: true }).catch(() => {});
    return false;
  }
}

/** @param {URLSearchParams} params */
export function validMilitaryInstallationBox(params) {
  const south = requiredFiniteQueryNumber(params, 'south');
  const west = requiredFiniteQueryNumber(params, 'west');
  const north = requiredFiniteQueryNumber(params, 'north');
  const east = requiredFiniteQueryNumber(params, 'east');
  if (south === null || west === null || north === null || east === null)
    return null;
  if (
    south < -90 ||
    north > 90 ||
    west < -180 ||
    east > 180 ||
    south >= north ||
    west >= east
  )
    return null;
  if (north - south > 10 || east - west > 10) return null;
  return { south, west, north, east };
}

function trimMilitaryInstallationCache() {
  while (_militaryInstallationCache.size > MILITARY_INSTALLATION_MAX_CACHE) {
    const oldest = _militaryInstallationCache.keys().next().value;
    if (oldest === undefined) break;
    _militaryInstallationCache.delete(oldest);
  }
}

/**
 * Safe, evidence-based reason for an installation upstream failure.
 * @param {unknown} error Whatever the refresh threw.
 * @returns {'rate_limited'|'timeout'|'query_failed'|'unavailable'}
 */
export function militaryInstallationFailureReason(error) {
  const reason = errorField(error, 'installationReason');
  if (
    reason === 'rate_limited' ||
    reason === 'timeout' ||
    reason === 'query_failed'
  )
    return reason;
  const name = errorField(error, 'name');
  return name === 'AbortError' || name === 'TimeoutError'
    ? 'timeout'
    : 'unavailable';
}

/** @returns {import('vite').Plugin} */
export function militaryInstallationsProxy() {
  /**
   * @param {{south:number, west:number, north:number, east:number}} box
   * @param {string} key
   */
  async function refresh(box, key) {
    const bbox = `${box.south},${box.west},${box.north},${box.east}`;
    const ql = `[out:json][timeout:20];(nwr["military"~"^(airfield|naval_base|range|barracks|base)$"](${bbox});nwr["landuse"="military"](${bbox}););out center tags geom ${MILITARY_INSTALLATION_ELEMENT_CAP};`;
    const upstream = await fetchOverpassPayload(
      `data=${encodeURIComponent(ql)}`,
      MILITARY_INSTALLATION_MAX_RESPONSE_BYTES,
    );
    if (
      upstream.status >= 400 ||
      upstream.rateLimited ||
      upstream.runtimeError
    ) {
      throw Object.assign(
        new Error('Mapped installation upstream unavailable'),
        {
          installationReason: upstream.rateLimited
            ? 'rate_limited'
            : upstream.status === 504
              ? 'timeout'
              : upstream.runtimeError
                ? 'query_failed'
                : 'unavailable',
        },
      );
    }
    const parsed = JSON.parse(upstream.body);
    const elements = Array.isArray(parsed?.elements)
      ? parsed.elements.slice(0, MILITARY_INSTALLATION_ELEMENT_CAP)
      : [];
    const payload = {
      elements,
      // Honest truncation flag — the client re-asks for its exact viewport so
      // off-view features can never starve in-view ones. The cap travels with
      // the payload so the client never has to hard-code it.
      saturated: elements.length >= MILITARY_INSTALLATION_ELEMENT_CAP,
      elementCap: MILITARY_INSTALLATION_ELEMENT_CAP,
      retrievedAt: new Date().toISOString(),
      status: 'ready',
    };
    const entry = { payload, cachedAt: Date.now() };
    _militaryInstallationCache.set(key, entry);
    trimMilitaryInstallationCache();
    writeMilitaryInstallationDisk(key, entry);
    return payload;
  }

  /** @param {import('vite').Connect.Server} middlewares */
  function install(middlewares) {
    middlewares.use('/api/military-installations', async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }
      if (!_militaryInstallationsRateLimiter(rateLimitKey(req))) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': '5',
        });
        res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
        return;
      }
      const url = new URL(req.url || '', 'http://localhost');
      const requested = validMilitaryInstallationBox(url.searchParams);
      if (!requested) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'A non-dateline bbox no larger than 10 degrees is required',
          }),
        );
        return;
      }
      // Query the SNAPPED box, not the raw viewport: neighbouring views then
      // share one cache entry, and an outward snap always covers what was asked.
      // `exact=1` opts out — the client sends it after a SATURATED snapped
      // response, so a truncated tile can never starve the actual viewport. It
      // is keyed separately so exact and snapped answers never collide.
      const exact = url.searchParams.get('exact') === '1';
      const box = exact
        ? requested
        : quantizeMilitaryInstallationBox(requested);
      // Key at the precision the query actually uses (see militaryInstallationCacheKey).
      const key = exact
        ? `exact:${militaryInstallationCacheKey(box, 5)}`
        : militaryInstallationCacheKey(box);
      const now = Date.now();
      const cached = _militaryInstallationCache.get(key);
      const preflight = await resolveMilitaryInstallationTier({
        cacheKey: key,
        memoryCache: _militaryInstallationCache,
        inFlight: _militaryInstallationInFlight,
        readDisk: () =>
          readMilitaryInstallationDisk(key, MILITARY_INSTALLATION_DISK_TTL_MS),
        now,
      });
      if (preflight.source !== 'UPSTREAM') {
        if (preflight.source === 'DISK') {
          _militaryInstallationCache.set(key, preflight.entry);
          trimMilitaryInstallationCache();
        }
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
          'X-Military-Installations': preflight.source,
        });
        res.end(
          JSON.stringify({ ...preflight.entry.payload, status: 'cached' }),
        );
        return;
      }
      const request = coalesceProxyRequest(
        _militaryInstallationInFlight,
        key,
        () => refresh(box, key),
      );
      try {
        const payload = await request.promise;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
          'X-Military-Installations': request.shared ? 'INFLIGHT' : 'MISS',
        });
        res.end(JSON.stringify(payload));
      } catch (error) {
        if (cached && now - cached.cachedAt <= MILITARY_INSTALLATION_STALE_MS) {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-Military-Installations': 'STALE',
          });
          res.end(JSON.stringify({ ...cached.payload, status: 'stale' }));
          return;
        }
        // Overpass is down: last-good mapped context at ANY age beats an empty
        // layer (the same serve-stale rule the Overpass proxy applies).
        const stale = await readMilitaryInstallationDisk(key, Infinity);
        if (stale) {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-Military-Installations': 'STALE-DISK',
          });
          res.end(JSON.stringify({ ...stale.payload, status: 'stale' }));
          return;
        }
        res.writeHead(503, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({
            error: 'Mapped installation context is temporarily unavailable',
            reason: militaryInstallationFailureReason(error),
          }),
        );
      }
    });
  }

  return {
    name: 'military-installations-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
