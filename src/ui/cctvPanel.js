// src/ui/cctvPanel.js — the CCTV panel: enabling the layer, stepping to the
// nearest, previous or next camera or picking one from the list, the selected
// camera's live frame, source badge and summary, coverage, auto-hop and
// projection, and the manual pose calibration. Also the CCTV sync chip, and
// the explicit camera focus the panel and other surfaces route through.
//
// These are StyleManager methods, kept here and adopted by StyleManager (see
// src/ui/adoptMethods.js); they run on its state. _initCctvPanel() wires the
// panel.

import { runCctvLayerEnableTransition } from '../cctvFocusPolicy.js';
import cctvLayer from '../data/cctv.js';
import { setSplitFlapText } from '../splitFlap.js';

/**
 * Central UI orchestrator for the God's Eye View application.
 *
 * Responsibilities:
 * - CesiumJS PostProcessStage pipeline: registers per-style GLSL stages
 *   (NVG, FLIR, CRT, anime, noir, snow) and manages intensity crossfades.
 * - Bloom and sharpen post-processing toggle/intensity control.
 * - Draggable/collapsible panel system with localStorage persistence,
 *   z-order stacking, and viewport-clamped positioning.
 * - CCTV panel: camera selection, coverage toggle, projection, calibration
 *   sliders, auto-hop, and summary typewriter effect.
 * - Location bar with city/POI preset pills, QWERTY key navigation,
 *   geocoding search, and inter-city world-jump transitions.
 * - Orbit controller integration for POI fly-around.
 * - Recording mode with safe-frame overlay and HUD mode switching.
 * - Share link encoding/decoding (delegates to ShareLinkManager).
 * - Detection overlay mode cycling and density tuning.
 * - Toast notification system.
 * - Intel HUD lifecycle and variant switching.
 */

/** Shortest-wrap signed degrees, for heading offsets typed as absolute values. */
const signedNormalizeDeg = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180;
/**
 * Field definitions for the CCTV click-to-edit pose readout. Chips DISPLAY the
 * camera's EFFECTIVE pose (not raw offsets — "HDG 135.0°" instead of the old
 * "HEADING 0°" nonsense); typed values convert back to calibration offsets
 * against the frozen basePose. ΔN/ΔE stay offset-denominated (absolute lat/lon
 * typing is user-hostile).
 */
const CCTV_CAL_FIELDS = {
  heading: {
    label: 'HDG',
    unit: '°',
    decimals: 1,
    get: (cam) => cam.headingDeg,
    toPatch: (value, base) => ({
      headingDeg: signedNormalizeDeg(value - base.headingDeg),
    }),
  },
  pitch: {
    label: 'PITCH',
    unit: '°',
    decimals: 1,
    get: (cam) => cam.pitchDeg,
    toPatch: (value, base) => ({ pitchDeg: value - base.pitchDeg }),
  },
  fov: {
    label: 'FOV',
    unit: '°',
    decimals: 0,
    get: (cam) => cam.fovDeg,
    toPatch: (value, base) => ({ fovDeg: value - base.fovDeg }),
  },
  range: {
    label: 'RANGE',
    unit: 'm',
    decimals: 0,
    get: (cam) => cam.rangeM,
    toPatch: (value, base) => ({
      rangeScale: base.rangeM > 0 ? value / base.rangeM : 1,
    }),
  },
  height: {
    label: 'HGT',
    unit: 'm',
    decimals: 0,
    get: (cam) => cam.mountHeightM,
    toPatch: (value, base) => ({ heightM: value - base.mountHeightM }),
  },
  north: {
    label: 'ΔN',
    unit: 'm',
    decimals: 1,
    get: (cam) => cam.calibration?.offsetNorthM || 0,
    toPatch: (value) => ({ offsetNorthM: value }),
  },
  east: {
    label: 'ΔE',
    unit: 'm',
    decimals: 1,
    get: (cam) => cam.calibration?.offsetEastM || 0,
    toPatch: (value) => ({ offsetEastM: value }),
  },
};

export class CctvPanel {
  /**
   * Updates the CCTV loading chip (same pattern as the traffic sync chip)
   * with staggered initial-load progress, e.g. "LOADING FRAMES 12/36".
   * Shows a brief "camera grid ready" confirmation, then hides.
   * @param {{active: boolean, loaded: number, total: number}|null|undefined} loading
   *   Loading progress from the CCTV layer UI state.
   * @param {boolean} enabled - Whether the CCTV layer is currently enabled.
   * @returns {void}
   */
  _updateCctvSyncChip(loading, enabled) {
    if (!this._cctvSyncChip || !this._cctvSyncLabel || !this._cctvSyncProgress)
      return;
    const total = Number(loading?.total) || 0;
    const loaded = Math.max(0, Math.min(Number(loading?.loaded) || 0, total));
    const busy = !!enabled && !!loading?.active && total > 0;

    if (busy) {
      clearTimeout(this._cctvChipHideTimer);
      this._cctvChipHideTimer = null;
      this._cctvChipWasBusy = true;
      setSplitFlapText(this._cctvSyncLabel, 'loading frames');
      // The counter is left plain on purpose: it ticks every few frames
      // during a grid load, and flapping it would read as a slot machine.
      this._cctvSyncProgress.textContent = `${loaded}/${total}`;
      this._cctvSyncChip.classList.add('visible');
      return;
    }

    if (this._cctvChipWasBusy && enabled && total > 0) {
      // Load just completed — flash the final count, then auto-hide.
      this._cctvChipWasBusy = false;
      setSplitFlapText(this._cctvSyncLabel, 'camera grid ready');
      this._cctvSyncProgress.textContent = `${total}/${total}`;
      this._cctvSyncChip.classList.add('visible');
      clearTimeout(this._cctvChipHideTimer);
      this._cctvChipHideTimer = window.setTimeout(() => {
        this._cctvChipHideTimer = null;
        this._cctvSyncChip.classList.remove('visible');
      }, 1500);
      return;
    }

    if (!this._cctvChipHideTimer) {
      this._cctvChipWasBusy = false;
      this._cctvSyncChip.classList.remove('visible');
    }
  }

  /**
   * Activates an explicit CCTV target, then releases tracking before its camera
   * flight. Cockpit mode keeps tracking and suppresses only the flight.
   * @param {Function} activate CCTV target activation returning its camera ID.
   * @param {Function} focus CCTV camera flight receiving the activated ID.
   * @returns {*} Focus operation result.
   */
  _runExplicitCctvFocus(activate, focus) {
    if (this._disposed) return false;
    const cameraId = activate();
    if (!cameraId) return false;
    return this._runExplicitNavigation('camera', () => focus(cameraId));
  }

  /**
   * Wires up all CCTV panel controls: enable/disable, nearest/prev/next camera,
   * camera select dropdown, focus, coverage, auto-hop, projection,
   * manual calibration sliders, and save/reset buttons.
   * @returns {void}
   */
  _initCctvPanel() {
    if (!this._cctvPanel) return;

    this._cctvEnableBtn?.addEventListener('click', async () => {
      await this._toggleCctvEnabled();
    });

    this._cctvNearestBtn?.addEventListener('click', async () => {
      if (!(await this._toggleCctvEnabled(true))) return;
      this._runExplicitCctvFocus(
        () => cctvLayer.focusNearest({ focus: false }),
        (cameraId) => cctvLayer.focusCamera(cameraId, 1.8),
      );
    });

    this._cctvPrevBtn?.addEventListener('click', async () => {
      if (!(await this._toggleCctvEnabled(true))) return;
      this._runExplicitCctvFocus(
        () => cctvLayer.cycleCamera(-1),
        (cameraId) => cctvLayer.focusCamera(cameraId, 1.4),
      );
    });

    this._cctvNextBtn?.addEventListener('click', async () => {
      if (!(await this._toggleCctvEnabled(true))) return;
      this._runExplicitCctvFocus(
        () => cctvLayer.cycleCamera(1),
        (cameraId) => cctvLayer.focusCamera(cameraId, 1.4),
      );
    });

    this._cctvSelect?.addEventListener('change', async () => {
      const cameraId = this._cctvSelect.value;
      if (!cameraId) return;
      if (!(await this._toggleCctvEnabled(true))) return;
      // Picking a camera from the dropdown flies to it. The catalog spans
      // three metros, so a bare selection used to leave the view in the old
      // city with a camera active thousands of km away.
      this._runExplicitCctvFocus(
        () => (cctvLayer.selectCamera(cameraId) ? cameraId : null),
        (selectedId) => cctvLayer.focusCamera(selectedId, 2.2),
      );
      this._dataManager?.setLayerParams(
        'cctv',
        { selectedCameraId: cameraId },
        { origin: 'user' },
      );
    });

    this._cctvFocusBtn?.addEventListener('click', async () => {
      const selected =
        this._cctvState?.activeCameraId || this._cctvSelect?.value;
      if (!selected) return;
      if (!(await this._toggleCctvEnabled(true))) return;
      this._runExplicitCctvFocus(
        () => selected,
        (cameraId) => cctvLayer.focusCamera(cameraId, 1.9),
      );
      this._dataManager?.setLayerParams(
        'cctv',
        { selectedCameraId: selected },
        { origin: 'user' },
      );
    });

    this._cctvCoverageBtn?.addEventListener('click', () => {
      const current =
        this._cctvState?.coverageMode ||
        (this._cctvState?.showCoverage ? 'on' : 'off');
      const next =
        current === 'off' ? 'on' : current === 'on' ? 'viewshed' : 'off';
      this._dataManager?.setLayerParams(
        'cctv',
        { coverageMode: next },
        { origin: 'user' },
      );
    });

    this._cctvAutoHopBtn?.addEventListener('click', () => {
      const current = !!this._cctvState?.autoHop;
      this._dataManager?.setLayerParams(
        'cctv',
        { autoHop: !current },
        { origin: 'user' },
      );
    });

    this._cctvProjectionBtn?.addEventListener('click', () => {
      const current = this._cctvState?.showProjection !== false;
      this._dataManager?.setLayerParams(
        'cctv',
        { showProjection: !current },
        { origin: 'user' },
      );
    });

    this._cctvAdjustBtn?.addEventListener('click', () => {
      const current = !!this._cctvState?.calibrationMode;
      this._dataManager?.setLayerParams(
        'cctv',
        { calibrationMode: !current },
        { origin: 'user' },
      );
    });

    // Click-to-edit pose readout: each chip swaps to a number input; Enter or
    // blur commits (converted to a calibration offset against basePose),
    // Escape cancels. Delegated so re-renders never re-bind.
    this._cctvCalReadout?.addEventListener('click', (event) => {
      const chip = event.target.closest?.('.cctv-cal-value');
      if (!chip || chip.disabled || chip.querySelector('input')) return;
      this._beginCctvCalValueEdit(chip);
    });

    this._cctvCalibSaveBtn?.addEventListener('click', () => {
      const cameraId = this._activeCctvCameraId();
      if (!cameraId || !this._dataManager) return;
      this._dataManager.setLayerParams(
        'cctv',
        {
          selectedCameraId: cameraId,
          calibration: { cameraId, save: true },
        },
        { origin: 'user' },
      );
      this._showToast('CCTV calibration saved');
    });

    this._cctvCalibResetBtn?.addEventListener('click', () => {
      this._resetCctvCalibration();
    });

    this._renderCctvState(null);
    this._syncCctvPanelViewport();
  }

  /**
   * Returns the currently active CCTV camera ID from state or the select dropdown.
   * @returns {string} Camera ID, or empty string if none.
   */
  _activeCctvCameraId() {
    return this._cctvState?.activeCameraId || this._cctvSelect?.value || '';
  }

  /**
   * Clears the preview and invalidates any in-flight preload.
   * @returns {void}
   */
  _clearCctvFrame() {
    this._cctvFrameRequestToken += 1;
    this._cctvFramePreloader = null;
    if (this._cctvFrame) {
      this._cctvFrame.classList.remove('active');
      this._cctvFrame.removeAttribute('src');
      this._cctvFrame.dataset.cameraId = '';
      this._cctvFrame.dataset.currentSrc = '';
      this._cctvFrame.dataset.loading = '';
      this._cctvFrame.dataset.error = '';
    }
    this._cctvFrameWrap?.classList.remove('loading', 'has-frame');
  }

  /**
   * Fetches a replacement frame OFF-DOM and assigns it to the live element
   * only once it has decoded.
   *
   * The live <img> is never pointed at an unresolved URL. A completed
   * preload is already in the HTTP cache, so assigning `src` swaps in a
   * single paint — the browser's own atomic behavior. A slow or failed
   * fetch never reaches the element at all, so settled pixels survive.
   *
   * (A two-slot crossfade was tried and reverted: with no z-index the slots
   * paint in DOM order, so promotion was asymmetric and yanked the visible
   * layer once per refresh — a flicker on every feed cycle. Measured against
   * main, which never blanked on a successful refresh in the first place.)
   *
   * @param {string} src
   * @param {string} cameraId
   * @param {boolean} cameraChanged
   * @returns {void}
   */
  _queueCctvFrame(src, cameraId, cameraChanged) {
    if (!this._cctvFrame || !src) return;

    if (cameraChanged) {
      // A different camera gets an honest acquisition state. Never retain
      // the prior camera's pixels under the newly selected metadata.
      this._cctvFrame.classList.remove('active');
      this._cctvFrame.removeAttribute('src');
      this._cctvFrameWrap?.classList.remove('has-frame');
    }

    const token = ++this._cctvFrameRequestToken;
    this._cctvFrame.dataset.cameraId = cameraId;
    this._cctvFrame.dataset.currentSrc = src;
    this._cctvFrame.dataset.loading = 'true';
    this._cctvFrame.dataset.error = '';
    this._cctvFrameWrap?.classList.toggle(
      'loading',
      !this._cctvFrameWrap?.classList.contains('has-frame'),
    );

    const preloader = new Image();
    this._cctvFramePreloader = preloader;
    preloader.onload = () => this._settleCctvFrame(token, src, true);
    preloader.onerror = () => this._settleCctvFrame(token, src, false);
    preloader.src = src;
  }

  /**
   * Commits a decoded frame to the live element, or records the failure
   * without disturbing whatever is already on screen.
   * @param {number} token - Request token; a stale one is ignored.
   * @param {string} src
   * @param {boolean} ok
   * @returns {void}
   */
  _settleCctvFrame(token, src, ok) {
    if (!this._cctvFrame || token !== this._cctvFrameRequestToken) return;
    this._cctvFramePreloader = null;
    this._cctvFrame.dataset.loading = '';
    this._cctvFrameWrap?.classList.remove('loading');

    const syncBadge = () =>
      this._syncCctvSourceBadge(
        this._cctvState?.activeCamera,
        !!this._cctvState?.enabled && !!this._dataManager?.isEnabled('cctv'),
      );

    if (!ok) {
      // Leave the element untouched — a settled frame stays on screen.
      this._cctvFrame.dataset.error = 'true';
      syncBadge();
      return;
    }

    this._cctvFrame.dataset.error = '';
    this._cctvFrame.src = src;
    this._cctvFrame.classList.add('active');
    this._cctvFrameWrap?.classList.add('has-frame');
    syncBadge();
  }

  /**
   * Keeps the source badge truthful about the visible frame lifecycle. Health
   * may already be OK while the browser is still decoding the requested image.
   * @param {object|null} activeCamera
   * @param {boolean} enabled
   * @returns {void}
   */
  _syncCctvSourceBadge(activeCamera, enabled) {
    if (!this._cctvSourceBadge) return;
    if (!enabled || !activeCamera) {
      this._cctvSourceBadge.textContent = 'SOURCE · UNKNOWN';
      this._cctvSourceBadge.dataset.frameState = 'idle';
      return;
    }
    const hasDisplayedFrame =
      this._cctvFrameWrap?.classList.contains('has-frame');
    if (this._cctvFrame?.dataset.loading === 'true' && !hasDisplayedFrame) {
      this._cctvSourceBadge.textContent = 'FRAME · LOADING';
      this._cctvSourceBadge.dataset.frameState = 'loading';
      return;
    }
    if (this._cctvFrame?.dataset.error === 'true' && !hasDisplayedFrame) {
      this._cctvSourceBadge.textContent = 'FRAME · UNAVAILABLE';
      this._cctvSourceBadge.dataset.frameState = 'error';
      return;
    }
    const kind = String(
      activeCamera.sourceKind || activeCamera.feedType || 'unknown',
    ).toUpperCase();
    const status = String(activeCamera.sourceStatus || 'unknown').toUpperCase();
    this._cctvSourceBadge.textContent = `${kind} · ${status}`;
    this._cctvSourceBadge.dataset.frameState = 'ready';
  }

  /**
   * Resets calibration for the active CCTV camera to its server defaults.
   * @returns {void}
   */
  _resetCctvCalibration() {
    const cameraId = this._activeCctvCameraId();
    if (!cameraId || !this._dataManager) return;
    this._dataManager.setLayerParams(
      'cctv',
      {
        selectedCameraId: cameraId,
        calibration: {
          cameraId,
          reset: true,
        },
      },
      { origin: 'user' },
    );
    this._showToast('CCTV calibration reset');
  }

  /**
   * Swaps a readout chip's text for an inline number input. Enter/blur commits
   * (converted to a calibration offset patch), Escape cancels. The next state
   * re-render restores the chip text either way.
   * @param {HTMLButtonElement} chip - The clicked `.cctv-cal-value` element.
   * @returns {void}
   */
  _beginCctvCalValueEdit(chip) {
    const field = CCTV_CAL_FIELDS[chip.dataset.calField];
    const activeCamera = this._cctvState?.activeCamera;
    if (!field || !activeCamera?.basePose) return;
    const startValue = field.get(activeCamera);
    const input = document.createElement('input');
    input.type = 'number';
    input.step = field.decimals > 0 ? '0.1' : '1';
    input.value = Number(startValue).toFixed(field.decimals);
    input.className = 'cctv-cal-input';
    chip.textContent = `${field.label} `;
    chip.appendChild(input);
    input.focus();
    input.select();

    let finished = false;
    const finish = (commit) => {
      if (finished) return;
      finished = true;
      const typed = parseFloat(input.value);
      input.remove();
      if (commit && Number.isFinite(typed)) {
        const cameraId = this._activeCctvCameraId();
        if (cameraId && this._dataManager) {
          this._dataManager.setLayerParams(
            'cctv',
            {
              selectedCameraId: cameraId,
              calibration: {
                cameraId,
                patch: field.toPatch(typed, activeCamera.basePose),
              },
            },
            { origin: 'user' },
          );
          return; // re-render restores the chip text from fresh state
        }
      }
      this._syncCctvCalReadout(
        !!this._cctvState?.enabled,
        this._cctvState?.activeCamera || null,
      );
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') finish(true);
      else if (event.key === 'Escape') finish(false);
      event.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (event) => event.stopPropagation());
  }

  /**
   * Synchronizes the pose readout chips, ADJUST button, and SAVE/RESET
   * disabled states with the active camera.
   * @param {boolean} enabled - Whether the CCTV layer is currently enabled.
   * @param {object|null} activeCamera - The active camera data object (may be null).
   * @returns {void}
   */
  _syncCctvCalReadout(enabled, activeCamera) {
    const canCalibrate = !!enabled && !!activeCamera;
    if (this._cctvAdjustBtn) {
      const adjustOn = !!this._cctvState?.calibrationMode;
      this._cctvAdjustBtn.classList.toggle('active', adjustOn && canCalibrate);
      this._cctvAdjustBtn.textContent = adjustOn ? 'ADJUST ON' : 'ADJUST';
      this._cctvAdjustBtn.disabled = !canCalibrate;
    }
    if (this._cctvCalReadout) {
      for (const chip of this._cctvCalReadout.querySelectorAll(
        '.cctv-cal-value',
      )) {
        if (chip.querySelector('input')) continue; // an edit is in flight — don't clobber
        const field = CCTV_CAL_FIELDS[chip.dataset.calField];
        if (!field) continue;
        const value = canCalibrate ? field.get(activeCamera) : null;
        chip.textContent = Number.isFinite(value)
          ? `${field.label} ${Number(value).toFixed(field.decimals)}${field.unit}`
          : `${field.label} --`;
        chip.disabled = !canCalibrate;
      }
    }
    for (const el of [this._cctvCalibSaveBtn, this._cctvCalibResetBtn]) {
      if (el) el.disabled = !canCalibrate;
    }
  }

  /**
   * Toggles the CCTV layer enabled state. When enabling and no camera is active,
   * auto-focuses on the nearest camera.
   * @param {boolean} [forceState] - Explicit on/off. Omit to toggle.
   * @returns {Promise<boolean>} True if the layer is now in the requested state.
   */
  async _toggleCctvEnabled(forceState) {
    if (!this._dataManager?.layers?.has('cctv')) {
      this._showToast('CCTV layer unavailable');
      return false;
    }
    const enabled = this._dataManager.isEnabled('cctv');
    const target = typeof forceState === 'boolean' ? forceState : !enabled;
    if (target === enabled) return true;
    await runCctvLayerEnableTransition({
      target,
      setEnabled: (next) =>
        this._dataManager.setEnabled('cctv', next, { origin: 'user' }),
      readOwnership: () => ({
        trackedEntity: this.viewer?.trackedEntity,
        cockpitActive: !!this.cockpitView?.active,
      }),
      shouldFocus: () => !this._cctvState?.activeCameraId,
      activate: () => cctvLayer.focusNearest({ focus: false }),
      fly: (cameraId) =>
        this._runExplicitCctvFocus(
          () => cameraId,
          (selectedId) => cctvLayer.focusCamera(selectedId, 1.6),
        ),
    });
    return true;
  }

  /**
   * Maps a `deriveCalBadge` value (cctv.js) to its panel copy. Single source
   * of truth for CAL-badge casing — used by both the quality chip and the
   * meta line so the two never drift onto different label conventions.
   * @param {'calibrated'|'curated'|'raw-prior'|null} badge - Badge state from cctv.js.
   * @returns {string} Display label, or '--' when there is no active camera.
   */
  _calBadgeLabel(badge) {
    switch (badge) {
      case 'calibrated':
        return 'CALIBRATED';
      case 'curated':
        return 'CURATED';
      case 'raw-prior':
        return 'RAW PRIOR';
      default:
        return '--';
    }
  }

  /**
   * Full re-render of the CCTV panel UI from a CCTV layer state snapshot.
   * Updates enable button, camera select dropdown, navigation buttons,
   * coverage/auto-hop/projection toggles, quality chip, source badge,
   * metadata line, frame image, calibration controls, and summary text.
   * @param {object|null} state - CCTV layer UI state, or null to render empty.
   * @returns {void}
   */
  _renderCctvState(state) {
    this._cctvState = state || null;
    const cameras = state?.cameras || [];
    const enabled = !!state?.enabled && !!this._dataManager?.isEnabled('cctv');
    const activeId = state?.activeCameraId || '';
    const activeCamera = state?.activeCamera || null;

    // Auto-expand the panel when the active camera CHANGES to a new non-null
    // id while the layer is enabled. Covers click-on-globe, panel controls,
    // and voice (selectCamera/cycleCamera/focusNearest all notify through
    // this subscription). The last-seen guard keeps routine notifications
    // from re-expanding a panel the user deliberately collapsed, and timed
    // auto-hop transitions only expand on the first activation so the panel
    // does not pop open on every hop.
    const effectiveActiveId = enabled ? activeId || null : null;
    const isFirstActivation = this._lastSeenCctvActiveId === null;
    if (
      effectiveActiveId &&
      effectiveActiveId !== this._lastSeenCctvActiveId &&
      (!state?.autoHop || isFirstActivation)
    ) {
      this.setPanelCollapsed('cctv-panel', false, {
        explicit: Boolean(state?.explicitSelection),
      });
    }
    this._lastSeenCctvActiveId = effectiveActiveId;

    this._updateCctvSyncChip(state?.loading, enabled);

    if (this._cctvEnableBtn) {
      this._cctvEnableBtn.classList.toggle('active', enabled);
      this._cctvEnableBtn.textContent = enabled ? 'CCTV ON' : 'CCTV OFF';
    }

    if (this._cctvSelect) {
      const shouldRebuild =
        this._cctvSelect.options.length !== cameras.length ||
        cameras.some(
          (cam, idx) => this._cctvSelect.options[idx]?.value !== cam.id,
        );
      if (shouldRebuild) {
        this._cctvSelect.innerHTML = '';
        for (const camera of cameras) {
          const option = document.createElement('option');
          option.value = camera.id;
          option.textContent = `${camera.city} · ${camera.name}`;
          this._cctvSelect.appendChild(option);
        }
      }
      this._cctvSelect.disabled = !enabled || cameras.length === 0;
      if (
        activeId &&
        Array.from(this._cctvSelect.options).some(
          (opt) => opt.value === activeId,
        )
      ) {
        this._cctvSelect.value = activeId;
      } else if (!activeId) {
        this._cctvSelect.selectedIndex = -1;
      }
    }

    for (const btn of [
      this._cctvNearestBtn,
      this._cctvPrevBtn,
      this._cctvNextBtn,
    ]) {
      if (!btn) continue;
      btn.disabled = !enabled || cameras.length === 0;
    }
    if (this._cctvFocusBtn) {
      this._cctvFocusBtn.disabled =
        !enabled || cameras.length === 0 || !activeId;
    }

    if (this._cctvCoverageBtn) {
      // Tri-state (viewshed design §3b): off → on (wireframes) → viewshed
      // (color-coded volumes). The click handler cycles; this renders.
      const mode = state?.coverageMode || (state?.showCoverage ? 'on' : 'off');
      this._cctvCoverageBtn.classList.toggle('active', mode !== 'off');
      this._cctvCoverageBtn.textContent =
        mode === 'viewshed'
          ? 'VIEWSHED ON'
          : mode === 'on'
            ? 'COVERAGE ON'
            : 'COVERAGE OFF';
      this._cctvCoverageBtn.disabled = !enabled;
    }

    if (this._cctvAutoHopBtn) {
      const autoHop = !!state?.autoHop;
      this._cctvAutoHopBtn.classList.toggle('active', autoHop);
      this._cctvAutoHopBtn.textContent = autoHop
        ? 'AUTO HOP ON'
        : 'AUTO HOP OFF';
      this._cctvAutoHopBtn.disabled = !enabled;
    }

    if (this._cctvProjectionBtn) {
      const showProjection = state?.showProjection !== false;
      this._cctvProjectionBtn.classList.toggle('active', showProjection);
      this._cctvProjectionBtn.textContent = showProjection
        ? 'PROJECTION ON'
        : 'PROJECTION OFF';
      this._cctvProjectionBtn.disabled = !enabled;
    }

    if (this._cctvQualityChip) {
      // CAL badge (cctv-v2 design §3b, amended by LOCKED §9.2 — panel-only,
      // no in-world tint): three states driven by cctv.js's deriveCalBadge,
      // no client-side scoring math. Casing is unified via _calBadgeLabel so
      // the chip and the meta line never drift onto different conventions.
      // Save-gated persistence (viewshed design §3e): unsaved live edits show
      // EDITED on top of whatever the persisted badge state is — SAVE CAL
      // promotes to CALIBRATED, RESET CAL clears.
      const badge = activeCamera?.calBadge || null;
      const dirty = !!activeCamera?.calDirty;
      this._cctvQualityChip.textContent = dirty
        ? 'CAL · EDITED (UNSAVED)'
        : `CAL · ${this._calBadgeLabel(badge)}`;
      this._cctvQualityChip.dataset.calBadge = dirty ? 'edited' : badge || '';
    }

    this._syncCctvCalReadout(enabled, activeCamera);

    if (this._cctvMeta) {
      if (activeCamera) {
        const provider =
          activeCamera.sourceLabel ||
          activeCamera.provider ||
          'Configured Source';
        const statusMsg = activeCamera.sourceMessage
          ? ` · ${activeCamera.sourceMessage}`
          : '';
        const calBadge = activeCamera.calBadge
          ? this._calBadgeLabel(activeCamera.calBadge)
          : '';
        const projLabel = state?.showProjection !== false ? 'MONITOR' : 'OFF';
        this._cctvMeta.textContent = `${activeCamera.city} · HDG ${Math.round(activeCamera.headingDeg)}° · FOV ${Math.round(activeCamera.fovDeg)}° · RANGE ${Math.round(activeCamera.rangeM)}m · ${projLabel}${calBadge ? ` · ${calBadge}` : ''} · ${provider}${statusMsg}`;
      } else if (cameras.length > 0) {
        this._cctvMeta.textContent = enabled
          ? `${cameras.length} cameras loaded · click a camera to activate`
          : `${cameras.length} cameras loaded · enable CCTV to activate`;
      } else {
        this._cctvMeta.textContent = 'Enable CCTV to load camera intersections';
      }
    }

    if (this._cctvFrame) {
      const nextSrc = enabled ? activeCamera?.frameUrl : null;
      const nextCameraId = enabled ? activeCamera?.id || '' : '';
      const cameraChanged = this._cctvFrame.dataset.cameraId !== nextCameraId;
      const frameLoading = this._cctvFrame.dataset.loading === 'true';
      // A same-camera refresh waits for the current image to settle. Replacing
      // src every 10 seconds can cancel a slow but healthy decode forever and
      // leave SNAPSHOT · OK beside a blank/loading preview. Camera changes are
      // immediate so navigation never waits on the prior camera's request.
      if (
        nextSrc &&
        (cameraChanged ||
          (!frameLoading && this._cctvFrame.dataset.currentSrc !== nextSrc))
      ) {
        this._queueCctvFrame(nextSrc, nextCameraId, cameraChanged);
      }
      if (!nextSrc) {
        this._clearCctvFrame();
      }
    }

    this._syncCctvSourceBadge(activeCamera, enabled);
    this._typeCctvSummary(
      state?.summary ||
        'Enable CCTV to start camera-linked intelligence summaries.',
    );
  }

  /**
   * Typewriter-animates CCTV summary text into the summary element.
   * Skips animation if the text hasn't changed since the last call.
   * Advances 3 characters per 20ms tick for a fast teletype effect.
   * @param {string} text - Summary text to display.
   * @returns {void}
   */
  _typeCctvSummary(text) {
    if (!this._cctvSummary) return;
    const nextText = String(text || '').trim() || 'No summary available.';
    if (nextText === this._lastCctvSummaryText) return;
    this._lastCctvSummaryText = nextText;

    clearInterval(this._cctvSummaryTypingTimer);
    this._cctvSummary.textContent = '';
    let idx = 0;
    this._cctvSummaryTypingTimer = setInterval(() => {
      idx += 3;
      if (idx >= nextText.length) {
        this._cctvSummary.textContent = nextText;
        clearInterval(this._cctvSummaryTypingTimer);
        this._cctvSummaryTypingTimer = null;
        return;
      }
      this._cctvSummary.textContent = nextText.slice(0, idx);
    }, 20);
  }

  /**
   * Recalculates the CCTV panel max-height based on its current top position
   * and the window height, enabling internal scroll without viewport overflow.
   * @returns {void}
   */
  _syncCctvPanelViewport() {
    if (!this._cctvPanel) return;
    const inner = this._cctvPanel.querySelector('.cctv-panel-inner');
    requestAnimationFrame(() => {
      if (this._cctvPanel.parentElement?.id === 'right-context-rail') {
        this._cctvPanel.style.maxHeight = '';
        if (inner) inner.style.maxHeight = '';
        this._scheduleRightPanelLayout();
        return;
      }
      const rect = this._cctvPanel.getBoundingClientRect();
      const availableHeight = Math.max(
        190,
        Math.floor(window.innerHeight - rect.top - 12),
      );
      this._cctvPanel.style.maxHeight = `${availableHeight}px`;
      if (inner) {
        inner.style.maxHeight = `${availableHeight}px`;
      }
    });
  }
}
