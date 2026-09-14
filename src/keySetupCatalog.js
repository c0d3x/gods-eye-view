/**
 * The provider keys Provider Settings (the POWER UP panel) offers, and what
 * each one unlocks.
 *
 * Browser code reads this for tooltips and loading feedback. The dev server's
 * key setup (server/keySetupCore.mjs) builds its status payload and its list
 * of writable variables from it. Nothing here touches the filesystem, the
 * network or process.env, so both sides can import it.
 */

/**
 * @typedef {object} KeySetupEntry
 * @property {string} id
 * @property {string} title
 * @property {string} unlocks What the key turns on.
 * @property {string} getUrl Where to get the key.
 * @property {readonly string[]} envVars
 * @property {'metered'|'free'} tier
 * @property {boolean} [clientExposed]
 */

/**
 * Every key the panel offers, in the order it offers them — most magic per
 * minute first. `tier` mirrors the README's color legend: 'metered' (🔴) is a
 * billing-enabled account, 'free' (🟡) is a register-and-paste key.
 * `clientExposed` marks the two keys that are injected into the browser
 * bundle by design (restrict them at the provider, per SECURITY.md).
 * @type {readonly KeySetupEntry[]}
 */
export const KEY_SETUP_KEYS = Object.freeze([
  Object.freeze({
    id: 'google-maps',
    title: 'GOOGLE MAPS — BROWSER',
    unlocks: 'The photorealistic 3D planet + place search',
    getUrl: 'https://developers.google.com/maps/documentation/tile/get-api-key',
    envVars: Object.freeze(['GOOGLE_MAPS_API_KEY']),
    tier: 'metered',
    clientExposed: true,
  }),
  Object.freeze({
    id: 'google-maps-server',
    title: 'GOOGLE MAPS — SERVER',
    unlocks: 'Places context + Street View fallback; optional separate key',
    getUrl:
      'https://developers.google.com/maps/documentation/places/web-service/get-api-key',
    envVars: Object.freeze(['GOOGLE_MAPS_SERVER_API_KEY']),
    tier: 'metered',
  }),
  Object.freeze({
    id: 'openai',
    title: 'OPENAI',
    unlocks: 'Voice control — talk to the planet',
    getUrl: 'https://platform.openai.com/api-keys',
    envVars: Object.freeze(['OPENAI_API_KEY']),
    tier: 'metered',
  }),
  Object.freeze({
    id: 'aisstream',
    title: 'AISSTREAM',
    unlocks: 'Live ships, worldwide',
    getUrl: 'https://aisstream.io',
    envVars: Object.freeze(['AISSTREAM_API_KEY']),
    tier: 'free',
  }),
  Object.freeze({
    id: 'firms',
    title: 'NASA FIRMS',
    unlocks: 'Live active-fire detections',
    getUrl: 'https://firms.modaps.eosdis.nasa.gov/api/map_key/',
    envVars: Object.freeze(['FIRMS_MAP_KEY']),
    tier: 'free',
  }),
  Object.freeze({
    id: 'tomtom',
    title: 'TOMTOM',
    unlocks: 'Real live traffic (keyless runs a simulation)',
    getUrl: 'https://developer.tomtom.com',
    envVars: Object.freeze(['TOMTOM_API_KEY']),
    tier: 'free',
  }),
  Object.freeze({
    id: 'cesium-ion',
    title: 'CESIUM ION',
    unlocks: 'Bing imagery map stacks + world terrain',
    getUrl: 'https://ion.cesium.com/tokens',
    envVars: Object.freeze(['CESIUM_ION_TOKEN']),
    tier: 'free',
    clientExposed: true,
  }),
  Object.freeze({
    id: 'opensky',
    title: 'OPENSKY',
    unlocks: 'More flight-polling credits (anonymous works without)',
    getUrl: 'https://opensky-network.org',
    envVars: Object.freeze(['OPENSKY_CLIENT_ID', 'OPENSKY_CLIENT_SECRET']),
    tier: 'free',
  }),
  Object.freeze({
    id: 'launch-library',
    title: 'LAUNCH LIBRARY',
    unlocks: 'Higher space-missions request allowance',
    getUrl: 'https://thespacedevs.com',
    envVars: Object.freeze(['LL2_API_TOKEN']),
    tier: 'free',
  }),
]);

/** @returns {Set<string>} every env var the panel is allowed to write. */
export function knownKeySetupEnvVars() {
  const names = new Set();
  for (const entry of KEY_SETUP_KEYS) {
    for (const envVar of entry.envVars) names.add(envVar);
  }
  return names;
}

/** Tooltip guidance for a control gated by one registry entry. */
export function keySetupRequirement(id) {
  const entry = KEY_SETUP_KEYS.find((candidate) => candidate.id === id);
  if (!entry) return '';
  return `Needs ${entry.envVars.join(' + ')} — add it in Provider Settings`;
}

/** The environment variables a key-setup entry needs, or none for an unknown id. */
export function keySetupEnvVars(id) {
  return KEY_SETUP_KEYS.find((candidate) => candidate.id === id)?.envVars || [];
}
