// src/ui/sceneState.js — snapshots of what the page shows, for voice
// read-back, scene recipes and share links: the full control state, the
// camera's position and orientation, and the visual state (style,
// post-processing, HUD, detection and each style's shader settings), with
// the methods that restore them. Also setOrbit(), which scenes call.
//
// These are StyleManager methods, kept here and adopted by StyleManager (see
// src/ui/adoptMethods.js); they run on its state.
import * as Cesium from 'cesium';
import { BLOOM_SCALE_VERSION, decodeBloomIntensity } from '../bloom.js';
import {
  getMode as getDetectionMode,
  getDetectionTuning,
} from '../data/detection.js';
import { canonicalizeDensity } from '../data/detectionPolicy.js';
import {
  getScopeMaskFeather,
  isScopeMaskEnabled,
  setScopeMaskEnabled,
  setScopeMaskFeather,
} from '../scopeMask.js';
import { STYLES } from './styleConfig.js';

export class SceneState {
  /**
   * Starts or stops orbiting the active POI.
   * @param {boolean} [enabled] - Omit to toggle.
   * @returns {{ok: boolean, orbiting: boolean, error?: string}}
   */
  setOrbit(enabled) {
    const active = !!this.orbitController?.active;
    if (typeof enabled === 'boolean' && enabled === active) {
      return { ok: true, orbiting: active };
    }
    if (enabled === false) {
      this._stopOrbit();
      return { ok: true, orbiting: false };
    }
    if (!this._currentTarget) {
      return {
        ok: false,
        orbiting: false,
        error: 'No active landmark to orbit — fly to a landmark first',
      };
    }
    this._toggleOrbit();
    return { ok: true, orbiting: !!this.orbitController?.active };
  }

  /**
   * Full control-state snapshot — single source for voice read-back so the
   * agent confirms from the same state it acted on.
   * @returns {object} Current style/stack/HUD/detection/post-processing state.
   */
  getControlState() {
    return {
      style: this.activeStyle || 'normal',
      mapStack: this.mapStackController?.getActiveId?.() || null,
      hud: {
        visible: !!this.hud?.visible,
        layout: this.hud?.getVariant?.() || null,
      },
      detection: this.getDetectionState(),
      bloom: {
        enabled: !!this.bloomEnabled,
        intensityPct: this._bloomSlider
          ? parseInt(this._bloomSlider.value, 10)
          : null,
      },
      sharpen: {
        enabled: !!this.sharpenEnabled,
        intensityPct: this._sharpenSlider
          ? parseInt(this._sharpenSlider.value, 10)
          : null,
      },
      celestialRing: {
        enabled: this.celestialRingEnabled,
        visible: !!this.celestialRing?.visible,
      },
      orbiting: !!this.orbitController?.active,
      recording: !!this._recordingMode,
      cleanView: document.body.classList.contains('ui-clean-view'),
    };
  }

  /**
   * Captures the current camera position and orientation as a serializable object.
   * @returns {{lat: number, lon: number, alt: number, heading: number, pitch: number, roll: number}|null}
   */
  getCameraState() {
    const carto = this.viewer.camera.positionCartographic;
    if (!carto) return null;
    return {
      lat: Cesium.Math.toDegrees(carto.latitude),
      lon: Cesium.Math.toDegrees(carto.longitude),
      alt: carto.height,
      heading: Cesium.Math.toDegrees(this.viewer.camera.heading),
      pitch: Cesium.Math.toDegrees(this.viewer.camera.pitch),
      roll: Cesium.Math.toDegrees(this.viewer.camera.roll),
    };
  }

  /**
   * Flies the camera to a previously captured camera state using cubic ease-in-out.
   * @param {{lat: number, lon: number, alt: number, heading?: number, pitch?: number, roll?: number}} cameraState
   * @param {number} [duration=2.8] - Flight duration in seconds.
   * @returns {void}
   */
  applyCameraState(cameraState, duration = 2.8) {
    if (!cameraState) return;
    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        cameraState.lon,
        cameraState.lat,
        cameraState.alt,
      ),
      orientation: {
        heading: Cesium.Math.toRadians(cameraState.heading || 0),
        pitch: Cesium.Math.toRadians(cameraState.pitch || -35),
        roll: Cesium.Math.toRadians(cameraState.roll || 0),
      },
      duration: Math.max(0.2, duration || 0),
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    });
  }

  /**
   * Snapshots the full visual state (active style, bloom, sharpen, HUD, detection,
   * per-style shader uniform values) for serialization or scene recipe capture.
   * @returns {object} Serializable visual state object.
   */
  getVisualState() {
    const styleParams = {};
    for (const [styleName, stage] of Object.entries(this.stages)) {
      const shader = STYLES[styleName];
      if (!shader?.uniforms) continue;
      styleParams[styleName] = {};
      for (const uniformName of Object.keys(shader.uniforms)) {
        styleParams[styleName][uniformName] = stage.uniforms[uniformName];
      }
    }

    return {
      style: this.activeStyle,
      bloom: {
        enabled: this.bloomEnabled,
        intensity: this._getBloomIntensity(),
        version: BLOOM_SCALE_VERSION,
      },
      sharpen: {
        enabled: this.sharpenEnabled,
        intensity: parseInt(this._sharpenSlider?.value || '49', 10),
      },
      hud: {
        visible: this.hud.visible,
        variant: this.hud.getVariant(),
      },
      detection: {
        mode: getDetectionMode(),
        density: parseInt(this._detectionDensitySlider?.value || '50', 10),
        allocation: getDetectionTuning().allocationStrategy,
        fadePct: parseInt(this._detectionFadeSlider?.value || '7', 10),
        outsideOpacityPct: parseInt(
          this._detectionOpacitySlider?.value || '0',
          10,
        ),
      },
      scope: {
        enabled: isScopeMaskEnabled(),
        featherPct: Math.round(getScopeMaskFeather() * 100),
      },
      mapStack: this.mapStackController?.getActiveId?.() || 'photoreal',
      styleParams,
    };
  }

  /**
   * Restores a full visual state snapshot, applying style, bloom, sharpen,
   * HUD, detection, and per-style shader uniforms. Used by scene recipes
   * and share-link restore. Async so the map-stack switch resolves before
   * the share state is synced; callers may fire-and-forget.
   * @param {object} [state={}] - Visual state object (as returned by getVisualState).
   * @param {object} [options]
   * @param {(() => boolean)|null} [options.isCurrent] Caller liveness predicate.
   *   The map-stack switch is this method's ONLY suspension point, and the
   *   shader-uniform writes come after it — so a caller superseded while that
   *   switch is in flight would otherwise resume and commit the look of a
   *   state the operator has already moved past. Scene playback reproduced
   *   exactly that: a stale shot's uniforms landing on top of the live run.
   *   Omit it and the method behaves as it always has.
   * @returns {Promise<boolean>} Whether the state was committed.
   */
  async applyVisualState(state = {}, { isCurrent = null } = {}) {
    const superseded = () => typeof isCurrent === 'function' && !isCurrent();
    if (superseded()) return false;

    if (state.style && state.style !== this.activeStyle) {
      this.setStyle(state.style, { applyPreset: false });
    }

    const bloomState = state.bloom || {};
    if (typeof bloomState.intensity === 'number' && this._bloomSlider) {
      const intensity = decodeBloomIntensity(
        bloomState.intensity,
        bloomState.version ?? state.bloomVersion ?? BLOOM_SCALE_VERSION,
      );
      this._setBloomIntensity(intensity, { syncShare: false });
    }
    if (typeof bloomState.enabled === 'boolean') {
      this._setBloomEnabled(bloomState.enabled);
    }

    const sharpenState = state.sharpen || {};
    if (typeof sharpenState.intensity === 'number' && this._sharpenSlider) {
      const pct = Math.max(
        0,
        Math.min(100, Math.round(sharpenState.intensity)),
      );
      this._sharpenSlider.value = String(pct);
      this._sharpenSliderValue.textContent = `${pct}%`;
      this._applySharpenIntensity(pct / 100);
    }
    if (typeof sharpenState.enabled === 'boolean') {
      this._setSharpenEnabled(sharpenState.enabled);
    }

    const hudState = state.hud || {};
    if (hudState.variant) {
      this._setHudVariant(hudState.variant);
    }
    if (typeof hudState.visible === 'boolean') {
      this.hud.setMode(hudState.visible ? 'on' : 'off');
      this._updateHudButtonState();
    }

    const scopeState = state.scope || {};
    if (typeof scopeState.enabled === 'boolean') {
      setScopeMaskEnabled(scopeState.enabled);
      this._scopeBtn?.classList.toggle('active', scopeState.enabled);
      this._scopeBtn?.setAttribute('aria-pressed', String(scopeState.enabled));
    }
    if (typeof scopeState.featherPct === 'number' && this._scopeFeatherSlider) {
      const pct = Math.max(0, Math.min(100, Math.round(scopeState.featherPct)));
      this._scopeFeatherSlider.value = String(pct);
      if (this._scopeFeatherValue)
        this._scopeFeatherValue.textContent = `${pct}%`;
      setScopeMaskFeather(pct / 100);
    }

    const detectionState = state.detection || {};
    if (
      typeof detectionState.density === 'number' &&
      this._detectionDensitySlider
    ) {
      const pct = canonicalizeDensity(detectionState.density);
      this._detectionDensitySlider.value = String(pct);
      if (this._detectionDensityValue)
        this._detectionDensityValue.textContent = `${pct}%`;
      this._applyDetectionDensityFromUi();
    }
    if (detectionState.allocation) {
      this._setDetectionAllocation(detectionState.allocation, {
        syncShare: false,
      });
    }
    if (
      typeof detectionState.fadePct === 'number' &&
      this._detectionFadeSlider
    ) {
      this._detectionFadeSlider.value = String(detectionState.fadePct);
    }
    if (
      typeof detectionState.outsideOpacityPct === 'number' &&
      this._detectionOpacitySlider
    ) {
      this._detectionOpacitySlider.value = String(
        detectionState.outsideOpacityPct,
      );
    }
    this._applyDetectionFadeFromUi();
    if (detectionState.mode) {
      this._setDetectionMode(detectionState.mode);
    }

    if (state.mapStack) {
      // The stack switch is itself a MUTATION, not merely a suspension point,
      // so it needs a gate on BOTH sides of the await.
      if (superseded()) return false;
      const stackBefore = this.mapStackController?.getActiveId?.() ?? null;
      const genBefore =
        this.mapStackController?.getSwitchGeneration?.() ?? null;

      await this._setMapStack(state.mapStack, { syncShare: false });

      if (superseded()) {
        // Superseded DURING the switch, which the pre-check above cannot catch
        // and which has already moved the globe. The controller only
        // invalidates a switch when another setStack() arrives, and a winning
        // state that omits `mapStack` never issues one — every normalized scene
        // shot omits it — so this stale globe would simply stand. Put back what
        // the winner inherited.
        const genAfter =
          this.mapStackController?.getSwitchGeneration?.() ?? null;
        // _setMapStack issues exactly one setStack(), which advances the
        // generation once, or not at all when the stack was unavailable and
        // nothing was mutated. Anything past that is a NEWER switch whose
        // caller owns the globe now, and reverting would stomp a live intent.
        const globeIsStillOurs =
          genBefore !== null && genAfter !== null && genAfter <= genBefore + 1;
        const landed = this.mapStackController?.getActiveId?.() ?? null;
        if (globeIsStillOurs && stackBefore && landed !== stackBefore) {
          await this._setMapStack(stackBefore, { syncShare: false });
        }
        return false;
      }
      // Everything below is the uniform commit, already past its own gate.
    }

    if (state.styleParams && typeof state.styleParams === 'object') {
      for (const [styleName, params] of Object.entries(state.styleParams)) {
        const stage = this.stages[styleName];
        if (!stage || !params) continue;
        for (const [uniformName, uniformValue] of Object.entries(params)) {
          if (stage.uniforms[uniformName] === undefined) continue;
          stage.uniforms[uniformName] = uniformValue;
        }
      }
      this._updateSliderPanel(this.activeStyle);
    }

    this._syncShareState();
    return true;
  }
}
