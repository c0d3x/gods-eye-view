/**
 * Values the dev server keeps on globalThis, so they survive an in-process
 * re-evaluation of vite.config.js. See server/keySetupEndpoint.mjs.
 */
declare var __GEV_PROVIDER_ENV_AT_BOOT:
  | Readonly<Record<string, string>>
  | undefined;
