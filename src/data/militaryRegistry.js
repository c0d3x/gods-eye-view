/**
 * Shared military-aircraft ICAO24 registry (2026-06-10 playtest fix).
 *
 * adsb.lol /v2/mil tags aircraft via its database's military flag; OpenSky
 * carries no such tag, so military aircraft (e.g. ADAPT91/92) appeared in
 * BOTH layers as duplicate icons and tracks. This registry reconciles them:
 *
 *  - The military layer, while enabled, feeds every poll's ICAO set here and
 *    marks itself active — the commercial flights layer then SUPPRESSES its
 *    duplicates (military layer wins icon, track, and click).
 *  - While the military layer is OFF, the flights layer keeps a low-rate
 *    poll (60s against the dev proxy's cached /api/adsblol/mil) so known
 *    military aircraft are still classified and styled amber.
 */

const MIL_POLL_INTERVAL_MS = 60000;
/** Most hexes the registry keeps; the least recently seen go first. */
export const MILITARY_REGISTRY_MAX_ENTRIES = 4096;
/** A hex that no poll has listed for this long is forgotten. */
export const MILITARY_REGISTRY_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * @type {Map<string, number>} Lowercase ICAO24 hexes known to be military,
 * each mapped to when a poll last listed it. Insertion order is last-seen
 * order, oldest first, so pruning reads from the front.
 */
const _milIcaos = new Map();
/** @type {boolean} True while the dedicated military layer is enabled. */
let _militaryLayerActive = false;
/** @type {Set<(active: boolean) => void>} Fired on active-state TRANSITIONS. */
const _activeChangeListeners = new Set();
/** @type {number} Epoch ms of the last registry refresh (any source). */
let _lastRefreshMs = 0;
/** @type {boolean} A self-poll fetch is in flight. */
let _polling = false;

/**
 * True when the dedicated military layer currently renders these aircraft
 * (the flights layer should suppress duplicates rather than restyle them).
 * @returns {boolean}
 */
export function isMilitaryLayerActive() {
  return _militaryLayerActive;
}

/**
 * Marks the dedicated military layer enabled/disabled. On a TRANSITION
 * (value actually changed) the registered change listeners fire so the
 * flights layer can reconcile its duplicates immediately instead of waiting
 * out its 30 s poll (pre-ship audit M2).
 * @param {boolean} active - Whether the military layer renders.
 * @returns {void}
 */
export function setMilitaryLayerActive(active) {
  const next = !!active;
  if (next === _militaryLayerActive) return;
  _militaryLayerActive = next;
  for (const listener of _activeChangeListeners) {
    try {
      listener(next);
    } catch {
      // a broken listener must never break the layer toggle
    }
  }
}

/**
 * Subscribes to military-layer active-state transitions (fired only when the
 * value changes, AFTER the new state is committed).
 * @param {(active: boolean) => void} listener - Change callback.
 * @returns {() => void} Unsubscribe function.
 */
export function onMilitaryLayerActiveChange(listener) {
  if (typeof listener !== 'function') return () => {};
  _activeChangeListeners.add(listener);
  return () => _activeChangeListeners.delete(listener);
}

/**
 * Extends the known-military set from a fresh poll.
 * A transient dropout from one poll must not declassify an aircraft, so a
 * hex stays until no poll has listed it for MILITARY_REGISTRY_TTL_MS. Past
 * MILITARY_REGISTRY_MAX_ENTRIES the least recently seen go first, so a long
 * session can't grow the registry without bound.
 * @param {Iterable<string>} icaos - ICAO24 hexes from a /v2/mil response.
 * @param {number} [now] - Epoch ms of the poll.
 * @returns {void}
 */
export function registerMilitaryIcaos(icaos, now = Date.now()) {
  for (const icao of icaos || []) {
    const hex = String(icao || '').trim().toLowerCase();
    if (!hex) continue;
    // Delete first so the hex moves to the end: newest last.
    _milIcaos.delete(hex);
    _milIcaos.set(hex, now);
  }
  _lastRefreshMs = now;
  for (const [hex, seenMs] of _milIcaos) {
    const expired = now - seenMs > MILITARY_REGISTRY_TTL_MS;
    if (!expired && _milIcaos.size <= MILITARY_REGISTRY_MAX_ENTRIES) break;
    _milIcaos.delete(hex);
  }
}

/**
 * Whether an aircraft is known military.
 * @param {string} icao24 - ICAO24 hex (any case).
 * @returns {boolean}
 */
export function isMilitaryIcao(icao24) {
  return _milIcaos.has(String(icao24 || '').toLowerCase());
}

/** Test hook: how many hexes the registry holds. */
export function _militaryRegistrySizeForTest() {
  return _milIcaos.size;
}

/** Test hook: empties the registry and marks it never refreshed. */
export function _resetMilitaryRegistryForTest() {
  _milIcaos.clear();
  _lastRefreshMs = 0;
}

/**
 * Refreshes the registry from /api/adsblol/mil when stale — used by the
 * flights layer so classification works while the military layer is off
 * (the military layer's own polls keep it fresh otherwise). The dev proxy
 * caches upstream responses, so this is nearly free.
 * @returns {void} Fire-and-forget; failures leave the current set intact.
 */
export function refreshMilitaryRegistryIfStale() {
  if (_militaryLayerActive) return; // military layer's polls keep us fresh
  if (_polling || (Date.now() - _lastRefreshMs) < MIL_POLL_INTERVAL_MS) return;
  _polling = true;
  (async () => {
    try {
      const response = await fetch('/api/adsblol/mil', { signal: AbortSignal.timeout(10000) });
      if (!response.ok) return;
      const data = await response.json();
      const aircraft = Array.isArray(data?.ac) ? data.ac : [];
      registerMilitaryIcaos(aircraft.map((entry) => entry?.hex));
    } catch {
      // keep the existing set on any failure
    } finally {
      _polling = false;
    }
  })();
}
