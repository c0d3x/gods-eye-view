// @ts-check
/**
 * Redaction for the voice debug log. The browser applies it before posting a
 * record, and the dev server applies it again before writing one, so a record
 * posted by anything other than the app is redacted too.
 */

const SECRET_KEY =
  /(?:api[_-]?key|authorization|bearer|client[_-]?secret|token|secret|password)/i;
const MAX_STRING_LENGTH = 50000;
const MAX_DEPTH = 10;

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
    .replace(
      /(authorization["']?\s*[:=]\s*["']?)(?:(?:basic|bearer)\s+)?[^\s"',;}]+/gi,
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
 * keys, credentials inside strings, and image data URLs. Nesting past ten
 * levels is replaced with a marker.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function sanitizeDebugValue(value, depth = 0) {
  if (depth > MAX_DEPTH) return '[MaxDepth]';
  if (
    value == null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'string') return sanitizeDebugString(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDebugValue(item, depth + 1));
  }
  if (typeof value !== 'object') return String(value);

  /** @type {Record<string, unknown>} */
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    // A parsed `__proto__` key would reassign the copy's prototype.
    if (key === '__proto__') continue;
    output[key] = isSecretLikeKey(key)
      ? '[Redacted]'
      : sanitizeDebugValue(item, depth + 1);
  }
  return output;
}
