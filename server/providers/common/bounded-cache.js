/**
 * A small in-memory cache with a size cap and an optional time to live.
 *
 * For caches whose keys come from clients (a point, a callsign, a camera
 * pose): without a cap, every new key a client invents stays in memory for
 * the life of the server.
 *
 * When the cache is full the least recently used entry goes first. Reading a
 * fresh entry or storing a key again makes it the most recently used. Entries
 * expire `ttlMs` after they were stored; an expired entry reads as missing and
 * is dropped when it is read, when the cap evicts it, or when a write finds it
 * at the oldest end.
 */

/**
 * @template V
 * @param {object} options
 * @param {number} options.maxEntries Most entries kept at once (at least 1).
 * @param {number} [options.ttlMs] How long an entry stays fresh, in ms. The
 *   default, Infinity, leaves freshness to the caller and only bounds the size.
 * @param {() => number} [options.now] Clock; reads Date.now() at call time.
 */
export function createBoundedCache({
  maxEntries,
  ttlMs = Number.POSITIVE_INFINITY,
  now = () => Date.now(),
}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError('maxEntries must be a positive integer');
  }
  if (!(ttlMs > 0)) {
    throw new RangeError('ttlMs must be positive');
  }
  /** @type {Map<string, {value: V, expiresAt: number}>} */
  const items = new Map();

  /** @param {number} at */
  const dropExpiredFromOldest = (at) => {
    for (const [key, item] of items) {
      if (item.expiresAt > at) break;
      items.delete(key);
    }
  };

  return {
    /**
     * @param {string} key
     * @returns {V|undefined} The fresh value stored for `key`, if any.
     */
    get(key) {
      const item = items.get(key);
      if (!item) return undefined;
      items.delete(key);
      if (item.expiresAt <= now()) return undefined;
      items.set(key, item);
      return item.value;
    },
    /**
     * Store `value` as the most recently used entry, evicting the least
     * recently used past the cap.
     * @param {string} key
     * @param {V} value
     * @returns {V} The stored value.
     */
    set(key, value) {
      const at = now();
      items.delete(key);
      dropExpiredFromOldest(at);
      items.set(key, { value, expiresAt: at + ttlMs });
      while (items.size > maxEntries) {
        const oldest = items.keys().next().value;
        if (oldest === undefined) break;
        items.delete(oldest);
      }
      return value;
    },
    /** @param {string} key */
    delete(key) {
      return items.delete(key);
    },
    clear() {
      items.clear();
    },
    /**
     * Fresh entries, least recently used first; for persisting the cache.
     * @returns {Generator<[string, V]>}
     */
    *entries() {
      const at = now();
      for (const [key, item] of items) {
        if (item.expiresAt > at) yield [key, item.value];
      }
    },
    /** Entries held, including expired ones not yet dropped. */
    get size() {
      return items.size;
    },
  };
}
