/**
 * A node:test reporter that lists the tests that were queued but never
 * passed or failed. When a test file's process stops early, Node reports
 * the tests it reached and counts the file as passing, so
 * scripts/run-unit-tests.mjs reads this list to fail the run instead.
 *
 * Writes one JSON line: { "unfinished": [{ "file", "name" }] }.
 */

/** Whether a queued entry stands for a whole test file, not a test in it. */
function isFileEntry({ file, name, nesting }) {
  if (nesting !== 0 || typeof file !== 'string') return false;
  const path = file.split('\\').join('/');
  const wanted = String(name).split('\\').join('/');
  return path === wanted || path.endsWith(`/${wanted}`);
}

export default async function* unfinishedTestsReporter(source) {
  const pending = new Map();
  for await (const event of source) {
    const data = event.data;
    if (!data || typeof data.name !== 'string') continue;
    const key = JSON.stringify([data.file ?? null, data.nesting, data.name]);
    if (event.type === 'test:enqueue') {
      const entry = pending.get(key) ?? { data, count: 0 };
      entry.count += 1;
      pending.set(key, entry);
    } else if (event.type === 'test:pass' || event.type === 'test:fail') {
      const entry = pending.get(key);
      if (!entry) continue;
      entry.count -= 1;
      if (entry.count <= 0) pending.delete(key);
    }
  }
  const unfinished = [...pending.values()]
    .filter(({ data }) => !isFileEntry(data))
    .map(({ data }) => ({ file: data.file ?? null, name: data.name }));
  yield `${JSON.stringify({ unfinished })}\n`;
}
