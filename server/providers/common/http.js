import { readResponseTextCapped } from '../../../src/sources/httpBody.js';

export {
  readResponseTextCapped,
  readResponseJsonCapped,
  readResponseBytesCapped,
  coalesceProxyRequest,
} from '../../../src/sources/httpBody.js';

/**
 * readResponseTextCapped for a caller that answers an oversized body itself:
 * resolves { tooLarge, text } instead of throwing RESPONSE_TOO_LARGE. The cap
 * counts bytes, whether or not the body streams, and the read stops as soon
 * as the cap is crossed — so a malicious or buggy upstream that streams an
 * unbounded body (no/oversized Content-Length, chunked) can't OOM the proxy.
 * @param {Response} upstream - fetch() response.
 * @param {number} maxBytes - hard ceiling on bytes read.
 * @returns {Promise<{tooLarge: boolean, text: string}>}
 */
export async function readCappedResponseText(upstream, maxBytes) {
  try {
    return {
      tooLarge: false,
      text: await readResponseTextCapped(upstream, maxBytes),
    };
  } catch (error) {
    if (/** @type {{code?: string}} */ (error)?.code !== 'RESPONSE_TOO_LARGE') {
      throw error;
    }
    return { tooLarge: true, text: '' };
  }
}
