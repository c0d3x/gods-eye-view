/**
 * Write a JSON response, unless one already went out: a throw after a route
 * has answered must not answer again, which Node refuses.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body Serialized with JSON.stringify.
 * @param {Record<string, string>} [headers] Extra headers, such as Cache-Control.
 * @returns {boolean} Whether this call wrote the response.
 */
export function writeJson(res, status, body, headers = {}) {
  if (res.headersSent) return false;
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
  return true;
}
