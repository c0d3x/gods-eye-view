import assert from 'node:assert/strict';
import test from 'node:test';
import {
  electronBuilderConfig,
  isUnsignedResource,
  PRODUCT_NAME,
  pickSigningIdentity,
} from './packaging.mjs';

const hash = (/** @type {string} */ digit) => digit.repeat(40);
const found = (/** @type {string[]} */ lines) =>
  `${lines.map((line, index) => `  ${index + 1}) ${line}`).join('\n')}\n     ${lines.length} valid identities found\n`;

test('a Developer ID certificate is preferred, then Apple Development', () => {
  const both = found([
    `${hash('A')} "Apple Development: Jo Dev (TEAM1)"`,
    `${hash('B')} "Developer ID Application: Jo Dev (TEAM1)"`,
  ]);
  assert.deepEqual(pickSigningIdentity(both), {
    hash: hash('B'),
    name: 'Developer ID Application: Jo Dev (TEAM1)',
    kind: 'developer-id',
  });
  const development = found([
    `${hash('A')} "Apple Development: Jo Dev (TEAM1)"`,
  ]);
  assert.equal(pickSigningIdentity(development)?.kind, 'development');
  assert.equal(pickSigningIdentity('     0 valid identities found\n'), null);
});

test('two certificates with one name are told apart by hash', () => {
  const twins = found([
    `${hash('C')} "Apple Development: Jo Dev (TEAM1)"`,
    `${hash('D')} "Apple Development: Jo Dev (TEAM1)"`,
  ]);
  assert.equal(pickSigningIdentity(twins)?.hash, hash('C'));
  assert.equal(pickSigningIdentity(twins, hash('D'))?.hash, hash('D'));
  assert.equal(pickSigningIdentity(twins, 'Developer ID Application: X'), null);
});

test('only native modules under the app folder are signed on their own', () => {
  const app = '/x/God.app/Contents/Resources/app';
  assert.equal(isUnsignedResource(`${app}/dist/cesium/Assets/a.jpg`), true);
  assert.equal(isUnsignedResource(`${app}/server/providers/local.js`), true);
  assert.equal(
    isUnsignedResource(`${app}/node_modules/@rolldown/binding/x.node`),
    false,
  );
  assert.equal(
    isUnsignedResource(
      '/x/God.app/Contents/Frameworks/Electron Framework.framework',
    ),
    false,
  );
});

test('a signed build uses the hardened runtime and the entitlements; an ad-hoc one does not', () => {
  const sign = async () => {};
  const signed = electronBuilderConfig({
    outDir: '/out',
    identity: hash('A'),
    sign,
  });
  assert.equal(signed.productName, PRODUCT_NAME);
  assert.equal(signed.mac.identity, hash('A'));
  assert.equal(signed.mac.hardenedRuntime, true);
  assert.equal(signed.mac.entitlements, 'app/build/entitlements.mac.plist');
  assert.equal(signed.mac.sign, sign);
  assert.deepEqual(signed.mac.target, [{ target: 'dmg', arch: ['arm64'] }]);
  assert.equal(signed.publish, null, 'nothing is published');
  assert.match(signed.mac.extendInfo.NSMicrophoneUsageDescription, /voice/);
  const adHoc = electronBuilderConfig({ outDir: '/out', identity: null, sign });
  assert.equal(adHoc.mac.identity, '-');
  assert.equal(adHoc.mac.hardenedRuntime, false);
  assert.equal(adHoc.mac.entitlements, undefined);
});

test('the app ships its server and built files, without tests or browser-only packages', () => {
  const { files } = electronBuilderConfig({
    outDir: '/out',
    identity: null,
    sign: async () => {},
  });
  for (const entry of [
    'app/**/*.mjs',
    'dist/**/*',
    'server/**/*',
    'src/**/*',
  ]) {
    assert.ok(files.includes(entry), entry);
  }
  for (const entry of [
    '!**/*.test.mjs',
    '!node_modules/cesium/Build/**',
    '!node_modules/hls.js/**',
    '!node_modules/mapillary-js/**',
  ]) {
    assert.ok(files.includes(entry), entry);
  }
});
