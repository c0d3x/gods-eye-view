/**
 * How the Mac app is packaged and signed (scripts/app.mjs runs this): the
 * electron-builder configuration and the choice of signing identity.
 */

import { APP_ID } from './policy.mjs';

export const PRODUCT_NAME = "God's Eye View";

/**
 * Browser-only packages the build already bundles into dist/, and the parts
 * of Cesium the server never loads (its prebuilt Build/, which dist/cesium
 * copies). The server's own imports reach Cesium's sources through shared
 * modules under src/, so the rest of Cesium stays.
 */
const LEFT_OUT = Object.freeze([
  '!node_modules/cesium/Build/**',
  '!node_modules/hls.js/**',
  '!node_modules/mapillary-js/**',
  '!node_modules/@jtarrio/**',
]);

/**
 * Chooses the certificate to sign with, from `security find-identity -v -p
 * codesigning` output: a Developer ID Application certificate (the only kind
 * Apple notarizes), then an Apple Development one (a stable identity, so the
 * microphone and Keychain grants survive rebuilds), and otherwise none, which
 * means an ad-hoc signature. `preferred` names one explicitly. The SHA-1
 * hash identifies the certificate, since a keychain can hold two with the
 * same name.
 * @param {string} output
 * @param {string} [preferred]
 * @returns {{name: string, hash: string, kind: 'developer-id' | 'development' | 'named'} | null}
 */
export function pickSigningIdentity(output, preferred) {
  const identities = [
    ...String(output).matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/gm),
  ].map((match) => ({ hash: match[1], name: match[2] }));
  if (preferred) {
    const named = identities.find(
      ({ name, hash }) => name === preferred || hash === preferred,
    );
    return named ? { ...named, kind: 'named' } : null;
  }
  const developerId = identities.find(({ name }) =>
    name.startsWith('Developer ID Application:'),
  );
  if (developerId) return { ...developerId, kind: 'developer-id' };
  const development = identities.find(({ name }) =>
    name.startsWith('Apple Development:'),
  );
  if (development) return { ...development, kind: 'development' };
  return null;
}

/**
 * Whether the signer skips a file: everything under the app's own files
 * except native Node modules. The bundle's seal still covers those files;
 * only Mach-O code needs a signature of its own, and signing every Cesium
 * texture would take minutes.
 * @param {string} file
 */
export function isUnsignedResource(file) {
  return file.includes('/Contents/Resources/app/') && !file.endsWith('.node');
}

/**
 * The electron-builder configuration.
 * @param {object} options
 * @param {string} options.outDir Where the .app and the .dmg go.
 * @param {string | null} options.identity A certificate's SHA-1 hash, or
 *   null for an ad-hoc signature.
 * @param {(opts: object) => Promise<void>} options.sign Signs the app with
 *   electron-builder's options (scripts/app.mjs passes @electron/osx-sign).
 */
export function electronBuilderConfig({ outDir, identity, sign }) {
  const signed = identity !== null;
  return {
    appId: APP_ID,
    productName: PRODUCT_NAME,
    copyright:
      'MIT License. God’s Eye View by Bilawal Sidhu; this build from c0d3x/gods-eye-view.',
    directories: { output: outDir, buildResources: 'app/build' },
    // Electron's own download, which `pnpm run app:setup` put there.
    electronDist: 'node_modules/electron/dist',
    files: [
      'package.json',
      'app/**/*.mjs',
      'build/**/*.js',
      'config/**/*',
      'dist/**/*',
      'server/**/*',
      'src/**/*',
      'scripts/google-server-key.mjs',
      'scripts/pinokio-environment.mjs',
      '!**/*.test.mjs',
      '!**/*.md',
      ...LEFT_OUT,
    ],
    // Plain files: the server reads its data and WASM from disk.
    asar: false,
    // No native modules need building for Electron; the few prebuilt ones
    // use Node-API.
    npmRebuild: false,
    publish: null,
    mac: {
      target: [{ target: 'dmg', arch: ['arm64'] }],
      category: 'public.app-category.reference',
      icon: 'app/build/icon.png',
      identity: signed ? identity : '-',
      sign,
      // The hardened runtime needs a real certificate: with an ad-hoc
      // signature, library validation would refuse the app's own frameworks.
      hardenedRuntime: signed,
      entitlements: signed ? 'app/build/entitlements.mac.plist' : undefined,
      entitlementsInherit: signed
        ? 'app/build/entitlements.mac.plist'
        : undefined,
      gatekeeperAssess: false,
      notarize: false,
      extendInfo: {
        NSMicrophoneUsageDescription:
          "God's Eye View listens while you hold the voice key, to send what you say to the voice assistant.",
        NSLocationWhenInUseUsageDescription:
          "God's Eye View can center the globe on where you are.",
      },
    },
    dmg: { title: PRODUCT_NAME, writeUpdateInfo: false },
  };
}
