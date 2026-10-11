import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appOrigin,
  isAppUrl,
  isExternalLink,
  toolPath,
  usbDeviceLabel,
} from './policy.mjs';

const APP = 'http://127.0.0.1:4173/';

test("only the app's own server counts as the app", () => {
  assert.equal(appOrigin(APP), 'http://127.0.0.1:4173');
  assert.equal(appOrigin(null), '');
  assert.equal(isAppUrl('http://127.0.0.1:4173/#v=2', APP), true);
  assert.equal(isAppUrl('http://127.0.0.1:4174/', APP), false);
  assert.equal(isAppUrl('http://localhost:4173/', APP), false);
  assert.equal(isAppUrl('https://evil.example/', APP), false);
  assert.equal(isAppUrl('not a url', APP), false);
  assert.equal(isAppUrl('http://127.0.0.1:4173/', null), false);
});

test('only http and https links off the app open in the browser', () => {
  assert.equal(isExternalLink('https://www.openstreetmap.org/', APP), true);
  assert.equal(isExternalLink('http://example.com/a', APP), true);
  assert.equal(isExternalLink('http://127.0.0.1:4173/panel/', APP), false);
  for (const url of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,hi',
    'smb://server/share',
    'not a url',
  ]) {
    assert.equal(isExternalLink(url, APP), false, url);
  }
});

test('the server PATH keeps what it has and adds where the tools live', () => {
  const result = toolPath('/usr/bin:/bin:/opt/homebrew/bin', '/Users/me');
  const entries = result.split(':');
  assert.deepEqual(entries.slice(0, 3), [
    '/usr/bin',
    '/bin',
    '/opt/homebrew/bin',
  ]);
  for (const folder of [
    '/usr/local/bin',
    '/Users/me/.local/bin',
    '/Users/me/.codex/bin',
  ]) {
    assert.ok(entries.includes(folder), folder);
  }
  assert.equal(new Set(entries).size, entries.length, 'no folder twice');
  assert.ok(toolPath(undefined, '/Users/me').startsWith('/opt/homebrew/bin'));
});

test('a USB device is named for the chooser', () => {
  assert.equal(
    usbDeviceLabel({
      manufacturerName: 'Realtek',
      productName: 'RTL2838UHIDIR',
      vendorId: 0x0bda,
      productId: 0x2838,
    }),
    'Realtek RTL2838UHIDIR (0bda:2838)',
  );
  assert.equal(
    usbDeviceLabel({ vendorId: 1, productId: 2 }),
    'USB device (0001:0002)',
  );
});
