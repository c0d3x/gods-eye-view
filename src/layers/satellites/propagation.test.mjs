import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { propagate, twoline2satrec } from 'satellite.js';
import { createCatalog } from './catalog.js';
import { createControls } from './controls.js';
import { createOrbits } from './orbits.js';
import { createRendering } from './rendering.js';
import { createState } from './state.js';

// The ISS element set from September 2008, and the same set with its drag
// term raised from -0.0000116 to 0.5: SGP4 carries that one for a few weeks,
// then reports it decayed and satellite.js returns no position.
const L1 =
  '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927';
const DECAYING_L1 =
  '1 25544U 98067A   08264.51782528 -.00002182  00000-0  50000-2 0  2927';
const L2 =
  '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537';
const EPOCH_MS = Date.UTC(2008, 0, 1) + (264.51782528 - 1) * 86_400_000;
const AFTER_DECAY = new Date(EPOCH_MS + 60 * 86_400_000);

/** A stand-in point that copies positions on assignment, as a PointPrimitive does. */
function point() {
  let position = null;
  return {
    get position() {
      return position;
    },
    set position(value) {
      position = Cesium.Cartesian3.clone(value);
    },
  };
}

/** The layer parts the fleet loops use, wired as index.js wires them. */
function createFleet(rows) {
  const services = { focus: {}, layerState: {}, overlays: {} };
  const state = createState({ services });
  const parts = {};
  const context = { state, services, parts, source: {} };
  parts.orbits = createOrbits(context);
  parts.catalog = createCatalog(context);
  parts.rendering = createRendering(context);
  parts.controls = createControls(context);
  state._denseIds = [];
  state._denseCursor = 0;
  for (const row of rows) {
    state._catalog.set(row.noradId, {
      name: row.name,
      satrec: row.satrec,
      group: row.group || 'stations',
    });
    state._points.set(row.noradId, row.point || point());
    if (row.group === 'dense') state._denseIds.push(row.noradId);
  }
  return { state, parts };
}

/** Count reads of a row's element set from here on. */
function countSatrecReads(row) {
  const { satrec } = row;
  const counter = { reads: 0 };
  Object.defineProperty(row, 'satrec', {
    get() {
      counter.reads += 1;
      return satrec;
    },
  });
  return counter;
}

test('the decaying element set really makes satellite.js return null', () => {
  assert.equal(propagate(twoline2satrec(DECAYING_L1, L2), AFTER_DECAY), null);
  assert.ok(propagate(twoline2satrec(L1, L2), AFTER_DECAY)?.position);
});

test('propagation reports a decayed satellite as null instead of throwing', () => {
  const { parts } = createFleet([]);
  const satrec = twoline2satrec(DECAYING_L1, L2);
  assert.equal(parts.orbits.propagatePosition(satrec, AFTER_DECAY), null);
  assert.doesNotThrow(() => parts.orbits.computeOrbitPath(satrec, AFTER_DECAY));
  // A healthy one still gets a fresh object unless the caller passes scratch.
  const healthy = twoline2satrec(L1, L2);
  const first = parts.orbits.propagatePosition(healthy, AFTER_DECAY);
  assert.notEqual(parts.orbits.propagatePosition(healthy, AFTER_DECAY), first);
  const scratch = {};
  assert.equal(
    parts.orbits.propagatePosition(healthy, AFTER_DECAY, scratch),
    scratch,
  );
  assert.ok(Number.isFinite(scratch.latitude));
});

test('a decayed satellite fails once, then is skipped until the next refresh', () => {
  const healthyPoint = point();
  const { state, parts } = createFleet([
    {
      noradId: 90001,
      name: 'DECAYED',
      satrec: twoline2satrec(DECAYING_L1, L2),
    },
    {
      noradId: 25544,
      name: 'ISS',
      satrec: twoline2satrec(L1, L2),
      point: healthyPoint,
    },
  ]);
  assert.doesNotThrow(() => parts.rendering._propagateAll(AFTER_DECAY));
  assert.equal(state._catalog.get(90001).failed, true);
  assert.equal(state._catalog.get(25544).failed, undefined);
  assert.equal(parts.controls.methods.getStats().failed, 1);
  const firstFix = Cesium.Cartesian3.clone(healthyPoint.position);

  // Later ticks skip the failed row without even reading its element set.
  const counter = countSatrecReads(state._catalog.get(90001));
  const later = new Date(AFTER_DECAY.getTime() + 60_000);
  assert.equal(
    parts.rendering._propagateAll(later),
    1,
    'the healthy satellite moves',
  );
  assert.equal(counter.reads, 0);
  assert.equal(
    parts.controls.methods.getStats().failed,
    1,
    'a failure counts once',
  );
  assert.equal(
    Cesium.Cartesian3.equals(healthyPoint.position, firstFix),
    false,
  );

  // A TLE refresh builds a fresh row, which is tried again.
  state._catalog.set(90001, {
    name: 'DECAYED',
    satrec: twoline2satrec(L1, L2),
    group: 'stations',
  });
  assert.equal(parts.rendering._propagateAll(later), 2);
  assert.equal(parts.controls.methods.getStats().failed, 0);
});

test('the dense round-robin skips a decayed satellite the same way', () => {
  const healthyPoint = point();
  const { state, parts } = createFleet([
    {
      noradId: 90002,
      name: 'DECAYED DENSE',
      satrec: twoline2satrec(DECAYING_L1, L2),
      group: 'dense',
    },
    {
      noradId: 25544,
      name: 'HEALTHY DENSE',
      satrec: twoline2satrec(L1, L2),
      group: 'dense',
      point: healthyPoint,
    },
  ]);
  // A small dense set refreshes one satellite per frame, so a full pass over
  // both takes two frames.
  const pass = (now) => {
    for (let frame = 0; frame < state._denseIds.length; frame++)
      parts.catalog._propagateDenseChunk(now);
  };
  assert.doesNotThrow(() => pass(AFTER_DECAY));
  assert.equal(state._catalog.get(90002).failed, true);
  assert.ok(healthyPoint.position, 'the healthy satellite is placed');
  assert.equal(parts.controls.methods.getStats().failed, 1);

  const counter = countSatrecReads(state._catalog.get(90002));
  pass(new Date(AFTER_DECAY.getTime() + 60_000));
  assert.equal(counter.reads, 0);
});
