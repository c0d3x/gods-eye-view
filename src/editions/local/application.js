import { createApplication } from '../../app/application.js';
import { createLocalControls } from './controls.js';
import { createLocalData } from './data.js';
import { createLocalScene } from './scene.js';
import { createLocalTools } from './tools.js';

// The existing controls and layer catalog contain page-scoped state.
let constructed = false;

/** Compose the standalone application once per page. Reload to start again. */
export function createLocalApplication({
  googleApiKey,
  cesiumToken,
  allowQaRegistration = false,
}) {
  if (constructed)
    throw new Error('The standalone application already owns this page');
  constructed = true;
  const loadingScreen = document.getElementById('loading-screen');
  const loaderStatus = loadingScreen.querySelector('.loader-status');
  return createApplication({
    createScene: (context) =>
      createLocalScene({ ...context, googleApiKey, cesiumToken, loaderStatus }),
    createControls: (context) =>
      createLocalControls({ ...context, loaderStatus }),
    createData: (context) =>
      createLocalData({ ...context, allowQaRegistration }),
    createTools: (context) => createLocalTools({ ...context, loadingScreen }),
  });
}
