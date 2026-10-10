import https from 'node:https';
import { Readable } from 'node:stream';
import { isPublicAddress } from '../common/public-address.js';
export function radioMirrorOrigin(value) {
  const hostname = String(value ?? '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (!/^[a-z0-9-]+\.api\.radio-browser\.info$/.test(hostname)) return null;
  return `https://${hostname}`;
}

/** Return whether a resolved Radio Browser address is safe for an outbound request. */
export function isPublicRadioAddress(value) {
  return isPublicAddress(value);
}

export function radioProxyDestination(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return null;
  }
  const origin = radioMirrorOrigin(url.hostname);
  if (
    !origin ||
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  )
    return null;
  const discovery =
    url.hostname.toLowerCase() === 'all.api.radio-browser.info' &&
    url.pathname === '/json/servers' &&
    !url.search;
  const directory = url.pathname === '/json/stations/search';
  const click = /^\/json\/url\/[0-9a-f-]+$/i.test(url.pathname) && !url.search;
  return discovery || directory || click ? url : null;
}

export async function resolveRadioProxyAddresses(hostname, lookupImpl) {
  const resolved = await lookupImpl(hostname, { all: true, verbatim: true });
  const rows = Array.isArray(resolved) ? resolved : [resolved];
  const addresses = rows
    .map((row) => ({
      address: String(row?.address || ''),
      family: Number(row?.family) || undefined,
    }))
    .filter((row) => row.address);
  if (
    !addresses.length ||
    addresses.some((row) => !isPublicRadioAddress(row.address))
  ) {
    throw new Error('Radio Browser resolved to a forbidden address');
  }
  return addresses;
}

export function fetchPinnedRadioResponse(url, options, addresses) {
  return new Promise((resolve, reject) => {
    const address = addresses[0];
    const request = https.request(
      url,
      {
        method: 'GET',
        headers: options.headers,
        signal: options.signal,
        lookup(_hostname, lookupOptions, callback) {
          if (lookupOptions?.all) callback(null, addresses);
          else callback(null, address.address, address.family);
        },
      },
      (response) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value))
            value.forEach((item) => headers.append(name, item));
          else if (value !== undefined) headers.set(name, String(value));
        }
        resolve(
          new Response(Readable.toWeb(response), {
            status: response.statusCode || 500,
            statusText: response.statusMessage || '',
            headers,
          }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}
