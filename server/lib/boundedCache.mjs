/**
 * A small in-memory cache with a size cap and a time to live.
 *
 * Entries expire `ttlMs` after they were stored. When the cache is full the
 * oldest entry is evicted first, and storing a key again makes it the newest.
 * Every entry shares one time to live, so the oldest entries are also the
 * first to expire; each write drops expired entries from the front.
 */

/**
 * @template V
 * @param {object} options
 * @param {number} options.maxEntries Most entries kept at once (at least 1).
 * @param {number} options.ttlMs How long an entry stays fresh, in ms.
 * @param {() => number} [options.now] Clock; reads Date.now() at call time.
 */
export function createBoundedCache({
  maxEntries,
  ttlMs,
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
  const dropExpired = (at) => {
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
      if (item.expiresAt <= now()) {
        items.delete(key);
        return undefined;
      }
      return item.value;
    },
    /**
     * Store `value` as the newest entry, evicting the oldest past the cap.
     * @param {string} key
     * @param {V} value
     * @returns {V} The stored value.
     */
    set(key, value) {
      const at = now();
      items.delete(key);
      dropExpired(at);
      items.set(key, { value, expiresAt: at + ttlMs });
      while (items.size > maxEntries) {
        items.delete(items.keys().next().value);
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
     * Fresh entries, oldest first; for persisting the cache.
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
