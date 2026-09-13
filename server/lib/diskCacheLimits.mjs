import path from 'node:path';
import { createCachePruner } from './diskCache.mjs';

const CACHE_DIR = path.join(process.cwd(), '.gev-cache');

/**
 * Limits for the .gev-cache/ directories that gain a file per query. The
 * single-file caches there (TLEs, launches, FIRMS, terrain, adsbdb) are
 * bounded by their in-memory caps. Overpass keeps 90 days because it serves
 * stale data of any age when every mirror is down; TomTom's budget.json is
 * its daily request budget, spend protection rather than cache.
 */
export const DISK_CACHE_LIMITS = Object.freeze({
  overpass: Object.freeze({
    directory: path.join(CACHE_DIR, 'overpass'),
    maxAgeMs: 90 * 86_400_000,
    maxBytes: 64 * 1024 * 1024,
  }),
  militaryInstallations: Object.freeze({
    directory: path.join(CACHE_DIR, 'military-installations'),
    maxAgeMs: 90 * 86_400_000,
    maxBytes: 32 * 1024 * 1024,
  }),
  tomtom: Object.freeze({
    directory: path.join(CACHE_DIR, 'tomtom'),
    maxAgeMs: 86_400_000,
    maxBytes: 64 * 1024 * 1024,
    keep: Object.freeze(['budget.json']),
  }),
});

/**
 * One pruner per directory above: writes call `afterWrite()`, and the dev
 * server's startup janitor calls `runNow()`.
 */
export const diskCachePruners = Object.fromEntries(
  Object.entries(DISK_CACHE_LIMITS).map(([name, limits]) => [
    name,
    createCachePruner(limits),
  ]),
);

/**
 * Vite plugin: prune the per-query disk caches when the server starts.
 * Writes prune again, at most every ten minutes (see createCachePruner).
 *
 * @returns {import('vite').Plugin}
 */
export function diskCacheJanitor() {
  const pruneAll = () => {
    for (const pruner of Object.values(diskCachePruners)) void pruner.runNow();
  };
  return {
    name: 'gev-disk-cache-janitor',
    configureServer: pruneAll,
    configurePreviewServer: pruneAll,
  };
}
