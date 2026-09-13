/**
 * Read a request body of at most `maxBytes`.
 *
 * Resolves `{ ok: true, text }`, or `{ ok: false, tooLarge: true }` as soon as
 * the declared or received size passes the cap. An oversized body is not
 * buffered: the rest of it is read and discarded, so the connection stays
 * intact and the caller's 413 response reaches the client.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<{ok: true, text: string} | {ok: false, tooLarge: true}>}
 */
export function readBodyWithin(req, maxBytes) {
  const declared = Number(req.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    req.resume();
    return Promise.resolve({ ok: false, tooLarge: true });
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const onData = (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.off('data', onData);
        req.off('end', onEnd);
        req.resume();
        resolve({ ok: false, tooLarge: true });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      resolve({ ok: true, text: Buffer.concat(chunks).toString('utf8') });
    };
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', reject);
  });
}
