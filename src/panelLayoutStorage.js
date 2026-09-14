// @ts-check
/**
 * Panel positions are saved in localStorage under a versioned key,
 * `godsEyeView.v<N>.panelPos.<panelId>`. Raising N resets every panel to the
 * new layout defaults; this module retires what older versions saved.
 */

const VERSIONED_KEY =
  /^godsEyeView\.v(\d+)\.(?:(panelPos)\..+|layoutResetNotified)$/;

/**
 * @param {string} version - A storage version such as 'v8'.
 * @returns {number} Its number, or NaN when it isn't `v<digits>`.
 */
function versionNumber(version) {
  const match = /^v(\d+)$/.exec(String(version));
  return match ? Number(match[1]) : Number.NaN;
}

/**
 * Deletes the panel positions and reset markers saved under a version older
 * than `currentVersion`. Collapsed-state keys are versioned separately and
 * are left alone.
 * @param {Storage} storage - localStorage, or a stand-in with the same API.
 * @param {string} currentVersion - The current position version, e.g. 'v8'.
 * @returns {{ hadOldPositions: boolean, removed: string[] }}
 */
export function retireSupersededPanelPositions(storage, currentVersion) {
  const current = versionNumber(currentVersion);
  // A bad version would compare as older than everything and delete it all.
  if (Number.isNaN(current)) {
    throw new Error(`Bad panel position version: ${currentVersion}`);
  }
  const removed = [];
  let hadOldPositions = false;
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key === null) continue;
    const match = VERSIONED_KEY.exec(key);
    if (!match || Number(match[1]) >= current) continue;
    removed.push(key);
    if (match[2]) hadOldPositions = true;
  }
  // Remove after the scan: each removal shifts the indices key() reads.
  for (const key of removed) storage.removeItem(key);
  return { hadOldPositions, removed };
}

/**
 * Runs once per page load. Retires superseded panel positions and says
 * whether to tell the user their layout was reset: once per version, and
 * only when positions from an older version were found.
 * @param {Storage} storage - localStorage, or a stand-in with the same API.
 * @param {string} currentVersion - The current position version, e.g. 'v8'.
 * @returns {boolean} True when the reset notice should be shown.
 */
export function takePanelLayoutResetNotice(storage, currentVersion) {
  const { hadOldPositions } = retireSupersededPanelPositions(
    storage,
    currentVersion,
  );
  const marker = `godsEyeView.${currentVersion}.layoutResetNotified`;
  if (storage.getItem(marker)) return false;
  storage.setItem(marker, '1');
  return hadOldPositions;
}
