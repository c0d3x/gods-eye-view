// @ts-check
// src/data/aircraftMeta.js
/**
 * Sticky per-aircraft metadata merge: once a field has resolved for an
 * aircraft, a later snapshot that MISSES the field (empty/null — OpenSky and
 * adsb.lol both do this intermittently) must not regress it. A later snapshot
 * that CHANGES the field always wins. Pattern from skylight (MIT)
 * server/src/datasource.ts "sticky enrichment".
 */

/**
 * @param {unknown} next This snapshot's value.
 * @param {unknown} prev The value kept so far.
 * @returns {string} The trimmed next value, else the previous one, else ''.
 */
export function stickyText(next, prev) {
  const n = String(next || '').trim();
  if (n) return n;
  const p = String(prev || '').trim();
  return p || '';
}

/**
 * @template T
 * @param {unknown} next This snapshot's value.
 * @param {unknown} prev The value kept so far.
 * @param {T} fallback Used when neither is a finite number.
 * @returns {number | T}
 */
export function stickyNumber(next, prev, fallback) {
  if (typeof next === 'number' && Number.isFinite(next)) return next;
  if (typeof prev === 'number' && Number.isFinite(prev)) return prev;
  return fallback;
}
