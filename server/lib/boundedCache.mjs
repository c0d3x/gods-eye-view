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
  const entries = new Map();

  const dropExpired = (at) => {
    for (const [key, entry] of entries) {
      if (entry.expiresAt > at) break;
      entries.delete(key);
    }
  };

  return {
    /**
     * @param {string} key
     * @returns {V|undefined} The fresh value stored for `key`, if any.
     */
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    /**
     * Store `value` as the newest entry, evicting the oldest past the cap.
     * @param {string} key
     * @param {V} value
     * @returns {V} The stored value.
     */
    set(key, value) {
      const at = now();
      entries.delete(key);
      dropExpired(at);
      entries.set(key, { value, expiresAt: at + ttlMs });
      while (entries.size > maxEntries) {
        entries.delete(entries.keys().next().value);
      }
      return value;
    },
    /** @param {string} key */
    delete(key) {
      return entries.delete(key);
    },
    clear() {
      entries.clear();
    },
    /** Entries held, including expired ones not yet dropped. */
    get size() {
      return entries.size;
    },
  };
}
