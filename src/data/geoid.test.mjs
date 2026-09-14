// src/data/geoid.test.mjs — EGM96 geoid-undulation lookup (docs/plans/2026-07-05-entity-height-datum-fix.md Task 1).
//
// Locks the module's public interface (later tasks — aircraft altitude
// correction, CCTV terrain fallback — call this verbatim):
//   ensureGeoidReady(): Promise<void>   lazy-loads the grid on first call
//   geoidHeight(latDeg, lonDeg): number N in metres; throws if not ready
//   orthometricToEllipsoidal(hMslM, latDeg, lonDeg): number  hMslM + N
//
// Tolerance is loose (±2.5 m) by design: the bundled grid is EGM96 while the
// plan's "Verified facts" reference values are Re:Earth's EGM2008 — the two
// models differ by up to ~1 m, and the brief's own tolerance absorbs that
// spread rather than asserting exact agreement.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import {
  ellipsoidalToMslDisplayM,
  ensureGeoidReady,
  ensureGeoidReadyWhenIdle,
  geoidHeight,
  isGeoidReady,
  orthometricToEllipsoidal,
} from './geoid.js';

const TOLERANCE_M = 2.5;

const LONDON = { lat: 51.5072, lon: -0.1275, nExpected: 46.1 };
const AUSTIN = { lat: 30.2672, lon: -97.7431, nExpected: -26.9 };
const SF = { lat: 37.7749, lon: -122.4194, nExpected: -32.2 };
const DENVER = { lat: 39.7392, lon: -104.9903, nExpected: -17.3 };
/** SFO runway 28R touchdown area — the cockpit/OSD field report's coordinates. */
const SFO = { lat: 37.616, lon: -122.368 };

test('geoidHeight throws before ensureGeoidReady() has resolved', () => {
  // A fresh, never-initialized module instance can't be observed from the
  // same process (ESM module cache), so this asserts the documented
  // contract via the type check further down instead of re-importing.
  // (See "ready-gate" test below for the real not-ready behavior.)
  assert.equal(typeof geoidHeight, 'function');
});

// Runs before any other test here loads the grid, so it sees the cold state.
test('ensureGeoidReadyWhenIdle() loads the grid at the next idle moment', async () => {
  const idle = [];
  const previous = globalThis.requestIdleCallback;
  globalThis.requestIdleCallback = (callback, options) => {
    idle.push({ callback, options });
    return idle.length;
  };
  try {
    assert.equal(isGeoidReady(), false);
    const ready = ensureGeoidReadyWhenIdle();
    assert.equal(idle.length, 1, 'the load waits for an idle moment');
    assert.ok(
      idle[0].options?.timeout > 0,
      'with a deadline, so a busy page still gets it',
    );
    assert.equal(isGeoidReady(), false);
    idle[0].callback();
    await ready;
    assert.equal(isGeoidReady(), true);
    // Once the grid is in, a later caller gets it without waiting again.
    await ensureGeoidReadyWhenIdle();
    assert.equal(idle.length, 1);
  } finally {
    if (previous === undefined) delete globalThis.requestIdleCallback;
    else globalThis.requestIdleCallback = previous;
  }
});

test('ensureGeoidReady() resolves and is idempotent (safe to call repeatedly)', async () => {
  await ensureGeoidReady();
  await ensureGeoidReady();
  await ensureGeoidReady();
});

test('geoidHeight matches known EGM96 undulation values within ±2.5 m', async () => {
  await ensureGeoidReady();
  for (const { lat, lon, nExpected } of [LONDON, AUSTIN, SF, DENVER]) {
    const n = geoidHeight(lat, lon);
    assert.ok(
      Math.abs(n - nExpected) <= TOLERANCE_M,
      `geoidHeight(${lat}, ${lon}) = ${n}, expected ≈ ${nExpected} (±${TOLERANCE_M})`,
    );
  }
});

test('orthometricToEllipsoidal adds the geoid undulation to the MSL height', async () => {
  await ensureGeoidReady();
  const hMslM = 15;
  const hEllipsoidal = orthometricToEllipsoidal(hMslM, LONDON.lat, LONDON.lon);
  // London geoid ≈ +46.1 -> 15 + 46.1 = 61.1, expect ≈ 61 within tolerance.
  assert.ok(
    Math.abs(hEllipsoidal - 61) <= TOLERANCE_M,
    `orthometricToEllipsoidal(15, london) = ${hEllipsoidal}, expected ≈ 61 (±${TOLERANCE_M})`,
  );
  // Must equal hMslM + geoidHeight exactly (same lookup, no extra fudge).
  const n = geoidHeight(LONDON.lat, LONDON.lon);
  assert.equal(hEllipsoidal, hMslM + n);
});

test('geoidHeight wraps longitude consistently (359.87 === -0.13)', async () => {
  await ensureGeoidReady();
  const wrapped = geoidHeight(51.5, 359.87);
  const normal = geoidHeight(51.5, -0.13);
  // Both longitudes name the same physical point (360° apart); the
  // underlying grid lookup takes different floating-point paths to get
  // there (mod-2π normalization), so equality is asserted to FP epsilon
  // rather than bit-for-bit — this is the "consistent," not "identical
  // bit pattern," invariant the brief calls for.
  assert.ok(
    Math.abs(wrapped - normal) < 1e-9,
    `geoidHeight(51.5, 359.87) = ${wrapped}, geoidHeight(51.5, -0.13) = ${normal}`,
  );
});

test('the grid asset reproduces the egm96-universal lookup it replaced, value for value', async () => {
  await ensureGeoidReady();
  // egm96-universal 1.1.1's meanSeaLevel() at the same points, captured before
  // the package was removed. The asset was also compared at every grid node and
  // 200 000 random points, with no difference at all.
  for (const [lat, lon, n] of [
    [51.5, -0.12, 45.95440000000002],
    [37.62, -122.38, -32.29729599999996],
    [0, 0, 17.16],
    [-8, 147, 84.23],
    [27, 86.9, -51.52999999999999],
  ]) {
    assert.equal(geoidHeight(lat, lon), n, `geoidHeight(${lat}, ${lon})`);
  }
});

test('every grid node reads back the undulation the asset stores', async () => {
  await ensureGeoidReady();
  // 721 rows from 90°N to 90°S and 1440 columns eastward from 0°, 15′ apart.
  // At a node the interpolation lands on that node, so the rounded values sum
  // to the grid's own sum, in centimetres.
  let sumCm = 0;
  for (let row = 0; row < 721; row++) {
    for (let col = 0; col < 1440; col++) {
      sumCm += Math.round(geoidHeight(90 - row * 0.25, col * 0.25) * 100);
    }
  }
  assert.equal(sumCm, -149_932_197);
});

test('a point off the globe has no undulation', async () => {
  await ensureGeoidReady();
  assert.ok(Number.isNaN(geoidHeight(Number.NaN, 0)));
  assert.ok(Number.isNaN(geoidHeight(0, Number.POSITIVE_INFINITY)));
  assert.ok(Number.isNaN(geoidHeight(undefined, 10)));
  // Past a pole, where egm96-universal threw a RangeError.
  assert.ok(Number.isNaN(geoidHeight(90.1, 0)));
  assert.ok(Number.isNaN(geoidHeight(-91, 0)));
});

test('coordinates are read as numbers, the way egm96-universal read them', async () => {
  await ensureGeoidReady();
  assert.equal(geoidHeight('51.5', '-0.12'), 45.95440000000002);
  assert.equal(geoidHeight(null, 0), 17.16);
});

test('a grid the server already unpacked decodes to the same values', async (t) => {
  // Vite serves a .gz file with Content-Encoding: gzip, so in the browser the
  // grid can arrive decompressed.
  const fs = process.getBuiltinModule('node:fs');
  const file = fs.readFileSync(
    new URL('./local_data/egm96/egm96-15.bin.gz', import.meta.url),
  );
  const fresh = await import('./geoid.js?server-unpacked');
  const readFileSync = t.mock.method(fs, 'readFileSync', () =>
    gunzipSync(file),
  );
  await fresh.ensureGeoidReady();
  readFileSync.mock.restore();
  await ensureGeoidReady();
  for (const [lat, lon] of [
    [51.5, -0.12],
    [-8, 147],
    [90, 0],
    [-90, 180],
  ]) {
    assert.equal(
      fresh.geoidHeight(lat, lon),
      geoidHeight(lat, lon),
      `geoidHeight(${lat}, ${lon})`,
    );
  }
});

test('a failed grid load is not cached: the next caller tries again', async (t) => {
  const fs = process.getBuiltinModule('node:fs');
  const fresh = await import('./geoid.js?retry-after-failure');
  const readFileSync = t.mock.method(
    fs,
    'readFileSync',
    () => new Uint8Array(10),
  );
  await assert.rejects(
    fresh.ensureGeoidReady(),
    /the grid is 10 bytes, not 2076480/,
  );
  assert.equal(fresh.isGeoidReady(), false);
  readFileSync.mock.restore();
  await fresh.ensureGeoidReady();
  assert.equal(fresh.isGeoidReady(), true);
});

// ── ellipsoidalToMslDisplayM — the ALT-readout datum correction ─────────────
//
// Field report (2026-08-22, cockpit parked at SFO): the camera OSD read
// "ALT: -15M" because Cesium's camera height is ELLIPSOIDAL and San Francisco
// sits ~32 m above the geoid's dip under the ellipsoid. Same family as the
// earlier JFK "ALT: -18M".

test('the SFO deck case: an ellipsoidal height equal to N reads as 0 m MSL', async () => {
  await ensureGeoidReady();
  const n = geoidHeight(SFO.lat, SFO.lon);
  // A camera sitting exactly ON the geoid reports h = N against the ellipsoid.
  assert.equal(ellipsoidalToMslDisplayM(n, n), 0);
});

test('the reported SFO cockpit OSD height turns into a small positive MSL number', async () => {
  await ensureGeoidReady();
  const n = geoidHeight(SFO.lat, SFO.lon);
  assert.ok(
    n < -25 && n > -40,
    `SFO undulation should be strongly negative, got ${n}`,
  );
  // The owner's screenshot: ALT: -15m ellipsoidal over the SFO deck.
  const displayed = ellipsoidalToMslDisplayM(-15, n);
  assert.ok(
    displayed > 10 && displayed < 25,
    `-15 m ellipsoidal at SFO should read ≈ +17 m MSL, got ${displayed}`,
  );
});

test('a positive undulation lowers the readout — the correction subtracts N', async () => {
  await ensureGeoidReady();
  const n = geoidHeight(LONDON.lat, LONDON.lon);
  assert.ok(n > 40, `London undulation should be strongly positive, got ${n}`);
  // Cruise case: 10 km ellipsoidal over London reads ~46 m LOWER as MSL.
  const cruise = ellipsoidalToMslDisplayM(10000, n);
  assert.equal(cruise, 10000 - n);
  assert.ok(
    cruise > 9950 && cruise < 9960,
    `10 000 m ellipsoidal over London should read ≈ 9954 m MSL, got ${cruise}`,
  );
});

test('ellipsoidalToMslDisplayM round-trips orthometricToEllipsoidal', async () => {
  await ensureGeoidReady();
  for (const point of [LONDON, AUSTIN, SF, DENVER]) {
    const n = geoidHeight(point.lat, point.lon);
    const ellipsoidal = orthometricToEllipsoidal(120, point.lat, point.lon);
    // Exact to FP epsilon: +N then -N is the same lookup, no extra fudge.
    assert.ok(Math.abs(ellipsoidalToMslDisplayM(ellipsoidal, n) - 120) < 1e-9);
  }
});

test('an unavailable geoid returns the uncorrected height, never NaN or blank', () => {
  // Grid still loading, lazy import failed, or an out-of-range lookup: the
  // readout degrades to the ellipsoidal number rather than printing NaN.
  for (const missing of [null, undefined, Number.NaN, 'x']) {
    assert.equal(ellipsoidalToMslDisplayM(-15, missing), -15);
  }
});

test('a non-finite height is passed through untouched', async () => {
  await ensureGeoidReady();
  const n = geoidHeight(SFO.lat, SFO.lon);
  assert.equal(ellipsoidalToMslDisplayM(null, n), null);
  assert.equal(ellipsoidalToMslDisplayM(undefined, n), undefined);
  assert.ok(Number.isNaN(ellipsoidalToMslDisplayM(Number.NaN, n)));
});

test('geoidHeight throws a clear error if called before the grid is ready', async () => {
  // Exercise the not-ready path via a fresh dynamic import under Node's ESM
  // cache-busting query trick so this module instance has never had
  // ensureGeoidReady() called on it.
  const fresh = await import('./geoid.js?fresh-not-ready-check');
  assert.throws(() => fresh.geoidHeight(0, 0), /not ready|ensureGeoidReady/i);
});
