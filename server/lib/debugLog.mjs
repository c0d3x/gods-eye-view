import fs from 'node:fs';
import path from 'node:path';
import { sanitizeDebugValue } from '../../src/voice/debugRedaction.js';

/** Largest record the voice debug-log route accepts. */
export const DEBUG_LOG_MAX_RECORD_BYTES = 256 * 1024;

/** Size at which the log rotates, keeping one previous file. */
export const DEBUG_LOG_MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * Whether a GEV_REALTIME_DEBUG_LOG value turns the voice debug log on.
 * @param {string|undefined} value
 */
export function isDebugLogEnabled(value) {
  return /^(?:1|true|on|yes)$/i.test(String(value ?? '').trim());
}

function tighten(target, mode) {
  try {
    fs.chmodSync(target, mode);
  } catch {
    // Best effort: Windows and some filesystems ignore POSIX modes.
  }
}

/**
 * Append-only JSONL log for voice debug records.
 *
 * Every record is redacted again here, whoever posted it. The directory is
 * created with mode 0700 and the file with 0600; ones left by an older
 * version are tightened on the first write. Once the file would grow past
 * `maxFileBytes` it becomes `<name>.1.jsonl`, replacing the previous one.
 *
 * @param {object} options
 * @param {string} options.directory
 * @param {string} [options.fileName]
 * @param {number} [options.maxFileBytes]
 * @param {() => Date} [options.now]
 */
export function createDebugLogWriter({
  directory,
  fileName = 'realtime-conversations.jsonl',
  maxFileBytes = DEBUG_LOG_MAX_FILE_BYTES,
  now = () => new Date(),
}) {
  const file = path.join(directory, fileName);
  const { name, ext } = path.parse(fileName);
  const previous = path.join(directory, `${name}.1${ext}`);
  let tightened = false;

  return {
    file,
    previous,
    /**
     * Redact and append one record.
     * @param {Record<string, unknown>} record
     */
    append(record) {
      const entry = {
        loggedAt: '',
        .../** @type {Record<string, unknown>} */ (sanitizeDebugValue(record)),
      };
      entry.loggedAt = now().toISOString();
      const line = `${JSON.stringify(entry)}\n`;

      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {
        // No log yet.
      }
      if (!tightened) {
        tighten(directory, 0o700);
        if (size > 0) tighten(file, 0o600);
        tightened = true;
      }
      if (size > 0 && size + Buffer.byteLength(line) > maxFileBytes) {
        fs.renameSync(file, previous);
      }
      fs.appendFileSync(file, line, { mode: 0o600 });
    },
  };
}
