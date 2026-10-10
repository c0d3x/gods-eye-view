/**
 * The provider keys the launchers and the setup doctor resolve, and the macOS
 * Keychain items each may live in, in lookup order. This is the one place the
 * Keychain is read: scripts/dev-fresh.sh goes through
 * scripts/read-keychain-value.mjs, and scripts/setup-doctor.mjs and the voice
 * benchmark's keys import it.
 */

import { spawnSync } from 'node:child_process';

/** Every OpenSky Keychain service, with each of the `accounts` in turn. */
const openSkyItems = (accounts) =>
  ['opensky-network', 'opensky'].flatMap((service) =>
    accounts.map((account) => [service, account]),
  );

export const CREDENTIALS = Object.freeze([
  {
    name: 'GOOGLE_MAPS_API_KEY',
    label: 'Google Maps',
    keychain: [
      ['google-maps-api', 'api-key'],
      ['google-maps-api', 'default'],
      ['google-maps-api', 'key'],
    ],
  },
  {
    name: 'GOOGLE_MAPS_SERVER_API_KEY',
    label: 'Google Places / Street View server',
    keychain: [],
  },
  {
    name: 'CESIUM_ION_TOKEN',
    label: 'Cesium ion',
    keychain: [['cesium-ion', 'token']],
  },
  {
    name: 'OPENAI_API_KEY',
    label: 'OpenAI voice',
    keychain: [['openai-api', 'api-key']],
  },
  {
    name: 'AISSTREAM_API_KEY',
    label: 'AISStream vessels',
    keychain: [['aisstream-api', 'api-key']],
  },
  {
    name: 'FIRMS_MAP_KEY',
    label: 'NASA FIRMS fires',
    keychain: [['firms-map', 'map-key']],
  },
  {
    name: 'TOMTOM_API_KEY',
    label: 'TomTom traffic',
    keychain: [['tomtom-api', 'api-key']],
  },
  {
    name: 'OPENSKY_CLIENT_ID',
    label: 'OpenSky client ID',
    keychain: openSkyItems(['client_id', 'client-id', 'client', 'api-key']),
  },
  {
    name: 'OPENSKY_CLIENT_SECRET',
    label: 'OpenSky client secret',
    keychain: openSkyItems(['client_secret', 'client-secret', 'secret']),
  },
  { name: 'LL2_API_TOKEN', label: 'Launch Library 2', keychain: [] },
  {
    name: 'MAPILLARY_CLIENT_TOKEN',
    label: 'Mapillary street level',
    keychain: [
      ['mapillary', 'client-token'],
      ['mapillary', 'token'],
    ],
  },
]);

/**
 * Looks one Keychain item up with `security find-generic-password`. With
 * `reveal`, returns the secret, which arrives on stdout and never enters an
 * argument list; without it, returns whether the item exists. Off macOS there
 * is no Keychain.
 */
export function findKeychainItem(
  service,
  account,
  { reveal = false, spawn = spawnSync, platform = process.platform } = {},
) {
  if (platform !== 'darwin') return reveal ? '' : false;
  const args = ['find-generic-password', '-s', service, '-a', account];
  if (reveal) args.push('-w');
  const result = spawn('security', args, {
    encoding: 'utf8',
    stdio: ['ignore', reveal ? 'pipe' : 'ignore', 'ignore'],
  });
  if (!reveal) return result.status === 0;
  return result.status === 0
    ? String(result.stdout ?? '').replace(/\r?\n$/, '')
    : '';
}

/**
 * The first Keychain value for a provider key, from its items in order.
 * @param {string} name - A provider key, such as OPENAI_API_KEY.
 * @returns {string} The value, or '' when no item holds one.
 */
export function readKeychainValue(name, options = {}) {
  const spec = CREDENTIALS.find((entry) => entry.name === name);
  for (const [service, account] of spec?.keychain ?? []) {
    const value = findKeychainItem(service, account, {
      ...options,
      reveal: true,
    });
    if (value) return value;
  }
  return '';
}
