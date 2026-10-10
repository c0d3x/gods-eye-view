import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsers } from 'prettier/plugins/babel.mjs';
import { startDeferredVoice } from './deferredVoice.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeCommands(log) {
  return {
    runner: async (name, args, options) => {
      log.push({ name, args, options });
      return { ok: true, name };
    },
    stop: (options) => log.push({ stop: options }),
  };
}

function harness({ signal } = {}) {
  const chunk = deferred();
  const cleanups = [];
  const log = [];
  const started = [];
  const ready = [];
  const voice = startDeferredVoice({
    load: () => chunk.promise,
    start: (module) => {
      started.push(module);
      return module.init();
    },
    onReady: (commands) => ready.push(commands),
    defer: (dispose) => cleanups.push(dispose),
    signal,
  });
  return {
    voice,
    chunk,
    log,
    started,
    ready,
    teardown: () => {
      while (cleanups.length) cleanups.pop()();
    },
  };
}

test('voice starts when its chunk arrives, and actions wait for it', async () => {
  const controller = new AbortController();
  const h = harness({ signal: controller.signal });
  assert.equal(h.voice.commands, null, 'nothing is loaded at startup');
  const pending = h.voice.run('annotate_map', { annotations: [] });
  await Promise.resolve();
  assert.equal(h.log.length, 0, 'no action runs before the chunk arrives');

  const commands = fakeCommands(h.log);
  h.chunk.resolve({ init: () => commands });
  assert.deepEqual(await pending, { ok: true, name: 'annotate_map' });
  assert.equal(await h.voice.ready, commands);
  assert.equal(h.voice.commands, commands);
  assert.deepEqual(h.ready, [commands]);
  assert.equal(h.log[0].options.signal, controller.signal);

  globalThis.window = { __gevVoiceCommands: commands };
  try {
    h.teardown();
    assert.deepEqual(h.log.at(-1), { stop: { removeUi: true } });
    assert.equal('__gevVoiceCommands' in globalThis.window, false);
  } finally {
    delete globalThis.window;
  }
});

test('a teardown before the chunk arrives means voice never starts', async () => {
  const h = harness();
  h.teardown();
  h.chunk.resolve({ init: () => assert.fail('voice started after teardown') });
  assert.equal(await h.voice.ready, null);
  assert.equal(h.started.length, 0);
  assert.deepEqual(await h.voice.run('stop_tracking', {}), {
    ok: false,
    error: 'App actions are not available',
  });
});

test('an aborted application never starts voice', async () => {
  const controller = new AbortController();
  const h = harness({ signal: controller.signal });
  controller.abort();
  h.chunk.resolve({ init: () => assert.fail('voice started after abort') });
  assert.equal(await h.voice.ready, null);
});

test('a chunk that fails to load leaves the app running without voice', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const h = harness();
  h.chunk.reject(new Error('network down'));
  assert.equal(await h.voice.ready, null);
  assert.equal((await h.voice.run('stop_tracking', {})).ok, false);
  assert.match(String(warn.mock.calls[0].arguments.join(' ')), /network down/);
  h.teardown();
});

test('an action retries a failed chunk load, at most every ten seconds', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let clock = 0;
  let loads = 0;
  const log = [];
  const commands = fakeCommands(log);
  const ready = [];
  const voice = startDeferredVoice({
    load: async () => {
      loads += 1;
      if (loads === 1) throw new Error('network down');
      return { init: () => commands };
    },
    start: (module) => module.init(),
    onReady: (started) => ready.push(started),
    defer: () => {},
    now: () => clock,
  });
  assert.equal(await voice.ready, null);
  clock = 9_999;
  assert.equal((await voice.run('stop_tracking', {})).ok, false);
  assert.equal(loads, 1, 'too soon to try again');
  clock = 10_000;
  assert.deepEqual(await voice.run('stop_tracking', {}), {
    ok: true,
    name: 'stop_tracking',
  });
  assert.equal(loads, 2);
  assert.equal(await voice.ready, commands);
  assert.deepEqual(ready, [commands]);
});

/** Static imports only: what loads with a module, not what it may load later. */
function staticImports(file) {
  const ast = parsers.babel.parse(readFileSync(file, 'utf8'));
  const found = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (
      [
        'ImportDeclaration',
        'ExportNamedDeclaration',
        'ExportAllDeclaration',
      ].includes(node.type) &&
      node.source?.value
    )
      found.push(node.source.value);
    for (const [key, value] of Object.entries(node))
      if (!['loc', 'comments', 'tokens', 'extra'].includes(key)) visit(value);
  };
  visit(ast.program);
  return found;
}

test('the startup bundle reaches the voice stack only through dynamic imports', () => {
  const reached = new Set();
  const queue = [path.join(ROOT, 'src/main.js')];
  while (queue.length) {
    const file = queue.pop();
    if (reached.has(file)) continue;
    reached.add(file);
    for (const specifier of staticImports(file)) {
      if (!specifier.startsWith('.')) continue;
      const target = path.resolve(path.dirname(file), specifier);
      if (/\.[mc]?js$/.test(target)) queue.push(target);
    }
  }
  const relative = [...reached].map((file) => path.relative(ROOT, file));
  assert.ok(relative.includes('src/app/tools.js'), 'the walk covers startup');
  for (const voiceOnly of [
    'src/voice/gevRealtime.js',
    'src/voice/gevActions.js',
    'src/voice/commands.js',
    'src/voice/realtimeController.js',
  ])
    assert.equal(
      relative.includes(voiceOnly),
      false,
      `${voiceOnly} must stay out of the startup chunk`,
    );
});
