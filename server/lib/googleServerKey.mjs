/** Resolve server credentials after applying environment overrides per key. */
export function resolveGoogleServerKey(environment = {}, defaults = {}) {
  const value = (name) =>
    String(environment[name] ?? defaults[name] ?? '').trim();
  return value('GOOGLE_MAPS_SERVER_API_KEY') || value('GOOGLE_MAPS_API_KEY');
}

/**
 * Google API key for the SERVER-SIDE calls (Places nearby/text search, the
 * CCTV Street View fallback). These never reach the browser, so this key can
 * be restricted by server IP and scoped to Places API + Street View Static
 * API — while GOOGLE_MAPS_API_KEY stays referrer-restricted to Map Tiles +
 * Geocoding for the browser (#33). Splitting them is opt-in: unset, this
 * falls back to the shared browser key and nothing changes.
 */
export function googleServerApiKey(environment = process.env) {
  return resolveGoogleServerKey(environment);
}
