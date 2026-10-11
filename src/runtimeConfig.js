/**
 * Browser keys given to the page when it loads.
 *
 * The Mac app serves them as `window.__GEV_RUNTIME_CONFIG__`
 * (app/runtimeConfig.mjs), so a key saved in the app works without
 * rebuilding. The web build has no runtime config and keeps the values Vite
 * baked in.
 *
 * @param {string} name The environment variable the key comes from.
 * @param {string | undefined} builtValue The value Vite baked in, if any.
 * @returns {string | undefined}
 */
export function runtimeKey(name, builtValue) {
  const config = /** @type {Record<string, unknown> | undefined} */ (
    /** @type {any} */ (globalThis).__GEV_RUNTIME_CONFIG__
  );
  const value = config?.[name];
  return typeof value === 'string' ? value : builtValue;
}
