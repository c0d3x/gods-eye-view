import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as Cesium from 'cesium';
import { twoline2satrec } from 'satellite.js';
import {
  _resetRenderGovernorForTest,
  getRenderGovernorDiagnostics,
  installRenderGovernor,
} from '../renderGovernor.js';
import satellitesLayer, {
  _clearDenseCatalogStateForTest,
  _clearSatelliteLabelLifecycleForTest,
  _setDenseCatalogStateForTest,
  _setSatelliteLabelLifecycleStateForTest,
} from './satellites.js';

const L1 =
  '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927';
const L2 =
  '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537';

const holds = () => getRenderGovernorDiagnostics().holds;

function installGovernor() {
  _resetRenderGovernorForTest();
  installRenderGovernor({
    scene: {
      requestRenderMode: true,
      maximumRenderTimeChange: Number.POSITIVE_INFINITY,
      requestRender() {},
    },
  });
}

test('the layer holds continuous rendering only while its dots or rings are shown', () => {
  installGovernor();
  // An enabled layer, as Space Missions keeps it: dots and rings hidden.
  _setDenseCatalogStateForTest({ showPoints: false });
  try {
    satellitesLayer.setParams({ showPoints: false, showOrbits: false });
    assert.deepEqual(holds(), [], 'nothing moves, so the render loop can idle');

    satellitesLayer.setParams({ showPoints: true });
    assert.deepEqual(holds(), ['satellites']);
    satellitesLayer.setParams({ showPoints: false });
    assert.deepEqual(holds(), []);

    satellitesLayer.setParams({ showOrbits: true });
    assert.deepEqual(holds(), ['satellites']);
    satellitesLayer.setParams({ showOrbits: false });
    assert.deepEqual(holds(), []);
    assert.equal(getRenderGovernorDiagnostics().mode, 'idle');
  } finally {
    _clearDenseCatalogStateForTest();
    _resetRenderGovernorForTest();
  }
});

test('a tracked satellite holds continuous rendering while the camera follows it', () => {
  installGovernor();
  const point = {
    position: Cesium.Cartesian3.fromDegrees(-97.7, 30.2, 420_000),
    show: true,
  };
  const viewer = {
    entities: new Cesium.EntityCollection(),
    trackedEntity: undefined,
    scene: {
      frameState: { frameNumber: 1 },
      primitives: { remove() {} },
    },
  };
  _setSatelliteLabelLifecycleStateForTest({
    viewer,
    satrec: twoline2satrec(L1, L2),
    point,
  });
  try {
    satellitesLayer.setParams({ showPoints: false, showOrbits: false });
    assert.deepEqual(holds(), []);

    assert.equal(satellitesLayer.trackById(25544), true);
    assert.deepEqual(holds(), ['satellites'], 'the camera moves every frame');

    satellitesLayer.stopTracking();
    assert.deepEqual(holds(), [], 'released once nothing moves again');
  } finally {
    _clearSatelliteLabelLifecycleForTest();
    _resetRenderGovernorForTest();
  }
});

test('enabling the layer takes the hold through the same sync', () => {
  const lifecycle = readFileSync(
    new URL('../layers/satellites/lifecycle.js', import.meta.url),
    'utf8',
  );
  const enable = lifecycle.slice(
    lifecycle.indexOf('enable(viewer) {'),
    lifecycle.indexOf('disable(viewer) {'),
  );
  assert.match(enable, /_syncContinuousRenderHold\(\);/);
  assert.doesNotMatch(enable, /holdContinuousRender\('satellites'\)/);
});
