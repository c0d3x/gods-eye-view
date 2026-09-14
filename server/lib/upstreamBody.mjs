/**
 * Read an upstream fetch() Response body with a hard byte cap, so a broken or
 * hostile upstream can't make the dev server buffer an unbounded body.
 */

/** The cap on a provider's JSON answer: OpenSky tokens, OpenAI and Google Places. */
export const PROVIDER_JSON_MAX_BYTES = 2 * 1024 * 1024;

/** The error a capped reader throws for an oversized body. */
function responseTooLarge() {
  return Object.assign(new Error('Upstream response too large'), {
    code: 'RESPONSE_TOO_LARGE',
  });
}

/**
 * Read a fetch() Response body as text with a hard byte cap. Rejects early on an
 * oversized Content-Length, then streams with a running cap so a chunked or
 * length-omitted response cannot blow past the limit. Throws { code:'RESPONSE_TOO_LARGE' }.
 * @param {Response} response
 * @param {number} maxBytes
 */
export async function readResponseTextCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await response.body?.cancel();
    } catch {
      /* no-op */
    }
    throw responseTooLarge();
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw responseTooLarge();
    }
    return text;
  }
  const decoder = new TextDecoder();
  let out = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* no-op */
      }
      throw responseTooLarge();
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

/**
 * readResponseTextCapped for a caller that answers an oversized body itself:
 * resolves { tooLarge, text } instead of throwing RESPONSE_TOO_LARGE.
 * @param {Response} response
 * @param {number} maxBytes
 */
export async function readResponseTextWithin(response, maxBytes) {
  try {
    return {
      tooLarge: false,
      text: await readResponseTextCapped(response, maxBytes),
    };
  } catch (error) {
    if (error?.code !== 'RESPONSE_TOO_LARGE') throw error;
    return { tooLarge: true, text: '' };
  }
}

/**
 * Parse a fetch() JSON response only after enforcing a hard byte cap.
 * @param {Response} response
 * @param {number} maxBytes
 */
export async function readResponseJsonCapped(response, maxBytes) {
  return JSON.parse(await readResponseTextCapped(response, maxBytes));
}

/**
 * Parse text as a JSON object; anything else reads as an empty object.
 * @param {string} text
 */
export function parseJsonObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

/**
 * Read a fetch() Response body as bytes with a hard cap, the way
 * readResponseTextCapped reads text. Throws { code:'RESPONSE_TOO_LARGE' }.
 * @param {Response} response
 * @param {number} maxBytes
 */
export async function readResponseBytesCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await response.body?.cancel();
    } catch {
      /* no-op */
    }
    throw responseTooLarge();
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw responseTooLarge();
    return bytes;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* no-op */
      }
      throw responseTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}
