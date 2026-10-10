/** Most hexes a registry keeps; the least recently seen go first. */
export const MILITARY_REGISTRY_MAX_ENTRIES = 4096;
/** A hex that no poll has listed for this long is forgotten. */
export const MILITARY_REGISTRY_TTL_MS = 6 * 60 * 60 * 1000;

/** Instance-owned military identity and active-layer classification.
 * Both aircraft layers share the same application-supplied registry. */
export function createMilitaryRegistry({ source, now = Date.now } = {}) {
  const MIL_POLL_INTERVAL_MS = 60000;

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
  let currentSource = null;
  let lifetime = null;
  let releaseSource = null;

  /** Replace the classification source and cancel its outstanding work. */
  function configureSource(nextSource, { signal } = {}) {
    if (typeof nextSource?.getSnapshot !== 'function')
      throw new TypeError('A snapshot source is required');
    releaseSource?.();
    const controller = new AbortController();
    lifetime = controller;
    currentSource = nextSource;
    _milIcaos.clear();
    _lastRefreshMs = 0;
    _polling = false;
    const release = () => {
      controller.abort();
      signal?.removeEventListener('abort', release);
      if (lifetime !== controller) return;
      currentSource = null;
      lifetime = null;
      releaseSource = null;
      _milIcaos.clear();
      _lastRefreshMs = 0;
      _polling = false;
    };
    releaseSource = release;
    if (signal?.aborted) release();
    else signal?.addEventListener('abort', release, { once: true });
    return release;
  }

  /**
   * True when the dedicated military layer currently renders these aircraft
   * (the flights layer should suppress duplicates rather than restyle them).
   * @returns {boolean}
   */
  function isMilitaryLayerActive() {
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
  function setMilitaryLayerActive(active) {
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
  function onMilitaryLayerActiveChange(listener) {
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
   * @returns {void}
   */
  function registerMilitaryIcaos(icaos) {
    const seenMs = now();
    for (const icao of icaos || []) {
      const hex = String(icao || '')
        .trim()
        .toLowerCase();
      if (!hex) continue;
      // Delete first so the hex moves to the end: newest last.
      _milIcaos.delete(hex);
      _milIcaos.set(hex, seenMs);
    }
    _lastRefreshMs = seenMs;
    for (const [hex, lastSeenMs] of _milIcaos) {
      const expired = seenMs - lastSeenMs > MILITARY_REGISTRY_TTL_MS;
      if (!expired && _milIcaos.size <= MILITARY_REGISTRY_MAX_ENTRIES) break;
      _milIcaos.delete(hex);
    }
  }

  /**
   * Whether an aircraft is known military.
   * @param {string} icao24 - ICAO24 hex (any case).
   * @returns {boolean}
   */
  function isMilitaryIcao(icao24) {
    return _milIcaos.has(String(icao24 || '').toLowerCase());
  }

  /** Refresh known identities while the dedicated layer is disabled.
   * A failed or cancelled request retains the current set and never swaps sources. */
  async function refreshMilitaryRegistryIfStale() {
    if (
      !currentSource ||
      !lifetime ||
      lifetime.signal.aborted ||
      _militaryLayerActive
    )
      return;
    if (_polling || now() - _lastRefreshMs < MIL_POLL_INTERVAL_MS) return;
    const owner = lifetime;
    const requestSource = currentSource;
    const signal = AbortSignal.any([owner.signal, AbortSignal.timeout(10000)]);
    _polling = true;
    try {
      const ids =
        typeof requestSource.getIdentities === 'function'
          ? await requestSource.getIdentities({}, { signal })
          : (await requestSource.getSnapshot({}, { signal })).records.map(
              (record) => record.id,
            );
      signal.throwIfAborted();
      if (lifetime !== owner) return;
      if (!Array.isArray(ids))
        throw new TypeError('Expected aircraft identities');
      registerMilitaryIcaos(ids);
    } catch {
      // Keep the existing classification through source outages.
    } finally {
      if (lifetime === owner) _polling = false;
    }
  }
  function dispose() {
    releaseSource?.();
    _milIcaos.clear();
    _lastRefreshMs = 0;
    _activeChangeListeners.clear();
    _militaryLayerActive = false;
  }
  if (source) configureSource(source);
  return {
    configureSource,
    dispose,
    isMilitaryLayerActive,
    setMilitaryLayerActive,
    onMilitaryLayerActiveChange,
    registerMilitaryIcaos,
    isMilitaryIcao,
    refreshMilitaryRegistryIfStale,
  };
}
