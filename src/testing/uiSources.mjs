// The text of src/ui.js and of the modules its panels move into (#46), for the
// tests that read UI code as text. They read it all as one string, so a panel
// that moves out of ui.js does not break them: its module joins this list.
import { readFileSync } from 'node:fs';

/** src/ui.js, then each module extracted from it, relative to src/. */
export const UI_SOURCE_FILES = Object.freeze([
  'ui.js',
  'ui/cockpitView.js',
  'ui/radioPanel.js',
  'ui/cctvPanel.js',
  'ui/panelLayout.js',
  'ui/panelChrome.js',
  'ui/locationBar.js',
  'ui/globeNavigation.js',
  'ui/styleConfig.js',
  'ui/visualStyles.js',
  'ui/detectionControls.js',
  'ui/cockpitControls.js',
]);

/**
 * The files in UI_SOURCE_FILES, read and joined in that order.
 * @returns {string}
 */
export function readUiSource() {
  return UI_SOURCE_FILES.map((file) =>
    readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'),
  ).join('\n');
}
