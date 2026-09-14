/**
 * GBFS (General Bikeshare Feed Specification) proxy: /api/gbfs/<encoded URL>
 * relays a station feed from an allowlisted https host.
 */

import {
  fetchWithTimeout,
  upstreamErrorMessage,
  upstreamErrorStatus,
} from '../lib/fetchWithTimeout.mjs';
import { errorMessage } from '../lib/thrownErrors.mjs';
import { readResponseTextWithin } from '../lib/upstreamBody.mjs';

/** Upstream fetch timeout for GBFS requests (ms). */
const GBFS_PROXY_TIMEOUT_MS = 12000;
/** Allowlisted GBFS hostnames; wildcard *.publicbikesystem.net also accepted. */
const GBFS_ALLOWED_HOSTS = new Set([
  'gbfs.lyft.com',
  'gbfs.bluebikes.com',
  'gbfs.bcycle.com',
  'gbfs.biketownpdx.com',
  'gbfs.cogobikeshare.com',
  'austin.publicbikesystem.net',
  'hon.publicbikesystem.net',
  'chat.publicbikesystem.net',
]);

/**
 * Check whether a hostname is in the GBFS allowlist.
 *
 * Also accepts any subdomain of publicbikesystem.net.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
function isAllowedGbfsHost(hostname) {
  const host = String(hostname || '')
    .trim()
    .toLowerCase();
  if (!host) return false;
  if (GBFS_ALLOWED_HOSTS.has(host)) return true;
  return host.endsWith('.publicbikesystem.net');
}

/**
 * Only allow station_information.json and station_status.json endpoints.
 *
 * @param {string} pathname
 * @returns {boolean}
 */
function isAllowedGbfsPath(pathname) {
  return /\/station_(information|status)\.json$/i.test(String(pathname || ''));
}

/**
 * Return an appropriate Cache-Control header for a GBFS endpoint.
 *
 * station_information is semi-static (5 min cache); station_status is
 * real-time (no-store).
 *
 * @param {string} pathname
 * @returns {string} Cache-Control header value.
 */
function gbfsCacheControl(pathname) {
  if (/\/station_information\.json$/i.test(String(pathname || ''))) {
    return 'public, max-age=300';
  }
  return 'no-store';
}

/**
 * Vite plugin: GBFS bike-share proxy with host allowlisting and size limits.
 *
 * Accepts GET /api/gbfs/<encoded-upstream-URL> and proxies the request
 * to the upstream GBFS provider. Validates hostname against an allowlist,
 * restricts to station_information/station_status paths, enforces HTTPS,
 * and caps response body at 5 MB.
 *
 * @returns {import('vite').Plugin}
 */
export function gbfsProxy() {
  return {
    name: 'gbfs-proxy',
    configureServer(server) {
      server.middlewares.use('/api/gbfs', async (req, res) => {
        try {
          if (req.method !== 'GET') {
            res.writeHead(405, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            });
            res.end(JSON.stringify({ error: 'Method Not Allowed' }));
            return;
          }

          const url = new URL(req.url || '/', 'http://localhost');
          const encodedTarget = url.pathname.replace(/^\/+/, '');
          if (!encodedTarget) {
            res.writeHead(400, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            });
            res.end(JSON.stringify({ error: 'Missing GBFS upstream target' }));
            return;
          }

          let decodedTarget = '';
          try {
            decodedTarget = decodeURIComponent(encodedTarget);
          } catch {
            res.writeHead(400, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            });
            res.end(JSON.stringify({ error: 'Invalid GBFS target encoding' }));
            return;
          }

          /** @type {URL|null} */
          let upstreamUrl = null;
          try {
            upstreamUrl = new URL(decodedTarget);
          } catch {
            res.writeHead(400, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            });
            res.end(JSON.stringify({ error: 'Invalid GBFS upstream URL' }));
            return;
          }

          if (upstreamUrl.protocol !== 'https:') {
            res.writeHead(400, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            });
            res.end(
              JSON.stringify({ error: 'Only https GBFS targets are allowed' }),
            );
            return;
          }

          if (!isAllowedGbfsHost(upstreamUrl.hostname)) {
            res.writeHead(403, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            });
            res.end(JSON.stringify({ error: 'GBFS host not allowed' }));
            return;
          }

          if (!isAllowedGbfsPath(upstreamUrl.pathname)) {
            res.writeHead(400, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            });
            res.end(
              JSON.stringify({
                error:
                  'Only station_information/station_status endpoints are allowed',
              }),
            );
            return;
          }

          // The deadline covers the body too, so a feed can't trickle it out.
          const upstream = await fetchWithTimeout(
            upstreamUrl.toString(),
            {
              method: 'GET',
              headers: {
                Accept: 'application/json',
                'User-Agent': 'gods-eye-view-gbfs-proxy/1.0',
              },
            },
            { timeoutMs: GBFS_PROXY_TIMEOUT_MS },
          );

          // Limit response size to prevent memory exhaustion from malicious upstream
          const GBFS_MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB
          const { tooLarge, text: body } = await readResponseTextWithin(
            upstream,
            GBFS_MAX_BODY_BYTES,
          );
          if (tooLarge) {
            res.writeHead(502, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            });
            res.end(
              JSON.stringify({ error: 'GBFS upstream response too large' }),
            );
            return;
          }
          if (!upstream.ok) {
            // Never relay the feed's own error page or text.
            res.writeHead(upstream.status, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            });
            res.end(
              JSON.stringify({
                error: upstreamErrorMessage('GBFS feed', upstream.status),
              }),
            );
            return;
          }
          const contentType =
            upstream.headers.get('content-type') || 'application/json';
          res.writeHead(upstream.status, {
            'Content-Type': contentType,
            'Cache-Control': gbfsCacheControl(upstreamUrl.pathname),
            'X-GBFS-Upstream': upstreamUrl.hostname,
            'X-GBFS-Cache': 'MISS',
          });
          res.end(body);
        } catch (error) {
          if (upstreamErrorStatus(error) === 504) {
            res.writeHead(504, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            });
            res.end(JSON.stringify({ error: 'GBFS upstream timeout' }));
            return;
          }
          console.error('[GBFS Proxy]', errorMessage(error) || String(error));
          res.writeHead(502, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({ error: 'GBFS proxy error' }));
        }
      });
    },
  };
}
