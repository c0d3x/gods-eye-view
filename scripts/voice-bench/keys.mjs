/**
 * Runtime key lookup for the voice benchmark. Keys are read from the
 * environment, then the macOS Keychain, at call time. They are never written
 * to results, logs, or files.
 */
import { findKeychainItem } from '../lib/credentials.mjs';

const KEYCHAIN = {
  openai: { env: 'OPENAI_API_KEY', service: 'openai-api', account: 'api-key' },
  gemini: { env: 'GEMINI_API_KEY', service: 'gemini-api', account: 'api-key' },
};

const cache = new Map();

/** Resolve a provider key from the environment, then the Keychain. */
export function providerKey(provider) {
  if (cache.has(provider)) return cache.get(provider);
  const spec = KEYCHAIN[provider];
  if (!spec) throw new Error(`unknown key provider: ${provider}`);
  let value = process.env[spec.env] || '';
  if (!value) {
    value = findKeychainItem(spec.service, spec.account, {
      reveal: true,
    }).trim();
  }
  if (!value) throw new Error(`${spec.env} is not available (env or Keychain)`);
  cache.set(provider, value);
  return value;
}
