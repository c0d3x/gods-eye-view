/**
 * @file Load a binary file shipped beside the source modules.
 *
 * The bytes counterpart of `bundledJson.js`. The browser fetches the file from
 * `url` — a `new URL('./…', import.meta.url)` written in the calling module,
 * which Vite serves as-is in dev and emits as an asset in the production
 * build. Under Node (node:test) that URL is a `file:` URL, which `fetch`
 * cannot read, so the file is read from disk instead.
 *
 * @module data/bundledBytes
 */

/**
 * @param {URL} url - Resolved against the calling module's `import.meta.url`.
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<Uint8Array<ArrayBuffer>>} The file's bytes, exactly as
 *   served.
 */
export async function loadBundledBytes(url, { signal } = {}) {
  signal?.throwIfAborted();
  if (url.protocol === 'file:') {
    // Node's built-in, reached without an import, so the browser build never
    // bundles or rewrites it. The read is synchronous, as in bundledJson.js,
    // so the result settles without waiting on the event loop.
    /** @type {{getBuiltinModule?: Function, version?: string} | undefined} */
    const nodeProcess = /** @type {any} */ (globalThis).process;
    const getBuiltinModule = nodeProcess?.getBuiltinModule;
    if (typeof getBuiltinModule !== 'function')
      throw new Error(
        `God's Eye View needs Node 24.14 or newer to read ${url.pathname.split('/').pop()} (running ${nodeProcess?.version ?? 'an unknown runtime'})`,
      );
    const { readFileSync } = getBuiltinModule('node:fs');
    return new Uint8Array(readFileSync(url));
  }
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url.pathname}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}
