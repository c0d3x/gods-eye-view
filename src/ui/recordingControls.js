// src/ui/recordingControls.js — recording mode, which hides the UI chrome
// behind a 16:9 or 9:16 safe-frame overlay, and the recording-friendly
// post-processing applyCinematicPreset() applies.
//
// These are StyleManager methods, kept here and adopted by StyleManager (see
// src/ui/adoptMethods.js); they run on its state.
import { BLOOM_SCALE_VERSION, decodeBloomIntensity } from '../bloom.js';
import { canonicalizeDensity } from '../data/detectionPolicy.js';

export class RecordingControls {
  /**
   * Resets the safe-frame overlay to its inactive state on init.
   * @returns {void}
   */
  _initRecordingOverlay() {
    if (!this._safeFrameOverlay || !this._safeFrameBox) return;
    this._safeFrameOverlay.classList.remove(
      'active',
      'ratio-9-16',
      'ratio-16-9',
    );
  }

  /**
   * Applies recording-friendly post-processing and shader uniform overrides.
   * @param {object} preset
   */
  applyCinematicPreset(preset = {}) {
    const bloomInput =
      typeof preset.bloom === 'object'
        ? preset.bloom
        : { intensity: preset.bloom };
    let decodedBloomIntensity = null;
    if (typeof bloomInput.intensity === 'number') {
      decodedBloomIntensity = decodeBloomIntensity(
        bloomInput.intensity,
        bloomInput.version ?? preset.bloomVersion ?? BLOOM_SCALE_VERSION,
      );
      this._setBloomIntensity(decodedBloomIntensity, { syncShare: false });
    }
    if (typeof bloomInput.enabled === 'boolean') {
      this._setBloomEnabled(bloomInput.enabled);
    } else if (typeof bloomInput.intensity === 'number') {
      this._setBloomEnabled(
        (decodedBloomIntensity ?? this._getBloomIntensity()) > 0,
      );
    }

    const sharpenInput =
      typeof preset.sharpen === 'object'
        ? preset.sharpen
        : { enabled: preset.sharpen };
    if (typeof sharpenInput.intensity === 'number' && this._sharpenSlider) {
      const sharpenPct = Math.max(
        0,
        Math.min(100, Math.round(sharpenInput.intensity)),
      );
      this._sharpenSlider.value = String(sharpenPct);
      this._sharpenSliderValue.textContent = `${sharpenPct}%`;
      this._applySharpenIntensity(sharpenPct / 100);
    }
    if (typeof sharpenInput.enabled === 'boolean') {
      this._setSharpenEnabled(sharpenInput.enabled);
    } else if (typeof sharpenInput.intensity === 'number') {
      this._setSharpenEnabled(sharpenInput.intensity > 0);
    }

    if (preset.hudVariant) {
      this._setHudVariant(preset.hudVariant);
    }

    if (preset.detectionMode) {
      this._setDetectionMode(preset.detectionMode);
    }
    if (
      typeof preset.detectionDensity === 'number' &&
      this._detectionDensitySlider
    ) {
      const density = canonicalizeDensity(preset.detectionDensity);
      this._detectionDensitySlider.value = String(density);
      this._detectionDensityValue.textContent = `${density}%`;
      this._applyDetectionDensityFromUi();
    }
    if (preset.detectionAllocation) {
      this._setDetectionAllocation(preset.detectionAllocation, {
        syncShare: false,
      });
    }

    if (preset.styleParams && typeof preset.styleParams === 'object') {
      for (const [styleName, params] of Object.entries(preset.styleParams)) {
        const stage = this.stages[styleName];
        if (!stage || !params || typeof params !== 'object') continue;
        for (const [uniformName, uniformValue] of Object.entries(params)) {
          if (stage.uniforms[uniformName] === undefined) continue;
          stage.uniforms[uniformName] = uniformValue;
        }
      }

      // Keep slider panel values in sync when updating the active style.
      this._updateSliderPanel(this.activeStyle);
    }

    this._syncShareState();
  }

  /**
   * Enters or exits recording mode. When active, hides UI chrome via a body class,
   * displays a safe-frame composition overlay (16:9 or 9:16), and switches
   * the HUD to the specified mode. Exiting restores the HUD mode and layout
   * variant that were active before recording started.
   * @param {boolean} enabled - Whether to enable recording mode.
   * @param {object} [options]
   * @param {boolean} [options.hidePanels=true] - Hide all panel chrome.
   * @param {string} [options.hudMode='minimal'] - HUD mode while recording ('off'|'minimal'|'full'|'auto').
   * @param {string} [options.safeFrame='16:9'] - Aspect ratio for the safe-frame overlay.
   * @returns {void}
   */
  setRecordingMode(enabled, options = {}) {
    const {
      hidePanels = true,
      hudMode = 'minimal',
      safeFrame = '16:9',
    } = options;
    this._recordingMode = !!enabled;
    this._recordingConfig = { hidePanels, hudMode, safeFrame };

    document.body.classList.toggle(
      'recording-mode',
      this._recordingMode && hidePanels,
    );

    if (this._safeFrameOverlay) {
      this._safeFrameOverlay.classList.remove('ratio-9-16', 'ratio-16-9');
      this._safeFrameOverlay.classList.toggle('active', this._recordingMode);
      this._safeFrameOverlay.classList.add(
        safeFrame === '9:16' ? 'ratio-9-16' : 'ratio-16-9',
      );
    }

    if (this._recordingMode) {
      // Snapshot the user's HUD state once per recording session so exit can
      // restore it (re-entrant calls must not capture mid-recording state).
      if (!this._preRecordingHudState) {
        this._preRecordingHudState = {
          mode: this.hud.getMode(),
          variant: this.hud.getVariant(),
        };
      }
      if (hudMode === 'off') {
        this.hud.setMode('off');
      } else if (hudMode === 'full' || hudMode === 'minimal') {
        this.hud.setMode('on');
        this.hud.setVariant(hudMode === 'minimal' ? 'minimal' : 'tactical');
        if (this._hudLayoutSelect)
          this._hudLayoutSelect.value = this.hud.getVariant();
      } else {
        this.hud.setMode('auto');
      }
    } else {
      const saved = this._preRecordingHudState;
      this._preRecordingHudState = null;
      if (saved) {
        this.hud.setVariant(saved.variant);
        if (this._hudLayoutSelect)
          this._hudLayoutSelect.value = this.hud.getVariant();
      }
      this.hud.setMode(saved ? saved.mode : 'auto');
      if (this._safeFrameOverlay) {
        this._safeFrameOverlay.classList.remove(
          'active',
          'ratio-9-16',
          'ratio-16-9',
        );
      }
    }
    this._hudBtn.classList.toggle('active', this.hud.visible);
    this._syncShareState();
  }
}
