// @ts-check
/**
 * Data files that ship with the app, read by URL in the browser and under Node
 * alike. A module names its file with
 * `new URL('./local_data/…', import.meta.url)`: Vite emits the file as a static
 * asset and rewrites the URL, so the browser fetches it when it is first needed
 * and never parses it as JavaScript. Node's fetch() cannot read `file:` URLs,
 * so there the file system reads them instead, through
 * process.getBuiltinModule, which keeps any `node:` import out of the browser
 * bundle. That read is synchronous, like the module imports it replaces: under
 * Node those resolved without waiting for the event loop, and tests that wait
 * out only microtasks rely on that.
 */

/**
 * A data file's bytes.
 * @param {URL} url - The file's URL, built from `import.meta.url`.
 * @returns {Promise<Uint8Array>}
 */
export async function readLocalAsset(url) {
  if (url.protocol === 'file:') {
    // @ts-expect-error Node only; the browser project has no Node types.
    const { readFileSync } = globalThis.process.getBuiltinModule('node:fs');
    return new Uint8Array(readFileSync(url));
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url.pathname}: HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * A data file parsed as JSON.
 * @param {URL} url - The file's URL, built from `import.meta.url`.
 * @returns {Promise<*>}
 */
export async function readLocalJson(url) {
  return JSON.parse(new TextDecoder().decode(await readLocalAsset(url)));
}
