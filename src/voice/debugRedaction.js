/**
 * Redaction for the voice debug log. The browser applies it before posting a
 * record, and the server applies it again before writing one, so a record
 * posted by anything other than the app is redacted too.
 */

const SECRET_KEY =
  /(?:api[_-]?key|authorization|bearer|client[_-]?secret|token|secret|password)/i;
const MAX_STRING_LENGTH = 50000;
const MAX_DEPTH = 10;
/**
 * The server's nesting limit for a whole record. It sits above anything the
 * browser or the server's content omission leaves, so it cuts only records
 * that came from somewhere else.
 */
const RECORD_MAX_DEPTH = 32;

/**
 * Whether a property name marks its value as a secret.
 * @param {string} key
 */
export function isSecretLikeKey(key) {
  return SECRET_KEY.test(key);
}

/**
 * Redact credentials and image data inside one string, and cap its length.
 * @param {string} value
 */
export function sanitizeDebugString(value) {
  if (value.startsWith('data:image/')) {
    return `[Redacted image data URL, ${value.length} chars]`;
  }
  const redacted = value
    .replace(
      /data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/gi,
      '[Redacted image data URL]',
    )
    .replace(/sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, '[Redacted OpenAI API key]')
    .replace(/\bek_[A-Za-z0-9_-]{16,}/g, '[Redacted ephemeral key]')
    .replace(/AIza[0-9A-Za-z_-]{35}/g, '[Redacted Google API key]')
    .replace(
      /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
      '[Redacted JWT]',
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [Redacted]')
    // An Authorization value, whatever its scheme (Basic, Bearer, Token...).
    .replace(
      /(authorization["']?\s*[:=]\s*["']?)(?:[A-Za-z][\w-]*\s+)?[^\s"',;}]+/gi,
      '$1[Redacted]',
    )
    .replace(/"client_secret"\s*:\s*"[^"]+"/gi, '"client_secret":"[Redacted]"')
    .replace(
      /"value"\s*:\s*"ek_[^"]+"/gi,
      '"value":"[Redacted ephemeral key]"',
    );
  return redacted.length > MAX_STRING_LENGTH
    ? `${redacted.slice(0, MAX_STRING_LENGTH)}...[Truncated ${redacted.length - MAX_STRING_LENGTH} chars]`
    : redacted;
}

/**
 * Deep-copy a debug value with secrets redacted: values under secret-like
 * keys, credentials inside strings, and image data URLs. Nesting past
 * `maxDepth` levels (ten by default) is replaced with a marker.
 * @param {unknown} value
 * @param {number} [depth]
 * @param {number} [maxDepth]
 * @returns {unknown}
 */
export function sanitizeDebugValue(value, depth = 0, maxDepth = MAX_DEPTH) {
  if (depth > maxDepth) return '[MaxDepth]';
  if (
    value == null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'string') return sanitizeDebugString(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDebugValue(item, depth + 1, maxDepth));
  }
  if (typeof value !== 'object') return String(value);

  /** @type {Record<string, unknown>} */
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    // A parsed `__proto__` key would reassign the copy's prototype.
    if (key === '__proto__') continue;
    output[key] = isSecretLikeKey(key)
      ? '[Redacted]'
      : sanitizeDebugValue(item, depth + 1, maxDepth);
  }
  return output;
}

/**
 * The server's pass over a whole posted record: the same rules, with a
 * nesting limit for the record rather than for one payload.
 * @param {unknown} record
 * @returns {unknown}
 */
export function redactDebugRecord(record) {
  return sanitizeDebugValue(record, 0, RECORD_MAX_DEPTH);
}
