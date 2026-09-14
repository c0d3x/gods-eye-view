/**
 * The Overpass proxy (/api/overpass) and the route proxy (/api/route):
 * sanitized Overpass QL tried across public mirrors, with memory and disk
 * caches, and walking, cycling and driving routes from routing.openstreetmap.de.
 */

import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  DISK_CACHE_LIMITS,
  diskCachePruners,
} from '../lib/diskCacheLimits.mjs';
import { haversineKm } from '../lib/geo.mjs';
import { createRateLimiter, rateLimitKey } from '../lib/rateLimit.mjs';
import { readBodyWithin } from '../lib/requestBody.mjs';
import { errorMessage } from '../lib/thrownErrors.mjs';
import { readResponseTextCapped } from '../lib/upstreamBody.mjs';

// ---------------------------------------------------------------------------
// Overpass API proxy constants and cache state
// ---------------------------------------------------------------------------
/** Ordered list of Overpass API mirrors; tried sequentially on failure/rate-limit. */
const OVERPASS_UPSTREAMS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  // Community full-planet instance (privateforge nonprofit) — added 2026-07-30
  // when all three mirrors above refused this IP (likely a dev-traffic rate
  // ban; refused connections fail in ms, so healthy mirrors above still win).
  // Verified: planet coverage (Texas query), CORS *, ~5-20 s cold latency.
  'https://overpass.private.coffee/api/interpreter',
];
/**
 * TTL for FRESH cached Overpass responses (ms). Road geometry is static for
 * months — the original 45 s TTL forced a public-mirror round-trip on nearly
 * every viewport revisit and left nothing to serve when the mirrors 502
 * (field-test 2026-07-17: all three mirrors down during US morning peak =
 * "traffic takes forever to load"). 24 h in memory; the disk layer below
 * keeps 7 days and also survives dev-server restarts.
 */
const OVERPASS_CACHE_MS = 86_400_000;
/** Disk-cache TTL for Overpass responses (ms) — 7 days. */
const OVERPASS_DISK_TTL_MS = 7 * 86_400_000;
/**
 * Disk-cache TTL for BOUNDARY-class queries (is_in / admin-relation pivots) — 30
 * days. Admin boundaries change ≈never, and their pivots are the most expensive
 * queries the app issues (multi-MB coastline geometry, 10–25 s on public mirrors —
 * field test 2026-07-23: outline latency + the Sicily miss). Keeping them a month
 * means each boundary is fetched roughly once per machine, ever.
 */
const OVERPASS_BOUNDARY_DISK_TTL_MS = 30 * 86_400_000;
/** Disk-cache directory for Overpass responses. */
const OVERPASS_DISK_DIR = DISK_CACHE_LIMITS.overpass.directory;
/** Per-upstream fetch timeout (ms). */
const OVERPASS_TIMEOUT_MS = 22000;
/** Max entries in the Overpass response cache (LRU-like, oldest evicted first). */
const OVERPASS_CACHE_MAX_ENTRIES = 120;
/**
 * One Overpass answer as the proxy serves it.
 * @typedef {object} OverpassPayload
 * @property {number} status
 * @property {string} body
 * @property {string} contentType
 * @property {string} endpoint
 * @property {boolean} [rateLimited]
 * @property {boolean} [runtimeError]
 */
/**
 * An Overpass answer in the memory or disk cache, stamped for the TTL checks.
 * @typedef {OverpassPayload & {cachedAt: number}} CachedOverpassPayload
 */
/** @type {Map<string, CachedOverpassPayload>} */
const _overpassCache = new Map();
/** @type {Map<string, Promise<OverpassPayload>>} In-flight Overpass requests keyed by normalized query body. */
const _overpassInFlight = new Map();

/**
 * Whether a normalized Overpass query is BOUNDARY-class (admin `is_in` lookups
 * and area→relation pivots) — the static, expensive geometry that earns the
 * 30-day disk TTL. The enclosing-compound sweep and road fetches keep the
 * default TTL. Exported for tests.
 * @param {unknown} cacheKey
 */
export function isOverpassBoundaryQuery(cacheKey) {
  return /is_in\s*\(|\bpivot\b/i.test(String(cacheKey || ''));
}

/**
 * Disk TTL for a query: boundary geometry keeps for a month, the rest 7 days.
 * @param {string} cacheKey
 */
function overpassDiskTtlMs(cacheKey) {
  return isOverpassBoundaryQuery(cacheKey)
    ? OVERPASS_BOUNDARY_DISK_TTL_MS
    : OVERPASS_DISK_TTL_MS;
}

/** Iterative Douglas-Peucker on [{lat,lon},...] (planar-degree approx — fine at
 *  the ~44 m tolerance used here). Endpoints always kept.
 * @param {Array<{lat: number, lon: number}>} points
 * @param {number} toleranceDeg
 */
function douglasPeucker(points, toleranceDeg) {
  const n = points.length;
  if (n <= 2) return points;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    // The loop test keeps the stack non-empty.
    const [a, b] = /** @type {number[]} */ (stack.pop());
    if (b - a < 2) continue;
    const ax = points[a].lon;
    const ay = points[a].lat;
    const vx = points[b].lon - ax;
    const vy = points[b].lat - ay;
    const c2 = vx * vx + vy * vy;
    let worst = -1;
    let worstDist = toleranceDeg;
    for (let i = a + 1; i < b; i++) {
      const wx = points[i].lon - ax;
      const wy = points[i].lat - ay;
      let d;
      if (c2 === 0) {
        d = Math.hypot(wx, wy);
      } else {
        const t = Math.max(0, Math.min(1, (vx * wx + vy * wy) / c2));
        d = Math.hypot(wx - t * vx, wy - t * vy);
      }
      if (d > worstDist) {
        worstDist = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/**
 * Simplify one element's geometry array in place if it is big enough.
 * @param {any} el One element of the parsed upstream Overpass JSON.
 * @param {number} minPoints
 * @param {number} toleranceDeg
 */
function simplifyElementGeometry(el, minPoints, toleranceDeg) {
  if (Array.isArray(el?.geometry) && el.geometry.length >= minPoints) {
    el.geometry = douglasPeucker(el.geometry, toleranceDeg);
  }
  if (Array.isArray(el?.members)) {
    for (const member of el.members) {
      if (
        Array.isArray(member?.geometry) &&
        member.geometry.length >= minPoints
      ) {
        member.geometry = douglasPeucker(member.geometry, toleranceDeg);
      }
    }
  }
}

/**
 * Server-side geometry simplification for large Overpass `out geom` payloads.
 * Region/state boundary pivots return multi-MB coastline rings whose fidelity
 * nothing downstream needs (the client re-simplifies for draw); decimating them
 * HERE shrinks the disk cache, the wire, and client parse time — and is what
 * makes the raised read cap safe. Anything unparseable or below the thresholds
 * passes through byte-identical. Exported for tests (opts override thresholds).
 *
 * @param {string} bodyText - Raw upstream JSON body.
 * @param {object} [opts]
 * @param {number} [opts.minBytes]
 * @param {number} [opts.minPoints]
 * @param {number} [opts.toleranceDeg]
 * @returns {string} Possibly-simplified JSON body.
 */
export function simplifyOverpassPayloadBody(bodyText, opts = {}) {
  const minBytes = opts.minBytes ?? OVERPASS_SIMPLIFY_MIN_BYTES;
  const minPoints = opts.minPoints ?? OVERPASS_SIMPLIFY_MIN_POINTS;
  const toleranceDeg = opts.toleranceDeg ?? OVERPASS_SIMPLIFY_TOLERANCE_DEG;
  if (typeof bodyText !== 'string' || bodyText.length < minBytes)
    return bodyText;
  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
  if (!Array.isArray(data?.elements)) return bodyText;
  for (const el of data.elements)
    simplifyElementGeometry(el, minPoints, toleranceDeg);
  try {
    return JSON.stringify(data);
  } catch {
    return bodyText;
  }
}

/**
 * Normalized Overpass query -> stable disk-cache file path.
 * @param {string} cacheKey
 */
function overpassDiskPath(cacheKey) {
  return path.join(
    OVERPASS_DISK_DIR,
    `${createHash('sha1').update(cacheKey).digest('hex')}.json`,
  );
}

/**
 * Read a disk-cached Overpass payload. maxAgeMs Infinity = any age (the
 * serve-stale path when every mirror is down).
 * @param {string} cacheKey
 * @param {number} maxAgeMs
 * @returns {Promise<CachedOverpassPayload|null>} Payload with cachedAt, or null.
 */
export async function readOverpassDisk(cacheKey, maxAgeMs) {
  try {
    const raw = await fsp.readFile(overpassDiskPath(cacheKey), 'utf8');
    const payload = JSON.parse(raw);
    if (
      !payload ||
      typeof payload.body !== 'string' ||
      !Number.isFinite(payload.cachedAt)
    )
      return null;
    // Older versions persisted 4xx refusals with normal data TTLs. Ignore
    // them on both fresh and stale reads so an upgrade can recover immediately.
    if (!overpassPayloadIsData(payload)) return null;
    if (Date.now() - payload.cachedAt > maxAgeMs) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget disk write for a successful Overpass payload.
 * @param {string} cacheKey
 * @param {CachedOverpassPayload} payload
 */
function writeOverpassDisk(cacheKey, payload) {
  fsp
    .mkdir(OVERPASS_DISK_DIR, { recursive: true })
    .then(() =>
      fsp.writeFile(overpassDiskPath(cacheKey), JSON.stringify(payload)),
    )
    .then(() => diskCachePruners.overpass.afterWrite())
    .catch((err) =>
      console.warn(
        '[Overpass Proxy] disk cache write failed:',
        err?.message || err,
      ),
    );
}

/**
 * Resolve every cache/coalescing layer before admitting a request to the local
 * upstream rate limiter. The injected limiter callback is invoked exactly once
 * for a complete cache miss and never for memory, in-flight, or disk hits.
 * Exported so the admission ordering can be tested without a Vite server.
 *
 * @param {object} options
 * @param {string} options.cacheKey
 * @param {Map<string, CachedOverpassPayload>} options.memoryCache
 * @param {Map<string, Promise<OverpassPayload>>} options.inFlight
 * @param {()=>Promise<CachedOverpassPayload|null>} options.readDisk
 * @param {()=>boolean} options.allowUpstream
 * @param {number} [options.now]
 * @param {number} [options.cacheMs]
 * @returns {Promise<{source: 'HIT'|'DISK', payload: CachedOverpassPayload} | {source: 'INFLIGHT', payload: OverpassPayload} | {source: 'UPSTREAM', payload: null} | {source: 'RATE_LIMITED', payload: null}>}
 */
export async function resolveOverpassPreflight({
  cacheKey,
  memoryCache,
  inFlight,
  readDisk,
  allowUpstream,
  now = Date.now(),
  cacheMs = OVERPASS_CACHE_MS,
}) {
  const cached = memoryCache.get(cacheKey);
  if (
    cached &&
    overpassPayloadIsData(cached) &&
    now - cached.cachedAt <= cacheMs
  )
    return { source: 'HIT', payload: cached };

  const pending = inFlight.get(cacheKey);
  if (pending) return { source: 'INFLIGHT', payload: await pending };

  const disk = await readDisk();
  if (disk && overpassPayloadIsData(disk))
    return { source: 'DISK', payload: disk };

  return allowUpstream()
    ? { source: 'UPSTREAM', payload: null }
    : { source: 'RATE_LIMITED', payload: null };
}

/**
 * Return only last-good Overpass data, regardless of its age.
 * @param {string} cacheKey
 */
async function readStaleOverpass(cacheKey) {
  const cached = _overpassCache.get(cacheKey);
  return cached && overpassPayloadIsData(cached)
    ? cached
    : readOverpassDisk(cacheKey, Infinity);
}
/** OSM routing (FOSSGIS OSRM) cache: profile|coords -> { payload, cachedAt }. */
const ROUTE_CACHE_MS = 600000;
const _routeCache = new Map();

// --- Abuse guards shared by the Overpass + route proxies --------------------
/** Max accepted POST body for the Overpass proxy (Overpass QL queries are tiny). */
const OVERPASS_MAX_BODY_BYTES = 24 * 1024; // 24 KB
/**
 * Hard cap on a single Overpass upstream response we will buffer into memory.
 * 32 MB (was 12 MB): a dense island/state admin boundary at full `out geom`
 * fidelity — Sicilia's Mediterranean coastline — can exceed 12 MB, and clipping
 * it read as a permanent "transient" failure (field test 2026-07-23, Sicily
 * never traced). The buffered payload is SIMPLIFIED server-side before it is
 * cached or sent (simplifyOverpassPayloadBody), so the raised cap does not
 * raise what clients receive or what the disk stores.
 */
const OVERPASS_MAX_RESPONSE_BYTES = 32 * 1024 * 1024; // 32 MB
/** Only payloads at least this large go through geometry simplification. */
const OVERPASS_SIMPLIFY_MIN_BYTES = 1_500_000;
/** Only per-element geometry arrays with at least this many points are simplified. */
const OVERPASS_SIMPLIFY_MIN_POINTS = 1200;
/**
 * Douglas-Peucker tolerance (degrees, ≈44 m of latitude). Region/state boundary
 * rings are drawn at regional camera scale and the client simplifies again for
 * draw, so ~44 m fidelity is invisible; building footprints never reach the
 * point threshold above and pass through untouched.
 */
const OVERPASS_SIMPLIFY_TOLERANCE_DEG = 0.0004;
/** Max concurrent in-flight upstream Overpass fetches across all distinct queries. */
const OVERPASS_MAX_CONCURRENT = 6;
let _overpassConcurrent = 0;
/** Hard cap on the OSRM route response we will buffer. */
const ROUTE_MAX_RESPONSE_BYTES = 8 * 1024 * 1024; // 8 MB
/** Reject routes whose straight-line spans are obviously abusive (km). */
const ROUTE_MAX_LEG_KM = 600;
const ROUTE_MAX_TOTAL_KM = 2500;

/**
 * Fixed-window backstops (server/lib/rateLimit.mjs) so a runaway client can't
 * hammer the public Overpass / OSRM mirrors or exhaust this process.
 */
const _overpassRateLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 90,
  globalMax: 300,
});

const _routeRateLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 60,
  globalMax: 200,
});

/** Server-side timeout ceiling (seconds) we allow inside an Overpass QL query. */
const OVERPASS_MAX_QL_TIMEOUT = 30;
/** Max `around:` radius (m) — every app caller uses <= 1800 m. */
const OVERPASS_MAX_AROUND_M = 50000;
/** Max bbox span (degrees) — app bboxes are small viewport tiles. */
const OVERPASS_MAX_BBOX_DEG = 12;
/**
 * Every Overpass element-type specifier, including the combined shortcuts
 * (nwr/nw/nr/wr) and `rel`. Shared by the selector + area-element-deny regexes so
 * they can't drift (a missing shortcut like `wr` was an area-scan bypass).
 */
const OVERPASS_ELEMENT_TYPES = 'node|way|relation|nwr|nw|nr|wr|rel';
/** Element-selector (incl. `area`) whose statements must be individually bounded. */
const OVERPASS_SELECTOR_RE = new RegExp(
  `\\b(?:${OVERPASS_ELEMENT_TYPES}|area)\\b`,
);
/** An element selector bounded BY an area — the country-scan abuse shape. */
const OVERPASS_AREA_ELEMENT_RE = new RegExp(
  `\\b(?:${OVERPASS_ELEMENT_TYPES})\\s*\\(\\s*area\\b`,
  'i',
);
/** A single bbox 4-tuple `(s,w,n,e)` (non-global so it does not advance lastIndex). */
const OVERPASS_BBOX_RE =
  /\(\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*\)/;

/**
 * Validate + clamp an Overpass form body. Defends the generic proxy against
 * planet-scale abuse: requires exactly one `data` query in which EVERY element
 * selector is individually spatially bounded (around / bbox / is_in / poly /
 * area-set / pivot), rejects oversized radii and world-sized bboxes, and clamps
 * every `[timeout:]` directive. Comments + quoted literals are stripped first so
 * a fake bound inside a tag value can't satisfy the check.
 *
 * Every real app caller passes (annotations/locations/cctv use `around:`/`is_in`/
 * `area.`/`pivot`; traffic uses a small `(s,w,n,e)` bbox); a mixed query that
 * pairs one bounded selector with a global one is rejected.
 *
 * @returns {{ok:true, body:string} | {ok:false, error:string}}
 */
/**
 * Single-pass lexer: blank out quoted literals (→ empty quotes) and strip line
 * and block comments — recognizing each in one walk so a comment marker INSIDE a
 * quoted string is treated as string content, not a comment (and vice versa).
 * Chained regex replaces get the ordering wrong (a quoted slash-slash would hide
 * the rest of the line), which is exactly the bypass this avoids.
 * @param {string} src
 */
function stripOverpassNoise(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const quote = c;
      i += 1;
      while (i < n) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        } // escaped char
        if (src[i] === quote) {
          i += 1;
          break;
        } // closing quote
        i += 1;
      }
      out += quote + quote; // collapse the literal to empty quotes
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      out += ' ';
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      i += 2;
      while (i < n && src[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Validate an Overpass query body, rejecting unbounded queries.
 * @param {string} rawBody URL-encoded request body.
 * @returns {{ok: true, body: string} | {ok: false, error: string}}
 */
function sanitizeOverpassBody(rawBody) {
  let params;
  try {
    params = new URLSearchParams(rawBody);
  } catch {
    return { ok: false, error: 'Malformed query body' };
  }
  const all = params.getAll('data');
  if (all.length !== 1)
    return { ok: false, error: 'Exactly one data query is required' };
  const data = all[0];
  if (!data?.trim()) return { ok: false, error: 'Missing Overpass data query' };

  // Blank quoted literals + strip comments in one lexer pass so a fake bound or a
  // `//` inside a string can't hide an unbounded selector (or satisfy a bound).
  const stripped = stripOverpassNoise(data);

  // Reject oversized radii in EVERY around form — point `around:r,lat,lon` AND the
  // input-set form `around.set:r` — and parse the full numeric token so scientific
  // notation (`5e7`) can't slip a planet-scale radius past the cap.
  for (const m of stripped.matchAll(/around(?:\.\w+)?:\s*([\d.eE+-]+)/gi)) {
    const radius = Number(m[1]);
    if (!Number.isFinite(radius) || radius > OVERPASS_MAX_AROUND_M) {
      return { ok: false, error: 'Overpass around radius too large' };
    }
  }
  // Reject world-sized / oversized bboxes.
  for (const m of stripped.matchAll(
    /\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/g,
  )) {
    const s = Number(m[1]);
    const w = Number(m[2]);
    const n = Number(m[3]);
    const e = Number(m[4]);
    if (
      Math.abs(n - s) > OVERPASS_MAX_BBOX_DEG ||
      Math.abs(e - w) > OVERPASS_MAX_BBOX_DEG
    ) {
      return { ok: false, error: 'Overpass bbox too large' };
    }
  }

  // Reject control-flow constructs the app never uses — their set/bound semantics
  // are hard to validate statically. The app only uses plain selectors + is_in /
  // area / pivot / recursion, so this denylist closes loop/transform escape hatches.
  if (/\b(?:foreach|complete|retro|compare|convert|make)\b/i.test(stripped)) {
    return { ok: false, error: 'Unsupported Overpass construct' };
  }
  // `poly:` has unchecked extent and the app never uses it — reject outright
  // (position-independent, so tag filters can't hide it).
  if (/\bpoly\s*:/i.test(stripped)) {
    return { ok: false, error: 'Overpass poly filter not allowed' };
  }

  // Every selector statement must be individually bounded, WITH set provenance: a
  // set counts as a bound only if it was assigned (->.set) by an already-bounded
  // statement. So `way[...]->.a` (global assigned to a set) is rejected, while the
  // app's `is_in(...)->.a; area.a[...]` and `area(id)->.x; rel(pivot.x)` validate.
  const boundedSets = new Set();
  for (let stmt of stripped.split(';')) {
    stmt = stmt.trim();
    if (!stmt || stmt.startsWith('[') || /^out\b/.test(stmt)) continue;

    // Strip output-set assignments (NOT input bounds), then strip bracket tag
    // filters so a tag KEY/value (e.g. `way[is_in]`, `node[around]`) can never be
    // misread as a spatial bound. Bounds live in (...) / function calls / set
    // refs, never inside [...], so the probe loses nothing real.
    /** @type {string[]} */
    const outSets = [];
    const body = stmt.replace(/->\s*\.(\w+)/g, (_, name) => {
      outSets.push(name);
      return ' ';
    });
    const probe = body.replace(/\[[^\]]*\]/g, ' ');

    // Reject element-in-area scans on the TAG-STRIPPED probe, so a tag filter
    // between the selector and the area filter (way["highway"](area.a)) can't hide
    // it. An area has unbounded extent (could be a whole country); the app only
    // SELECTS admin areas (area.set) and pivots (rel(pivot.x)), never node/way/
    // relation(area...). The probe collapses tags so `way (area.a)` is caught.
    if (OVERPASS_AREA_ELEMENT_RE.test(probe)) {
      return {
        ok: false,
        error: 'Overpass area-bounded element selector not allowed',
      };
    }

    const hasSelector = OVERPASS_SELECTOR_RE.test(probe);
    const inputSets = [...probe.matchAll(/(?<!\d)\.([a-z_]\w*)/gi)].map(
      (m) => m[1],
    );
    const directBound =
      /around:\s*\d/.test(probe) ||
      OVERPASS_BBOX_RE.test(probe) ||
      /is_in\s*\(/.test(probe) || // is_in(lat,lon) — the function form only
      /\barea\s*\(/.test(probe); // area(id) — bounded as a set definition

    const setBound = inputSets.some((s) => boundedSets.has(s));
    const bounded = directBound || setBound;

    if (hasSelector && !bounded) {
      return { ok: false, error: 'Overpass query has an unbounded selector' };
    }
    // Only a bounded statement can mark its output sets as bounded.
    if (bounded) for (const name of outSets) boundedSets.add(name);
  }

  const clamped = data.replace(
    /\[timeout:\s*(\d+)\s*\]/gi,
    (_, n) =>
      `[timeout:${Math.min(Number(n) || OVERPASS_MAX_QL_TIMEOUT, OVERPASS_MAX_QL_TIMEOUT)}]`,
  );
  return { ok: true, body: `data=${encodeURIComponent(clamped)}` };
}

/**
 * Detect whether an Overpass API response body indicates rate-limiting.
 *
 * Checks for known rate-limit phrases in the body text regardless of
 * HTTP status code, since some mirrors return 200 with an error payload.
 *
 * @param {string} bodyText - Upstream response body.
 * @returns {boolean} True if the body looks rate-limited.
 */
function overpassLooksRateLimited(bodyText) {
  const text = String(bodyText || '').toLowerCase();
  return (
    text.includes('rate_limited') ||
    text.includes('quota of your ip address') ||
    text.includes('dispatcher_client::request_read_and_idx::rate_limited') ||
    text.includes('too many requests')
  );
}

/**
 * Detect an Overpass HTTP-200 body that is actually a runtime FAILURE (server-side
 * timeout / out-of-memory) via its `remark`. These are transient upstream failures,
 * not authoritative empty results, so they must not be returned or cached.
 * @param {string} bodyText - Upstream response body.
 * @returns {boolean}
 */
function overpassLooksRuntimeError(bodyText) {
  const text = String(bodyText || '').toLowerCase();
  return (
    text.includes('runtime error') ||
    text.includes('timed out') ||
    text.includes('out of memory')
  );
}

/** Evict oldest Overpass cache entries until size is within the cap. */
function trimOverpassCache() {
  while (_overpassCache.size > OVERPASS_CACHE_MAX_ENTRIES) {
    const oldestKey = _overpassCache.keys().next().value;
    if (!oldestKey) break;
    _overpassCache.delete(oldestKey);
  }
}

/**
 * Write a completed Overpass payload to the HTTP response.
 *
 * @param {import('http').ServerResponse} res - Node HTTP response.
 * @param {{status:number,body:string,contentType:string,endpoint:string}} payload
 * @param {string} [cacheStatus='MISS'] - 'HIT', 'MISS', or 'INFLIGHT'.
 */
function sendOverpassResponse(res, payload, cacheStatus = 'MISS') {
  res.writeHead(payload.status, {
    'Content-Type': payload.contentType || 'application/json',
    'Cache-Control': 'public, max-age=15',
    'X-Overpass-Cache': cacheStatus,
    'X-Overpass-Upstream': payload.endpoint || 'unknown',
  });
  res.end(payload.body || '');
}

/**
 * True only for an upstream response that is actually Overpass data.
 *
 * The proxy caches on this and serves stale on its negation, so the two
 * decisions cannot drift apart: a payload that is not data must never be
 * written to the cache and must always be eligible for a stale replacement.
 * @param {{status: number, rateLimited?: boolean, runtimeError?: boolean}} payload
 * @returns {boolean}
 */
export function overpassPayloadIsData(payload) {
  const status = Number(payload?.status);
  return (
    Number.isFinite(status) &&
    status >= 200 &&
    status < 300 &&
    !payload.rateLimited &&
    !payload.runtimeError
  );
}

/**
 * Try each mirror once, retaining response-size and per-mirror timeout caps.
 * Refusals and body-level failures rotate; total failure returns the last
 * rate-limit payload, otherwise the first refusal, or throws a network error.
 * @param {string} body URL-encoded Overpass QL query body.
 * @param {number} [maxResponseBytes] Endpoint-specific response cap.
 * @param {object} [options] Server-only endpoint and I/O overrides for tests.
 * @param {readonly string[]} [options.endpoints]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {typeof readResponseTextCapped} [options.readBody]
 * @param {typeof simplifyOverpassPayloadBody} [options.simplify]
 * @returns {Promise<OverpassPayload>}
 */
export async function fetchOverpassPayload(
  body,
  maxResponseBytes = OVERPASS_MAX_RESPONSE_BYTES,
  {
    endpoints = OVERPASS_UPSTREAMS,
    fetchImpl = fetch,
    readBody = readResponseTextCapped,
    simplify = simplifyOverpassPayloadBody,
  } = {},
) {
  /** @type {unknown} Whatever the last failing mirror threw. */
  let lastError = null;
  /** @type {OverpassPayload|null} */
  let lastRateLimitPayload = null;
  /** @type {OverpassPayload|null} */
  let lastRefusalPayload = null;

  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);

    try {
      const upstream = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'gods-eye-view-overpass-proxy/1.0',
        },
        body,
        signal: controller.signal,
      });

      const responseBody = await readBody(upstream, maxResponseBytes);
      const contentType =
        upstream.headers.get('content-type') || 'application/json';
      const status = upstream.status;
      const rateLimited =
        status === 429 || overpassLooksRateLimited(responseBody);
      const runtimeError = overpassLooksRuntimeError(responseBody);
      const payload = {
        status,
        body: responseBody,
        contentType,
        endpoint,
        rateLimited,
        runtimeError,
      };

      if (rateLimited) {
        lastRateLimitPayload = payload;
        continue;
      }
      // A 200 body carrying a runtime error / timeout is a transient upstream
      // failure — skip to the next mirror rather than returning or caching it.
      if (runtimeError) {
        lastError = new Error(`Overpass runtime error (${endpoint})`);
        continue;
      }
      // Anything but 2xx is this mirror declining, not an answer. Only 5xx used
      // to rotate, so a 4xx ended the fan-out and was returned — and cached —
      // as data: overpass-api.de and its lz4 alias answer 406 to this proxy's
      // User-Agent while kumi.systems and private.coffee answer 200 to the very
      // same request, so every Overpass-backed layer failed on an Apache error
      // page with two healthy mirrors untried. The first refusal is kept so a
      // genuinely bad query still reports what upstream said, but only after
      // every mirror has had the chance to answer it.
      if (status < 200 || status >= 300) {
        if (!lastRefusalPayload) lastRefusalPayload = payload;
        lastError = new Error(
          `Overpass upstream returned ${status} (${endpoint})`,
        );
        continue;
      }

      // Success: decimate giant boundary geometry before it reaches the cache,
      // the disk, or the client (what makes the 32 MB read cap safe to hold).
      payload.body = simplify(payload.body);
      return payload;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  if (lastRateLimitPayload) return lastRateLimitPayload;
  if (lastRefusalPayload) return lastRefusalPayload;
  throw lastError || new Error('All Overpass upstreams failed');
}

/**
 * Vite plugin: Overpass API proxy with response caching and request coalescing.
 *
 * Accepts POST requests at /api/overpass, normalizes the query body for
 * cache keying, and fans out to multiple Overpass mirrors with per-upstream
 * timeout and rate-limit detection. Successful responses are cached for
 * OVERPASS_CACHE_MS. Concurrent identical queries share a single upstream
 * request via the in-flight map.
 *
 * @returns {import('vite').Plugin}
 */
export function overpassProxy() {
  return {
    name: 'overpass-proxy',
    configureServer(server) {
      server.middlewares.use('/api/overpass', async (req, res) => {
        // Hoisted out of the try so the catch's serve-stale lookup can see it
        // (a body-read failure would otherwise hit an out-of-scope reference).
        /** @type {string|null} */
        let cacheKey = null;
        try {
          if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method Not Allowed' }));
            return;
          }

          // Collect POST body with a hard byte cap (Overpass QL queries are small)
          const bodyRead = await readBodyWithin(req, OVERPASS_MAX_BODY_BYTES);
          if (!bodyRead.ok) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Overpass query too large' }));
            return;
          }
          const body = bodyRead.text;
          if (!body) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing Overpass query body' }));
            return;
          }

          // Validate + clamp the QL: reject unbounded/global queries and cap the
          // server-side timeout so a tiny body can't request planet-scale work.
          const sanitized = sanitizeOverpassBody(body);
          if (!sanitized.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: sanitized.error }));
            return;
          }
          const safeBody = sanitized.body;

          // Normalize whitespace so semantically identical Overpass QL queries share cache entries
          cacheKey = safeBody.replace(/\s+/g, ' ').trim();
          // Callbacks below use this copy; cacheKey stays a let for the catch.
          const requestKey = cacheKey;
          const preflight = await resolveOverpassPreflight({
            cacheKey,
            memoryCache: _overpassCache,
            inFlight: _overpassInFlight,
            // Fresh-enough disk entries survive restarts and skip the public
            // mirrors; boundary-class queries keep their month-long TTL.
            readDisk: () =>
              readOverpassDisk(requestKey, overpassDiskTtlMs(requestKey)),
            allowUpstream: () => _overpassRateLimiter(rateLimitKey(req)),
          });
          if (preflight.source === 'RATE_LIMITED') {
            res.writeHead(429, {
              'Content-Type': 'application/json',
              'Retry-After': '5',
            });
            res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
            return;
          }
          if (preflight.source !== 'UPSTREAM') {
            // A coalesced caller sees the same failure as the original request
            // and must get the same last-good fallback, not the raw refusal.
            if (!overpassPayloadIsData(preflight.payload)) {
              const stale = await readStaleOverpass(cacheKey);
              if (stale) {
                sendOverpassResponse(res, stale, 'STALE');
                return;
              }
            }
            if (preflight.source === 'DISK') {
              _overpassCache.set(cacheKey, preflight.payload);
              trimOverpassCache();
            }
            sendOverpassResponse(res, preflight.payload, preflight.source);
            return;
          }

          // From here onward the request is genuinely upstream-bound and has
          // consumed one local limiter slot. Cache and dedupe hits above do not.
          if (_overpassConcurrent >= OVERPASS_MAX_CONCURRENT) {
            res.writeHead(503, {
              'Content-Type': 'application/json',
              'Retry-After': '2',
            });
            res.end(
              JSON.stringify({
                error: 'Overpass proxy busy — try again shortly',
              }),
            );
            return;
          }
          _overpassConcurrent += 1;
          const requestPromise = fetchOverpassPayload(safeBody)
            .then((payload) => {
              // Only a 2xx is data. `< 500` cached every 4xx, so one mirror's
              // refusal was written to memory AND disk — and boundary-class
              // queries hold a month-long TTL, so a single 406 outlived the
              // outage that caused it.
              if (overpassPayloadIsData(payload)) {
                const entry = { ...payload, cachedAt: Date.now() };
                _overpassCache.set(requestKey, entry);
                trimOverpassCache();
                writeOverpassDisk(requestKey, entry);
              }
              return payload;
            })
            .finally(() => {
              _overpassConcurrent -= 1;
              _overpassInFlight.delete(requestKey);
            });

          _overpassInFlight.set(requestKey, requestPromise);
          const payload = await requestPromise;
          // Degraded upstream (rate-limited on every mirror / 5xx / runtime
          // error): last-good roads beat an empty layer — serve stale from
          // memory or disk at ANY age before surfacing the failure.
          if (!overpassPayloadIsData(payload)) {
            const stale = await readStaleOverpass(cacheKey);
            if (stale) {
              sendOverpassResponse(res, stale, 'STALE');
              return;
            }
          }
          sendOverpassResponse(res, payload, 'MISS');
        } catch (e) {
          // Every mirror threw (network-level). Same serve-stale rule.
          const stale = cacheKey ? await readStaleOverpass(cacheKey) : null;
          if (stale) {
            sendOverpassResponse(res, stale, 'STALE');
            return;
          }
          console.error('[Overpass Proxy]', errorMessage(e));
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Overpass proxy error' }));
        }
      });

      // Real OSM routing via the public FOSSGIS OSRM servers (foot/car/bike).
      // GET /api/route?profile=foot|car|bike&coords=lon,lat;lon,lat[;...]
      server.middlewares.use('/api/route', async (req, res) => {
        /** @param {string} msg */
        const fail = (msg) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: msg }));
        };
        try {
          if (!_routeRateLimiter(rateLimitKey(req))) {
            res.writeHead(429, {
              'Content-Type': 'application/json',
              'Retry-After': '5',
            });
            res.end(JSON.stringify({ ok: false, error: 'rate limited' }));
            return;
          }
          const url = new URL(req.url || '', 'http://localhost');
          const raw = (url.searchParams.get('profile') || 'foot').toLowerCase();
          const profile =
            raw === 'car' || raw === 'driving'
              ? 'car'
              : raw === 'bike' || raw === 'cycling' || raw === 'bicycle'
                ? 'bike'
                : raw === 'foot' || raw === 'walking' || raw === 'walk'
                  ? 'foot'
                  : null;
          if (!profile) return fail('invalid profile');
          const osrmProfile = profile === 'car' ? 'driving' : profile;
          const pairs = (url.searchParams.get('coords') || '')
            .split(';')
            .map((s) => s.trim())
            .filter(Boolean);
          if (pairs.length < 2 || pairs.length > 12)
            return fail('need 2-12 coordinates');
          const clean = [];
          const pts = [];
          for (const pr of pairs) {
            const parts = pr.split(',');
            if (parts.length !== 2) return fail('invalid coordinate');
            const lon = Number(parts[0]);
            const lat = Number(parts[1]);
            if (
              !Number.isFinite(lon) ||
              !Number.isFinite(lat) ||
              Math.abs(lat) > 90 ||
              Math.abs(lon) > 180
            ) {
              return fail('invalid coordinate');
            }
            clean.push(`${lon},${lat}`);
            pts.push([lon, lat]);
          }
          // Reject obviously-abusive spans — a real walking/driving route is local,
          // so a cross-continent request is either a bug or an attempt to drive
          // heavy upstream OSRM work.
          let totalKm = 0;
          for (let i = 1; i < pts.length; i += 1) {
            // pts are [lon, lat]; existing haversineKm takes (lat1, lon1, lat2, lon2).
            const legKm = haversineKm(
              pts[i - 1][1],
              pts[i - 1][0],
              pts[i][1],
              pts[i][0],
            );
            if (legKm > ROUTE_MAX_LEG_KM) return fail('route leg too long');
            totalKm += legKm;
          }
          if (totalKm > ROUTE_MAX_TOTAL_KM) return fail('route too long');
          const coords = clean.join(';');
          const cacheKey = `${profile}|${coords}`;
          const now = Date.now();
          const cached = _routeCache.get(cacheKey);
          if (cached && now - cached.cachedAt <= ROUTE_CACHE_MS) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(cached.payload));
            return;
          }
          const upstream = `https://routing.openstreetmap.de/routed-${profile}/route/v1/${osrmProfile}/${coords}?overview=full&geometries=geojson&alternatives=false&steps=false`;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 12000);
          let osrm;
          try {
            const upstreamRes = await fetch(upstream, {
              signal: controller.signal,
              headers: { 'User-Agent': 'gods-eye-view/dev (local)' },
            });
            if (!upstreamRes.ok) return fail('no route found');
            const ctype = upstreamRes.headers.get('content-type') || '';
            if (!ctype.includes('json')) return fail('no route found');
            const text = await readResponseTextCapped(
              upstreamRes,
              ROUTE_MAX_RESPONSE_BYTES,
            );
            osrm = JSON.parse(text);
          } finally {
            clearTimeout(timer);
          }
          const route = osrm?.routes?.[0];
          if (osrm?.code !== 'Ok' || !route?.geometry?.coordinates?.length)
            return fail('no route found');
          const payload = {
            ok: true,
            profile,
            distanceM: Math.round(route.distance),
            durationS: Math.round(route.duration),
            geometry: route.geometry.coordinates,
          };
          _routeCache.set(cacheKey, { payload, cachedAt: now });
          if (_routeCache.size > 200)
            _routeCache.delete(_routeCache.keys().next().value);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        } catch (e) {
          console.error('[Route Proxy]', errorMessage(e) || e);
          fail('route proxy error');
        }
      });
    },
  };
}
