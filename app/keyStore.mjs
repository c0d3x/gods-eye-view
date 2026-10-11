/**
 * The Mac app's provider keys: dotenv text, encrypted with a key that the
 * macOS Keychain holds (Electron's safeStorage), in one file under the app's
 * Application Support folder.
 *
 * Provider Settings reads and writes it through the `store` option of
 * keySetupEndpoint (server/standalone/key-setup.js), and the app copies its
 * values into process.env at launch. The app treats it as the only source of
 * keys, as Pinokio does with its ENVIRONMENT file.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

/** The store's name in Provider Settings' status payload. */
export const KEY_STORE_NAME = 'app-keychain';

/**
 * @param {object} options
 * @param {string} options.file Where the encrypted keys live.
 * @param {(text: string) => Buffer} options.encrypt
 * @param {(data: Buffer) => string} options.decrypt
 */
export function createKeyStore({ file, encrypt, decrypt }) {
  /** The saved dotenv text, or '' before the first save. */
  const read = () => {
    let data;
    try {
      data = fs.readFileSync(file);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
        return '';
      }
      throw error;
    }
    return decrypt(data);
  };

  /**
   * Replaces the saved text: a fresh 0600 file in the same folder, synced and
   * renamed over the old one, so a failed write never leaves a partial store.
   * @param {string} text
   */
  const write = (text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${randomUUID().slice(0, 8)}.tmp`,
    );
    const fd = fs.openSync(tmp, 'wx', 0o600);
    let staged = false;
    try {
      const data = encrypt(text);
      let written = 0;
      while (written < data.length) {
        written += fs.writeSync(fd, data, written, data.length - written);
      }
      fs.fsyncSync(fd);
      staged = true;
    } finally {
      fs.closeSync(fd);
      if (!staged) fs.rmSync(tmp, { force: true });
    }
    try {
      fs.renameSync(tmp, file);
    } catch (error) {
      fs.rmSync(tmp, { force: true });
      throw error;
    }
  };

  return {
    name: KEY_STORE_NAME,
    read,
    write,
    /**
     * The saved values, by environment variable name, in an object without a
     * prototype (as Node 26's parseEnv returns; Node 24's has one).
     */
    values: () =>
      /** @type {Record<string, string>} */ (
        Object.assign(Object.create(null), parseEnv(read()))
      ),
  };
}

/**
 * Copies the saved keys into the environment the provider modules read. An
 * empty value is a removed key, as Provider Settings writes it.
 * @param {Record<string, string>} values
 * @param {NodeJS.ProcessEnv} env
 */
export function applyStoredKeys(values, env = process.env) {
  for (const [name, value] of Object.entries(values)) env[name] = value;
}
