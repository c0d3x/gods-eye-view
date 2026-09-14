// src/ui/globeNavigation.js — who moves the camera: the navigation authority
// every explicit flight goes through (stamping, deferring and reasserting it),
// letting go of whatever the camera follows, orbit mode, and the Reset and
// Clear buttons that return to the globe and drop the selected layers.
//
// These are StyleManager methods, kept here and adopted by StyleManager (see
// src/ui/adoptMethods.js); they run on its state. _disposeGlobeNavigation()
// removes the two buttons' listeners.
import * as Cesium from 'cesium';
import { interruptCameraMotion } from '../cameraVerbs.js';
import { aircraftTrackingTarget } from '../cockpitTracking.js';
import aisLiveVesselsLayer from '../data/aisLiveVessels.js';
import flightsLayer from '../data/flights.js';
import militaryAwarenessLayer from '../data/militaryAwareness.js';
import militaryFlightsLayer from '../data/militaryFlights.js';
import rocketLaunchesLayer from '../data/rocketLaunches.js';
import satellitesLayer from '../data/satellites.js';
import { flyToGlobeView, GLOBE_VIEW } from '../locations.js';
import {
  beginDeferredNavigation,
  reassertNavigationHandoff,
  runExplicitNavigation,
} from '../navigationPolicy.js';

export class GlobeNavigation {
  /** Advance camera authority and settle any older search UI immediately. */
  _stampNavigation({
    cancelPendingSelection = true,
    clearSearchedLocation = true,
  } = {}) {
    this._navigationGeneration += 1;
    // A newer destination owns the camera, so the last free-text search is no
    // longer where we are. DEFERRED navigation opts out here and clears at the
    // reassert seam instead: a geocode that never resolves moves no camera, and
    // a lookup that fails must not blank a readout that is still true.
    if (clearSearchedLocation) this.clearSearchedLocation();
    if (cancelPendingSelection) {
      if (
        this._hasShareState &&
        this._resolveInitialShareRestore &&
        !this._layerStateCoordinator
      ) {
        this._initialShareSelectionSuperseded = true;
      }
      const passivelyClearedShareSelection =
        this._layerStateCoordinator?.cancelPendingShareTracking?.(
          'superseded-by-explicit-navigation',
          { clearSelection: true },
        ) === true;
      try {
        flightsLayer.cancelPendingTrackingRestore?.();
      } catch {
        /* best effort */
      }
      try {
        militaryFlightsLayer.cancelPendingTrackingRestore?.();
      } catch {
        /* best effort */
      }
      try {
        satellitesLayer.cancelPendingTrackingRestore?.();
      } catch {
        /* best effort */
      }
      // A deliberate destination supersedes share-selected entities that have
      // not arrived yet. Active owners publish their clear when released.
      if (!passivelyClearedShareSelection && !flightsLayer.getTrackedInfo?.()) {
        this._dataManager?.setLayerParams(
          'flights',
          {
            selectedFlightsTrackingId: null,
          },
          { origin: 'tool' },
        );
      }
      if (
        !passivelyClearedShareSelection &&
        !militaryFlightsLayer.getTrackedInfo?.()
      ) {
        this._dataManager?.setLayerParams(
          'military',
          {
            selectedMilitaryTrackingId: null,
          },
          { origin: 'tool' },
        );
      }
      if (
        !passivelyClearedShareSelection &&
        !satellitesLayer.getTrackedInfo?.()
      ) {
        this._dataManager?.setLayerParams(
          'satellites',
          {
            selectedSatTrackingId: null,
          },
          { origin: 'tool' },
        );
      }
    }
    if (this._activeLocationSearchGeneration !== null) {
      this._settleLocationSearchUi(this._activeLocationSearchGeneration);
    }
    return this._navigationGeneration;
  }

  /** Release every follow owner while preserving Contact and vessel selection. */
  _releaseFollowCamera({
    preserveVesselSelection = true,
    preserveCameraFlight = false,
    trackingOrigin = 'tool',
  } = {}) {
    let contactSelected = false;
    try {
      contactSelected = Boolean(
        militaryAwarenessLayer.releaseCameraOwnership?.({
          preserveVesselSelection,
          origin: trackingOrigin,
        }),
      );
    } catch {
      try {
        flightsLayer.stopTracking?.({ origin: trackingOrigin });
      } catch {
        /* best-effort release */
      }
      try {
        militaryFlightsLayer.stopTracking?.({ origin: trackingOrigin });
      } catch {
        /* best-effort release */
      }
      if (!preserveVesselSelection) {
        try {
          aisLiveVesselsLayer.clearSelection?.();
        } catch {
          /* best-effort release */
        }
      }
    }
    try {
      satellitesLayer.stopTracking?.({ origin: trackingOrigin });
    } catch {
      /* best-effort release */
    }
    try {
      rocketLaunchesLayer.releaseCameraOwnership?.();
    } catch {
      /* best-effort release */
    }
    this.viewer.trackedEntity = undefined;
    interruptCameraMotion('explicit-navigation');
    this._stopOrbit();
    if (!preserveCameraFlight) this.viewer.camera.cancelFlight();
    try {
      this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    } catch {
      /* teardown race */
    }
    return contactSelected;
  }

  /** Run one immediate destination through the shared ownership policy. */
  _runExplicitNavigation(noun, navigate, releaseOptions = undefined) {
    return runExplicitNavigation({
      disposed: this._disposed,
      cockpitActive: !!this.cockpitView?.active,
      noun,
      showToast: (text) => this._showToast(text),
      stamp: () => this._stampNavigation(),
      release: () => this._releaseFollowCamera(releaseOptions),
      navigate,
    });
  }

  /** Accept a delayed lookup without releasing its current camera owner. */
  _beginDeferredNavigation(
    noun = 'location',
    { cancelPendingSelection = true } = {},
  ) {
    return beginDeferredNavigation({
      disposed: this._disposed,
      cockpitActive: !!this.cockpitView?.active,
      noun,
      showToast: (text) => this._showToast(text),
      // The searched-location readout survives the STAMP; only a flight that
      // actually starts invalidates it (see the release hook below).
      stamp: () =>
        this._stampNavigation({
          cancelPendingSelection,
          clearSearchedLocation: false,
        }),
    });
  }

  /** Final authority check and release immediately before a delayed flight. */
  _reassertNavigationHandoff(generation) {
    return reassertNavigationHandoff({
      generation,
      currentGeneration: this._navigationGeneration,
      cockpitActive: !!this.cockpitView?.active,
      disposed: this._disposed,
      showToast: (text) => this._showToast(text),
      // Reached only once the handoff is granted, immediately before the
      // deferred flight starts — so a lookup that failed, was superseded, or
      // was refused by the cockpit leaves the old readout standing.
      release: () => {
        this.clearSearchedLocation();
        return this._releaseFollowCamera();
      },
    });
  }

  /** Public lifecycle seam used by voice location navigation. */
  beginDeferredLocationNavigation() {
    return this._beginDeferredNavigation('location');
  }

  /** Public final-authority seam used by voice geocoding. */
  reassertDeferredLocationNavigation(generation) {
    return this._reassertNavigationHandoff(generation);
  }

  /** Public immediate route used by voice destinations. */
  runImmediateLocationNavigation(navigate) {
    return this.runImmediateNavigation('location', navigate);
  }

  /** Public authority facade used by validated voice camera destinations. */
  runImmediateNavigation(noun, navigate, releaseOptions = undefined) {
    return this._runExplicitNavigation(noun, navigate, releaseOptions);
  }

  /** Supersede deferred work when an owner-specific route handles release. */
  supersedeDeferredNavigation() {
    return this._stampNavigation();
  }

  /** Route a valid vessel/fire request through the shared navigation policy. */
  _runExplicitWorldFocus(detail, fly) {
    return this._runExplicitNavigation(detail?.kind || 'target', fly);
  }

  /** Return the aircraft tracker owned before a multi-step Cockpit transaction. */
  getAircraftTrackingTarget() {
    return aircraftTrackingTarget(this.cockpitView?.readAircraftInfo?.());
  }

  // ── Orbit Mode ──────────────────────────────

  /**
   * Creates the orbit mode indicator DOM element and appends it to the body.
   * @returns {void}
   */
  _initOrbit() {
    // Create orbit indicator element
    this._orbitIndicator = document.createElement('div');
    this._orbitIndicator.id = 'orbit-indicator';
    this._orbitIndicator.innerHTML =
      '<span class="orbit-icon">&#x21BB;</span> ORBIT';
    document.body.appendChild(this._orbitIndicator);
  }

  /**
   * Toggles the orbit controller around the current POI target. Shows a toast
   * if no target position has been set (user must fly to a POI first).
   * @returns {void}
   */
  _toggleOrbit() {
    if (!this._currentTarget) {
      this._showToast('Fly to a POI first');
      return;
    }

    const isActive = this.orbitController.toggle(this._currentTarget, {
      radius: this._currentPoi?.alt || 500,
      pitch: this._currentPoi?.pitch || -30,
    });

    this._orbitIndicator.classList.toggle('active', isActive);
  }

  /**
   * Stops orbit mode if active and hides the orbit indicator.
   * @returns {void}
   */
  _stopOrbit() {
    if (this.orbitController.active) {
      this.orbitController.stop();
      this._orbitIndicator.classList.remove('active');
    }
  }

  /** Wire the persistent reset control to the same route used by voice. */
  _initResetGlobeButton() {
    this._globeResetHandler = () => {
      this.resetToGlobeView();
    };
    for (const button of [this._resetGlobeBtn, this._cockpitResetGlobeBtn]) {
      button?.addEventListener('click', this._globeResetHandler);
    }
  }

  /** Wire the top-center action that clears only manager-owned data layers. */
  _initClearSelectedLayersButton() {
    if (!this._clearSelectedLayersBtn) return;
    this._clearSelectedLayersHandler = () => {
      void this.clearSelectedLayers();
    };
    this._clearSelectedLayersBtn.addEventListener(
      'click',
      this._clearSelectedLayersHandler,
    );
  }

  /**
   * Clear every selected data layer without resetting visual, map, HUD, or
   * camera state. A layer may still release camera work it owns as part of its
   * established disable lifecycle.
   * @returns {Promise<object>} Aggregate manager lifecycle truth for the batch.
   */
  clearSelectedLayers() {
    if (this._clearSelectedLayersPromise)
      return this._clearSelectedLayersPromise;
    if (!this._dataManager?.clearSelectedLayers) {
      return Promise.resolve({
        targetIds: [],
        items: [],
        clearedIds: [],
        notClearedIds: [],
      });
    }
    const generation = ++this._contextModeGeneration;
    const notificationToken = Symbol('clear-selected-layers');
    if (this._contextRestoreState) this._contextRestoreState.cancelled = true;
    this._contextModeChanging = true;
    this._contextMode = null;
    this._contextModeEntering = null;
    this._contextModeEntryIntent = null;
    this._contextModeReplacementIntent = null;
    this._contextSessionSnapshot = null;
    this._contextRestoreState = null;
    this._preservePanelStateDuringLayerClear = true;
    this._syncContextModeButtons();
    this._userFacingContextNotificationTokens.add(notificationToken);
    this._clearSelectedLayersBtn.setAttribute('aria-disabled', 'true');
    this._clearSelectedLayersBtn.setAttribute('aria-busy', 'true');
    this._clearSelectedLayersBtn.setAttribute(
      'aria-label',
      'Clearing selected data layers',
    );

    const managerOperation = this._dataManager.clearSelectedLayers({
      origin: 'user',
      notificationToken,
    });
    this._clearSelectedLayersManagerPromise = managerOperation;
    const operation = managerOperation
      .then((result) => {
        if (result.targetIds.length === 0) {
          this._showToast('No selected data layers');
        } else if (result.notClearedIds.length > 0) {
          this._showToast(
            `${result.notClearedIds.length} data layer${result.notClearedIds.length === 1 ? '' : 's'} could not be cleared`,
          );
        } else {
          this._showToast(
            `Cleared ${result.clearedIds.length} data layer${result.clearedIds.length === 1 ? '' : 's'}`,
          );
        }
        return result;
      })
      .catch((error) => {
        console.warn('[Data] clear selected layers failed', error);
        this._showToast('Selected data layers could not be cleared');
        return {
          targetIds: [],
          items: [],
          clearedIds: [],
          notClearedIds: [],
          error,
        };
      })
      .finally(() => {
        this._userFacingContextNotificationTokens.delete(notificationToken);
        if (generation === this._contextModeGeneration) {
          this._contextModeChanging = false;
          this._syncContextModeButtons();
        }
        this._clearSelectedLayersBtn.setAttribute('aria-disabled', 'false');
        this._clearSelectedLayersBtn.setAttribute('aria-busy', 'false');
        this._clearSelectedLayersBtn.setAttribute(
          'aria-label',
          'Clear selected data layers',
        );
        this._preservePanelStateDuringLayerClear = false;
        this._clearSelectedLayersManagerPromise = null;
        this._clearSelectedLayersPromise = null;
      });
    this._clearSelectedLayersPromise = operation;
    return operation;
  }

  /**
   * Release every camera owner and return to the canonical full-globe frame.
   * Repeated requests adopt the in-flight reset rather than cancelling it.
   * @returns {Promise<object>} Canonical reset result shared with voice.
   */
  resetToGlobeView() {
    if (this._globeResetPromise) return this._globeResetPromise;
    this._stampNavigation();
    interruptCameraMotion('reset-globe');
    this._stopOrbit();
    this.cockpitView?.exit({ restoreTracking: false });
    try {
      militaryAwarenessLayer.releaseCameraOwnership?.({ origin: 'tool' });
    } catch {
      // Keep reset available if Context has not initialized completely.
      try {
        flightsLayer.stopTracking?.({ origin: 'tool' });
      } catch {
        /* best-effort release */
      }
      try {
        militaryFlightsLayer.stopTracking?.({ origin: 'tool' });
      } catch {
        /* best-effort release */
      }
      try {
        aisLiveVesselsLayer.clearSelection?.();
      } catch {
        /* best-effort release */
      }
    }
    try {
      satellitesLayer.stopTracking?.({ origin: 'tool' });
    } catch {
      /* best-effort release */
    }
    try {
      rocketLaunchesLayer.releaseCameraOwnership?.();
    } catch {
      /* best-effort release */
    }
    this.viewer.trackedEntity = undefined;
    this.viewer.camera.cancelFlight();
    this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    this._beginWorldJumpTransition();

    let resolveReset;
    const resetPromise = new Promise((resolve) => {
      resolveReset = resolve;
    });
    this._globeResetPromise = resetPromise;
    let settled = false;
    let timer = null;
    const finish = (cancelled = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this._endWorldJumpTransition();
      const carto = this.viewer.camera.positionCartographic;
      const result = {
        ok: !cancelled,
        action: 'zoom_to_globe',
        cancelled,
        heightKm: Math.round(GLOBE_VIEW.heightM / 1000),
        centeredOn: {
          latitude: Number(Cesium.Math.toDegrees(carto.latitude).toFixed(2)),
          longitude: Number(Cesium.Math.toDegrees(carto.longitude).toFixed(2)),
        },
      };
      this._resetGlobeBtn?.setAttribute(
        'aria-label',
        'Reset to full globe view',
      );
      this._cockpitResetGlobeBtn?.setAttribute(
        'aria-label',
        'Reset cockpit to full globe view',
      );
      this._globeResetPromise = null;
      resolveReset(result);
    };
    timer = window.setTimeout(() => {
      const height = this.viewer.camera.positionCartographic?.height;
      finish(
        !Number.isFinite(height) ||
          Math.abs(height - GLOBE_VIEW.heightM) > 1000,
      );
    }, 4200);
    this._resetGlobeBtn?.setAttribute(
      'aria-label',
      'Resetting to full globe view',
    );
    this._cockpitResetGlobeBtn?.setAttribute(
      'aria-label',
      'Resetting cockpit to full globe view',
    );
    const target = flyToGlobeView(this.viewer, {
      onComplete: () => finish(false),
      onCancel: () => finish(true),
    });
    if (!target) finish(true);
    return resetPromise;
  }

  /**
   * Remove the Reset and Clear buttons' listeners when StyleManager is
   * disposed.
   */
  _disposeGlobeNavigation() {
    if (this._globeResetHandler) {
      this._resetGlobeBtn?.removeEventListener(
        'click',
        this._globeResetHandler,
      );
      this._cockpitResetGlobeBtn?.removeEventListener(
        'click',
        this._globeResetHandler,
      );
      this._globeResetHandler = null;
    }
    if (this._clearSelectedLayersBtn && this._clearSelectedLayersHandler) {
      this._clearSelectedLayersBtn.removeEventListener(
        'click',
        this._clearSelectedLayersHandler,
      );
      this._clearSelectedLayersHandler = null;
    }
  }
}
