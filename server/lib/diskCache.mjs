import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Delete old and excess files from one disk-cache directory.
 *
 * Files last modified more than `maxAgeMs` ago are removed; then, while the
 * directory still holds more than `maxBytes`, the least recently modified
 * files go. Subdirectories and names in `keep` are neither counted nor
 * touched, and a missing directory is not an error.
 *
 * @param {string} directory
 * @param {object} limits
 * @param {number} limits.maxAgeMs
 * @param {number} limits.maxBytes
 * @param {readonly string[]} [limits.keep]
 * @param {number} [limits.now]
 * @returns {Promise<{removed: number, bytes: number}>} Files removed, bytes left.
 */
export async function pruneCacheDirectory(
  directory,
  { maxAgeMs, maxBytes, keep = [], now = Date.now() },
) {
  let dirents;
  try {
    dirents = await fsp.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { removed: 0, bytes: 0 };
    throw error;
  }

  const files = [];
  for (const dirent of dirents) {
    if (!dirent.isFile() || keep.includes(dirent.name)) continue;
    const file = path.join(directory, dirent.name);
    try {
      const stats = await fsp.stat(file);
      files.push({ file, size: stats.size, mtimeMs: stats.mtimeMs });
    } catch {
      // Removed since the listing.
    }
  }

  // Oldest first: once a file is within the age limit and the directory is
  // within its size limit, every remaining file is too.
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let bytes = files.reduce((total, file) => total + file.size, 0);
  let removed = 0;
  for (const file of files) {
    if (now - file.mtimeMs <= maxAgeMs && bytes <= maxBytes) break;
    try {
      await fsp.rm(file.file, { force: true });
      bytes -= file.size;
      removed += 1;
    } catch {
      // Best effort; the next pass tries again.
    }
  }
  return { removed, bytes };
}

/**
 * Prune one cache directory on demand (at startup) and, at most once per
 * `intervalMs`, after writes. Failures are logged, never thrown.
 *
 * @param {object} options
 * @param {string} options.directory
 * @param {number} options.maxAgeMs
 * @param {number} options.maxBytes
 * @param {readonly string[]} [options.keep]
 * @param {number} [options.intervalMs]
 * @param {() => number} [options.now]
 * @param {(message: string) => void} [options.log]
 */
export function createCachePruner({
  directory,
  maxAgeMs,
  maxBytes,
  keep = [],
  intervalMs = 10 * 60_000,
  now = () => Date.now(),
  log = (message) => console.warn(message),
}) {
  let lastRun = Number.NEGATIVE_INFINITY;
  let running = null;

  const runNow = () => {
    if (running) return running;
    lastRun = now();
    running = pruneCacheDirectory(directory, {
      maxAgeMs,
      maxBytes,
      keep,
      now: lastRun,
    })
      .catch((error) => {
        log(
          `[disk cache] Pruning ${path.basename(directory)} failed: ${error?.code || error?.message || error}`,
        );
        return { removed: 0, bytes: 0 };
      })
      .finally(() => {
        running = null;
      });
    return running;
  };

  return {
    directory,
    runNow,
    /**
     * Note a write. Prunes when the last run was at least `intervalMs` ago,
     * returning that run; otherwise returns null.
     */
    afterWrite() {
      if (running || now() - lastRun < intervalMs) return null;
      return runNow();
    },
  };
}
