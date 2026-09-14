// src/ui/detectionControls.js — the detection overlay's controls: its mode,
// density, fade and allocation settings and the DETECT button, what the
// Contacts mode turns on while it owns detection, and getDetectionState(),
// getDetectionDiagnostics() and setDetection() for voice tools and scenes.
//
// These are StyleManager methods, kept here and adopted by StyleManager (see
// src/ui/adoptMethods.js); they run on its state.
import {
  getKeyholeFadeTuning,
  setKeyholeFadeTuning,
} from '../celestialRing.js';
import {
  getDetectionDiagnostics as readDetectionDiagnostics,
  getDetectionTuning,
  getMode as getDetectionMode,
  setMode as setDetectionModeByLabel,
  setDetectionTuning,
} from '../data/detection.js';
import {
  ALLOCATION_STRATEGIES,
  canonicalizeDensity,
  defaultDensityForProfile,
  normalizeAllocationStrategy,
  normalizeProfile,
  profileForDensity,
} from '../data/detectionPolicy.js';
import {
  applyContactsDetection,
  shareCacheNeedsHeal,
  shareableDetectionState,
} from '../contactsDetectionPolicy.js';
import {
  MILITARY_DETECTION_PRESET,
  STYLE_PRESET_DEFAULTS,
} from './styleConfig.js';

export const DETECTION_ALLOCATION_STORAGE_KEY = 'gev:detection-allocation:v1';

export class DetectionControls {
  /**
   * Contacts-scoped detection (owner playtest 2026-08-18: "when you click on
   * Contacts, detections should just turn on, and they should stay on in
   * Cockpit or in third-person tracking inside Contacts").
   *
   * The scope is the CONTACTS SESSION, not Cockpit. Cockpit enter/exit and
   * third-person tracking are moves WITHIN that session and deliberately do not
   * touch detection — an earlier build hooked this to cockpit enter/exit, which
   * is exactly what turned detections off when the owner left the cockpit.
   *
   * Called from `_syncContextModeButtons`, the single funnel every
   * `_contextMode` mutation routes through, and gated on the transaction having
   * SETTLED (`!_contextModeChanging`) so a failed activation can never strand
   * detection on.
   * @returns {void}
   */
  _syncContactsDetection() {
    if (this._contextModeChanging) return;
    const result = applyContactsDetection({
      active: this._contextMode === 'flights',
      restore: this._contactsDetectionRestore,
      // A map style picked DURING the session owns detection on the way out —
      // its auto-enable preset is younger than the entry snapshot.
      styleOwnsDetection:
        !this._detectionUserOverridden &&
        Boolean(STYLE_PRESET_DEFAULTS[this.activeStyle]?.detection),
      // The snapshot must cover everything activation mutates — the preset
      // writes DENSITY as well as mode, so a mode-only snapshot returned
      // OFF @ 25% as OFF @ 75% and the next manual enable came back Dense.
      getState: () => {
        const state = this.getDetectionState();
        return { mode: state.detectionMode, densityPct: state.densityPct };
      },
      // Owner playtest: the force-on lands on the tactical look the military
      // styles apply — the SAME preset object — not on whatever profile the
      // operator last happened to leave detection at.
      applyPreset: () => this._applyDetectionPreset(MILITARY_DETECTION_PRESET),
      // The preset applier IS the state replayer: same density-then-mode order,
      // same slider writes, so a restore round-trips exactly.
      restoreState: (state) => this._applyDetectionPreset(state),
    });
    const hadOwnership = Boolean(this._contactsDetectionRestore);
    this._contactsDetectionRestore = result.restore;
    // Serialization reads that ownership: while Contacts holds it the link
    // carries the SAVED snapshot, and once released it carries live state. The
    // share cache therefore goes stale on any ownership transition, whether or
    // not the detection engine itself moved — and it does not always move.
    // Exiting while a military style owns detection returns changed:false (the
    // style's preset already matches), and returning early there left a copied
    // link claiming the operator's pre-Contacts values while the map showed
    // Dense @ 75%.
    if (
      !shareCacheNeedsHeal({
        changed: result.changed,
        hadOwnership,
        hasOwnership: Boolean(result.restore),
      })
    )
      return;
    if (result.changed) this._syncDetectionUiFromEngine();
    this._syncShareState();
  }

  /**
   * Reads and canonicalizes the five-stop density control. The engine derives
   * Sparse/Balanced/Dense from the same stop.
   * @returns {void}
   */
  _applyDetectionDensityFromUi() {
    if (!this._detectionDensitySlider) return;
    const pct = canonicalizeDensity(this._detectionDensitySlider.value);
    this._detectionDensitySlider.value = String(pct);
    if (this._detectionDensityValue)
      this._detectionDensityValue.textContent = `${pct}%`;
    setDetectionTuning({ densityPct: pct });
    this._updateDetectionButton(getDetectionMode());
  }

  /** Apply responsive keyhole fade controls from normalized UI percentages. */
  _applyDetectionFadeFromUi() {
    const fadePct = Math.max(
      0,
      Math.min(40, Math.round(Number(this._detectionFadeSlider?.value) || 0)),
    );
    const outsideOpacityValue = this._detectionOpacitySlider?.value;
    const outsideOpacityPct = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          outsideOpacityValue == null ? 3 : Number(outsideOpacityValue) || 0,
        ),
      ),
    );
    if (this._detectionFadeSlider)
      this._detectionFadeSlider.value = String(fadePct);
    if (this._detectionFadeValue)
      this._detectionFadeValue.textContent = `${fadePct}%`;
    if (this._detectionOpacitySlider)
      this._detectionOpacitySlider.value = String(outsideOpacityPct);
    if (this._detectionOpacityValue)
      this._detectionOpacityValue.textContent = `${outsideOpacityPct}%`;
    setKeyholeFadeTuning({
      fadeRatio: fadePct / 100,
      outsideOpacity: outsideOpacityPct / 100,
    });
    this.viewer.scene.requestRender?.();
  }

  _setDetectionAllocation(strategy, { syncShare = true, persist = true } = {}) {
    const raw = String(strategy || '')
      .trim()
      .toUpperCase();
    if (!ALLOCATION_STRATEGIES.includes(raw)) return false;
    const normalized = normalizeAllocationStrategy(raw);
    this._detectionAllocationPreference = normalized;
    setDetectionTuning({ allocationStrategy: normalized });
    for (const button of this._detectionAllocationBtns) {
      const active = button.dataset.allocation === normalized;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', String(active));
    }
    if (persist) {
      try {
        localStorage.setItem(DETECTION_ALLOCATION_STORAGE_KEY, normalized);
      } catch {
        /* best effort */
      }
    }
    if (syncShare) this._syncShareState();
    return true;
  }

  _syncDetectionUiFromEngine() {
    const tuning = getDetectionTuning();
    if (this._detectionDensitySlider)
      this._detectionDensitySlider.value = String(tuning.densityPct);
    if (this._detectionDensityValue)
      this._detectionDensityValue.textContent = `${tuning.densityPct}%`;
    this._setDetectionAllocation(tuning.allocationStrategy, {
      syncShare: false,
      persist: false,
    });
    const fadeTuning = getKeyholeFadeTuning();
    if (this._detectionFadeSlider)
      this._detectionFadeSlider.value = String(
        Math.round(fadeTuning.fadeRatio * 100),
      );
    if (this._detectionOpacitySlider) {
      this._detectionOpacitySlider.value = String(
        Math.round(fadeTuning.outsideOpacity * 100),
      );
    }
    this._applyDetectionFadeFromUi();
    this._updateDetectionButton(getDetectionMode());
  }

  /**
   * Activates a detection overlay mode by label (e.g. 'OFF', 'SPARSE', 'PANOPTIC').
   * @param {string} modeLabel - Detection mode label to set.
   * @returns {void}
   */
  _setDetectionMode(modeLabel) {
    if (!modeLabel) return;
    setDetectionModeByLabel(modeLabel);
    this._syncDetectionUiFromEngine();
    this._syncShareState();
  }

  /**
   * Apply a detection preset's density and mode through the real UI path.
   *
   * Deliberately does NOT consult `_detectionUserOverridden` — the CALLER owns
   * that decision. The style path checks it (an explicit Sparse/Off must
   * survive a style switch); Cockpit entry does not (owner: detection is on in
   * the cockpit "regardless").
   * @param {{mode?: string, densityPct?: number}} det Preset detection config.
   * @returns {void}
   */
  _applyDetectionPreset(det) {
    if (!det) return;
    if (typeof det.densityPct === 'number' && this._detectionDensitySlider) {
      const pct = canonicalizeDensity(det.densityPct);
      this._detectionDensitySlider.value = String(pct);
      if (this._detectionDensityValue)
        this._detectionDensityValue.textContent = `${pct}%`;
      this._applyDetectionDensityFromUi();
    }
    if (det.mode) this._setDetectionMode(String(det.mode).toUpperCase());
  }

  /**
   * Pushes the current visual state (bloom, sharpen, HUD, detection) to
   * the ShareLinkManager so the URL hash stays in sync.
   * @returns {void}
   */
  /**
   * Detection as a DURABLE preference, for serialization into a share link.
   *
   * While Contacts is active it OWNS detection and forces Dense @ 75%. That is
   * a session-scoped override, not something the operator chose: it is undone
   * verbatim on deactivation. Serializing the forced values shipped a link that
   * pinned Dense @ 75% on the recipient — as a durable preference, with no
   * Contacts mode present to explain or undo it — even though the author's own
   * setting was (say) OFF @ 50%. Publish what deactivation would restore.
   *
   * `_contactsDetectionRestore` is exactly that snapshot and is null whenever
   * Contacts does not own detection, so the live values are used normally.
   */
  _shareableDetectionState() {
    return shareableDetectionState({
      owned: this._contactsDetectionRestore,
      liveMode: getDetectionMode(),
      liveDensityPct: parseInt(this._detectionDensitySlider?.value || '50', 10),
    });
  }

  /**
   * Reads current detection overlay state (engine mode + UI density percent).
   * @returns {{detectionMode: string, densityPct: number|null, allocationStrategy:string, fadePct:number, outsideOpacityPct:number}}
   */
  getDetectionState() {
    const pct = this._detectionDensitySlider
      ? parseInt(this._detectionDensitySlider.value, 10)
      : null;
    return {
      detectionMode: getDetectionMode(),
      densityPct: pct,
      allocationStrategy: getDetectionTuning().allocationStrategy,
      fadePct: parseInt(this._detectionFadeSlider?.value || '7', 10),
      outsideOpacityPct: parseInt(
        this._detectionOpacitySlider?.value || '0',
        10,
      ),
    };
  }

  /** Read-only overlay diagnostics used by browser QA and regression harnesses. */
  getDetectionDiagnostics() {
    return readDetectionDiagnostics();
  }

  /**
   * Controls the detection overlay: on/off, mode, and density percent.
   * Density writes the slider AND the engine so share links and scene
   * snapshots stay truthful.
   * @param {object} [options]
   * @param {boolean} [options.enabled] - false forces OFF; true restores the current density profile.
   * @param {'sparse'|'balanced'|'dense'|'panoptic'} [options.mode] - Profile (legacy aliases accepted).
   * @param {number} [options.densityPct] - 0-100 density percent.
   * @param {'elastic'|'weighted'} [options.allocationStrategy] - Layer-capacity policy.
   * @param {number} [options.fadePct] - Fade distance as 0-40% of the keyhole radius.
   * @param {number} [options.outsideOpacityPct] - Opacity beyond the fade distance, 0-100%.
   * @returns {{ok: boolean, detectionMode?: string, densityPct?: number|null, error?: string}}
   */
  setDetection({
    enabled,
    mode,
    densityPct,
    allocationStrategy,
    fadePct,
    outsideOpacityPct,
  } = {}) {
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return {
        ok: false,
        error: `Invalid detection enabled value: ${enabled}`,
        ...this.getDetectionState(),
      };
    }
    let requestedProfile = null;
    if (typeof mode === 'string' && mode.trim()) {
      requestedProfile = normalizeProfile(mode);
      if (!requestedProfile) {
        return {
          ok: false,
          error: `Unknown detection mode: ${mode}`,
          ...this.getDetectionState(),
        };
      }
    }
    let requestedDensity = null;
    if (densityPct != null) {
      if (!Number.isFinite(Number(densityPct))) {
        return {
          ok: false,
          error: `Invalid density: ${densityPct}`,
          ...this.getDetectionState(),
        };
      }
      requestedDensity = canonicalizeDensity(Number(densityPct));
    }
    if (
      requestedProfile &&
      requestedProfile !== 'OFF' &&
      requestedDensity != null &&
      profileForDensity(requestedDensity) !== requestedProfile
    ) {
      return {
        ok: false,
        error: `Detection mode ${requestedProfile} conflicts with density ${requestedDensity}%`,
        ...this.getDetectionState(),
      };
    }
    let requestedAllocation = null;
    if (allocationStrategy != null) {
      requestedAllocation = String(allocationStrategy).trim().toUpperCase();
      if (!ALLOCATION_STRATEGIES.includes(requestedAllocation)) {
        return {
          ok: false,
          error: `Unknown allocation strategy: ${allocationStrategy}`,
          ...this.getDetectionState(),
        };
      }
    }
    if (fadePct != null) {
      if (!Number.isFinite(Number(fadePct))) {
        return {
          ok: false,
          error: `Invalid fade distance: ${fadePct}`,
          ...this.getDetectionState(),
        };
      }
    }
    if (outsideOpacityPct != null) {
      if (!Number.isFinite(Number(outsideOpacityPct))) {
        return {
          ok: false,
          error: `Invalid outside opacity: ${outsideOpacityPct}`,
          ...this.getDetectionState(),
        };
      }
    }
    const hasExplicitVisualChange =
      typeof enabled === 'boolean' ||
      requestedProfile !== null ||
      requestedDensity !== null ||
      requestedAllocation !== null ||
      fadePct != null ||
      outsideOpacityPct != null;
    if (hasExplicitVisualChange) {
      // Voice/scripted detection control counts as an explicit user choice, so
      // neither style presets nor a still-pending shared visual restore can
      // overwrite it afterward.
      this.shareLinkManager?.claimRestoreLane?.('visual');
      this._detectionUserOverridden = true;
    }
    if (requestedAllocation) {
      this._setDetectionAllocation(requestedAllocation, { syncShare: false });
    }
    if (fadePct != null && this._detectionFadeSlider) {
      this._detectionFadeSlider.value = String(
        Math.max(0, Math.min(40, Math.round(Number(fadePct)))),
      );
    }
    if (outsideOpacityPct != null && this._detectionOpacitySlider) {
      this._detectionOpacitySlider.value = String(
        Math.max(0, Math.min(100, Math.round(Number(outsideOpacityPct)))),
      );
    }
    if (fadePct != null || outsideOpacityPct != null)
      this._applyDetectionFadeFromUi();

    if (
      requestedProfile &&
      requestedProfile !== 'OFF' &&
      requestedDensity == null
    ) {
      requestedDensity = defaultDensityForProfile(requestedProfile);
    }
    if (requestedDensity != null && this._detectionDensitySlider) {
      this._detectionDensitySlider.value = String(requestedDensity);
      this._applyDetectionDensityFromUi();
    }

    if (enabled === false || requestedProfile === 'OFF') {
      setDetectionModeByLabel('OFF');
    } else if (requestedProfile) {
      setDetectionModeByLabel(requestedProfile);
    } else if (enabled === true && getDetectionMode() === 'OFF') {
      setDetectionModeByLabel(
        profileForDensity(
          requestedDensity ?? this._detectionDensitySlider?.value ?? 50,
        ),
      );
    }
    this._syncDetectionUiFromEngine();
    this._syncShareState();
    return { ok: true, ...this.getDetectionState() };
  }

  /**
   * Updates the detection toggle button label and CSS classes to reflect
   * the current density-derived profile. Also toggles the density and
   * allocation controls together.
   * @param {string} modeLabel - Current detection mode label.
   * @returns {void}
   */
  _updateDetectionButton(modeLabel) {
    const btn = this._detectionBtn;
    const enabled = modeLabel !== 'OFF';
    btn.setAttribute('aria-pressed', String(enabled));
    btn.setAttribute(
      'aria-label',
      enabled
        ? `Detection overlay: ${String(modeLabel).toLowerCase()}`
        : 'Detection overlay: off',
    );
    btn.classList.remove('active', 'god', 'panoptic');
    if (modeLabel === 'SPARSE') {
      btn.querySelector('.pp-label').textContent = 'SPARSE';
      btn.classList.add('active');
    } else if (modeLabel === 'BALANCED') {
      btn.querySelector('.pp-label').textContent = 'BALANCED';
      btn.classList.add('active');
    } else if (modeLabel === 'DENSE') {
      btn.querySelector('.pp-label').textContent = 'DENSE';
      btn.classList.add('active', 'panoptic');
    } else {
      btn.querySelector('.pp-label').textContent = 'DETECT';
    }

    if (this._detectionSliderRow) {
      this._detectionSliderRow.classList.toggle('visible', modeLabel !== 'OFF');
    }
    if (this._detectionAllocationRow) {
      this._detectionAllocationRow.classList.toggle(
        'visible',
        modeLabel !== 'OFF',
      );
    }
    if (this._detectionFadeRow) {
      this._detectionFadeRow.classList.toggle('visible', modeLabel !== 'OFF');
    }
    if (this._detectionOpacityRow) {
      this._detectionOpacityRow.classList.toggle(
        'visible',
        modeLabel !== 'OFF',
      );
    }
    this._layoutRightPanels();
  }
}
