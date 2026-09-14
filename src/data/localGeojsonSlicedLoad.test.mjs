import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import * as Cesium from 'cesium';
import { createLocalGeoJsonLayer, yieldToMain } from './localGeojson.js';

// The layer keeps its entity contexts on window, which Node does not have.
// One stand-in serves the whole file, so a layer destroyed mid-load still
// finds it while the load unwinds.
const originalWindow = globalThis.window;
before(() => {
  globalThis.window = { dispatchEvent() {} };
});
after(() => {
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
});

/**
 * GeoJSON Lines for `count` polygon features, one entity each. Polygons only:
 * Cesium draws point markers on a canvas, which Node does not have.
 */
function fixtureLines(count) {
  return Array.from({ length: count }, (_, index) => {
    const lon = -97.7 + index * 0.01;
    const lat = 30.2 + (index % 5) * 0.01;
    return JSON.stringify({
      type: 'Feature',
      id: `site-${index}`,
      properties: { name: `Site ${index}` },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [lon, lat],
            [lon + 0.005, lat],
            [lon + 0.005, lat + 0.005],
            [lon, lat],
          ],
        ],
      },
    });
  });
}

class MockEvent {
  listeners = new Set();
  addEventListener(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  removeEventListener(listener) {
    this.listeners.delete(listener);
  }
}

/**
 * A real local layer over `lines`, with a scene that records the data sources
 * added to it and removed from it. Call enable() to load it.
 */
function fixtureLayer(t, lines, { loadSliceSize, yieldDuringLoad } = {}) {
  const added = [];
  const removed = [];
  const viewer = {
    selectedEntity: undefined,
    dataSources: {
      add(dataSource) {
        added.push(dataSource);
        return dataSource;
      },
      remove(dataSource) {
        removed.push(dataSource);
        return true;
      },
    },
    camera: {
      positionWC: Cesium.Cartesian3.fromDegrees(-97.6, 30.2, 100_000),
      frustum: { fov: Math.PI / 3 },
      moveEnd: new MockEvent(),
      flyTo() {},
    },
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600 },
      preRender: new MockEvent(),
      sampleHeightSupported: false,
      screenSpaceCameraController: { enableInputs: true },
      pick() {
        return null;
      },
      requestRender() {},
    },
  };
  const layer = createLocalGeoJsonLayer({
    id: 'local-dams',
    url: '/fixture.geojsonl',
    name: 'Fixture Dams',
    color: '#0088ff',
    overlayHost: { setVisible() {}, setEntries() {}, clearSource() {} },
    projectToWindow: () => ({ x: 400, y: 300 }),
    screenSpaceEventHandlerFactory: () => ({
      setInputAction() {},
      destroy() {},
    }),
    loadSliceSize,
    yieldDuringLoad,
  });
  // destroy() is idempotent, so a test may call it before this hook does.
  const destroy = () => layer.destroy(viewer);
  t.after(destroy);
  const enable = async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => lines.join('\n'),
    });
    try {
      await layer.enable(viewer);
    } finally {
      globalThis.fetch = originalFetch;
    }
  };
  return { layer, viewer, added, removed, enable, destroy };
}

/** What a data source's entities look like once the layer has set them up. */
function snapshot(dataSource) {
  const now = Cesium.JulianDate.now();
  return dataSource.entities.values.map((entity) => {
    const position = entity.position?.getValue(now);
    return {
      id: entity.id,
      layer: entity.__localLayerId,
      position: position
        ? [position.x, position.y, position.z].map((value) => Math.round(value))
        : null,
      stem: Boolean(entity.polyline),
      point: Boolean(entity.point),
    };
  });
}

test('a sliced load builds the same entities as a single pass', async (t) => {
  const lines = fixtureLines(23);
  const whole = fixtureLayer(t, lines, { loadSliceSize: Infinity });
  await whole.enable();
  assert.equal(whole.added.length, 1);
  const expected = snapshot(whole.added[0]);
  const expectedStats = whole.layer.getStats().count;
  const expectedStems = whole.layer.getLodDiagnostics().total;
  whole.destroy();

  const sliced = fixtureLayer(t, lines, { loadSliceSize: 5 });
  await sliced.enable();
  assert.equal(sliced.added.length, 1);
  assert.equal(expected.length, 23);
  assert.deepEqual(snapshot(sliced.added[0]), expected);
  assert.equal(sliced.layer.getStats().count, expectedStats);
  assert.equal(sliced.layer.getLodDiagnostics().total, expectedStems);
});

test('a large load yields to the browser between slices, a small one never', async (t) => {
  let yields = 0;
  const counted = async () => {
    yields += 1;
  };
  const sliced = fixtureLayer(t, fixtureLines(23), {
    loadSliceSize: 5,
    yieldDuringLoad: counted,
  });
  await sliced.enable();
  // 23 lines, features and entities in slices of 5: four yields per phase.
  assert.equal(yields, 12);
  assert.equal(sliced.layer.getStats().count, 23);
  sliced.destroy();

  yields = 0;
  const whole = fixtureLayer(t, fixtureLines(23), {
    loadSliceSize: Infinity,
    yieldDuringLoad: counted,
  });
  await whole.enable();
  assert.equal(yields, 0);
});

test('destroying the layer between slices leaves nothing in the scene', async (t) => {
  // The 6th yield falls while Cesium builds the entities, before the source
  // joins the scene; the 10th while the layer sets up each entity, after.
  for (const [destroyAt, joinedScene] of [
    [6, false],
    [10, true],
  ]) {
    let yields = 0;
    const fixture = fixtureLayer(t, fixtureLines(23), {
      loadSliceSize: 5,
      yieldDuringLoad: async () => {
        yields += 1;
        if (yields === destroyAt) fixture.destroy();
      },
    });
    await fixture.enable();
    assert.equal(yields, destroyAt, `the load stops at yield ${destroyAt}`);
    assert.equal(fixture.added.length, joinedScene ? 1 : 0);
    // Counted, not compared: a failing deepEqual would print whole data sources.
    const leftInScene = fixture.added.filter(
      (source) => !fixture.removed.includes(source),
    );
    assert.equal(
      leftInScene.length,
      0,
      'a source that joined the scene is removed again',
    );
    assert.equal(fixture.layer.getStats().count, 0);
  }
});

test('yieldToMain gives way even while the test timers are faked', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'setImmediate'] });
  await yieldToMain();
});
