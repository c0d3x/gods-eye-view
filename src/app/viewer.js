// @ts-check
import * as Cesium from 'cesium';

/**
 * Create the standard globe viewer in caller-owned, visible containers.
 * @param {{ container: Element | string, creditContainer: Element | string }} containers
 *   The viewer's container, and the one that holds its credits.
 * @returns {Cesium.Viewer}
 */
export function createApplicationViewer({ container, creditContainer }) {
  if (!container || !creditContainer)
    throw new TypeError('Viewer and credit containers are required');
  const viewer = new Cesium.Viewer(container, {
    timeline: false,
    animation: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    vrButton: false,
    selectionIndicator: false,
    infoBox: false,
    baseLayer: false,
    creditContainer,
    msaaSamples: 4,
    contextOptions: { webgl: { preserveDrawingBuffer: true } },
  });
  try {
    viewer.targetFrameRate = 60;
    viewer.scene.globe.show = false;
    // The viewer always creates a sky atmosphere, since the options above
    // don't set `skyAtmosphere: false`.
    const skyAtmosphere = /** @type {Cesium.SkyAtmosphere} */ (
      viewer.scene.skyAtmosphere
    );
    skyAtmosphere.show = true;
    skyAtmosphere.atmosphereLightIntensity = 18;
    skyAtmosphere.saturationShift = -0.12;
    skyAtmosphere.brightnessShift = -0.08;
    return viewer;
  } catch (error) {
    viewer.destroy();
    throw error;
  }
}
