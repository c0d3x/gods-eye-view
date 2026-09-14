// @ts-check
import { createLocalApplication } from './editions/local/application.js';
import { describeError } from './editions/local/errors.js';

const application = createLocalApplication({
  googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
  cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  allowQaRegistration: import.meta.env.DEV,
});

application.start().catch((error) => {
  console.error("God's Eye View initialization failed:", error);
  const loaderStatus = /** @type {HTMLElement} */ (
    document.querySelector('#loading-screen .loader-status')
  );
  loaderStatus.textContent = `Error: ${describeError(error)}`;
  loaderStatus.style.color = '#ff4444';
});

export { application };
