/**
 * Public-address checks for outbound requests: which IP addresses are
 * globally routable, name resolution that refuses anything else, and a
 * request pinned to the addresses that passed, so a second DNS answer can't
 * swap in a private one.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

/** A host that resolves, or points, to an address requests may not use. */
export class PrivateAddressError extends Error {
  /** @param {string} hostname */
  constructor(hostname) {
    super(`${hostname} resolves to an address that is not allowed`);
    this.name = 'PrivateAddressError';
    this.hostname = hostname;
  }
}

/**
 * Whether a dotted-quad IPv4 address is outside the global unicast space:
 * private, loopback, link-local, shared, documentation, benchmarking,
 * multicast or reserved. A quad with an octet over 255 counts as non-global;
 * anything that isn't a dotted quad returns false.
 * @param {string} hostname
 */
export function isNonGlobalIpv4(hostname) {
  const pieces = hostname.split('.');
  if (pieces.length !== 4 || pieces.some((piece) => !/^\d{1,3}$/.test(piece))) {
    return false;
  }
  const values = pieces.map(Number);
  if (values.some((value) => value > 255)) return true;
  const [a, b, c] = values;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/**
 * Whether a resolved IPv4 or IPv6 address is public: global unicast IPv4,
 * or IPv6 in 2000::/3 outside its special-purpose blocks. IPv4-mapped and
 * other embedded forms are refused.
 * @param {string} value
 */
export function isPublicAddress(value) {
  const address = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!address) return false;
  if (!address.includes(':')) {
    const ipv4 = address.split('.');
    return (
      ipv4.length === 4 &&
      ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) &&
      !isNonGlobalIpv4(address)
    );
  }
  const pieces = address.split('::');
  if (pieces.length > 2) return false;
  const left = pieces[0] ? pieces[0].split(':') : [];
  const right = pieces[1] ? pieces[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (
    (pieces.length === 1 && missing !== 0) ||
    (pieces.length === 2 && missing < 1)
  ) {
    return false;
  }
  const groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))
  ) {
    return false;
  }
  const numeric = groups.reduce(
    (total, group) => (total << 16n) | BigInt(`0x${group}`),
    0n,
  );
  /**
   * @param {string} text
   * @param {number} prefix
   */
  const cidr = (text, prefix) => {
    const base = text
      .split(':')
      .reduce(
        (total, group) => (total << 16n) | BigInt(`0x${group || '0'}`),
        0n,
      );
    const shift = 128n - BigInt(prefix);
    return numeric >> shift === base >> shift;
  };
  return (
    cidr('2000:0:0:0:0:0:0:0', 3) &&
    !cidr('2001:0:0:0:0:0:0:0', 23) &&
    !cidr('2001:db8:0:0:0:0:0:0', 32) &&
    !cidr('2002:0:0:0:0:0:0:0', 16) &&
    !cidr('3fff:0:0:0:0:0:0:0', 20)
  );
}

/**
 * Resolve a hostname and return its addresses, refusing the whole answer
 * when any address isn't public. An IP literal resolves to itself.
 * @param {string} hostname
 * @param {typeof dnsLookup} [lookup]
 * @returns {Promise<Array<{address: string, family: number}>>}
 */
export async function resolvePublicAddresses(hostname, lookup = dnsLookup) {
  const host = String(hostname).replace(/^\[|\]$/g, '');
  const resolved = await lookup(host, { all: true, verbatim: true });
  const rows = Array.isArray(resolved) ? resolved : [resolved];
  const addresses = rows
    .map((row) => {
      const address = String(row?.address || '');
      const family = Number(row?.family) || (address.includes(':') ? 6 : 4);
      return { address, family };
    })
    .filter((row) => row.address);
  if (
    !addresses.length ||
    addresses.some((row) => !isPublicAddress(row.address))
  ) {
    throw new PrivateAddressError(host);
  }
  return addresses;
}

/**
 * Make a request whose connection goes only to `addresses`, and return it as
 * a fetch Response. The hostname still names the server in the Host header
 * and for TLS. Redirects are returned, never followed.
 * @param {URL | string} url
 * @param {{method?: string, headers?: Record<string, string>, signal?: AbortSignal}} init
 * @param {Array<{address: string, family: number}>} addresses
 * @returns {Promise<Response>}
 */
export function requestPinned(url, init, addresses) {
  const target = url instanceof URL ? url : new URL(url);
  const client = target.protocol === 'http:' ? http : https;
  const { method = 'GET', headers, signal } = init ?? {};
  const [first] = addresses;
  return new Promise((resolve, reject) => {
    const request = client.request(
      target,
      {
        method,
        headers,
        signal,
        lookup(_hostname, options, callback) {
          if (options?.all) callback(null, addresses);
          else callback(null, first.address, first.family);
        },
      },
      (response) => {
        try {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) {
              for (const item of value) responseHeaders.append(name, item);
            } else if (value !== undefined) {
              responseHeaders.set(name, String(value));
            }
          }
          const status = response.statusCode || 502;
          // A Response can't carry a body with these statuses.
          const bodyless = status === 204 || status === 205 || status === 304;
          if (bodyless) response.resume();
          resolve(
            new Response(bodyless ? null : Readable.toWeb(response), {
              status,
              headers: responseHeaders,
            }),
          );
        } catch (error) {
          // An unusable status line or header; drop the connection.
          response.destroy();
          reject(error);
        }
      },
    );
    request.on('error', reject);
    request.end();
  });
}
