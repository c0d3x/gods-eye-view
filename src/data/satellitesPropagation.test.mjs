import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { twoline2satrec } from 'satellite.js';
import satellitesLayer, {
  _clearDenseCatalogStateForTest,
  _propagateAllForTest,
  _seedCatalogForTest,
} from './satellites.js';

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

test('a decayed satellite fails once, then is skipped until the next refresh', () => {
  const healthyPoint = point();
  const { records } = _seedCatalogForTest([
    {
      noradId: 90001,
      name: 'DECAYED',
      satrec: twoline2satrec(DECAYING_L1, L2),
      point: point(),
    },
    {
      noradId: 25544,
      name: 'ISS',
      satrec: twoline2satrec(L1, L2),
      point: healthyPoint,
    },
  ]);
  try {
    assert.doesNotThrow(() => _propagateAllForTest(AFTER_DECAY));
    assert.equal(records.get(90001).failed, true);
    assert.equal(records.get(25544).failed, undefined);
    assert.equal(satellitesLayer.getStats().failed, 1);
    const firstFix = Cesium.Cartesian3.clone(healthyPoint.position);

    // Later ticks skip the failed row without even reading its element set.
    const failed = records.get(90001);
    const { satrec } = failed;
    let reads = 0;
    Object.defineProperty(failed, 'satrec', {
      get() {
        reads += 1;
        return satrec;
      },
    });
    const later = new Date(AFTER_DECAY.getTime() + 60_000);
    assert.equal(_propagateAllForTest(later), 1, 'the healthy satellite moves');
    assert.equal(reads, 0);
    assert.equal(satellitesLayer.getStats().failed, 1, 'a failure counts once');
    assert.equal(
      Cesium.Cartesian3.equals(healthyPoint.position, firstFix),
      false,
    );
  } finally {
    _clearDenseCatalogStateForTest();
  }
});
