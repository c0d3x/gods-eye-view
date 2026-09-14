/**
 * Return the existing promise for a cache key, or create one and remove it
 * only when that exact promise settles.
 * @template T
 * @param {Map<string, Promise<T>>} inFlight
 * @param {string} key
 * @param {() => T | PromiseLike<T>} create
 */
export function coalesceProxyRequest(inFlight, key, create) {
  const existing = inFlight.get(key);
  if (existing) return { promise: existing, shared: true };
  /** @type {Promise<T>} */
  let promise;
  promise = Promise.resolve()
    .then(create)
    .finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return { promise, shared: false };
}
