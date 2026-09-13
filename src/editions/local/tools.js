import { initAnnotations } from '../../annotations/index.js';
import {
  getRenderGovernorDiagnostics,
  governorRequestRender,
  holdContinuousRender,
  installRenderGovernor,
  releaseContinuousRender,
} from '../../renderGovernor.js';
import { SceneDirector } from '../../scenes/director.js';
import { destroyScopeMask, installScopeMask } from '../../scopeMask.js';
import { startLocalChrome } from './startupChrome.js';

/** Attach scene tools, rendering listeners and the standalone debug handle. */
export function createLocalTools({
  scene,
  controls,
  data,
  loadingScreen,
  signal,
  defer,
}) {
  const { viewer, tileset, mapStackController } = scene;
  const { styleManager, weatherEffects, cockpitCloudEffects } = controls;
  const { dataManager } = data;
  const sceneDirector = new SceneDirector(viewer, styleManager, dataManager);
  defer(() => sceneDirector.destroy());
  const annotations = initAnnotations({ viewer, tileset });
  defer(() => {
    if (window.__gevAnnotations === annotations) delete window.__gevAnnotations;
    annotations.destroy();
  });
  defer(startLocalChrome({ loadingScreen, styleManager, dataManager, signal }));
  // Idle render governor: flips the scene into requestRenderMode whenever
  // nothing animates per frame. Installed AFTER every module above has had
  // its chance to register pre-install holds. (perf wave 2)
  installRenderGovernor(viewer);

  // Install the explicit scope mask used by the DISPLAY controls.
  installScopeMask(viewer);
  defer(() => destroyScopeMask());

  // The follow camera recomputes the tracked target's dead-reckon position
  // every frame — tracking anything is a per-frame animation. (perf wave 2)
  const removeTrackingListener = viewer.trackedEntityChanged.addEventListener(
    () => {
      if (viewer.trackedEntity) holdContinuousRender('tracked-entity');
      else releaseContinuousRender('tracked-entity');
    },
  );

  // Hidden-state suspension (perf wave 2): when the window/tab is hidden,
  // stop the default render loop outright — a hidden canvas repaints for
  // nobody, and browser rAF throttling still lets throttled frames burn
  // GPU. Holder/data state is untouched, so return is seamless: restore
  // the loop, refresh the one DOM surface we gated, render a frame.
  const syncVisibilitySuspension = () => {
    const hidden = document.hidden;
    viewer.useDefaultRenderLoop = !hidden;
    cockpitCloudEffects?.setSuspended?.(hidden);
    if (!hidden) {
      if (dataManager._panelRefreshPendingOnVisible) {
        dataManager._panelRefreshPendingOnVisible = false;
        dataManager._refreshTogglePanel();
      }
      governorRequestRender('visibility-restore');
    }
  };
  document.addEventListener('visibilitychange', syncVisibilitySuspension);
  defer(() =>
    document.removeEventListener('visibilitychange', syncVisibilitySuspension),
  );
  defer(() => {
    removeTrackingListener();
    releaseContinuousRender('tracked-entity');
  });
  // Apply the CURRENT state too — bootstrap can complete while the tab is
  // already hidden, and waiting for the next transition would leave the
  // loop burning behind a hidden tab. (perf wave 2 fix)
  syncVisibilitySuspension();

  window.__godsEyeView = {
    viewer,
    styleManager,
    tileset,
    dataManager,
    sceneDirector,
    mapStackController,
    annotations,
    weatherEffects,
    cockpitCloudEffects,
    getRenderGovernorDiagnostics,
    requestRender: governorRequestRender,
  };
  const debug = window.__godsEyeView;
  defer(() => {
    if (window.__godsEyeView === debug) delete window.__godsEyeView;
  });
  // The voice stack is a chunk of its own. It starts loading once everything
  // above is attached, and its controls appear when it arrives; a teardown
  // that comes first means it never starts.
  let voiceCommands = null;
  let closed = false;
  defer(() => {
    closed = true;
    if (!voiceCommands) return;
    voiceCommands.stop({ removeUi: true });
    if (window.__gevVoiceCommands === voiceCommands)
      delete window.__gevVoiceCommands;
  });
  const voiceReady = import('../../voice/gevRealtime.js').then(
    ({ initGevVoiceCommands }) => {
      if (closed) return null;
      voiceCommands = initGevVoiceCommands({
        viewer,
        styleManager,
        dataManager,
        sceneDirector,
        annotations,
      });
      debug.voiceCommands = voiceCommands;
      return voiceCommands;
    },
    (error) => {
      console.warn(
        '[GEV] Voice control failed to load:',
        error?.message || error,
      );
      return null;
    },
  );
  return {
    sceneDirector,
    annotations,
    voiceReady,
    get voiceCommands() {
      return voiceCommands;
    },
  };
}
