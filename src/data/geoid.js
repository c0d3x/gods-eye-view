// src/data/geoid.js — EGM96 geoid-undulation lookup.
//
// h = H + N: the globe (Cesium ellipsoid) needs ELLIPSOIDAL height (h);
// most real-world elevation sources (barometric altitude, MSL survey data,
// Caltrans/TfL camera priors) give ORTHOMETRIC height (H, "height above mean
// sea level"). N is the local geoid undulation — the gap between the WGS84
// ellipsoid and the geoid (~mean sea level) surface, ranging roughly
// -106..+85 m worldwide. See docs/plans/2026-07-05-entity-height-datum-fix.md.
//
// The grid is NGA's EGM96 geoid at 15 arc-minutes: 721 rows from 90°N to 90°S,
// each of 1440 columns eastward from 0°, in centimetres. It ships as a static
// asset, local_data/egm96/egm96-15.bin.gz (see the README there): each row is
// stored as little-endian Int16 differences from the value before it, and
// the file is gzipped, which brings the 2 MB grid to 0.9 MB.
// ensureGeoidReady() fetches and decodes it on first use, and geoidHeight()
// interpolates it bilinearly. Grid and interpolation are those of the
// egm96-universal package this module used to wrap, value for value.

import { readLocalAsset } from './localAsset.js';

const GRID_URL = new URL('./local_data/egm96/egm96-15.bin.gz', import.meta.url);
const ROWS = 721;
const COLS = 1440;
/** Grid spacing, 15 arc-minutes, in radians. */
const INTERVAL = (15 / 60) * (Math.PI / 180);

/** @type {Int16Array|null} Undulation in centimetres, row-major, once loaded. */
let grid = null;
let readyPromise = null;

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Unpacks the asset and undoes the row deltas. The file arrives gzipped,
 * unless the server sent it with `Content-Encoding: gzip` (Vite's does, for a
 * .gz file) and the browser has already unpacked it. The grid itself cannot
 * start with gzip's magic number: its first value is 1361 cm, bytes 51 05.
 * @param {Uint8Array} file
 * @returns {Promise<Int16Array>}
 */
async function decodeGrid(file) {
  const bytes = file[0] === 0x1f && file[1] === 0x8b ? await gunzip(file) : file;
  if (bytes.byteLength !== ROWS * COLS * 2) {
    throw new Error(`geoid.js: the grid is ${bytes.byteLength} bytes, not ${ROWS * COLS * 2}`);
  }
  const deltas = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cells = new Int16Array(ROWS * COLS);
  for (let row = 0; row < ROWS; row++) {
    let value = 0;
    for (let col = 0; col < COLS; col++) {
      const k = row * COLS + col;
      value += deltas.getInt16(k * 2, true);
      cells[k] = value;
    }
  }
  return cells;
}

/**
 * Lazily loads the EGM96 grid: the asset is fetched on the first call, so its
 * 0.9 MB stay out of the bundle and off the startup path. Safe to call many
 * times; the request happens once and later calls resolve from the cached
 * promise. A failed load is not cached, so the next call tries again.
 * @returns {Promise<void>}
 */
export async function ensureGeoidReady() {
  if (!readyPromise) {
    readyPromise = readLocalAsset(GRID_URL)
      .then(decodeGrid)
      .then((cells) => {
        grid = cells;
      })
      .catch((error) => {
        readyPromise = null;
        throw error;
      });
  }
  return readyPromise;
}

/**
 * Whether the grid has loaded, so geoidHeight() can be called right now. A
 * readout that polls can use a grid another module loaded without awaiting.
 * @returns {boolean}
 */
export function isGeoidReady() {
  return grid !== null;
}

/**
 * How long a warm-up waits for an idle moment before loading the grid anyway,
 * so a page that is never idle still gets it.
 */
export const GEOID_IDLE_TIMEOUT_MS = 5000;

/**
 * Like ensureGeoidReady(), but starts the 0.9 MB download only once the page
 * is idle, or after `timeoutMs` at the latest, so it does not compete with the
 * app's own startup. For callers that can run uncorrected until the grid
 * arrives: a readout, or a layer that re-anchors when it resolves. When the
 * grid is already loading or loaded, this returns at once. Safari has no
 * requestIdleCallback, so there it waits two seconds.
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<void>}
 */
export function ensureGeoidReadyWhenIdle({ timeoutMs = GEOID_IDLE_TIMEOUT_MS } = {}) {
  if (readyPromise) return readyPromise;
  return new Promise((resolve) => {
    const start = () => resolve(ensureGeoidReady());
    if (typeof globalThis.requestIdleCallback === 'function') {
      globalThis.requestIdleCallback(start, { timeout: timeoutMs });
    } else {
      globalThis.setTimeout(start, Math.min(timeoutMs, 2000))?.unref?.();
    }
  });
}

/** Wraps an angle in radians into [center − π, center + π). */
function normalizeRadians(rads, center = 0) {
  return rads - (2 * Math.PI) * Math.floor((rads + Math.PI - center) / (2 * Math.PI));
}

/** Undulation at one grid node, in metres. */
function node(row, col) {
  return grid[row * COLS + col] / 100;
}

function lerp(a, b, t) {
  return a + ((b - a) * t);
}

/**
 * Geoid undulation N at a given point, in metres, relative to the WGS84
 * ellipsoid (positive = geoid above ellipsoid), interpolated bilinearly
 * between the four grid nodes around it. The coordinates are read as numbers
 * the way egm96-universal read them: a numeric string counts, and null is 0.
 * A point off the globe has no undulation, so a coordinate that is not a
 * finite number, or a latitude past a pole, gives NaN. Throws if
 * `ensureGeoidReady()` has not resolved yet.
 * @param {number} latDeg
 * @param {number} lonDeg
 * @returns {number}
 */
export function geoidHeight(latDeg, lonDeg) {
  if (!grid) {
    throw new Error(
      'geoid.js: geoidHeight() called before ensureGeoidReady() resolved — ' +
        'await ensureGeoidReady() first.'
    );
  }
  const latNum = Number(latDeg);
  const lonNum = Number(lonDeg);
  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) return Number.NaN;
  const lat = normalizeRadians(latNum * (Math.PI / 180));
  const lon = normalizeRadians(lonNum * (Math.PI / 180));

  let topRow = Math.floor(((Math.PI / 2) - lat) / INTERVAL);
  // At 90°S there is no row below; interpolate from the one above instead.
  topRow = topRow === ROWS - 1 ? topRow - 1 : topRow;
  const bottomRow = topRow + 1;
  // Past a pole the rows run off the grid (egm96-universal threw a RangeError).
  if (topRow < 0 || bottomRow >= ROWS) return Number.NaN;
  const leftCol = Math.floor(normalizeRadians(lon, Math.PI) / INTERVAL);
  const rightCol = (leftCol + 1) % COLS;

  const x = (lon - normalizeRadians(leftCol * INTERVAL)) / INTERVAL;
  const y = ((Math.PI / 2) - (topRow * INTERVAL) - lat) / INTERVAL;
  const top = lerp(node(topRow, leftCol), node(topRow, rightCol), x);
  const bottom = lerp(node(bottomRow, leftCol), node(bottomRow, rightCol), x);
  return lerp(top, bottom, y);
}

/**
 * Converts an orthometric (mean-sea-level) height to an ellipsoidal
 * (WGS84 globe-relative) height: h = H + N.
 * @param {number} hMslM - orthometric height in metres (height above MSL)
 * @param {number} latDeg
 * @param {number} lonDeg
 * @returns {number} ellipsoidal height in metres
 */
export function orthometricToEllipsoidal(hMslM, latDeg, lonDeg) {
  return hMslM + geoidHeight(latDeg, lonDeg);
}

/**
 * READOUT-ONLY inverse of {@link orthometricToEllipsoidal}: H = h - N.
 *
 * Cesium reports camera and entity heights against the WGS84 ELLIPSOID, but a
 * viewer reads "ALT" as height above mean sea level — so over San Francisco
 * (N ≈ -32 m) a camera sitting 17 m above the SFO deck reports a startling
 * -15 m until the undulation is taken back out.
 *
 * Takes N as an argument instead of calling {@link geoidHeight} itself, so it
 * stays a pure function a display surface can call every tick against a cached
 * cell, and so it degrades safely: a non-finite N (grid still loading, or its
 * load failed) returns the UNCORRECTED height rather than NaN — a readout that
 * is ~30 m off for a beat beats a readout that blanks.
 *
 * This converts the DATUM of a height that is ALREADY ellipsoidal. It must
 * never be applied to a barometric/aviation altitude: those are MSL-referenced
 * already, and subtracting N there would introduce the very error it removes
 * here, sign-flipped.
 *
 * @param {number} hEllipsoidalM - height above the WGS84 ellipsoid, in metres
 * @param {number|null|undefined} geoidUndulationM - N at that point, in metres
 * @returns {number} height above MSL in metres, or the input when N is unknown
 */
export function ellipsoidalToMslDisplayM(hEllipsoidalM, geoidUndulationM) {
  if (!Number.isFinite(hEllipsoidalM)) return hEllipsoidalM;
  if (!Number.isFinite(geoidUndulationM)) return hEllipsoidalM;
  return hEllipsoidalM - geoidUndulationM;
}
