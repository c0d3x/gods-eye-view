/**
 * The Radio Browser directory proxy (/api/radio): the station catalog from the
 * public Radio Browser mirrors, and stream relays pinned to public addresses.
 */

import { randomUUID } from 'node:crypto';
import { lookup as lookupDns } from 'node:dns/promises';
import { normalizeRadioCountryInput } from '../../src/data/radioCountry.js';
import {
  isNonGlobalIpv4,
  isPublicAddress,
  PrivateAddressError,
  requestPinned,
  resolvePublicAddresses,
} from '../lib/publicAddress.mjs';
import { readResponseTextCapped } from '../lib/upstreamBody.mjs';

// ---------------------------------------------------------------------------
// Radio Browser directory proxy
// ---------------------------------------------------------------------------
const RADIO_DIRECTORY_CACHE_MS = 45 * 60 * 1000;
const RADIO_DIRECTORY_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const RADIO_MIRROR_CACHE_MS = 6 * 60 * 60 * 1000;
const RADIO_FETCH_TIMEOUT_MS = 12_000;
const RADIO_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const RADIO_DIRECTORY_LIMIT = 750;
const RADIO_CATALOG_MIN_SUCCESSFUL_QUERIES = 5;
const RADIO_CATALOG_HEALTHY_MIN_STATIONS = Math.ceil(RADIO_DIRECTORY_LIMIT / 2);
const RADIO_USER_AGENT = 'GodsEyeView/1.0 (Radio Browser directory client)';
const RADIO_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RADIO_FALLBACK_MIRRORS = Object.freeze([
  'https://de1.api.radio-browser.info',
  'https://de2.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
]);

function cleanRadioText(value, maxLength) {
  return (
    String(value ?? '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: directory text must lose its control characters
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLength)
      .trim()
  );
}

/** Return a normalized public HTTPS URL, or null for local/private targets. */
export function publicRadioHttpsUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    const hostname = url.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '');
    if (url.protocol !== 'https:' || url.username || url.password || !hostname)
      return null;
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      isNonGlobalIpv4(hostname) ||
      hostname.includes(':')
    )
      return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

/** Normalize one Radio Browser station and omit favicons and unsafe streams. */
export function normalizeRadioBrowserStation(raw) {
  const id = cleanRadioText(raw?.stationuuid, 40).toLowerCase();
  const lat =
    raw?.geo_lat === null || raw?.geo_lat === '' ? null : Number(raw?.geo_lat);
  const lon =
    raw?.geo_long === null || raw?.geo_long === ''
      ? null
      : Number(raw?.geo_long);
  const codec = cleanRadioText(raw?.codec, 16).toUpperCase();
  const streamUrl = publicRadioHttpsUrl(raw?.url_resolved || raw?.url);
  if (
    !RADIO_UUID_RE.test(id) ||
    Number(raw?.lastcheckok) !== 1 ||
    Number(raw?.hls) === 1 ||
    lat === null ||
    !Number.isFinite(lat) ||
    lat < -90 ||
    lat > 90 ||
    lon === null ||
    !Number.isFinite(lon) ||
    lon < -180 ||
    lon > 180 ||
    !/^(?:MP3|AAC(?:\+|-LC|-HE)?|HE-AAC)$/i.test(codec) ||
    !streamUrl
  )
    return null;

  const name = cleanRadioText(raw?.name, 140);
  if (!name) return null;
  const tags = String(raw?.tags ?? '')
    .split(',')
    .map((tag) =>
      cleanRadioText(tag, 80)
        .toLocaleLowerCase()
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .filter((tag, index, all) => all.indexOf(tag) === index)
    .slice(0, 24);
  const languages = String(raw?.language ?? '')
    .split(',')
    .map((language) => cleanRadioText(language, 40))
    .filter(Boolean)
    .slice(0, 8);
  const rawCountryCode = cleanRadioText(raw?.countrycode, 2).toUpperCase();
  const normalizedCode = normalizeRadioCountryInput(rawCountryCode);
  const normalizedCountry =
    normalizedCode.valid && !normalizedCode.empty
      ? normalizedCode
      : normalizeRadioCountryInput(cleanRadioText(raw?.country, 80));
  const bitrate = Number(raw?.bitrate);
  return {
    id,
    name,
    lat,
    lon,
    streamUrl,
    homepage: publicRadioHttpsUrl(raw?.homepage),
    tags,
    languages,
    state: cleanRadioText(raw?.state, 80),
    country:
      normalizedCountry.valid && !normalizedCountry.empty
        ? normalizedCountry.name
        : cleanRadioText(raw?.country, 80),
    countryCode: normalizedCountry.valid ? normalizedCountry.code : '',
    metadataTrust: 'untrusted-community',
    codec,
    bitrate:
      Number.isInteger(bitrate) && bitrate >= 8 && bitrate <= 1024
        ? bitrate
        : null,
    clickCount: Math.max(0, Math.min(10_000_000, Number(raw?.clickcount) || 0)),
  };
}

export function publicRadioStation(station) {
  return {
    id: station.id,
    name: station.name,
    lat: station.lat,
    lon: station.lon,
    streamUrl: station.streamUrl,
    homepage: station.homepage,
    tags: station.tags,
    languages: station.languages,
    state: station.state,
    country: station.country,
    countryCode: station.countryCode,
    metadataTrust: station.metadataTrust,
    codec: station.codec,
    bitrate: station.bitrate,
  };
}

function radioMirrorOrigin(value) {
  const hostname = String(value ?? '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (!/^[a-z0-9-]+\.api\.radio-browser\.info$/.test(hostname)) return null;
  return `https://${hostname}`;
}

/** Return whether a resolved Radio Browser address is safe for an outbound request. */
export function isPublicRadioAddress(value) {
  return isPublicAddress(value);
}

function radioProxyDestination(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return null;
  }
  const origin = radioMirrorOrigin(url.hostname);
  if (
    !origin ||
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  )
    return null;
  const discovery =
    url.hostname.toLowerCase() === 'all.api.radio-browser.info' &&
    url.pathname === '/json/servers' &&
    !url.search;
  const directory = url.pathname === '/json/stations/search';
  const click = /^\/json\/url\/[0-9a-f-]+$/i.test(url.pathname) && !url.search;
  return discovery || directory || click ? url : null;
}

async function resolveRadioProxyAddresses(hostname, lookupImpl) {
  try {
    return await resolvePublicAddresses(hostname, lookupImpl);
  } catch (error) {
    if (error instanceof PrivateAddressError) {
      throw new Error('Radio Browser resolved to a forbidden address');
    }
    throw error;
  }
}

async function mapRadioConcurrent(values, concurrency, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      for (;;) {
        const index = cursor++;
        if (index >= values.length) return;
        results[index] = await mapper(values[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * A Radio Browser catalog as the proxy serves it.
 * @typedef {object} RadioCatalog
 * @property {number} cachedAt
 * @property {string} updatedAt
 * @property {Array<ReturnType<typeof publicRadioStation>>} stations
 * @property {Set<string>} stationIds
 * @property {boolean} degraded
 * @property {string|null} degradedReason
 * @property {{successfulQueries: number, totalQueries: number, stationCount: number, healthyStationMinimum: number}} coverage
 * @property {number|null} acceptedGeneration
 */

/**
 * Create the testable Connect middleware backing `/api/radio`.
 * @param {object} [options]
 * @param {typeof fetch|null} [options.fetchImpl] Makes each request in place of
 *   the pinned one. For tests.
 * @param {typeof lookupDns} [options.lookupImpl]
 * @param {() => number} [options.now]
 */
export function createRadioProxyMiddleware({
  fetchImpl = null,
  lookupImpl = lookupDns,
  now = Date.now,
} = {}) {
  let mirrorCache = { origins: [...RADIO_FALLBACK_MIRRORS], cachedAt: 0 };
  /** @type {Promise<string[]>|null} */
  let mirrorPromise = null;
  /** @type {RadioCatalog|null} */
  let catalogCache = null;
  let catalogGeneration = 0;
  // The generation counter is process-local, so it restarts from 1 with the
  // server. The instance token scopes each generation sequence: a client that
  // sees a new instance must treat the catalog as a fresh sequence, never as a
  // repeat ("still generation 1") or a regression ("generation went backward").
  const catalogInstance = randomUUID();
  let servedStationIds = new Set();
  /** @type {Promise<RadioCatalog>|null} */
  let refreshPromise = null;

  async function fetchJson(url, maxBytes = RADIO_RESPONSE_MAX_BYTES) {
    const destination = radioProxyDestination(url);
    if (!destination)
      throw new Error('Radio Browser destination is not permitted');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RADIO_FETCH_TIMEOUT_MS);
    try {
      const addresses = await resolveRadioProxyAddresses(
        destination.hostname,
        lookupImpl,
      );
      const options = {
        headers: { Accept: 'application/json', 'User-Agent': RADIO_USER_AGENT },
        signal: controller.signal,
        redirect: /** @type {const} */ ('manual'),
      };
      const response = fetchImpl
        ? await fetchImpl(destination.href, options)
        : await requestPinned(destination, options, addresses);
      if (response.status >= 300 && response.status < 400) {
        try {
          await response.body?.cancel?.();
        } catch {
          /* no-op */
        }
        throw new Error('Radio Browser redirects are refused');
      }
      if (!response.ok)
        throw new Error(`Radio Browser returned ${response.status}`);
      const text = await readResponseTextCapped(response, maxBytes);
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }
  }

  async function mirrors() {
    if (now() - mirrorCache.cachedAt < RADIO_MIRROR_CACHE_MS)
      return mirrorCache.origins;
    if (!mirrorPromise) {
      mirrorPromise = (async () => {
        try {
          const rows = await fetchJson(
            'https://all.api.radio-browser.info/json/servers',
            256 * 1024,
          );
          const discovered = [
            ...new Set(
              (Array.isArray(rows) ? rows : [])
                .map((row) => radioMirrorOrigin(row?.name))
                .filter((origin) => origin !== null),
            ),
          ];
          if (discovered.length) {
            mirrorCache = {
              origins: [
                ...discovered,
                ...RADIO_FALLBACK_MIRRORS.filter(
                  (origin) => !discovered.includes(origin),
                ),
              ],
              cachedAt: now(),
            };
          }
        } catch {
          mirrorCache = { ...mirrorCache, cachedAt: now() };
        }
        return mirrorCache.origins;
      })().finally(() => {
        mirrorPromise = null;
      });
    }
    return mirrorPromise;
  }

  async function fetchPath(pathname) {
    let lastError = null;
    for (const origin of await mirrors()) {
      try {
        return await fetchJson(`${origin}${pathname}`);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('No Radio Browser mirror is available');
  }

  async function refreshCatalog() {
    const queries = [
      null,
      'news',
      'talk',
      'weather',
      'emergency',
      'scanner',
      'aviation',
      'marine',
      'traffic',
    ];
    const outcomes = await mapRadioConcurrent(
      queries,
      3,
      async (tag, index) => {
        const params = new URLSearchParams({
          has_geo_info: 'true',
          is_https: 'true',
          hidebroken: 'true',
          order: 'clickcount',
          reverse: 'true',
          limit: index === 0 ? '1800' : '220',
        });
        if (tag) params.set('tag', tag);
        try {
          const rows = await fetchPath(`/json/stations/search?${params}`);
          if (!Array.isArray(rows))
            throw new Error('Radio Browser catalog payload was not an array');
          if (
            !rows.every(
              (row) =>
                row &&
                typeof row === 'object' &&
                !Array.isArray(row) &&
                typeof row.stationuuid === 'string' &&
                typeof row.name === 'string' &&
                (typeof row.url_resolved === 'string' ||
                  typeof row.url === 'string'),
            )
          )
            throw new Error(
              'Radio Browser catalog contained a malformed station row',
            );
          const stations = rows
            .map(normalizeRadioBrowserStation)
            .filter((station) => station !== null);
          const requestedTag = cleanRadioText(tag, 80)
            .toLocaleLowerCase()
            .replace(/[_-]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          const requestedTagCovered =
            !requestedTag ||
            stations.some((station) =>
              station.tags.some(
                (stationTag) =>
                  stationTag === requestedTag ||
                  stationTag.includes(requestedTag),
              ),
            );
          return {
            // Query coverage is based on accepted rows, not merely a payload that
            // happens to match the upstream schema. Specialist responses must
            // also contain an accepted station tagged for the requested category.
            succeeded: stations.length > 0 && requestedTagCovered,
            stations,
          };
        } catch {
          return { succeeded: false, stations: [] };
        }
      },
    );
    const resultSets = outcomes.map((outcome) => outcome.stations);

    const selected = [];
    const seen = new Set();
    const take = (station) => {
      if (
        !station ||
        seen.has(station.id) ||
        selected.length >= RADIO_DIRECTORY_LIMIT
      )
        return;
      seen.add(station.id);
      selected.push(station);
    };
    // Seed specialist station-tag queries before popularity fill so operational
    // categories remain represented even when global click charts skew musical.
    for (const rows of resultSets.slice(1)) rows.slice(0, 45).forEach(take);
    resultSets
      .flat()
      .sort(
        (a, b) => b.clickCount - a.clickCount || a.name.localeCompare(b.name),
      )
      .forEach(take);
    const timestamp = now();
    const successfulQueries = outcomes.filter(
      (outcome) => outcome.succeeded,
    ).length;
    const broadQueryHealthy =
      outcomes[0].succeeded && outcomes[0].stations.length > 0;
    const healthReasons = [];
    if (!broadQueryHealthy) healthReasons.push('broad-query-unhealthy');
    if (successfulQueries < RADIO_CATALOG_MIN_SUCCESSFUL_QUERIES)
      healthReasons.push('query-coverage-below-policy');
    if (selected.length < RADIO_CATALOG_HEALTHY_MIN_STATIONS)
      healthReasons.push('station-coverage-below-policy');
    const degraded = healthReasons.length > 0;
    const coverage = {
      successfulQueries,
      totalQueries: queries.length,
      stationCount: selected.length,
      healthyStationMinimum: RADIO_CATALOG_HEALTHY_MIN_STATIONS,
    };
    const nextCatalog = {
      cachedAt: timestamp,
      updatedAt: new Date(timestamp).toISOString(),
      stations: selected.map(publicRadioStation),
      stationIds: new Set(selected.map((station) => station.id)),
      degraded,
      degradedReason: degraded ? healthReasons.join(',') : null,
      coverage,
    };
    if (degraded && catalogCache) {
      throw Object.assign(
        new Error('Radio Browser catalog refresh did not meet health policy'),
        {
          radioCatalogDegraded: true,
          radioDegradedReason: nextCatalog.degradedReason,
          radioCoverage: coverage,
        },
      );
    }
    if (degraded && !selected.length) {
      throw Object.assign(
        new Error('Radio Browser catalog refresh returned no usable stations'),
        {
          radioCatalogDegraded: true,
          radioDegradedReason: nextCatalog.degradedReason,
          radioCoverage: coverage,
        },
      );
    }
    if (degraded) {
      servedStationIds = nextCatalog.stationIds;
      return { ...nextCatalog, acceptedGeneration: null };
    }
    catalogCache = {
      ...nextCatalog,
      acceptedGeneration: ++catalogGeneration,
    };
    servedStationIds = catalogCache.stationIds;
    return catalogCache;
  }

  async function getCatalog() {
    if (
      catalogCache &&
      now() - catalogCache.cachedAt < RADIO_DIRECTORY_CACHE_MS
    ) {
      return { ...catalogCache, stale: false };
    }
    if (!refreshPromise) {
      refreshPromise = refreshCatalog().finally(() => {
        refreshPromise = null;
      });
    }
    try {
      return { ...(await refreshPromise), stale: false };
    } catch (error) {
      if (
        catalogCache &&
        now() - catalogCache.cachedAt <= RADIO_DIRECTORY_STALE_MS
      ) {
        return {
          ...catalogCache,
          stale: true,
          degraded: true,
          degradedReason: error?.radioDegradedReason || 'refresh-failed',
          coverage: error?.radioCoverage || catalogCache.coverage,
        };
      }
      throw error;
    }
  }

  function sendJson(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(body));
  }

  return async function radioProxyMiddleware(req, res) {
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    if (requestUrl.pathname === '/stations') {
      if (req.method !== 'GET') {
        res.writeHead(405, { Allow: 'GET', 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      try {
        const catalog = await getCatalog();
        sendJson(res, 200, {
          stations: catalog.stations,
          updatedAt: catalog.updatedAt,
          stale: catalog.stale,
          degraded: Boolean(catalog.degraded),
          degradedReason: catalog.degradedReason || null,
          coverage: catalog.coverage || null,
          acceptedGeneration: catalog.acceptedGeneration ?? null,
          catalogInstance,
        });
      } catch (error) {
        sendJson(res, 503, {
          error: 'Radio directory is temporarily unavailable',
          degraded: Boolean(error?.radioCatalogDegraded),
          degradedReason: error?.radioDegradedReason || null,
        });
      }
      return;
    }

    const clickMatch = requestUrl.pathname.match(/^\/click\/([0-9a-f-]+)$/i);
    if (clickMatch) {
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST', 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      const id = clickMatch[1].toLowerCase();
      if (!RADIO_UUID_RE.test(id) || !servedStationIds.has(id)) {
        sendJson(res, 404, { error: 'Unknown radio station' });
        return;
      }
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      void fetchPath(`/json/url/${id}`).catch(() => {});
      return;
    }

    sendJson(res, 404, { error: 'Unknown radio route' });
  };
}

export function radioBrowserProxy() {
  const middleware = createRadioProxyMiddleware();
  const install = (server) => {
    server.middlewares.use('/api/radio', middleware);
  };
  return {
    name: 'radio-browser-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
