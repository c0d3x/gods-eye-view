import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDebugLogWriter,
  DEBUG_LOG_MAX_FILE_BYTES,
  DEBUG_LOG_MAX_RECORD_BYTES,
  isDebugLogEnabled,
} from './debugLog.mjs';

/** A not-yet-created log directory inside a temporary root. */
async function logDirectory(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'gev-debug-log-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return path.join(root, '.gev-logs');
}

async function readLines(file) {
  return (await readFile(file, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

test('only an explicit yes turns the log on', () => {
  for (const value of ['1', 'true', 'TRUE', 'on', 'yes', ' 1 ']) {
    assert.equal(isDebugLogEnabled(value), true, value);
  }
  for (const value of [undefined, '', '0', 'false', 'off', 'no', 'maybe']) {
    assert.equal(isDebugLogEnabled(value), false, String(value));
  }
});

test('records are capped at 256 KiB and the file at 20 MB', () => {
  assert.equal(DEBUG_LOG_MAX_RECORD_BYTES, 256 * 1024);
  assert.equal(DEBUG_LOG_MAX_FILE_BYTES, 20 * 1024 * 1024);
});

test('appends redacted records stamped with the server time', async (t) => {
  const directory = await logDirectory(t);
  const writer = createDebugLogWriter({
    directory,
    now: () => new Date('2026-09-13T12:00:00Z'),
  });
  const frame = 'data:image/png;base64,iVBORw0KGgo=';
  // Assembled at runtime so the source holds no key-shaped string for secret
  // scanning to flag.
  const googleKey = `AIza${'x'.repeat(35)}`;
  writer.append({
    event: 'session.token.ready',
    loggedAt: 'client-supplied',
    payload: {
      client_secret: { value: 'ek_abcdefghijklmnopqrstuvwxyz' },
      headers: { Authorization: 'Bearer sk-proj-abcdefghijklmnopqrstuvwxyz' },
      note: `keys sk-proj-abcdefghijklmnopqrstuvwxyz and ${googleKey}`,
      frame,
    },
  });

  const [entry] = await readLines(writer.file);
  assert.equal(Object.keys(entry)[0], 'loggedAt');
  assert.deepEqual(entry, {
    loggedAt: '2026-09-13T12:00:00.000Z',
    event: 'session.token.ready',
    payload: {
      client_secret: '[Redacted]',
      headers: { Authorization: '[Redacted]' },
      note: 'keys [Redacted OpenAI API key] and [Redacted Google API key]',
      frame: `[Redacted image data URL, ${frame.length} chars]`,
    },
  });
});

test('rotates at the size cap, keeping one previous file', async (t) => {
  const directory = await logDirectory(t);
  const writer = createDebugLogWriter({ directory, maxFileBytes: 400 });
  for (let index = 0; index < 12; index += 1) {
    writer.append({ event: 'tick', index, padding: 'x'.repeat(60) });
  }

  assert.deepEqual((await readdir(directory)).sort(), [
    'realtime-conversations.1.jsonl',
    'realtime-conversations.jsonl',
  ]);
  assert.ok((await stat(writer.file)).size <= 400);
  assert.ok((await stat(writer.previous)).size <= 400);
  // The newest records are in the current file and the ones just before them
  // in the previous file; anything older is gone.
  const current = await readLines(writer.file);
  const previous = await readLines(writer.previous);
  assert.equal(current.at(-1).index, 11);
  assert.equal(previous.at(-1).index, current[0].index - 1);
  assert.ok(previous[0].index > 0);
});

test('the directory is private (0700), the file too (0600), and old ones are tightened', {
  skip: process.platform === 'win32' && 'POSIX modes only',
}, async (t) => {
  const directory = await logDirectory(t);
  const writer = createDebugLogWriter({ directory });
  writer.append({ event: 'first' });
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(writer.file)).mode & 0o777, 0o600);

  // A world-readable log left by an older version is tightened on the
  // first write.
  const legacy = `${directory}-legacy`;
  await mkdir(legacy);
  await chmod(legacy, 0o755);
  const legacyFile = path.join(legacy, 'realtime-conversations.jsonl');
  await writeFile(legacyFile, '{}\n');
  await chmod(legacyFile, 0o644);
  createDebugLogWriter({ directory: legacy }).append({ event: 'next' });
  assert.equal((await stat(legacy)).mode & 0o777, 0o700);
  assert.equal((await stat(legacyFile)).mode & 0o777, 0o600);
});
