/**
 * The project page that upstream APIs ask clients to name as a contact point,
 * in the User-Agent (and Referer) the proxies send to CelesTrak, Nominatim,
 * Overpass instances and transit feeds. It names this fork, because its
 * operators are the people those services should contact.
 *
 * This module has no imports, so both the server providers and the shared
 * modules under `src/` can use it.
 */
export const PROJECT_URL = 'https://github.com/c0d3x/gods-eye-view';
