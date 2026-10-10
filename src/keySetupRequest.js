/**
 * The way into Provider Settings from elsewhere in the shell.
 *
 * Provider Settings exists only on a local dev server: keySetup.js removes
 * #key-setup wherever its status endpoint is unavailable. A surface that
 * offers to open it (the KEY REQUIRED banner's ADD KEY button) asks through a
 * document event, so it never imports the dev-only module.
 */
import { KEY_SETUP_KEYS } from './keySetupCore.mjs';

/** Document event keySetup.js answers by opening the dialog. */
export const KEY_SETUP_OPEN_EVENT = 'gev:open-key-setup';

/**
 * The KEY REQUIRED banner's detail: the variables the missing key sets, from
 * the key registry. An unnamed, unknown or hidden key returns '' rather than
 * guessing, as the layer row's tooltip does.
 * @param {string | undefined} id
 */
export function keyRequiredDetail(id) {
  /** @type {{hidden?: boolean, envVars: readonly string[]} | undefined} */
  const entry = KEY_SETUP_KEYS.find((candidate) => candidate.id === id);
  if (!entry || entry.hidden) return '';
  return `Needs ${entry.envVars.join(' + ')}`;
}

/** Whether this page has a Provider Settings dialog to open. */
export function isKeySetupAvailable(documentRef = globalThis.document) {
  return Boolean(documentRef?.getElementById?.('key-setup'));
}

/** Ask Provider Settings to open; nothing happens where it does not exist. */
export function requestKeySetup(documentRef = globalThis.document) {
  documentRef?.dispatchEvent?.(new CustomEvent(KEY_SETUP_OPEN_EVENT));
}
