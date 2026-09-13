import assert from 'node:assert/strict';
import test from 'node:test';
import {
  _resetRenderGovernorForTest,
  getRenderGovernorDiagnostics,
  installRenderGovernor,
} from '../renderGovernor.js';
import satellitesLayer, {
  _clearDenseCatalogStateForTest,
  _setDenseCatalogStateForTest,
} from './satellites.js';

const holds = () => getRenderGovernorDiagnostics().holds;

test('the layer holds continuous rendering only while its dots or rings are shown', () => {
  _resetRenderGovernorForTest();
  installRenderGovernor({
    scene: {
      requestRenderMode: true,
      maximumRenderTimeChange: Number.POSITIVE_INFINITY,
      requestRender() {},
    },
  });
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
