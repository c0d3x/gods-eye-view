// src/ui/shareState.js — share links: keeping the page's share state current,
// restoring a shared view on load and reporting a shared flight the page could
// not follow, the panel layout a link carries, and the Share button that
// copies the link.
//
// These are StyleManager methods, kept here and adopted by StyleManager (see
// src/ui/adoptMethods.js); they run on its state.
import { BLOOM_SCALE_VERSION } from '../bloom.js';
import { getDetectionTuning } from '../data/detection.js';
import { canPresentDeferredStatusNotice } from '../loadingFeedback.js';
import {
  isScopeMaskEnabled,
  getScopeMaskFeather,
  getScopeTerminusOverride,
} from '../scopeMask.js';

const SHARE_PANEL_STATE_SPECS = Object.freeze([
  { id: 'control-panel', pinnable: true },
  { id: 'location-bar', pinnable: true },
  { id: 'data-panel' },
  { id: 'cctv-panel' },
  { id: 'radio-panel' },
  { id: 'scene-panel' },
  { id: 'global-context-panel' },
  { id: 'pp-toggles' },
  { id: 'param-slider-panel' },
]);

export class ShareState {
  _syncShareState() {
    const detection = this._shareableDetectionState();
    this.shareLinkManager.onToggleChange(
      this.bloomEnabled,
      this.sharpenEnabled,
      {
        bloomIntensity: this._getBloomIntensity(),
        bloomVersion: BLOOM_SCALE_VERSION,
        sharpenIntensity: parseInt(this._sharpenSlider?.value || '49', 10),
        hudVariant: this.hud.getVariant(),
        hudVisible: this.hud.visible,
        detectionMode: detection.mode,
        detectionDensity: detection.densityPct,
        detectionAllocation: getDetectionTuning().allocationStrategy,
        detectionFadePct: parseInt(this._detectionFadeSlider?.value || '7', 10),
        detectionOutsideOpacityPct: parseInt(
          this._detectionOpacitySlider?.value || '1',
          10,
        ),
        celestialRingEnabled: this.celestialRingEnabled,
        scopeEnabled: isScopeMaskEnabled(),
        scopeFeatherPct: Math.round(getScopeMaskFeather() * 100),
        // null when adaptive — the share layer omits `sce` entirely in that case.
        scopeTerminusPct:
          getScopeTerminusOverride() == null
            ? null
            : Math.round(getScopeTerminusOverride() * 100),
        mapStack: this.mapStackController?.getActiveId?.() || 'photoreal',
      },
    );
  }

  _handleShareTrackingRestoreStatus(result) {
    if (!result || this._disposed) return;
    const trackingKey = `${result.layerId || ''}:${result.targetId ?? ''}`;
    if (result.classification === 'pending') {
      this._shareTrackingNoticeGeneration += 1;
      this._shareTrackingAcquiringKey = trackingKey;
      this._showGlobalStatusNotice('ACQUIRING', {
        state: 'acquiring',
        detail: `SHARED ${String(result.label || 'SUBJECT').toUpperCase()}`,
        persistent: true,
      });
      return;
    }
    const ownsAcquiringNotice = this._shareTrackingAcquiringKey === trackingKey;
    if (ownsAcquiringNotice) {
      this._shareTrackingNoticeGeneration += 1;
      this._shareTrackingAcquiringKey = null;
      if (this._globalStatusNotice?.state === 'acquiring') {
        this._globalStatusNotice = null;
        this._updateGlobalLoadingFeedback();
      }
    }
    if (
      result.classification === 'followed' ||
      result.classification === 'cancelled'
    )
      return;
    // A stale terminal result must never replace a newer target's acquisition.
    if (this._shareTrackingAcquiringKey) return;
    const noticeGeneration = ownsAcquiringNotice
      ? this._shareTrackingNoticeGeneration
      : ++this._shareTrackingNoticeGeneration;
    const subject = result.label || 'entity';
    const message =
      result.classification === 'expired'
        ? `Shared ${subject} follow expired`
        : result.classification === 'source-unavailable'
          ? `Shared ${subject} could not be restored — feed unavailable`
          : `Shared ${subject} is unavailable`;
    const showAfterStartupCover = () => {
      requestAnimationFrame(() => {
        if (
          !canPresentDeferredStatusNotice(
            noticeGeneration,
            this._shareTrackingNoticeGeneration,
            this._disposed,
          )
        )
          return;
        const startupCover = document.getElementById('loading-screen');
        if (
          !startupCover ||
          getComputedStyle(startupCover).visibility === 'hidden'
        ) {
          this._showGlobalStatusNotice(message);
          return;
        }
        let fallbackTimer = null;
        const showOnce = () => {
          startupCover.removeEventListener('transitionend', showOnce);
          if (fallbackTimer) clearTimeout(fallbackTimer);
          if (
            canPresentDeferredStatusNotice(
              noticeGeneration,
              this._shareTrackingNoticeGeneration,
              this._disposed,
            )
          )
            this._showGlobalStatusNotice(message);
        };
        startupCover.addEventListener('transitionend', showOnce, {
          once: true,
        });
        fallbackTimer = setTimeout(showOnce, 1000);
      });
    };
    if (this._resolveInitialShareRestore) {
      void this.initialRestorePromise.then(showAfterStartupCover);
      return;
    }
    showAfterStartupCover();
  }

  _buildSharePanelState() {
    const specs = [];
    for (const spec of SHARE_PANEL_STATE_SPECS) {
      const panelEl = document.getElementById(spec.id);
      if (!panelEl) continue;
      // Responsive auto-collapse is presentation only; the recipient should
      // restore the user's explicit expanded preference at its own viewport.
      const collapsed = panelEl.classList.contains('layout-auto-collapsed')
        ? false
        : panelEl.classList.contains('collapsed');
      const entry = { id: spec.id, collapsed };
      if (spec.pinnable)
        entry.pinned = panelEl.classList.contains('dock-pinned');
      specs.push(entry);
    }
    return specs.length ? { specs } : null;
  }

  _restorePanelState(panelState) {
    if (!panelState || !Array.isArray(panelState.specs)) return;
    const specsById = new Map(panelState.specs.map((spec) => [spec.id, spec]));
    for (const spec of SHARE_PANEL_STATE_SPECS) {
      const state = specsById.get(spec.id);
      if (!state || typeof state.collapsed !== 'boolean') continue;
      if (spec.pinnable && typeof state.pinned === 'boolean') {
        this._setCommandDockPanelPinState(spec.id, state.pinned, {
          restore: true,
          persist: false,
          syncShare: false,
        });
      }
      const nextCollapsed =
        state.pinned && spec.pinnable ? false : state.collapsed;
      this.setPanelCollapsed(spec.id, nextCollapsed, {
        restore: true,
        persist: false,
        syncShare: false,
      });
    }
    this.shareLinkManager?.onPanelStateChange?.();
  }

  // ── Share Button ─────────────────────────────

  /**
   * Wires the share button click to copy the current share link to the clipboard.
   * @returns {void}
   */
  _initShareButton() {
    this._shareBtn.addEventListener('click', async () => {
      const success = await this.shareLinkManager.copyLink();
      this._showToast(success ? 'Link copied!' : 'Copy failed');
    });
  }

  /** Whether a share link was used to load the page */
  get hasShareState() {
    return !!this._hasShareState;
  }

  /** Terminal result for the complete initial share restoration. */
  get initialRestorePromise() {
    return (
      this._initialShareRestorePromise ||
      Promise.resolve({ status: 'not-requested' })
    );
  }

  _settleInitialShareRestore(result) {
    if (!this._resolveInitialShareRestore) return;
    const resolve = this._resolveInitialShareRestore;
    this._resolveInitialShareRestore = null;
    resolve(result);
    window.dispatchEvent(
      new CustomEvent('gev:initial-share-restore-settled', { detail: result }),
    );
  }
}
