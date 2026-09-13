import os from 'node:os';

/**
 * Host names the dev server answers to, in every mode (LAN included).
 *
 * Vite always accepts IP addresses, `localhost` and `*.localhost`; any other
 * name must be listed. That Host check is what stops DNS rebinding from
 * reaching the API routes, so the list holds only this machine's own names —
 * its hostname and its `<name>.local` mDNS name — plus any names in
 * GEV_ALLOWED_HOSTS. Names are lowercased because browsers send them that
 * way and Vite compares them exactly.
 *
 * @param {object} [options]
 * @param {string} [options.hostname] This machine's hostname.
 * @param {string} [options.extra] Comma-separated extra names
 *   (GEV_ALLOWED_HOSTS); a leading dot also allows every subdomain.
 * @returns {string[]}
 */
export function resolveAllowedHosts({
  hostname = os.hostname(),
  extra = '',
} = {}) {
  const names = new Set(['localhost', '127.0.0.1']);
  const own = String(hostname ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  if (own) {
    const base = own.split('.')[0];
    names.add(own);
    if (base) {
      names.add(base);
      names.add(`${base}.local`);
    }
  }
  for (const entry of String(extra ?? '').split(',')) {
    const name = entry.trim().toLowerCase();
    // Host names only: a scheme, port, path or space would never match.
    if (name && !/[\s/:]/.test(name)) names.add(name);
  }
  return [...names];
}
