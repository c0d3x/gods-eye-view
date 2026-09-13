import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';
import { resolveAllowedHosts } from '../server/lib/allowedHosts.mjs';
import config from '../vite.config.js';

/** Run `fn` with environment variables set, then restore them. */
function withEnv(values, fn) {
  const previous = Object.fromEntries(
    Object.keys(values).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, values);
  try {
    return fn();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function allowedHostsFor(host) {
  return withEnv(
    { HOST: host, GEV_ALLOWED_HOSTS: 'gev.example' },
    () => config({ mode: 'test' }).server.allowedHosts,
  );
}

function statusFor(port, host) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/', headers: { host } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      })
      .on('error', reject);
  });
}

test('local and LAN modes use the same explicit host list', () => {
  const expected = resolveAllowedHosts({ extra: 'gev.example' });
  assert.ok(expected.includes('gev.example'));
  for (const host of ['localhost', '0.0.0.0', '::']) {
    const allowed = allowedHostsFor(host);
    assert.deepEqual(allowed, expected, host);
    assert.equal(allowed.includes('.local'), false, host);
  }
});

test("in LAN mode a foreign Host is refused while IPs and this machine's names are served", async (t) => {
  const allowedHosts = allowedHostsFor('0.0.0.0');
  const root = await mkdtemp(path.join(os.tmpdir(), 'gev-allowed-hosts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, 'index.html'),
    '<!doctype html><title>t</title>',
  );

  const server = await createServer({
    root,
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true },
    server: { host: '127.0.0.1', port: 0, allowedHosts },
  });
  t.after(() => server.close());
  await server.listen();
  const { port } = server.httpServer.address();

  const machine = `${os.hostname().toLowerCase().split('.')[0]}.local`;
  for (const [host, status] of [
    [`attacker.example:${port}`, 403],
    [`${machine}.attacker.example:${port}`, 403],
    [`some-other-device.local:${port}`, 403],
    [`${machine}:${port}`, 200],
    [`gev.example:${port}`, 200],
    [`localhost:${port}`, 200],
    [`192.168.1.20:${port}`, 200],
    [`[::1]:${port}`, 200],
  ]) {
    assert.equal(await statusFor(port, host), status, host);
  }
});
