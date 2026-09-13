/**
 * Refuse cross-site requests to the dev server's `/api` routes.
 *
 * The dev server spends the configured provider keys on the page's behalf, so
 * another site's page must not be able to call those routes through the
 * user's browser. Modern browsers label every request with `Sec-Fetch-Site`;
 * browsers without it still send `Origin` on cross-origin requests. Requests
 * with neither header come from non-browser clients (curl, scripts, tests) and
 * pass; the per-IP rate limits bound those.
 */

/** `Sec-Fetch-Site` values sent by the app's own pages and by navigation. */
const ALLOWED_FETCH_SITES = new Set(['same-origin', 'none']);

/** Methods whose requests carry no body to check. */
const BODYLESS_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Routes that accept a form-encoded body. The Overpass proxy mirrors the
 * Overpass API, whose clients post `data=<query>` as a form.
 */
export const FORM_ENCODED_API_PATHS = Object.freeze(['/api/overpass']);

const REFUSAL_LOG_INTERVAL_MS = 60_000;
const REFUSAL_LOG_MAX_ROUTES = 100;

function headerValue(value) {
  return String(Array.isArray(value) ? value[0] : (value ?? '')).trim();
}

function pathnameOf(path) {
  return String(path ?? '').split('?')[0];
}

function mediaTypeOf(contentType) {
  return headerValue(contentType).split(';')[0].trim().toLowerCase();
}

function isJsonMediaType(type) {
  return type === 'application/json' || type.endsWith('+json');
}

function hasBody(headers) {
  return (
    Number(headerValue(headers['content-length']) || 0) > 0 ||
    headerValue(headers['transfer-encoding']) !== ''
  );
}

function acceptsForm(path, formEncodedPaths) {
  const route = pathnameOf(path);
  return formEncodedPaths.some(
    (prefix) => route === prefix || route.startsWith(`${prefix}/`),
  );
}

/** Replace anything that could steer a terminal when echoed to the log. */
function printable(text, limit = 120) {
  return String(text)
    .slice(0, limit)
    .replace(/[^\x20-\x7e]/g, '?');
}

function refusal(status, reason, error) {
  return { ok: false, status, reason, error };
}

/**
 * The origin a request was addressed to, derived from its Host header.
 *
 * @param {string|string[]|undefined} hostHeader
 * @param {boolean} [encrypted] Whether the request arrived over TLS.
 * @returns {string|null} The origin, or null when the header is no authority.
 */
export function requestOrigin(hostHeader, encrypted = false) {
  const host = headerValue(hostHeader);
  if (!host) return null;
  try {
    const url = new URL(`${encrypted ? 'https' : 'http'}://${host}`);
    if (
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Whether an Origin header names exactly the expected origin, with no
 * credentials, path, query or fragment.
 *
 * @param {string|string[]|undefined} origin
 * @param {string} expected
 * @returns {boolean}
 */
export function isExactOrigin(origin, expected) {
  let parsed;
  try {
    parsed = new URL(headerValue(origin));
  } catch {
    return false;
  }
  return (
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.pathname === '/' &&
    parsed.search === '' &&
    parsed.hash === '' &&
    parsed.origin === expected
  );
}

/**
 * Decide whether one `/api` request may proceed.
 *
 * `Sec-Fetch-Site` decides when present: only `same-origin` and `none` pass.
 * Without it, an `Origin` header must name this server exactly. A request
 * with a body must declare JSON, except the form-encoded routes listed in
 * `formEncodedPaths`; a JSON body forces a CORS preflight on cross-origin
 * callers.
 *
 * @param {object} [request]
 * @param {string} [request.method]
 * @param {string} [request.path] Full request path, including `/api`.
 * @param {Record<string, string|string[]|undefined>} [request.headers]
 *   Node's lower-cased request headers.
 * @param {boolean} [request.encrypted] Whether the request arrived over TLS.
 * @param {object} [options]
 * @param {readonly string[]} [options.formEncodedPaths]
 * @returns {{ok: true} | {ok: false, status: number, reason: string, error: string}}
 */
export function checkApiRequest(
  { method = 'GET', path = '', headers = {}, encrypted = false } = {},
  { formEncodedPaths = FORM_ENCODED_API_PATHS } = {},
) {
  const fetchSite = headerValue(headers['sec-fetch-site']).toLowerCase();
  const origin = headerValue(headers.origin);
  if (fetchSite) {
    if (!ALLOWED_FETCH_SITES.has(fetchSite)) {
      return refusal(
        403,
        `Sec-Fetch-Site: ${fetchSite}`,
        'Cross-site requests are refused',
      );
    }
  } else if (origin) {
    const expected = requestOrigin(headers.host, encrypted);
    if (!expected || !isExactOrigin(origin, expected)) {
      return refusal(
        403,
        `Origin: ${origin}`,
        'Cross-origin requests are refused',
      );
    }
  }
  if (!BODYLESS_METHODS.has(String(method).toUpperCase()) && hasBody(headers)) {
    const type = mediaTypeOf(headers['content-type']);
    const form =
      type === 'application/x-www-form-urlencoded' &&
      acceptsForm(path, formEncodedPaths);
    if (!isJsonMediaType(type) && !form) {
      return refusal(
        415,
        `Content-Type: ${type || 'none'}`,
        'Content-Type must be application/json',
      );
    }
  }
  return { ok: true };
}

/**
 * Connect middleware applying {@link checkApiRequest}. Refused requests get
 * a JSON error, and each route's refusals are logged at most once a minute.
 *
 * @param {object} [options]
 * @param {readonly string[]} [options.formEncodedPaths]
 * @param {(message: string) => void} [options.log]
 * @param {() => number} [options.now]
 */
export function createApiRequestGuard({
  formEncodedPaths = FORM_ENCODED_API_PATHS,
  log = (message) => console.warn(message),
  now = Date.now,
} = {}) {
  const lastLogged = new Map();
  return (req, res, next) => {
    const path = req.originalUrl ?? req.url ?? '';
    const verdict = checkApiRequest(
      {
        method: req.method,
        path,
        headers: req.headers ?? {},
        encrypted: Boolean(req.socket?.encrypted),
      },
      { formEncodedPaths },
    );
    if (verdict.ok) {
      next();
      return;
    }

    const route = printable(pathnameOf(path));
    const at = now();
    const last = lastLogged.get(route);
    if (last === undefined || at - last >= REFUSAL_LOG_INTERVAL_MS) {
      lastLogged.delete(route);
      lastLogged.set(route, at);
      if (lastLogged.size > REFUSAL_LOG_MAX_ROUTES) {
        lastLogged.delete(lastLogged.keys().next().value);
      }
      log(
        `[API guard] Refused ${printable(req.method || 'GET', 16)} ${route} (${printable(verdict.reason)})`,
      );
    }

    res.statusCode = verdict.status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ error: verdict.error }));
  };
}
