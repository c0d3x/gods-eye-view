/**
 * The Mac app's rules for links, permissions and the environment, kept apart
 * from Electron so they can be tested in Node.
 */

import path from 'node:path';

/** The app's bundle identifier; also names its cache folder. */
export const APP_ID = 'io.github.c0d3x.gods-eye-view';

/**
 * The origin of the app's own server, or '' before it runs.
 * @param {string | null | undefined} appUrl
 */
export function appOrigin(appUrl) {
  try {
    return appUrl ? new URL(appUrl).origin : '';
  } catch {
    return '';
  }
}

/**
 * Whether a URL is on the app's own server.
 * @param {string | null | undefined} url
 * @param {string | null | undefined} appUrl
 */
export function isAppUrl(url, appUrl) {
  const origin = appOrigin(appUrl);
  if (!origin || !url) return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Whether a link may open in the default browser: http or https, and not the
 * app's own server.
 * @param {string} url
 * @param {string | null | undefined} appUrl
 */
export function isExternalLink(url, appUrl) {
  try {
    const { protocol } = new URL(url);
    return (
      (protocol === 'https:' || protocol === 'http:') && !isAppUrl(url, appUrl)
    );
  } catch {
    return false;
  }
}

/**
 * PATH for the server, with the folders where Homebrew, npm and Codex
 * install their tools added after whatever the app was given. A Finder launch
 * gets only the system folders, and ChatGPT sign-in runs `codex`, an npm
 * tool that needs `node` too.
 * @param {string | undefined} current
 * @param {string} home
 */
export function toolPath(current, home) {
  const entries = String(current ?? '')
    .split(path.delimiter)
    .filter(Boolean);
  for (const folder of [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.codex', 'bin'),
    path.join(home, 'Library', 'pnpm'),
    '/usr/bin',
    '/bin',
  ]) {
    if (!entries.includes(folder)) entries.push(folder);
  }
  return entries.join(path.delimiter);
}

/**
 * A USB device's name in the chooser.
 * @param {{productName?: string, manufacturerName?: string, vendorId: number, productId: number}} device
 */
export function usbDeviceLabel(device) {
  const hex = (/** @type {number} */ value) =>
    value.toString(16).padStart(4, '0');
  const name = [device.manufacturerName, device.productName]
    .filter(Boolean)
    .join(' ');
  return `${name || 'USB device'} (${hex(device.vendorId)}:${hex(device.productId)})`;
}
