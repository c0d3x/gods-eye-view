/**
 * The browser keys, given to the page when it loads instead of baked into the
 * build.
 *
 * The web build bakes GOOGLE_MAPS_API_KEY, CESIUM_ION_TOKEN and
 * MAPILLARY_CLIENT_TOKEN in as Vite defines (build/vite.js). The Mac app's
 * build is made once, without keys, so a key saved in the app reaches the
 * page through a small script this plugin serves, which sets
 * `window.__GEV_RUNTIME_CONFIG__` (read by src/runtimeConfig.js). The plugin
 * adds that script to the app's and the MCP panel's HTML. These are the keys
 * the web build already exposes to the browser; no server-only key is here.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/** Where the page loads the config from. Not under `/__`, which the MCP panel's requests refuse. */
export const RUNTIME_CONFIG_PATH = '/gev-runtime-config.js';

/** The browser keys, by the names src/runtimeConfig.js reads. */
export const RUNTIME_KEYS = Object.freeze([
  'GOOGLE_MAPS_API_KEY',
  'CESIUM_ION_TOKEN',
  'MAPILLARY_CLIENT_TOKEN',
]);

/** The documents that get the config script: the app and the MCP panel. */
const DOCUMENTS = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/panel/', 'panel/index.html'],
  ['/panel/index.html', 'panel/index.html'],
]);

/**
 * The browser keys from an environment, '' for any that is not set.
 * @param {NodeJS.ProcessEnv} env
 */
export function runtimeConfigFrom(env) {
  return Object.fromEntries(
    RUNTIME_KEYS.map((name) => [name, String(env[name] ?? '').trim()]),
  );
}

/**
 * The script that publishes the config. `<` is escaped so a value can never
 * close a script element.
 * @param {Record<string, string>} config
 */
export function runtimeConfigScript(config) {
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  return `window.__GEV_RUNTIME_CONFIG__ = Object.freeze(${json});\n`;
}

/**
 * Adds the config script as the first element of `<head>`, so it runs before
 * every other script on the page.
 * @param {string} html
 */
export function injectRuntimeConfig(html) {
  const tag = `<script src="${RUNTIME_CONFIG_PATH}"></script>`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (!head) throw new Error('The page has no <head> to load the config in');
  const at = head.index + head[0].length;
  return `${html.slice(0, at)}\n    ${tag}${html.slice(at)}`;
}

/**
 * Vite plugin for the app's preview server.
 * @param {object} options
 * @param {string} options.outDir The built app (`dist/`).
 * @param {() => Record<string, string>} options.getConfig Read on every request,
 *   so a key saved in Provider Settings is in the next page load.
 * @returns {import('vite').Plugin}
 */
export function runtimeConfigPlugin({ outDir, getConfig }) {
  return {
    name: 'gev-app-runtime-config',
    configurePreviewServer(server) {
      const headers = server.config.preview.headers ?? {};
      server.middlewares.use(async (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const pathname = (req.url ?? '/').split('?')[0];
        if (pathname === RUNTIME_CONFIG_PATH) {
          const body = runtimeConfigScript(getConfig());
          res.writeHead(200, {
            ...headers,
            'Content-Type': 'text/javascript; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(req.method === 'HEAD' ? undefined : body);
          return;
        }
        const document = DOCUMENTS.get(pathname);
        if (!document) return next();
        let html;
        try {
          html = await fs.readFile(path.join(outDir, document), 'utf8');
        } catch {
          return next();
        }
        const body = injectRuntimeConfig(html);
        res.writeHead(200, {
          ...headers,
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(req.method === 'HEAD' ? undefined : body);
      });
    },
  };
}
