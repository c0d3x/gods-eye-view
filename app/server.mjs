/**
 * The Mac app's local server: Vite's preview server, serving the built app
 * from `dist/` and every `/api` route from the same plugins `pnpm run dev`
 * uses, on 127.0.0.1 only.
 *
 * The plugin list follows server/standalone/vite.config.js, without its
 * dotenv loading: the app's keys come from its own store (app/keyStore.mjs),
 * not from `.env` files. Two plugins are the app's own: Provider Settings on
 * that store, and the runtime config that gives the page its browser keys.
 */

import path from 'node:path';
import { preview } from 'vite';
import { createBrowserViteConfig } from '../build/vite.js';
import { localMcpPlugin } from '../server/mcp/plugin.js';
import { localProviderPlugins } from '../server/providers/local.js';
import { apiNotFoundPlugin } from '../server/standalone/api-not-found.js';
import { keySetupEndpoint } from '../server/standalone/key-setup.js';
import { standaloneVoiceTools } from '../server/standalone/voiceTools.js';
import { runtimeConfigFrom, runtimeConfigPlugin } from './runtimeConfig.mjs';

/** The port MCP clients expect; the next free one when it is taken. */
const APP_PORT = 4173;

/**
 * @typedef {object} AppServerOptions
 * @property {string} root The app's files: `dist/`, `server/`, `src/` and the rest.
 * @property {{name: string, read: () => string, write: (text: string) => void}} store
 * @property {() => void} onSaved Called after Provider Settings saves a key.
 * @property {NodeJS.ProcessEnv} [env]
 * @property {number} [port]
 */

/**
 * The preview server's inline config.
 * @param {AppServerOptions} options
 * @returns {import('vite').InlineConfig}
 */
export function appViteConfig({
  root,
  store,
  onSaved,
  env = process.env,
  port = APP_PORT,
}) {
  // build/vite.js has no JSDoc for these options, and TypeScript's inference
  // from its defaults leaves out the ones without a default.
  const options = /** @type {any} */ ({
    plugins: [
      ...localProviderPlugins({ realtime: { tools: standaloneVoiceTools() } }),
      localMcpPlugin(),
      apiNotFoundPlugin(),
      // Before the provider routes and the /api 404, after the Host check and
      // the cross-site guard (pre plugins keep their order).
      { ...keySetupEndpoint({ store, onSaved }), enforce: 'pre' },
      runtimeConfigPlugin({
        outDir: path.join(root, 'dist'),
        getConfig: () => runtimeConfigFrom(env),
      }),
    ],
    // The page gets these from the runtime config instead.
    googleApiKey: '',
    cesiumToken: '',
    mapillaryToken: '',
    realtimeDebugLog: false,
    host: '127.0.0.1',
    port,
    command: 'serve',
  });
  const config = createBrowserViteConfig(options);
  return {
    ...config,
    root,
    configFile: false,
    envDir: false,
    logLevel: 'warn',
    preview: {
      ...config.preview,
      host: '127.0.0.1',
      port,
      strictPort: false,
      open: false,
    },
  };
}

/**
 * Starts the server and resolves once it listens.
 * @param {AppServerOptions} options
 */
export async function startAppServer(options) {
  const server = await preview(appViteConfig(options));
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') {
    await server.close();
    throw new Error('The app server is not listening on a TCP port');
  }
  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}/`,
    close: () => server.close(),
  };
}
