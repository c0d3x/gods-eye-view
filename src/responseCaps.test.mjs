import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { adsbdbProxy } from '../server/providers/aircraft/enrichment.js';
import {
  loadDriveBcSourcesFromOpenData,
  loadOntarioSourcesFromOpenData,
} from '../server/providers/cctv/sources.js';
import { openAiRealtimeProxy } from '../server/providers/openai.js';
import { terrainHeightsProxy } from '../server/providers/terrain.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A response that declares a body far past any proxy's cap. */
function oversized(headers = {}) {
  return new Response('{}', {
    headers: { 'content-length': String(512 * 1024 * 1024), ...headers },
  });
}

/**
 * A body streamed in 1 MiB chunks with no declared length, the way a broken
 * or hostile upstream would send it. `pulled` counts the chunks read.
 */
// The stream reads a chunk or two ahead of the consumer, so a read capped at
// N MiB pulls at most N + 2 of them.
function streamed(mebibytes) {
  const stats = { pulled: 0 };
  const chunk = new Uint8Array(1024 * 1024).fill(0x20);
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        if (stats.pulled >= mebibytes) {
          controller.close();
          return;
        }
        stats.pulled += 1;
        controller.enqueue(chunk);
      },
    }),
  );
  return { response, stats };
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'gev-response-caps-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function install(plugin, route) {
  let handler;
  plugin.configureServer({
    middlewares: {
      use(pathname, fn) {
        if (pathname === route) handler = fn;
      },
    },
  });
  return (url, { method = 'GET', body = '' } = {}) =>
    new Promise((resolve, reject) => {
      const headers = {};
      const res = {
        statusCode: 200,
        headersSent: false,
        setHeader(name, value) {
          headers[String(name).toLowerCase()] = value;
        },
        writeHead(status, values = {}) {
          this.statusCode = status;
          for (const [name, value] of Object.entries(values))
            this.setHeader(name, value);
        },
        end(payload = '') {
          this.headersSent = true;
          resolve({ status: this.statusCode, headers, body: String(payload) });
        },
      };
      const req = Object.assign(
        Readable.from(body ? [Buffer.from(body)] : []),
        {
          method,
          url,
          headers: { host: 'localhost:4173', origin: 'http://localhost:4173' },
          socket: { remoteAddress: '127.0.0.1' },
        },
      );
      Promise.resolve(handler(req, res)).catch(reject);
    });
}

test('terrain heights stop reading an upstream answer past the size cap', async (t) => {
  const cacheDir = await temporaryDirectory(t);
  t.mock.method(console, 'warn', () => {});
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async () => {
    const body = streamed(64);
    bodies.push(body.stats);
    return body.response;
  });
  const request = install(
    terrainHeightsProxy({ cacheDir }),
    '/api/terrain/heights',
  );
  const res = await request(
    `/?points=${encodeURIComponent('1.00000,2.00000')}`,
  );
  assert.equal(res.status, 502);
  assert.ok(bodies.length > 0);
  for (const stats of bodies)
    assert.ok(stats.pulled <= 4 + 2, `${stats.pulled}`);
});

test('an adsbdb answer past the size cap is treated as a miss', async (t) => {
  const cacheDir = await temporaryDirectory(t);
  const body = streamed(64);
  t.mock.method(globalThis, 'fetch', async () => body.response);
  const request = install(
    adsbdbProxy({ cachePath: path.join(cacheDir, 'adsbdb.json') }),
    '/api/adsbdb',
  );
  const res = await request('/type/abcdef');
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { found: false });
  assert.ok(body.stats.pulled <= 1 + 2, `${body.stats.pulled}`);
});

test('a camera catalog past the size cap is dropped, not buffered', async (t) => {
  t.mock.method(console, 'warn', () => {});
  for (const load of [
    loadOntarioSourcesFromOpenData,
    loadDriveBcSourcesFromOpenData,
  ]) {
    const body = streamed(64);
    t.mock.method(globalThis, 'fetch', async () => body.response);
    assert.deepEqual(await load(), []);
    assert.ok(
      body.stats.pulled <= 32 + 2,
      `${load.name}: ${body.stats.pulled}`,
    );
  }
});

test('an oversized Realtime token answer is refused', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const previous = process.env.GEV_RATELIMIT_OPENAI_PER_MIN;
  process.env.GEV_RATELIMIT_OPENAI_PER_MIN = '0';
  t.after(() => {
    if (previous === undefined) delete process.env.GEV_RATELIMIT_OPENAI_PER_MIN;
    else process.env.GEV_RATELIMIT_OPENAI_PER_MIN = previous;
  });
  const request = install(
    openAiRealtimeProxy({
      realtime: {
        resolveApiKey: () => 'fixture-key',
        fetchImpl: async () =>
          oversized({ 'content-type': 'application/json' }),
      },
    }),
    '/api/realtime/token',
  );
  const res = await request('/');
  assert.equal(res.status, 502);
  assert.deepEqual(JSON.parse(res.body), {
    error: 'Failed to create Realtime token',
  });
});

test('the AIS socket refuses messages past 1 MiB', async () => {
  const source = await readFile(
    path.join(ROOT, 'server/providers/vessels/ais-live.js'),
    'utf8',
  );
  assert.match(source, /new WebSocketCtor\(url, \{ maxPayload: 1 << 20 \}\)/);
});

/** Every server file, and the shared terrain fetcher, that reads upstream bodies. */
async function serverSources() {
  const files = ['src/data/terrainHeightsProxy.js'];
  const visit = async (directory) => {
    for (const entry of await readdir(path.join(ROOT, directory), {
      withFileTypes: true,
    })) {
      const relative = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) await visit(relative);
      else if (/\.m?js$/.test(entry.name) && !entry.name.includes('.test.'))
        files.push(relative);
    }
  };
  await visit('server');
  return files;
}

test('server code reads every upstream body through a capped reader', async () => {
  // Bodies that are not an upstream's: each is a Response this server built
  // itself, or a default that the server replaces with a capped reader.
  const allowed = new Set([
    // The transit service's own Response, built in-process.
    'server/providers/transit.js: res.end(await response.text());',
    // The MCP handler's own Response, built in-process.
    'server/mcp/plugin.js: res.end(Buffer.from(await response.arrayBuffer()));',
    // A test seam; terrain.js passes readResponseJsonCapped.
    'src/data/terrainHeightsProxy.js: readJson = (/** @type {Response} */ res) => res.json(),',
  ]);
  const uncapped = [];
  for (const file of await serverSources()) {
    const lines = (await readFile(path.join(ROOT, file), 'utf8')).split('\n');
    lines.forEach((raw, index) => {
      const line = raw.trim();
      if (/^(\/\/|\*)/.test(line)) return;
      if (!/\.(text|json|arrayBuffer)\(\)/.test(line)) return;
      if (allowed.has(`${file}: ${line}`)) return;
      uncapped.push(`${file}:${index + 1}: ${line}`);
    });
  }
  assert.deepEqual(uncapped, []);
});
