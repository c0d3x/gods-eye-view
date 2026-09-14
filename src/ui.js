import * as Cesium from 'cesium';
import { BLOOM_SCALE_VERSION, decodeBloomIntensity } from './bloom.js';
import { LOCATIONS } from './locations.js';
import { enterCockpitWithTracking } from './cockpitTracking.js';
import { CockpitViewController } from './ui/cockpitView.js';
import { IntelHUD } from './hud.js';
import { ShareLinkManager } from './sharelink.js';
import {
  isExplicitLayerStateOrigin,
  LayerStateCoordinator,
} from './data/layerState.js';
import { renderMapStackChips, syncMapStackChips } from './mapStackChips.js';
import { OrbitController } from './orbit.js';
import { CelestialRing, getKeyholeFadeTuning, setKeyholeFadeTuning } from './celestialRing.js';
import { destroyTrackedReadout, initTrackedReadout } from './data/trackedReadout.js';
import { destroyWorldOverlay, initWorldOverlay } from './overlays/worldOverlay.js';
import {
  destroyDetection,
  initDetection,
  cycleMode as cycleDetectionMode,
  getDetectionDiagnostics as readDetectionDiagnostics,
  getDetectionTuning,
  getMode as getDetectionMode,
  setMode as setDetectionModeByLabel,
  setDetectionStyle,
  setDetectionTuning,
} from './data/detection.js';
import {
  ALLOCATION_STRATEGIES,
  canonicalizeDensity,
  defaultDensityForProfile,
  normalizeAllocationStrategy,
  normalizeProfile,
  profileForDensity,
} from './data/detectionPolicy.js';
import trafficLayer from './data/traffic.js';
import flightsLayer from './data/flights.js';
import militaryFlightsLayer from './data/militaryFlights.js';
import satellitesLayer from './data/satellites.js';
import cctvLayer from './data/cctv.js';
import radioLayer from './data/radio.js';
import bikeshareLayer from './data/bikeshare.js';
import aisLiveVesselsLayer from './data/aisLiveVessels.js';
import militaryAwarenessLayer from './data/militaryAwareness.js';
import militaryInstallationsLayer from './data/militaryInstallations.js';
import {
  aggregateLayerLoading,
  canPresentDeferredStatusNotice,
  createGlobalStatusNotice,
  createLoadingFeedbackState,
  createTrafficSyncFeedbackState,
  presentGlobalLoadingStatus,
  presentGlobalStatusNotice,
  presentLoadingFeedback,
  reduceLoadingFeedback,
  reduceTrafficSyncFeedback,
} from './loadingFeedback.js';
import { setSplitFlapText } from './splitFlap.js';
import {
  cockpitEntryAllowed,
  contextAllowedLayerIds,
  contextLayerEnableBlockReason,
  contextRestoreLayerIds,
  contextSnapshotLayerIds,
  isExplicitUserIntentOrigin,
  mergeContextTransitionErrors,
  recordContextRestoreExplicitChange,
  recordContextSessionUserChange,
  runWithContextModeChanging,
  settleContextModeChange,
  settleContextIntentReplay,
  settleUserFacingContextAction,
  shouldCaptureContextSession,
  shouldDeferContextEntryDuringClear,
  shouldExitContextForLayerChange,
  spaceMissionEntryCancellationDisposition,
  contextModeWord,
} from './contextModePolicy.js';
import { shouldExpandGlobalContextPanel } from './rightRailPolicy.js';
import {
  applyCockpitVisionStageIntensities,
  captureCockpitVisionBaseline,
  normalizeCockpitVisionMode,
} from './cockpitVisionPolicy.js';
import {
  applyContactsDetection,
  shareCacheNeedsHeal,
  shareableDetectionState,
} from './contactsDetectionPolicy.js';
import {
  registerCctvFocusRequestListener,
  routeCctvFocusRequest,
} from './cctvFocusRequest.js';
import {
  flyToWorldTarget,
  registerWorldFocusRequestListener,
  routeWorldFocusRequest,
} from './worldFocus.js';
import {
  registerNavigationAuthorityListener,
  stampInitialShareGesture,
} from './navigationPolicy.js';
import { releaseContinuousRender } from './renderGovernor.js';
import {
  setScopeMaskEnabled,
  isScopeMaskEnabled,
  setScopeMaskFeather,
  getScopeMaskFeather,
  setScopeTerminusOverride,
  getScopeTerminusOverride,
  clampScopeTerminusPct,
} from './scopeMask.js';
import { adoptMethods } from './ui/adoptMethods.js';
import { RadioPanel } from './ui/radioPanel.js';
import { CctvPanel } from './ui/cctvPanel.js';
import { PanelLayout } from './ui/panelLayout.js';
import { PanelChrome, PANEL_Z_BASE } from './ui/panelChrome.js';
import { LocationBar } from './ui/locationBar.js';
import { GlobeNavigation } from './ui/globeNavigation.js';
import {
  STYLES,
  STYLE_STATUS_LABELS,
  MILITARY_DETECTION_PRESET,
  STYLE_PRESET_DEFAULTS,
} from './ui/styleConfig.js';
import { VisualStyles } from './ui/visualStyles.js';
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
/** Standard map-view panels cleared out of the way on a fresh Cockpit entry. */
const COCKPIT_ENTRY_COLLAPSE_PANEL_IDS = Object.freeze([
  'data-panel',
  'cctv-panel',
  'scene-panel',
  'pp-toggles',
  'global-context-panel',
  'radio-panel',
]);
const DETECTION_ALLOCATION_STORAGE_KEY = 'gev:detection-allocation:v1';

export class StyleManager {
  /**
   * @param {Cesium.Viewer} viewer - The CesiumJS viewer instance.
   * @param {object} [options]
   */
  constructor(viewer, { mapStackController = null } = {}) {
    this.viewer = viewer;
    this.mapStackController = mapStackController;
    this.stages = {};
    this.activeStyle = 'normal';
    document.documentElement.dataset.gevStyle = this.activeStyle;
    this.transitions = new Map();
    this.startTime = Date.now();

    // True once the user manually changes detection (button/key/slider/voice).
    // Gates per-style detection defaults so they never stomp an explicit choice.
    this._detectionUserOverridden = false;

    // Bloom/sharpen state
    this.bloomEnabled = false;
    this.sharpenEnabled = false;
    this._bloomStage = null;
    this._sharpenStage = null;
    this._recordingMode = false;
    this._recordingConfig = { hidePanels: true, hudMode: 'minimal', safeFrame: '16:9' };
    this._preRecordingHudState = null;
    this._panelZCounter = PANEL_Z_BASE + 10;
    this._animFrameId = null;
    this._lastLoadingFeedbackUpdateAt = 0;
    this._loadingFeedbackState = createLoadingFeedbackState();
    this._loadingFeedbackEvent = null;
    this._loadingFeedbackTicker = null;
    this._globalStatusNotice = null;
    this._shareTrackingAcquiringKey = null;
    this._shareTrackingNoticeGeneration = 0;
    this._globeResetPromise = null;
    this._globeResetHandler = null;
    this._clearSelectedLayersPromise = null;
    this._clearSelectedLayersManagerPromise = null;
    this._clearSelectedLayersHandler = null;
    this._dataManager = null;
    this._cctvUnsubscribe = null;
    this._radioUnsubscribe = null;
    this._radioState = null;
    this._radioCategorySignature = '';
    this._radioTunerStations = [];
    this._radioTunerPool = [];
    this._radioTunerDragging = false;
    this._radioTunerDragStartSlot = 0;
    this._radioTunerDragSnapshot = null;
    this._radioTunerLastSlot = 0;
    this._radioTunerDragDirection = 0;
    this._radioTunerCoordinate = 0;
    this._radioTunerPointerId = null;
    this._radioTunerKeyboardKey = null;
    this._radioTunerAbort = null;
    this._radioTunerBandSignature = '';
    this._radioTunerSelectedId = null;
    this._radioTunerBandPinnedForNavigation = false;
    this._radioTunerCameraRemove = null;
    this._refreshRadioTunerBand = null;
    this._cctvState = null;
    this._cctvSummaryTypingTimer = null;
    this._lastCctvSummaryText = '';
    // Auto-expand guard: last active camera id seen while the layer was
    // enabled; routine state notifications with the same id never re-expand.
    this._lastSeenCctvActiveId = null;
    this._cctvChipHideTimer = null;
    this._cctvChipWasBusy = false;
    this._leftStackLayoutFrame = null;
    this._leftStackReconsiderAutoCollapse = false;
    this._leftStackResizeObserver = null;
    this._leftStackMutationObserver = null;
    this._leftStackHudTransitionHandler = null;
    this._leftStackCollapsedHeights = new Map();
    this._leftStackPreferredPanelId = null;
    this._rightPanelStack = document.getElementById('right-context-rail');
    this._rightStackLayoutFrame = null;
    this._rightStackReconsiderAutoCollapse = false;
    this._rightStackResizeObserver = null;
    this._rightStackMutationObserver = null;
    this._rightStackHudTransitionHandler = null;
    this._rightStackPreferredPanelId = null;
    this._adaptivePanelSettleTimer = null;
    this._windowResizeHandler = null;
    this._loadingVisibilityHandler = null;
    this._cctvRequestFocusHandler = null;
    this._removeCctvRequestFocusListener = null;
    this._worldRequestFocusHandler = null;
    this._removeWorldRequestFocusListener = null;
    this._removeNavigationAuthorityListener = null;
    this._navigationOwnerChangedRemover = null;
    this._navigationGeneration = 0;
    this._activeLocationSearchGeneration = null;
    this._initialShareState = null;
    this._initialShareNavigationGeneration = null;
    this._initialShareRestoreTimeout = null;
    this._layerStateCoordinator = null;
    this._layerStateRestorePromise = null;
    this._awarenessSelectedHandler = null;
    this._awarenessClearedHandler = null;
    this._disposed = false;
    this._draggableResizeObserver = null;

    // DOM refs
    this._styleIndicator = document.getElementById('active-style-name');
    this._sliderPanel = document.getElementById('param-slider-panel');
    this._sliderContainer = document.getElementById('param-sliders');
    this._ppToggles = document.getElementById('pp-toggles');
    this._bloomBtn = document.getElementById('bloom-toggle');
    this._bloomSliderRow = document.getElementById('bloom-slider-row');
    this._bloomSlider = document.getElementById('bloom-intensity-slider');
    this._bloomSliderValue = document.getElementById('bloom-intensity-value');
    this._sharpenBtn = document.getElementById('sharpen-toggle');
    this._sharpenSliderRow = document.getElementById('sharpen-slider-row');
    this._sharpenSlider = document.getElementById('sharpen-intensity-slider');
    this._sharpenSliderValue = document.getElementById('sharpen-intensity-value');
    this._hudBtn = document.getElementById('hud-toggle');
    this._hudLayoutRow = document.getElementById('hud-layout-row');
    this._hudLayoutSelect = document.getElementById('hud-layout-select');
    this._detectionSliderRow = document.getElementById('detection-slider-row');
    this._detectionDensitySlider = document.getElementById('detection-density-slider');
    this._detectionDensityValue = document.getElementById('detection-density-value');
    this._detectionAllocationRow = document.getElementById('detection-allocation-row');
    this._detectionAllocationBtns = [
      document.getElementById('detection-allocation-elastic'),
      document.getElementById('detection-allocation-weighted'),
    ].filter(Boolean);
    this._detectionFadeRow = document.getElementById('detection-fade-row');
    this._detectionFadeSlider = document.getElementById('detection-fade-slider');
    this._detectionFadeValue = document.getElementById('detection-fade-value');
    this._detectionOpacityRow = document.getElementById('detection-opacity-row');
    this._detectionOpacitySlider = document.getElementById('detection-opacity-slider');
    this._detectionOpacityValue = document.getElementById('detection-opacity-value');
    let storedDetectionAllocation = 'ELASTIC';
    try {
      storedDetectionAllocation = localStorage.getItem(DETECTION_ALLOCATION_STORAGE_KEY) || 'ELASTIC';
    } catch { /* storage can be unavailable in privacy/test contexts */ }
    this._detectionAllocationPreference = normalizeAllocationStrategy(storedDetectionAllocation);
    this._celestialBtn = document.getElementById('celestial-toggle');
    this._scopeBtn = document.getElementById('scope-toggle');
    this._scopeFeatherSlider = document.getElementById('scope-feather-slider');
    this._scopeFeatherValue = document.getElementById('scope-feather-value');
    this._mapStackChips = document.getElementById('map-stack-chips');
    this._mapStackStatus = document.getElementById('map-stack-status');
    this._mapStackChangeHandler = null;
    this._cleanViewBtn = document.getElementById('clean-view-toggle');
    this._cleanViewExitBtn = document.getElementById('clean-view-exit');
    this._dataPanel = document.getElementById('data-panel');
    this._scenePanel = document.getElementById('scene-panel');
    this._cctvPanel = document.getElementById('cctv-panel');
    this._radioPanel = document.getElementById('radio-panel');
    this._contextRadioDock = document.getElementById('context-radio-dock');
    this._contextRadioToggleBtn = document.getElementById('context-radio-toggle-btn');
    this._contextRadioMini = document.getElementById('context-radio-mini');
    this._contextRadioMiniEnableBtn = document.getElementById('context-radio-mini-enable-btn');
    this._contextRadioDetailsBtn = document.getElementById('context-radio-details-btn');
    this._contextRadioMiniCloseBtn = document.getElementById('context-radio-mini-close-btn');
    this._contextRadioMiniStation = document.getElementById('context-radio-mini-station');
    this._contextRadioMiniPrevBtn = document.getElementById('context-radio-mini-prev-btn');
    this._contextRadioMiniPlayBtn = document.getElementById('context-radio-mini-play-btn');
    this._contextRadioMiniNextBtn = document.getElementById('context-radio-mini-next-btn');
    this._contextRadioMiniVolume = document.getElementById('context-radio-mini-volume');
    this._contextRadioMiniVolumeValue = document.getElementById('context-radio-mini-volume-value');
    this._cockpitUtilityControls = document.getElementById('cockpit-utility-controls');
    this._cockpitDisplayToggleBtn = document.getElementById('cockpit-display-toggle-btn');
    this._cockpitDisplayPanel = document.getElementById('cockpit-display-panel');
    this._cockpitDisplayPortalRecords = [];
    this._cockpitDisplayPortalActive = false;
    this._cockpitDisplayModeHandler = null;
    this._cockpitRadioToggleBtn = document.getElementById('cockpit-radio-toggle-btn');
    this._cockpitRadioPanel = document.getElementById('cockpit-radio-panel');
    this._cockpitRadioEnableBtn = document.getElementById('cockpit-radio-enable-btn');
    this._cockpitRadioStation = document.getElementById('cockpit-radio-station');
    this._cockpitRadioPrevBtn = document.getElementById('cockpit-radio-prev-btn');
    this._cockpitRadioPlayBtn = document.getElementById('cockpit-radio-play-btn');
    this._cockpitRadioNextBtn = document.getElementById('cockpit-radio-next-btn');
    this._cockpitRadioVolume = document.getElementById('cockpit-radio-volume');
    this._cockpitRadioVolumeValue = document.getElementById('cockpit-radio-volume-value');
    this._radioLayerState = document.getElementById('radio-layer-state');
    this._radioEnableBtn = document.getElementById('radio-enable-btn');
    this._radioFilter = document.getElementById('radio-filter');
    this._radioStationName = document.getElementById('radio-station-name');
    this._radioStationMeta = document.getElementById('radio-station-meta');
    this._radioStationTags = document.getElementById('radio-station-tags');
    this._radioTuner = document.getElementById('radio-tuner');
    this._radioTunerSlider = document.getElementById('radio-tuner-slider');
    this._radioTunerNeedle = document.getElementById('radio-tuner-needle');
    this._radioTunerBandLabel = document.getElementById('radio-tuner-band-label');
    this._radioTunerValue = document.getElementById('radio-tuner-value');
    this._radioTunerStation = document.getElementById('radio-tuner-station');
    this._radioPrevBtn = document.getElementById('radio-prev-btn');
    this._radioPlayBtn = document.getElementById('radio-play-btn');
    this._radioNextBtn = document.getElementById('radio-next-btn');
    this._radioStopBtn = document.getElementById('radio-stop-btn');
    this._radioVolume = document.getElementById('radio-volume');
    this._radioVolumeValue = document.getElementById('radio-volume-value');
    this._radioPlaybackState = document.getElementById('radio-playback-state');
    this._radioStationHomepage = document.getElementById('radio-station-homepage');
    this._globalContextFlightsBtn = document.getElementById('global-context-flights-btn');
    this._globalContextMissionsBtn = document.getElementById('global-context-missions-btn');
    this._contextModeStandby = document.getElementById('context-mode-standby');
    this._contextFlightsView = document.getElementById('context-flights-view');
    this._contextMissionsView = document.getElementById('context-missions-view');
    this._contextMode = null;
    this._contextModeChanging = false;
    this._contextModeGeneration = 0;
    this._contextModeEntering = null;
    this._contextModeEntryIntent = null;
    this._contextModeReplacementIntent = null;
    this._contextModeDeferredEntryIntent = null;
    this._contextSessionSnapshot = null;
    this._contextRestoreState = null;
    this._contextLayerReactionPromises = new Set();
    this._preservePanelStateDuringLayerClear = false;
    this._userFacingContextNotificationTokens = new Set();
    this._dataManagerBeforeDestroyUnsubscribe = null;
    this._dataManagerVisibilityGuardUnsubscribe = null;
    this._dataManagerVisibilityRequestUnsubscribe = null;
    this._installationsSearchBtn = document.getElementById('installations-search-btn');
    this._leftPanelStack = document.getElementById('left-panel-stack');
    this._cctvEnableBtn = document.getElementById('cctv-enable-btn');
    this._cctvNearestBtn = document.getElementById('cctv-nearest-btn');
    this._cctvPrevBtn = document.getElementById('cctv-prev-btn');
    this._cctvNextBtn = document.getElementById('cctv-next-btn');
    this._cctvSelect = document.getElementById('cctv-camera-select');
    this._cctvFocusBtn = document.getElementById('cctv-focus-btn');
    this._cctvCoverageBtn = document.getElementById('cctv-coverage-btn');
    this._cctvAutoHopBtn = document.getElementById('cctv-auto-hop-btn');
    this._cctvProjectionBtn = document.getElementById('cctv-projection-btn');
    this._cctvQualityChip = document.getElementById('cctv-quality-chip');
    this._cctvAdjustBtn = document.getElementById('cctv-adjust-btn');
    this._cctvCalReadout = document.getElementById('cctv-cal-readout');
    this._cctvCalibSaveBtn = document.getElementById('cctv-calib-save-btn');
    this._cctvCalibResetBtn = document.getElementById('cctv-calib-reset-btn');
    this._cctvFrame = document.getElementById('cctv-frame');
    this._cctvFrameWrap = document.getElementById('cctv-frame-wrap');
    this._cctvFrameRequestToken = 0;
    this._cctvFramePreloader = null;
    this._cctvSourceBadge = document.getElementById('cctv-source-badge');
    this._cctvMeta = document.getElementById('cctv-meta');
    this._cctvSummary = document.getElementById('cctv-summary');
    this._shareBtn = document.getElementById('share-btn');
    this._clearSelectedLayersBtn = document.getElementById('clear-selected-layers');
    this._globalLoadingStatus = document.getElementById('global-loading-status');
    this._globalLoadingLabel = document.getElementById('global-loading-label');
    this._globalLoadingDetail = document.getElementById('global-loading-detail');
    this._globalLoadingAction = document.getElementById('global-loading-action');
    // A KEY REQUIRED status opens Provider Settings; keySetup.js listens.
    this._globalLoadingAction?.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('gev:open-key-setup'));
    });
    this._resetGlobeBtn = document.getElementById('reset-globe-view');
    this._cockpitResetGlobeBtn = document.getElementById('cockpit-reset-globe');
    this._styleButtons = document.getElementById('style-buttons');
    this._trafficSyncChip = document.getElementById('traffic-sync-chip');
    this._trafficSyncLabel = document.getElementById('traffic-sync-label');
    this._trafficSyncProgress = document.getElementById('traffic-sync-progress');
    this._cctvSyncChip = document.getElementById('cctv-sync-chip');
    this._cctvSyncLabel = document.getElementById('cctv-sync-label');
    this._cctvSyncProgress = document.getElementById('cctv-sync-progress');
    this._toast = document.getElementById('toast');
    this._locationSearch = document.getElementById('location-search');
    this._searchToggle = document.getElementById('search-toggle');
    this._locationPills = document.getElementById('location-pills');
    this._poiRow = document.getElementById('poi-row');
    this._locationBarDivider = document.getElementById('location-bar-divider');
    this._styleMiniValue = document.getElementById('style-mini-value');
    this._locationMiniCity = document.getElementById('location-mini-city');
    this._locationMiniPoi = document.getElementById('location-mini-poi');
    this._safeFrameOverlay = document.getElementById('safe-frame-overlay');
    this._safeFrameBox = document.getElementById('safe-frame-box');
    this._activeLocationId = null;
    this._expandedCityId = null;
    this._activePoiIndex = null;
    this._currentTarget = null; // Cesium.Cartesian3 of current POI target
    this._currentPoi = null;    // Current POI data object
    // Formatted address of the last free-text geocode search. Preset pills set
    // _activeLocationId instead; a search has no preset record, so this is the
    // only thing the mini-status can report for it.
    this._searchedLocationLabel = null;
    this._trafficSyncFeedbackState = createTrafficSyncFeedbackState();
    this._trafficTransitionTimer = null;
    this._lastTrafficChipUpdateAt = 0;

    // Orbit controller
    this.orbitController = new OrbitController(viewer);
    this._orbitIndicator = null;

    // Intel HUD
    this.hud = new IntelHUD(viewer);
    this._cockpitVisionMode = 'optical';
    this._cockpitVisionRestore = null;
    this._cockpitPanelRestore = null;
    // True only while the open Data Layers panel is the reason Cockpit's
    // Contact panel is collapsed. A user-collapsed Contact panel must remain
    // collapsed when Data Layers closes.
    this._cockpitContextCollapsedForDataPanel = false;
    /** Pre-Contacts detection state, restored on deactivation (see _syncContactsDetection). */
    this._contactsDetectionRestore = null;
    this.cockpitView = new CockpitViewController(viewer, {
      onVisionChange: (mode, active, options) => this._setCockpitVision(mode, active, options),
      onCameraTakeover: () => this._stampNavigation({ cancelPendingSelection: false }),
      getInheritedVisionLabel: () => (
        STYLE_STATUS_LABELS[this.activeStyle]
        || String(this.activeStyle || 'normal').toUpperCase()
      ),
      isEntryAllowed: () => cockpitEntryAllowed({
        contextMode: this._contextMode,
        contextModeChanging: this._contextModeChanging,
        flightsEnabled: !!this._dataManager?.isEnabled('flights'),
        militaryEnabled: !!this._dataManager?.isEnabled('military'),
      }),
      onEntered: () => {
        // A new Cockpit session owns both side rails. Clear standard map-view
        // panels once on entry; NEXT/PREVIOUS never reaches this callback, so
        // panels the operator opens while already inside remain untouched.
        this._cockpitPanelRestore = new Map();
        this._cockpitContextCollapsedForDataPanel = false;
        for (const panelId of COCKPIT_ENTRY_COLLAPSE_PANEL_IDS) {
          const panel = document.getElementById(panelId);
          if (panel) {
            this._cockpitPanelRestore.set(panelId, panel.classList.contains('collapsed'));
          }
          this.setPanelCollapsed(panelId, true, {
            persist: false,
            syncShare: false,
          });
        }
        this.cockpitView?.setContextCollapsed(false);
        this.cockpitView?.setSignalCollapsed(false, { user: true });
      },
      onExited: () => {
        const restore = this._cockpitPanelRestore;
        this._cockpitPanelRestore = null;
        this._cockpitContextCollapsedForDataPanel = false;
        if (!restore) return;
        for (const [panelId, wasCollapsed] of restore) {
          this.setPanelCollapsed(panelId, wasCollapsed, {
            persist: false,
            syncShare: false,
          });
        }
      },
      restoreTrackingFrame: (entity) => {
        const [layerId, ...idParts] = String(entity?.gevTrackedId || '').split(':');
        const trackedId = idParts.join(':');
        if (!trackedId) return false;
        if (layerId === 'flights') return flightsLayer.refocusTrackedById?.(trackedId) === true;
        if (layerId === 'military') return militaryFlightsLayer.refocusTrackedById?.(trackedId) === true;
        return false;
      },
    });

    // Full-globe sun/moon ring. It is a crisp screen-space overlay above the
    // Cesium canvas but below the HUD/detection/readout z ladder.
    this.celestialRing = new CelestialRing(viewer, {
      enabled: false,
      onAutoDisable: () => this.setCelestialRingEnabled(false, {
        syncShare: !!this.shareLinkManager,
        focus: false,
      }),
    });

    // Share Link Manager
    this.shareLinkManager = new ShareLinkManager(viewer, {
      onRestore: async (state) => {
        const {
          style,
          bloom,
          sharpen,
          bloomIntensity,
          bloomVersion,
          sharpenIntensity,
          hudVariant,
          hudVisible,
          detectionMode,
          detectionDensity,
          detectionAllocation,
          detectionFadePct,
          detectionOutsideOpacityPct,
          celestialRing,
          scopeEnabled,
          scopeFeatherPct,
          scopeTerminusPct,
          mapStack,
          panelState,
          styleParams,
        } = state || {};
        // Ignore the retired 'ai-edit' style from older share links.
        if (style && style !== 'normal' && style !== 'ai-edit') {
          this.setStyle(style, { applyPreset: true, revealParameters: false, restore: true });
        }
        if (styleParams && style && this.stages[style] && STYLES[style]?.uniforms) {
          for (const [uniformName, uniformValue] of Object.entries(styleParams)) {
            if (!Object.hasOwn(STYLES[style].uniforms, uniformName)) continue;
            this.stages[style].uniforms[uniformName] = uniformValue;
          }
          this._updateSliderPanel(style, { reveal: false });
        }
        if (typeof bloomIntensity === 'number' && this._bloomSlider) {
          const intensity = decodeBloomIntensity(bloomIntensity, bloomVersion);
          this._setBloomIntensity(intensity, { syncShare: false });
        }
        if (typeof sharpenIntensity === 'number' && this._sharpenSlider) {
          const pct = Math.max(0, Math.min(100, Math.round(sharpenIntensity)));
          this._sharpenSlider.value = String(pct);
          this._sharpenSliderValue.textContent = `${pct}%`;
          this._applySharpenIntensity(pct / 100);
        }
        if (typeof bloom === 'boolean') this._setBloomEnabled(bloom);
        if (typeof sharpen === 'boolean') this._setSharpenEnabled(sharpen);
        if (hudVariant) this._setHudVariant(hudVariant);
        if (typeof hudVisible === 'boolean') {
          this.hud.setMode(hudVisible ? 'on' : 'off');
          this._updateHudButtonState();
        }
        if (typeof detectionDensity === 'number' && this._detectionDensitySlider) {
          const pct = canonicalizeDensity(detectionDensity);
          this._detectionDensitySlider.value = String(pct);
          this._detectionDensityValue.textContent = `${pct}%`;
          this._applyDetectionDensityFromUi();
        }
        if (detectionAllocation) {
          this._setDetectionAllocation(detectionAllocation, { syncShare: false, persist: false });
        }
        if (typeof detectionFadePct === 'number' && this._detectionFadeSlider) {
          this._detectionFadeSlider.value = String(detectionFadePct);
        }
        if (typeof detectionOutsideOpacityPct === 'number' && this._detectionOpacitySlider) {
          this._detectionOpacitySlider.value = String(detectionOutsideOpacityPct);
        }
        this._applyDetectionFadeFromUi();
        if (detectionMode) this._setDetectionMode(detectionMode);
        if (typeof celestialRing === 'boolean') {
          this.setCelestialRingEnabled(celestialRing, { syncShare: false, focus: false });
        }
        if (typeof scopeEnabled === 'boolean') {
          setScopeMaskEnabled(scopeEnabled);
          this._scopeBtn?.classList.toggle('active', scopeEnabled);
          this._scopeBtn?.setAttribute('aria-pressed', String(scopeEnabled));
        }
        if (typeof scopeFeatherPct === 'number' && this._scopeFeatherSlider) {
          const pct = Math.max(0, Math.min(100, Math.round(scopeFeatherPct)));
          this._scopeFeatherSlider.value = String(pct);
          if (this._scopeFeatherValue) this._scopeFeatherValue.textContent = `${pct}%`;
          setScopeMaskFeather(pct / 100);
        }
        // null restores the altitude-adaptive ramp; a number pins the terminus
        // (clamped to the supported 94..100 band, same as the `sce` hash key).
        if (scopeTerminusPct === null) setScopeTerminusOverride(null);
        else if (typeof scopeTerminusPct === 'number') {
          const pinned = clampScopeTerminusPct(scopeTerminusPct);
          setScopeTerminusOverride(pinned == null ? null : pinned / 100);
        }
        const mapStackRestore = mapStack
          ? this._setMapStack(mapStack, { syncShare: false })
          : Promise.resolve();
        if (panelState) this._restorePanelState(panelState);
        await mapStackRestore;
        this._syncShareState();
      },
      isNavigationCurrent: (generation) => generation === this._navigationGeneration,
      cancelOwnedNavigation: () => this.viewer.camera.cancelFlight(),
    });
    this.shareLinkManager.setPanelStateProvider(() => this._buildSharePanelState());
    this.shareLinkManager.setStyleParamStateProvider((styleName) => {
      const shader = STYLES[styleName];
      const stage = this.stages[styleName];
      if (!shader?.uniforms || !stage) return null;
      return Object.fromEntries(
        Object.keys(shader.uniforms).map((uniformName) => [uniformName, stage.uniforms[uniformName]]),
      );
    });
    // Parse before panel chrome initializes so every valid share URL starts
    // from deterministic markup defaults instead of recipient-local panel
    // preferences. Encoded panel fields are applied after all panels exist.
    this._initialShareState = this.shareLinkManager.parseInitialHash();

    this._detectionBtn = document.getElementById('detection-toggle');
    this._models3dBtn = document.getElementById('models3d-toggle');
    this._models3dModeRow = document.getElementById('models3d-mode-row');
    this._models3dModeBtns = [
      document.getElementById('models3d-mode-proximity'),
      document.getElementById('models3d-mode-all'),
    ];
    // DISPLAY-rail 3D-aircraft toggle (flights layer param). DEFAULT-ON in
    // PROXIMITY (owner directive 2026-08-22) — mirrors the `models3d` default in
    // layerState.js and `_models3dEnabled` in both flight layers, and the `active`
    // class the button carries in index.html. A fresh boot skips layer-state
    // restoration, so these initializers are the only thing keeping the lit
    // button and the armed layer in agreement.
    this._models3dEnabled = true;
    this._models3dMode = 'proximity'; // 'proximity' (nearest in view) | 'all' (every in-view plane)

    // The shared world-overlay host must own its one postRender lane before
    // detection and tracked-readout initialize. It stays transparent until a
    // production source explicitly registers entries.
    initWorldOverlay(viewer);

    // Initialize detection overlay BEFORE style stages so the composite
    // stage is first in the post-process pipeline
    initDetection(viewer, [trafficLayer, flightsLayer, militaryFlightsLayer, satellitesLayer, cctvLayer, bikeshareLayer, aisLiveVesselsLayer], (modeLabel) => {
      this._updateDetectionButton(modeLabel);
    });
    initTrackedReadout(viewer);
    setDetectionStyle(this.activeStyle);
    this._applyDetectionDensityFromUi();

    this._initStages();
    this._initBloomSharpen();
    this._initUI();
    this._initMapStackControl();
    this._initPanelChrome();
    this._initLeftPanelAdaptiveLayout();
    this._initRightPanelAdaptiveLayout();
    this._initRadioPanel();
    this._initCctvPanel();
    this._initGlobalContextPanel();
    this._initLocationBar();
    this._initShareButton();
    this._initClearSelectedLayersButton();
    this._initResetGlobeButton();
    this._initHUDToggle();
    this._initModels3dToggle();
    this._applyGlobalPostDefaults();
    this._initOrbit();
    this._initRecordingOverlay();
    this._startAnimationLoop();
    this._startTrafficChipTicker();
    this._updateStyleMiniStatus();
    this._updateLocationMiniStatus();

    // Restore from URL hash if present
    const savedState = this._initialShareState;
    this._initialShareRestorePromise = savedState
      ? new Promise((resolve) => { this._resolveInitialShareRestore = resolve; })
      : Promise.resolve({ status: 'not-requested', share: null, layers: [] });
    if (savedState) {
      this._hasShareState = true;
      // Reserve camera authority now; the delayed mesh-friendly flight may
      // run only if no newer user, voice, or tracking navigation has won.
      this._initialShareNavigationGeneration = this._beginDeferredNavigation(
        'shared view',
        { cancelPendingSelection: false },
      );
      this._initialShareRestoreTimeout = setTimeout(() => {
        this._initialShareRestoreTimeout = null;
        if (this._disposed) return;
        const generation = this._initialShareNavigationGeneration;
        const applyCamera = Number.isInteger(generation)
          && this._reassertNavigationHandoff(generation);
        void (async () => {
          try {
            const share = await this.shareLinkManager.applyState(savedState, {
              applyCamera,
              navigationToken: generation,
            });
            const layers = await (this._layerStateRestorePromise || Promise.resolve([]));
            const tracking = share.camera === 'applied'
              ? await this._layerStateCoordinator?.restoreShareTrackingSelection?.()
              : {
                  status: 'superseded',
                  cleared: this._layerStateCoordinator?.cancelPendingShareTracking?.(
                    'shared-camera-superseded',
                    { clearSelection: true },
                  ) === true,
                };
            this.shareLinkManager.completeInitialRestore();
            this._settleInitialShareRestore({ status: 'settled', share, layers, tracking });
          } catch (error) {
            this.shareLinkManager.completeInitialRestore();
            this._settleInitialShareRestore({
              status: 'failed',
              error: String(error?.message || error),
              share: null,
              layers: [],
            });
          }
        })();
      }, 1500);
    } else {
      this._syncShareState();
    }
    // A recipient can orbit before or during the delayed share flight. That
    // gesture keeps ordinary layer state but revokes the passive base camera
    // and selected-subject Follow so delayed work cannot seize navigation.
    this._initialShareGestureHandler = () => {
      if (
        this._disposed
        || !this._hasShareState
        || !this._resolveInitialShareRestore
      ) return;
      stampInitialShareGesture((options) => this._stampNavigation(options));
    };
    this.viewer?.canvas?.addEventListener('pointerdown', this._initialShareGestureHandler, {
      passive: true,
    });
    this.viewer?.canvas?.addEventListener('wheel', this._initialShareGestureHandler, {
      passive: true,
    });

    // Keep the parameter panel from overlapping toggle controls.
    this._layoutRightPanels();
    this._syncCctvPanelViewport();
    this._windowResizeHandler = () => {
      this._scheduleRightPanelLayout({ reconsiderAutoCollapse: true });
      this._syncCctvPanelViewport();
      this._scheduleLeftPanelLayout({ reconsiderAutoCollapse: true });
    };
    window.addEventListener('resize', this._windowResizeHandler);
    // The loading-chip ticker is stopped while the tab is hidden (it can do no
    // useful work off-screen and must not hold a 60ms timer there). Resample on
    // return so the time-driven reducer catches up on real elapsed time — and
    // re-arms its own ticker if the batch is still running.
    this._loadingVisibilityHandler = () => {
      if (!document.hidden) this._updateGlobalLoadingFeedback();
    };
    document.addEventListener('visibilitychange', this._loadingVisibilityHandler);
    this._cctvRequestFocusHandler = (event) => routeCctvFocusRequest(
      event,
      (activate, focus) => this._runExplicitCctvFocus(activate, focus),
      (cameraId, durationSec) => cctvLayer.focusCamera(cameraId, durationSec),
    );
    this._removeCctvRequestFocusListener = registerCctvFocusRequestListener(
      window,
      this._cctvRequestFocusHandler,
    );
    this._worldRequestFocusHandler = (event) => routeWorldFocusRequest(
      event,
      (detail, fly) => this._runExplicitWorldFocus(detail, fly),
      (detail) => flyToWorldTarget(this.viewer, detail),
    );
    this._removeWorldRequestFocusListener = registerWorldFocusRequestListener(
      window,
      this._worldRequestFocusHandler,
    );
    this._navigationOwnerChangedRemover = viewer.trackedEntityChanged.addEventListener((entity) => {
      if (entity && !this._disposed) this._stampNavigation({ cancelPendingSelection: false });
    });
    // Vessel/installation focus flies without ever assigning a tracked entity,
    // so it cannot reach the listener above. It announces instead.
    this._removeNavigationAuthorityListener = registerNavigationAuthorityListener(
      window,
      (event) => {
        if (this._disposed) return;
        this._stampNavigation({
          cancelPendingSelection: event?.detail?.cancelPendingSelection !== false,
        });
      },
    );
  }

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
      styleOwnsDetection: !this._detectionUserOverridden
        && Boolean(STYLE_PRESET_DEFAULTS[this.activeStyle]?.detection),
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
    if (!shareCacheNeedsHeal({
      changed: result.changed,
      hadOwnership,
      hasOwnership: Boolean(result.restore),
    })) return;
    if (result.changed) this._syncDetectionUiFromEngine();
    this._syncShareState();
  }

  /** Apply a temporary cockpit-only CRT/NVG/FLIR/NOIR post-process override. */
  _setCockpitVision(mode, active, { revealParameters = false } = {}) {
    const next = active ? normalizeCockpitVisionMode(mode) : 'optical';
    if (!this.stages) return;
    if (!active) {
      if (this._cockpitVisionRestore) {
        for (const [name, intensity] of Object.entries(this._cockpitVisionRestore)) {
          if (this.stages[name]) this._setStageIntensity(this.stages[name], intensity);
        }
      }
      this._cockpitVisionRestore = null;
      this._cockpitVisionMode = 'optical';
      this._syncIrBoost(); // Cockpit exit: fall back to the map preset's IR state
      this._updateSliderPanel(this.activeStyle, { reveal: false });
      this._revealCockpitStyleParameters({ openDisplay: revealParameters });
      return;
    }
    if (!this._cockpitVisionRestore) {
      this._cockpitVisionRestore = captureCockpitVisionBaseline(this.stages, this.transitions);
    }
    if (next === 'optical') {
      applyCockpitVisionStageIntensities(this.stages, next, this._cockpitVisionRestore);
      this._syncStagesEnabledFromIntensity();
      this._cockpitVisionMode = next;
      this._syncIrBoost();
      this._updateSliderPanel(this.activeStyle, { reveal: false });
      this._revealCockpitStyleParameters({ openDisplay: revealParameters });
      return;
    }
    const target = applyCockpitVisionStageIntensities(this.stages, next, this._cockpitVisionRestore);
    this._syncStagesEnabledFromIntensity();
    this._cockpitVisionMode = next;
    this._syncIrBoost(); // Cockpit vision override ('nvg'/'thermal' boost; CRT/NOIR clear)
    this._updateSliderPanel(target || null, { reveal: false });
    this._revealCockpitStyleParameters({ openDisplay: revealParameters });
  }

  /** IR hot-target boost (owner playtest 2026-08-16): under the luminance-
   *  mapped NVG/FLIR looks the 3D fleets flip to flat white so contacts read
   *  HOT instead of vanishing mid-gray; restored when the look exits. The
   *  EFFECTIVE look is Cockpit's vision override while Cockpit is active
   *  ('nvg'/'thermal', which can differ from the map preset in BOTH
   *  directions), otherwise the map preset ('surveillance'/'thermal'). */
  _syncIrBoost() {
    const cockpitMode = this.cockpitView?.active ? this._cockpitVisionMode : null;
    const effective = cockpitMode && cockpitMode !== 'optical' ? cockpitMode : this.activeStyle;
    const irBoost = effective === 'surveillance' || effective === 'thermal' || effective === 'nvg';
    this._dataManager?.setLayerParams('flights', { irBoost });
    this._dataManager?.setLayerParams('military', { irBoost });
    // Fog blends distant geometry toward an effectively-BLACK color in this
    // app (the Cesium globe is hidden), so beyond ~100 km every 3D aircraft
    // fogs to a black silhouette — lighting and shaders can't reach past it
    // (owner cockpit-FLIR field rounds, 2026-08-16). IR sensors see through
    // haze, so the boost styles simply turn fog off; the prior state restores
    // on exit. Transition-guarded so repeated syncs don't clobber the saved value.
    const scene = this.viewer?.scene;
    if (scene?.fog && irBoost !== this._irBoostActive) {
      this._irBoostActive = irBoost;
      if (irBoost) {
        this._irFogWasEnabled = scene.fog.enabled;
        scene.fog.enabled = false;
      } else if (this._irFogWasEnabled != null) {
        scene.fog.enabled = this._irFogWasEnabled;
        this._irFogWasEnabled = null;
      }
      scene.requestRender?.();
    }
  }

  /** Keep Cockpit's inherited label and restore target aligned with the active map preset. */
  _syncCockpitInheritedStyle() {
    if (!this.cockpitView?.active || !this.stages) return;
    this._cockpitVisionRestore = Object.fromEntries(
      Object.keys(this.stages).map((name) => [name, name === this.activeStyle ? 1 : 0]),
    );
    for (const name of Object.keys(this.stages)) this.transitions.delete(name);
    this.cockpitView.setVisionMode(this.cockpitView.visionMode);
  }

  /** Reveal shared style parameters, optionally opening Cockpit Display first. */
  _revealCockpitStyleParameters({ openDisplay = false } = {}) {
    if (!this.cockpitView?.active || !this._sliderPanel?.classList.contains('active')) return;
    if (openDisplay && this._cockpitDisplayToggleBtn?.getAttribute('aria-expanded') !== 'true') {
      this._setCockpitDisclosure?.('display', true);
      return;
    }
    if (this._cockpitDisplayToggleBtn?.getAttribute('aria-expanded') !== 'true') return;
    this._sliderPanel.classList.remove('collapsed');
    this._syncPanelCollapseButton(this._sliderPanel);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      this._sliderPanel?.scrollIntoView?.({ block: 'nearest' });
    }));
  }

  /**
   * Wires up all primary UI event listeners: style buttons, keyboard shortcuts
   * (1-8 style keys, H/O/V/F/D/C hotkeys, Escape), AI prompt input with
   * debounce, bloom/sharpen/HUD toggles, detection density slider, and
   * clean-view toggle.
   * @returns {void}
   */
  _initUI() {
    // Style buttons
    document.querySelectorAll('.style-btn').forEach(btn => {
      btn.addEventListener('click', () => this.setStyle(btn.dataset.style));
    });

    // Keyboard shortcuts: 1-7, H, Escape
    this._globalKeydownHandler = (e) => {
      // Ignore when interacting with a form control (except Escape). Global
      // hotkeys ('1'-'7', 'h', 'o', 'v', 'd', 'c', 'f') otherwise fire while a
      // <select> dropdown (e.g. HUD layout) is focused and its native
      // type-ahead is in use, or while typing in a text field (M9).
      const isFormControl = e.target?.matches?.('select, input, textarea')
        || e.target === this._locationSearch;
      if (isFormControl && e.key !== 'Escape') return;

      const keyMap = {
        '1': 'normal', '2': 'retro', '3': 'surveillance',
        '4': 'thermal', '5': 'anime', '6': 'noir',
        '7': 'snow',
      };
      if (keyMap[e.key]) this.setStyle(keyMap[e.key]);
      if (e.key === 'Escape') {
        if (this._locationSearch.classList.contains('expanded')) {
          this._locationSearch.classList.remove('expanded');
          this._locationSearch.value = '';
          this._locationSearch.blur();
        }
      }
      if (e.key.toLowerCase() === 'h') {
        this.shareLinkManager?.claimRestoreLane?.('visual');
        this.hud.toggle();
        this._updateHudButtonState();
        this._syncShareState();
      }
      if (e.key.toLowerCase() === 'o') this._toggleOrbit();
      if (e.key.toLowerCase() === 'v') this.toggleCleanView();
      if (e.key.toLowerCase() === 'f') {
        document.getElementById('data-panel').classList.toggle('active');
      }
      if (e.key.toLowerCase() === 'd') {
        this.shareLinkManager?.claimRestoreLane?.('visual');
        this._detectionUserOverridden = true;
        cycleDetectionMode();
        this._syncShareState();
      }
      if (e.key.toLowerCase() === 'c') {
        this._toggleCctvEnabled();
      }
    };
    document.addEventListener('keydown', this._globalKeydownHandler);

    // Bloom toggle
    this._bloomBtn.addEventListener('click', () => {
      this.shareLinkManager?.claimRestoreLane?.('visual');
      this._setBloomEnabled(!this.bloomEnabled);
    });

    // Bloom intensity slider
    this._bloomSlider.addEventListener('input', () => {
      this.shareLinkManager?.claimRestoreLane?.('visual');
      this._setBloomIntensity(parseInt(this._bloomSlider.value, 10));
    });

    // Sharpen toggle
    this._sharpenBtn.addEventListener('click', () => {
      this.shareLinkManager?.claimRestoreLane?.('visual');
      this._setSharpenEnabled(!this.sharpenEnabled);
    });

    // Scope mask — the explicit circular viewport treatment (owner ask:
    // standalone toggle + featherable edge; see src/scopeMask.js).
    this._scopeBtn?.addEventListener('click', () => {
      this.shareLinkManager?.claimRestoreLane?.('visual');
      const next = !isScopeMaskEnabled();
      setScopeMaskEnabled(next);
      this._scopeBtn.classList.toggle('active', next);
      this._scopeBtn.setAttribute('aria-pressed', String(next));
      this._syncShareState();
    });
    this._scopeFeatherSlider?.addEventListener('input', () => {
      this.shareLinkManager?.claimRestoreLane?.('visual');
      const pct = Math.max(0, Math.min(100, parseInt(this._scopeFeatherSlider.value, 10) || 0));
      if (this._scopeFeatherValue) this._scopeFeatherValue.textContent = `${pct}%`;
      setScopeMaskFeather(pct / 100);
      this._syncShareState();
    });

    if (this._sharpenSlider) {
      this._sharpenSlider.addEventListener('input', () => {
        this.shareLinkManager?.claimRestoreLane?.('visual');
        const pct = parseInt(this._sharpenSlider.value, 10);
        if (this._sharpenSliderValue) {
          this._sharpenSliderValue.textContent = `${pct}%`;
        }
        this._applySharpenIntensity(pct / 100);
        this._syncShareState();
      });
    }

    if (this._hudLayoutSelect) {
      this._hudLayoutSelect.addEventListener('change', () => {
        this.shareLinkManager?.claimRestoreLane?.('visual');
        this._setHudVariant(this._hudLayoutSelect.value);
      });
    }

    if (this._cleanViewBtn) {
      this._cleanViewBtn.addEventListener('click', () => this.toggleCleanView());
    }
    if (this._cleanViewExitBtn) {
      this._cleanViewExitBtn.addEventListener('click', () => this.toggleCleanView(false));
    }

    if (this._detectionDensitySlider) {
      this._detectionDensitySlider.addEventListener('input', () => {
        this.shareLinkManager?.claimRestoreLane?.('visual');
        this._detectionUserOverridden = true;
        const pct = canonicalizeDensity(this._detectionDensitySlider.value);
        this._detectionDensitySlider.value = String(pct);
        if (this._detectionDensityValue) {
          this._detectionDensityValue.textContent = `${pct}%`;
        }
        this._applyDetectionDensityFromUi();
        this._syncShareState();
      });
    }

    for (const button of this._detectionAllocationBtns) {
      button.addEventListener('click', () => {
        this.shareLinkManager?.claimRestoreLane?.('visual');
        this._detectionUserOverridden = true;
        this._setDetectionAllocation(button.dataset.allocation);
      });
    }

    for (const slider of [this._detectionFadeSlider, this._detectionOpacitySlider]) {
      slider?.addEventListener('input', () => {
        this.shareLinkManager?.claimRestoreLane?.('visual');
        this._applyDetectionFadeFromUi();
        this._syncShareState();
      });
    }

    if (this._celestialBtn) {
      this._celestialBtn.addEventListener('click', () => {
        const ringIsVisible = !!this.celestialRing?.visible;
        if (!this.celestialRingEnabled || !ringIsVisible) {
          this.setCelestialRingEnabled(true, { focus: true });
        } else {
          this.setCelestialRingEnabled(false);
        }
      });
    }
  }

  /**
   * Renders the owner-approved map stack chip row from the matching controller
   * entries. Cesium ion/Bing chips remain keyboard-focusable but unavailable,
   * with an accessible explanation, until a CESIUM_ION_TOKEN is configured.
   * @returns {void}
   */
  _initMapStackControl() {
    if (!this._mapStackChips || !this.mapStackController) return;

    if (!this._mapStackChangeHandler) {
      // Provider-driven transitions (notably Esri tile-error fallback) do not
      // pass through `_setMapStack()`. Follow the controller's existing public
      // event so the lit tile, the status line, AND the durable share state all
      // describe the rendered source — without the share sync, a silent
      // fallback leaves copyLink() encoding a stack that is no longer shown.
      this._mapStackChangeHandler = (event) => {
        this._renderMapStackState(event.detail);
        this._syncShareState();
      };
      window.addEventListener('gev:map-stack-changed', this._mapStackChangeHandler);
    }

    renderMapStackChips(this._mapStackChips, this.mapStackController.getStacks(), {
      activeId: this.mapStackController.getActiveId(),
      onSelect: (stackId) => { this._setMapStack(stackId); },
    });

    this._renderMapStackState(this.mapStackController.getState());
  }

  /**
   * Switches the active map/globe source stack.
   * @param {string} stackId - Map stack id.
   * @param {object} [options]
   * @param {boolean} [options.syncShare=true] - Whether to update the share link.
   * @returns {Promise<void>}
   */
  async _setMapStack(stackId, { syncShare = true } = {}) {
    if (!this.mapStackController) return;
    if (syncShare) this.shareLinkManager?.claimRestoreLane?.('map');
    const before = this.mapStackController.getActiveId();
    this._renderMapStackState(this.mapStackController.getState('switching'));
    const state = await this.mapStackController.setStack(stackId);
    this._renderMapStackState(state);

    if (state?.activeId === before && stackId !== before && state?.lastError) {
      this._showToast(state.lastError);
    }
    if (syncShare) this._syncShareState();
  }

  /**
   * Syncs the map stack chip row and status chip with controller state. The
   * lit chip always follows `state.activeId`, never the click — a rejected or
   * superseded switch therefore leaves the genuinely active stack lit.
   * @param {object} state - Map stack controller state.
   * @returns {void}
   */
  _renderMapStackState(state) {
    if (!state) return;
    syncMapStackChips(this._mapStackChips, state.activeId);
    if (this._mapStackStatus) {
      const stack = state.activeStack;
      const label = state.status === 'switching'
        ? '...'
        : (stack?.shortLabel || stack?.label || 'MAP');
      this._mapStackStatus.textContent = label;
      this._mapStackStatus.classList.toggle('warn', !!state.lastError);
    }
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
    if (this._detectionDensityValue) this._detectionDensityValue.textContent = `${pct}%`;
    setDetectionTuning({ densityPct: pct });
    this._updateDetectionButton(getDetectionMode());
  }

  /** Apply responsive keyhole fade controls from normalized UI percentages. */
  _applyDetectionFadeFromUi() {
    const fadePct = Math.max(0, Math.min(40, Math.round(Number(this._detectionFadeSlider?.value) || 0)));
    const outsideOpacityValue = this._detectionOpacitySlider?.value;
    const outsideOpacityPct = Math.max(
      0,
      Math.min(100, Math.round(outsideOpacityValue == null ? 3 : Number(outsideOpacityValue) || 0)),
    );
    if (this._detectionFadeSlider) this._detectionFadeSlider.value = String(fadePct);
    if (this._detectionFadeValue) this._detectionFadeValue.textContent = `${fadePct}%`;
    if (this._detectionOpacitySlider) this._detectionOpacitySlider.value = String(outsideOpacityPct);
    if (this._detectionOpacityValue) this._detectionOpacityValue.textContent = `${outsideOpacityPct}%`;
    setKeyholeFadeTuning({
      fadeRatio: fadePct / 100,
      outsideOpacity: outsideOpacityPct / 100,
    });
    this.viewer.scene.requestRender?.();
  }

  _setDetectionAllocation(strategy, { syncShare = true, persist = true } = {}) {
    const raw = String(strategy || '').trim().toUpperCase();
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
      try { localStorage.setItem(DETECTION_ALLOCATION_STORAGE_KEY, normalized); } catch { /* best effort */ }
    }
    if (syncShare) this._syncShareState();
    return true;
  }

  _syncDetectionUiFromEngine() {
    const tuning = getDetectionTuning();
    if (this._detectionDensitySlider) this._detectionDensitySlider.value = String(tuning.densityPct);
    if (this._detectionDensityValue) this._detectionDensityValue.textContent = `${tuning.densityPct}%`;
    this._setDetectionAllocation(tuning.allocationStrategy, { syncShare: false, persist: false });
    const fadeTuning = getKeyholeFadeTuning();
    if (this._detectionFadeSlider) this._detectionFadeSlider.value = String(Math.round(fadeTuning.fadeRatio * 100));
    if (this._detectionOpacitySlider) {
      this._detectionOpacitySlider.value = String(Math.round(fadeTuning.outsideOpacity * 100));
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
   * Switches the HUD layout variant (e.g. 'tactical', 'minimal') and syncs
   * the layout dropdown if present.
   * @param {string} variantName - HUD variant identifier.
   * @returns {void}
   */
  _setHudVariant(variantName) {
    if (!variantName) return;
    this.hud.setVariant(variantName);
    if (this._hudLayoutSelect && this._hudLayoutSelect.value !== this.hud.getVariant()) {
      this._hudLayoutSelect.value = this.hud.getVariant();
    }
    this._syncShareState();
    this._scheduleAdaptivePanelLayout({ settle: true });
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
      if (this._detectionDensityValue) this._detectionDensityValue.textContent = `${pct}%`;
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

  _syncShareState() {
    const detection = this._shareableDetectionState();
    this.shareLinkManager.onToggleChange(this.bloomEnabled, this.sharpenEnabled, {
      bloomIntensity: this._getBloomIntensity(),
      bloomVersion: BLOOM_SCALE_VERSION,
      sharpenIntensity: parseInt(this._sharpenSlider?.value || '49', 10),
      hudVariant: this.hud.getVariant(),
      hudVisible: this.hud.visible,
      detectionMode: detection.mode,
      detectionDensity: detection.densityPct,
      detectionAllocation: getDetectionTuning().allocationStrategy,
      detectionFadePct: parseInt(this._detectionFadeSlider?.value || '7', 10),
      detectionOutsideOpacityPct: parseInt(this._detectionOpacitySlider?.value || '1', 10),
      celestialRingEnabled: this.celestialRingEnabled,
      scopeEnabled: isScopeMaskEnabled(),
      scopeFeatherPct: Math.round(getScopeMaskFeather() * 100),
      // null when adaptive — the share layer omits `sce` entirely in that case.
      scopeTerminusPct: getScopeTerminusOverride() == null
        ? null
        : Math.round(getScopeTerminusOverride() * 100),
      mapStack: this.mapStackController?.getActiveId?.() || 'photoreal',
    });
  }

  /**
   * Updates the traffic sync status chip with loading phase label and progress.
   * Auto-hides after 1.5s when loading completes; stays visible while busy.
   * @param {boolean} [forceShow=false] - Force the chip visible regardless of busy state.
   * @returns {void}
   */
  _updateTrafficSyncChip(forceShow = false, now = performance.now()) {
    if (!this._trafficSyncChip || !this._trafficSyncLabel || !this._trafficSyncProgress) return;
    const layers = this._dataManager?.getAll?.();
    const traffic = Array.isArray(layers) ? layers.find((layer) => layer.id === 'traffic') : null;
    this._trafficSyncFeedbackState = reduceTrafficSyncFeedback(
      this._trafficSyncFeedbackState,
      { enabled: traffic?.enabled === true, stats: traffic?.stats || {}, forceShow },
      now,
    );
    const presentation = this._trafficSyncFeedbackState;
    // setSplitFlapText carries the same unchanged-text guard internally, and
    // the flap keeps textContent equal to the settled label throughout, so
    // this stays a no-op on the repeat ticks exactly as it did before.
    if (presentation.label) setSplitFlapText(this._trafficSyncLabel, presentation.label);
    // Written on every change INCLUDING the empty settled value — the reducer
    // clears the progress number once the sync lands, and a truthiness guard
    // here would strand the last "..." beside the settled label.
    if (this._trafficSyncProgress.textContent !== presentation.progressText) {
      this._trafficSyncProgress.textContent = presentation.progressText;
    }
    this._trafficSyncChip.classList.toggle('visible', presentation.visible);
  }

  _persistAwarenessSelection(event, cleared = false) {
    if (!this._dataManager) return;
    const origin = String(event?.detail?.origin || 'programmatic');
    if (!isExplicitLayerStateOrigin(origin)) return;
    const layerId = String(event?.detail?.layerId || '');
    const config = {
      flights: {
        key: 'selectedFlightsTrackingId',
        normalize: (value) => String(value ?? '').trim().toLowerCase() || null,
      },
      military: {
        key: 'selectedMilitaryTrackingId',
        normalize: (value) => String(value ?? '').trim().toLowerCase() || null,
      },
      satellites: {
        key: 'selectedSatTrackingId',
        normalize: (value) => {
          const candidate = Number(value);
          return Number.isFinite(candidate) && candidate > 0 ? Math.trunc(candidate) : null;
        },
      },
    }[layerId];
    if (!config) return;
    const selectedValue = cleared ? null : config.normalize(event?.detail?.id);
    if (cleared || selectedValue === null) {
      this._dataManager.adoptLayerParams?.(layerId, {
        [config.key]: selectedValue,
      }, { origin });
      return;
    }
    // A direct selection promotes a Context-owned tracker dependency into
    // durable visibility before its selected ID is normalized. Context exit
    // also keeps this adopted layer instead of tearing down the user's track.
    const visibilityAdopted = this._dataManager.adoptLayerVisibility?.(
      layerId,
      true,
      { origin, adoptedFromSelection: true },
    );
    if (visibilityAdopted === false) return;
    // Clear the prior family before publishing the replacement. Otherwise the
    // coordinator briefly sees two IDs and correctly treats them as an
    // ambiguous incoming state, which would discard the new durable target.
    for (const [otherLayerId, otherKey] of [
      ['flights', 'selectedFlightsTrackingId'],
      ['military', 'selectedMilitaryTrackingId'],
      ['satellites', 'selectedSatTrackingId'],
    ]) {
      if (otherLayerId === layerId) continue;
      this._dataManager.setLayerParams(otherLayerId, { [otherKey]: null }, { origin });
    }
    this._dataManager.adoptLayerParams?.(layerId, {
      [config.key]: selectedValue,
    }, { origin });
  }

  /**
   * Connects the layer data manager for traffic sync, CCTV state subscription,
   * and layer enable/disable operations.
   * @param {object|null} dataManager - The DataManager instance, or null to detach.
   * @returns {void}
   */
  attachDataManager(dataManager) {
    if (this._dataManagerBeforeDestroyUnsubscribe) {
      this._dataManagerBeforeDestroyUnsubscribe();
      this._dataManagerBeforeDestroyUnsubscribe = null;
    }
    if (this._dataManagerVisibilityGuardUnsubscribe) {
      this._dataManagerVisibilityGuardUnsubscribe();
      this._dataManagerVisibilityGuardUnsubscribe = null;
    }
    if (this._dataManagerVisibilityRequestUnsubscribe) {
      this._dataManagerVisibilityRequestUnsubscribe();
      this._dataManagerVisibilityRequestUnsubscribe = null;
    }
    this._dataManager = dataManager || null;
    this.hud.attachDataManager(this._dataManager);
    this._updateTrafficSyncChip();
    if (this._dataManagerUnsubscribe) {
      this._dataManagerUnsubscribe();
      this._dataManagerUnsubscribe = null;
    }
    if (typeof this._dataManager?.subscribe === 'function') {
      this._dataManagerUnsubscribe = this._dataManager.subscribe((change) => {
        if (String(change?.type || '').startsWith('visibility')) {
          this._handleContextLayerChange(change);
        }
        this._loadingFeedbackEvent = change;
        this._updateGlobalLoadingFeedback(performance.now());
      });
    }
    this._updateGlobalLoadingFeedback(performance.now());
    if (typeof this._dataManager?.subscribeVisibilityRequests === 'function') {
      this._dataManagerVisibilityRequestUnsubscribe = this._dataManager.subscribeVisibilityRequests((change) => {
        if (shouldCaptureContextSession(change)) {
          // This event is synchronous with intent publication, before an
          // awaited guard or Clear All can alter the rest of the layer set.
          // Manager effective visibility already includes both the new entry
          // intent and Clear's reserved OFF baseline.
          this._captureContextSessionSnapshot({ excludeLayerIds: [change.layerId] });
          if (shouldDeferContextEntryDuringClear({
            change,
            clearInFlight: Boolean(this._clearSelectedLayersPromise),
          })) {
            this._contextModeDeferredEntryIntent = {
              layerId: change.layerId,
              intentEpoch: change.intentEpoch,
              origin: change.origin,
            };
            this._contextModeEntering = 'space-missions';
            this._syncContextModeButtons();
          }
        } else if (
          change?.layerId === 'rocket-launches'
          && change.enabled === false
          && isExplicitUserIntentOrigin(change.origin, change.layerId)
        ) {
          this._contextModeDeferredEntryIntent = null;
          if (this._clearSelectedLayersPromise) {
            this._contextSessionSnapshot = null;
            this._contextModeEntering = null;
            this._syncContextModeButtons();
          }
        }
      });
    }
    if (typeof this._dataManager?.addVisibilityGuard === 'function') {
      this._dataManagerVisibilityGuardUnsubscribe = this._dataManager.addVisibilityGuard(async (change) => {
        const layerName = this._dataManager?.layers?.get(change.layerId)?.module?.name || change.layerId;
        const reason = contextLayerEnableBlockReason({
          contextMode: this._contextModeEntering || this._contextMode,
          change,
          layerName,
        });
        if (reason) return reason;
        if (
          change.enabled
          && ['military-awareness', 'rocket-launches'].includes(change.layerId)
          && shouldCaptureContextSession(change)
          && (
            !this._contextModeChanging
            || (
              change.layerId === 'rocket-launches'
              && this._contextModeDeferredEntryIntent?.intentEpoch === change.intentEpoch
            )
          )
        ) {
          const entryMode = change.layerId === 'rocket-launches' ? 'space-missions' : null;
          const deferredClearEntry = this._contextModeDeferredEntryIntent?.intentEpoch === change.intentEpoch;
          // A deferred entry owns the state after Clear settles. Restoring
          // Clear's transient busy flag here would leave Context stuck.
          const priorChanging = deferredClearEntry ? false : this._contextModeChanging;
          const notificationToken = change.notificationToken || Symbol('direct-context-shell-entry');
          const ownsNotificationToken = !change.notificationToken;
          if (ownsNotificationToken) {
            this._userFacingContextNotificationTokens.add(notificationToken);
          }
          this._contextModeEntering = entryMode;
          this._contextModeChanging = true;
          try {
            if (deferredClearEntry) {
              await this._clearSelectedLayersManagerPromise;
              if (this._contextModeDeferredEntryIntent?.intentEpoch !== change.intentEpoch) return false;
              this._contextModeDeferredEntryIntent = null;
            }
            await this._clearLayersOutsideContextMode(entryMode, { notificationToken });
          } catch (error) {
            this._contextModeEntering = null;
            console.warn(`[Context] ${change.layerId} isolation failed`, error);
            try {
              await this._restoreContextSession({
                excludeLayerIds: [change.layerId],
                notificationToken,
              });
            } catch (restoreError) {
              console.warn(`[Context] ${change.layerId} rollback failed`, restoreError);
            }
            return `${entryMode === 'space-missions' ? 'Space Missions' : 'Context'} could not start because another layer did not stop cleanly`;
          } finally {
            if (ownsNotificationToken) {
              this._userFacingContextNotificationTokens.delete(notificationToken);
            }
            settleContextModeChange(this, priorChanging);
          }
        }
        return null;
      });
    }
    if (typeof this._dataManager?.subscribeBeforeDestroy === 'function') {
      this._dataManagerBeforeDestroyUnsubscribe = this._dataManager.subscribeBeforeDestroy(async ({ layerId } = {}) => {
        if (!this._contextSessionSnapshot) return;
        await runWithContextModeChanging(this, async () => {
          this._contextMode = null;
          this.cockpitView?.exit({ restoreTracking: false });
          this._syncContextModeButtons();
          await this._restoreContextSession({ excludeLayerIds: layerId ? [layerId] : [] });
        });
      });
    }
    this._syncContextModeButtons();
    if (this._cctvUnsubscribe) {
      this._cctvUnsubscribe();
      this._cctvUnsubscribe = null;
    }
    if (typeof cctvLayer.subscribe === 'function') {
      this._cctvUnsubscribe = cctvLayer.subscribe((state) => {
        this._renderCctvState(state);
      });
    }
    if (typeof cctvLayer.getUIState === 'function') {
      this._renderCctvState(cctvLayer.getUIState());
    }
    if (this._radioUnsubscribe) {
      this._radioUnsubscribe();
      this._radioUnsubscribe = null;
    }
    if (typeof radioLayer.subscribe === 'function') {
      this._radioUnsubscribe = radioLayer.subscribe((state) => {
        this._renderRadioState(state);
      });
    }
    if (!this._awarenessSelectedHandler) {
      this._awarenessSelectedHandler = (event) => this._persistAwarenessSelection(event, false);
      this._awarenessClearedHandler = (event) => this._persistAwarenessSelection(event, true);
      window.addEventListener('gev:awareness-subject-selected', this._awarenessSelectedHandler);
      window.addEventListener('gev:awareness-subject-cleared', this._awarenessClearedHandler);
    }
    this._layerStateCoordinator?.destroy();
    this._layerStateCoordinator = null;
    this._layerStateRestorePromise = null;
    if (this._dataManager) {
      this._layerStateCoordinator = new LayerStateCoordinator(
        this._dataManager,
        this.shareLinkManager,
        {
          onDurableStateChange: (state) => this._syncModels3dFromLayerState(state),
          onTrackingRestoreStatus: (result) => this._handleShareTrackingRestoreStatus(result),
        },
      );
      this._layerStateRestorePromise = this._layerStateCoordinator.start({
        shareLayerState: this._initialShareState?.layerState || null,
        shareCreatedAtMs: this._initialShareState?.sharedAtMs ?? null,
        // Any valid camera/style share isolates recipient-local preferences,
        // including legacy and malformed-v2 layer payloads.
        allowLocalState: !this._initialShareState,
      });
      if (this._initialShareSelectionSuperseded) {
        this._layerStateCoordinator.cancelPendingShareTracking(
          'superseded-before-layer-coordinator-start',
          { clearSelection: true },
        );
      }
      void this._layerStateRestorePromise.then(() => {
        this._syncModels3dFromLayerState(this._layerStateCoordinator?.getDurableState());
      });
    }
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
    if (result.classification === 'followed' || result.classification === 'cancelled') return;
    // A stale terminal result must never replace a newer target's acquisition.
    if (this._shareTrackingAcquiringKey) return;
    const noticeGeneration = ownsAcquiringNotice
      ? this._shareTrackingNoticeGeneration
      : ++this._shareTrackingNoticeGeneration;
    const subject = result.label || 'entity';
    const message = result.classification === 'expired'
      ? `Shared ${subject} follow expired`
      : result.classification === 'source-unavailable'
        ? `Shared ${subject} could not be restored — feed unavailable`
        : `Shared ${subject} is unavailable`;
    const showAfterStartupCover = () => {
      requestAnimationFrame(() => {
        if (!canPresentDeferredStatusNotice(
          noticeGeneration,
          this._shareTrackingNoticeGeneration,
          this._disposed,
        )) return;
        const startupCover = document.getElementById('loading-screen');
        if (!startupCover || getComputedStyle(startupCover).visibility === 'hidden') {
          this._showGlobalStatusNotice(message);
          return;
        }
        let fallbackTimer = null;
        const showOnce = () => {
          startupCover.removeEventListener('transitionend', showOnce);
          if (fallbackTimer) clearTimeout(fallbackTimer);
          if (canPresentDeferredStatusNotice(
            noticeGeneration,
            this._shareTrackingNoticeGeneration,
            this._disposed,
          )) this._showGlobalStatusNotice(message);
        };
        startupCover.addEventListener('transitionend', showOnce, { once: true });
        fallbackTimer = setTimeout(showOnce, 1000);
      });
    };
    if (this._resolveInitialShareRestore) {
      void this.initialRestorePromise.then(showAfterStartupCover);
      return;
    }
    showAfterStartupCover();
  }

  _initGlobalContextPanel() {
    const contextTabs = [this._globalContextFlightsBtn, this._globalContextMissionsBtn].filter(Boolean);
    contextTabs.forEach((tab, index) => tab.addEventListener('keydown', (event) => {
      let nextIndex = null;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % contextTabs.length;
      else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + contextTabs.length) % contextTabs.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = contextTabs.length - 1;
      if (nextIndex === null) return;
      event.preventDefault();
      contextTabs[nextIndex].focus({ preventScroll: true });
      contextTabs[nextIndex].click();
    }));
    this._globalContextFlightsBtn?.addEventListener('click', () => {
      if (this._contextModeChanging || this._clearSelectedLayersPromise) return;
      const nextMode = this._contextMode === 'flights' ? null : 'flights';
      this._claimContextVisualAuthority();
      void this._runUserFacingContextAction(
        (notificationToken) => this._selectContextMode(
          nextMode,
          { notificationToken },
        ),
        'Contacts could not complete the requested transition; try again',
      ).then((succeeded) => {
        if (nextMode && shouldExpandGlobalContextPanel({
          action: 'contacts',
          explicitUserAction: true,
          succeeded: succeeded === true,
        })) this.setPanelCollapsed('global-context-panel', false, { explicit: true });
      });
    });
    this._globalContextMissionsBtn?.addEventListener('click', () => {
      if (this._contextModeChanging || this._clearSelectedLayersPromise) return;
      const nextMode = this._contextMode === 'space-missions' ? null : 'space-missions';
      this._claimContextVisualAuthority();
      void this._runUserFacingContextAction(
        (notificationToken) => this._selectContextMode(
          nextMode,
          { notificationToken },
        ),
        'Space Missions could not complete the requested transition; try again',
      ).then((succeeded) => {
        if (nextMode && shouldExpandGlobalContextPanel({
          action: 'space-missions',
          explicitUserAction: true,
          succeeded: succeeded === true,
        })) this.setPanelCollapsed('global-context-panel', false, { explicit: true });
      });
    });
    this._installationsSearchBtn?.addEventListener('click', () => {
      if (!this._dataManager?.layers?.has('military-installations')) return;
      const button = this._installationsSearchBtn;
      if (button.getAttribute('aria-busy') === 'true') return;
      button.setAttribute('aria-disabled', 'true');
      button.setAttribute('aria-busy', 'true');
      void this._runUserFacingContextAction(async (notificationToken) => {
        const enabled = await this._dataManager.setEnabled('military-installations', true, {
          origin: 'user',
          notificationToken,
        });
        if (enabled === false || !this._dataManager.isEnabled('military-installations')) return false;
        const searched = await militaryInstallationsLayer.searchNearby?.();
        if (searched === false) return false;
        const stats = militaryInstallationsLayer.getStats?.();
        this._showToast(stats?.statusMessage || (stats?.status === 'zoom-in'
          ? 'Zoom in to search mapped installations'
          : 'Nearby installations refreshed'));
        return true;
      }, 'Nearby installations could not be refreshed; try again').finally(() => {
        button.setAttribute('aria-disabled', 'false');
        button.setAttribute('aria-busy', 'false');
      });
    });
  }

  async _runUserFacingContextAction(
    operation,
    message = 'Context could not restore every layer; try again',
    { falseIsFailure = true } = {},
  ) {
    const notificationToken = Symbol('user-facing-context-action');
    this._userFacingContextNotificationTokens.add(notificationToken);
    try {
      return await settleUserFacingContextAction({
        operation: () => operation(notificationToken),
        falseIsFailure,
        onFailure: (error) => {
          console.warn('[Context] user-facing transition failed', error);
          this._showToast(message);
        },
      });
    } finally {
      this._userFacingContextNotificationTokens.delete(notificationToken);
    }
  }

  _trackContextLayerReaction(promise) {
    const tracked = Promise.resolve(promise);
    this._contextLayerReactionPromises.add(tracked);
    void tracked.finally(() => this._contextLayerReactionPromises.delete(tracked));
    return tracked;
  }

  async _waitForContextLayerSettlement() {
    while (this._contextLayerReactionPromises.size > 0) {
      await Promise.allSettled([...this._contextLayerReactionPromises]);
    }
  }

  _captureContextSessionSnapshot({ excludeLayerIds = [] } = {}) {
    if (!this._dataManager || this._contextSessionSnapshot) return;
    const params = {};
    for (const layerId of ['military-awareness', 'satellites']) {
      const value = this._dataManager.getLayerParams(layerId);
      if (value) params[layerId] = value;
    }
    this._contextSessionSnapshot = {
      enabledLayerIds: contextSnapshotLayerIds(
        this._dataManager.getEnabledLayerIds(),
        this._contextRestoreState?.enabledLayerIds,
        excludeLayerIds,
      ),
      userAdded: new Set(),
      userRemoved: new Set(),
      params,
    };
  }

  async _restoreContextSession({
    excludeLayerIds = [],
    notificationToken = null,
    signal = null,
  } = {}) {
    const snapshot = this._contextSessionSnapshot;
    if (!snapshot || !this._dataManager) return;
    // Clear the stored session before emitting restore notifications so none
    // of those transitions can be mistaken for a fresh Context entry.
    this._contextSessionSnapshot = null;
    const restoreState = {
      enabledLayerIds: contextRestoreLayerIds(snapshot),
      explicitLayerStates: new Map(),
    };
    this._contextRestoreState = restoreState;
    for (const [layerId, params] of Object.entries(snapshot.params)) {
      this._dataManager.setLayerParams(layerId, params);
    }
    let restoreError = null;
    const restoreSnapshot = async (restoreSignal = null) => {
      // Contacts owns the dependency intents it starts. Settle that
      // coordinator before restoring the remaining snapshot, otherwise its
      // dependency releases can supersede the restore's same-target requests
      // and make a valid Contacts-to-Missions handoff look like a failure.
      const contactsCoordinatorId = 'military-awareness';
      const settleContactsCoordinator = !restoreState.enabledLayerIds.has(contactsCoordinatorId)
        && this._dataManager.isEffectivelyEnabled(contactsCoordinatorId);
      if (settleContactsCoordinator) {
        const coordinatorSettled = await this._dataManager.setEnabled(
          contactsCoordinatorId,
          false,
          {
            origin: 'context-restore',
            ...(notificationToken ? { notificationToken } : {}),
            ...(restoreSignal ? { signal: restoreSignal } : {}),
          },
        );
        if (coordinatorSettled === false) {
          const error = new Error('Failed to settle Contacts before restoring Context');
          error.failedLayerIds = [contactsCoordinatorId];
          throw error;
        }
      }
      await this._dataManager.restoreEnabledLayerIds(restoreState.enabledLayerIds, {
        origin: 'context-restore',
        excludeLayerIds: settleContactsCoordinator
          ? [...excludeLayerIds, contactsCoordinatorId]
          : excludeLayerIds,
        notificationToken,
        ...(restoreSignal ? { signal: restoreSignal } : {}),
      });
    };
    try {
      await restoreSnapshot(signal);
    } catch (error) {
      restoreError = error;
      // A caller abort can arrive after only part of the exact restore has
      // settled. Finish that same target without the stale caller signal while
      // this restoreState still records newer explicit intents; replay below
      // then gives those newer intents final authority.
      if (signal?.aborted && !restoreState.cancelled) {
        try {
          await restoreSnapshot(null);
          restoreError = null;
        } catch (compensationError) {
          restoreError = mergeContextTransitionErrors(restoreError, compensationError);
        }
      }
    } finally {
      if (this._contextRestoreState === restoreState) this._contextRestoreState = null;
    }
    // Clear Selected Layers owns a newer global OFF intent. A restore that was
    // already awaiting lifecycle work must not replay its captured companion
    // intent or recreate the discarded session after Clear invalidates it.
    if (restoreState.cancelled) return;
    // A direct Radio command may finish after restore has already copied its
    // target and queued the opposite state. Replay that newer intent only
    // after the stale queue drains; the replay origin cannot recurse here.
    const replaySignal = signal?.aborted ? null : signal;
    const replayError = await settleContextIntentReplay({
      restoreState,
      setEnabled: (layerId, enabled, options = {}) => this._dataManager.setEnabled(
        layerId,
        enabled,
        { ...options, ...(replaySignal ? { signal: replaySignal } : {}) },
      ),
      notificationToken,
    });
    restoreError = mergeContextTransitionErrors(restoreError, replayError);
    if (restoreError && !this._contextSessionSnapshot) {
      // Keep the exact still-pending target so a later exit/teardown can retry
      // instead of silently losing the user's pre-Context layer state.
      this._contextSessionSnapshot = {
        enabledLayerIds: new Set(restoreState.enabledLayerIds),
        userAdded: new Set(),
        userRemoved: new Set(),
        params: snapshot.params,
      };
    }
    if (restoreError) throw restoreError;
  }

  /*
   * Cross-mode cancellation and failure deliberately settle on Context OFF.
   *
   * A reinstatement transaction lived here for three review rounds and was
   * removed on purpose. Restoring the prior mode is genuinely racy: the prior
   * mode has to be read before the teardown, but a second request arriving
   * while the first reinstatement is mid-activation reads `_contextMode` as
   * null and inherits nothing, so two overlapping cancellations still land on
   * OFF — and the only fix is a cross-transaction "logical prior mode" chain,
   * which is new shared mutable state read while an earlier transaction is
   * still awaiting. That trades a rare wrong resting state for a permanent
   * interleaving hazard.
   *
   * The defect that started this was the LIE, not the OFF: the transition
   * claimed to have cancelled cleanly while silently leaving Context off. So
   * the resting state stays OFF and is REPORTED as such, with the failed layer
   * ids preserved. A restore feature can be rebuilt post-launch on the
   * generation discipline the surrounding transaction already follows.
   */

  async _restoreContextSessionAfterLayerSettles(layerId, { notificationToken = null } = {}) {
    await this._dataManager?.waitForLayerSettled?.(layerId);
    return this._restoreContextSession({ notificationToken });
  }

  /**
   * Claim the visual restore lane for an explicit Context transition.
   *
   * Contacts OWNS detection while active (forced Dense @ 75%), so entering or
   * leaving it is a visual-lane gesture exactly like the HUD or detection
   * controls. Without this claim, the shared-view restore that lands 1.5 s into
   * startup re-applied the link's `dm`/`dd` over the forced preset and Contacts
   * lost its own overlay mid-session.
   *
   * Deliberately does NOT set `_detectionUserOverridden`: that flag means the
   * OPERATOR hand-edited detection and suppresses the military-style
   * auto-enable for the rest of the session. Context entry is not that, and
   * conflating them would silently disable a separate landed behavior.
   *
   * Call only for VALIDATED explicit transitions — never for programmatic or
   * restore-driven ones, which must stay eligible for the shared visual state.
   */
  _claimContextVisualAuthority() {
    this.shareLinkManager?.claimRestoreLane?.('visual');
  }

  async _selectContextMode(mode, { notificationToken = null, signal = null } = {}) {
    if (!this._dataManager) return false;
    if (this._clearSelectedLayersPromise) return false;
    this._contextTransitionFailedLayerIds = [];
    const generation = ++this._contextModeGeneration;
    const isCurrent = () => generation === this._contextModeGeneration;
    this._contextModeEntryIntent = null;
    this._contextModeReplacementIntent = null;
    this._contextModeChanging = true;
    this._syncContextModeButtons();
    try {
      if (mode !== 'flights' && this.cockpitView?.active) {
        this.cockpitView.exit({ restoreTracking: false });
      }
      if (!mode) {
        this._contextMode = null;
        this._syncContextModeButtons();
        await this._restoreContextSession({ notificationToken, signal });
        return isCurrent();
      }
      // A cross-mode switch dismantles the prior mode BEFORE the new one is
      // committed. If the caller aborts in that window the switch never lands,
      // and the resting state is Context OFF — reported as such by
      // setContextMode rather than dressed up as a clean cancellation. See the
      // note above _restoreContextSessionAfterLayerSettles.
      const crossModeSwitch = Boolean(this._contextMode && this._contextMode !== mode);
      if (crossModeSwitch) {
        this._contextMode = null;
        await this._restoreContextSession({ notificationToken, signal });
        if (!isCurrent()) return false;
        if (signal?.aborted) return false;
      }
      this._captureContextSessionSnapshot();
      this._contextMode = mode;
      this._syncContextModeButtons();
      // Replay isolation must settle before Space Missions starts. Contacts
      // keeps its non-dependency teardown in the background so slow source
      // shutdown does not delay cockpit entry.
      try {
        await this._clearLayersOutsideContextMode(mode, { notificationToken, signal });
      } catch (error) {
        if (!isCurrent()) return false;
        let transitionError = error;
        console.warn(`[Context] ${mode} isolation failed`, error);
        this._contextMode = null;
        this._syncContextModeButtons();
        try {
          await this._restoreContextSession({ notificationToken });
        } catch (restoreError) {
          transitionError = mergeContextTransitionErrors(transitionError, restoreError);
          this._contextTransitionFailedLayerIds = [...(transitionError.failedLayerIds || [])];
          throw transitionError;
        }
        this._contextTransitionFailedLayerIds = [...(transitionError?.failedLayerIds || [])];
        return false;
      }
      if (!isCurrent()) return false;
      // Entry is one transaction: isolation succeeded above, so a failed mode
      // activation must roll the cleared layers back instead of stranding the
      // user in a half-entered mode with an orphaned snapshot.
      const entryLayerId = mode === 'flights' ? 'military-awareness' : 'rocket-launches';
      if (mode === 'flights') {
        this._dataManager.setLayerParams('military-awareness', { passive: false });
      }
      let activated = false;
      let activationError = null;
      let activationIntent = null;
      let terminalIntentOutcome = null;
      try {
        activationIntent = this._dataManager._setEnabledWithIntent(
          entryLayerId,
          true,
          { notificationToken, ...(signal ? { signal } : {}) },
        );
        this._contextModeEntryIntent = {
          generation,
          layerId: entryLayerId,
          intentEpoch: activationIntent.intentEpoch,
        };
        activated = await activationIntent.promise;
        terminalIntentOutcome = await this._dataManager._waitForVisibilityIntent?.(
          entryLayerId,
          activationIntent.intentEpoch,
        );
      } catch (error) {
        activationError = error;
      }
      if (!isCurrent()) return false;
      let replacementIntent = mode === 'space-missions'
        && this._contextModeReplacementIntent?.generation === generation
        && this._contextModeReplacementIntent.layerId === entryLayerId
        ? this._contextModeReplacementIntent
        : null;
      while (replacementIntent) {
        const outcome = await this._dataManager._waitForVisibilityIntent?.(
          entryLayerId,
          replacementIntent.intentEpoch,
        );
        terminalIntentOutcome = outcome;
        if (!isCurrent()) return false;
        const replacementOwnsMode = outcome?.intentEpoch === replacementIntent.intentEpoch
          && outcome.enabled === true
          && outcome.succeeded === true;
        if (replacementOwnsMode) {
          this._contextModeEntering = null;
          this._contextModeEntryIntent = null;
          this._contextModeReplacementIntent = null;
          this._syncContextModeButtons();
          return true;
        }
        const successorEpoch = outcome?.cancellationReason === 'superseded'
          && outcome.successorEnabled === true
          && Number.isInteger(outcome.successorIntentEpoch)
          && outcome.successorIntentEpoch > replacementIntent.intentEpoch
          ? outcome.successorIntentEpoch
          : null;
        replacementIntent = successorEpoch === null ? null : {
          generation,
          layerId: entryLayerId,
          intentEpoch: successorEpoch,
        };
      }
      if (activationError || activated === false || !this._dataManager.isEnabled(entryLayerId)) {
        const cancelledAndSettled = terminalIntentOutcome?.succeeded === false
          && ['caller-abort', 'resource-abort', 'superseded'].includes(
            terminalIntentOutcome.cancellationReason,
          );
        let transitionError = null;
        if (!cancelledAndSettled) {
          transitionError = activationError instanceof Error
            ? activationError
            : new Error(`Context activation failed for: ${entryLayerId}`);
          transitionError.failedLayerIds = [...new Set([
            ...(transitionError.failedLayerIds || []),
            entryLayerId,
          ])];
          this._contextTransitionFailedLayerIds = [...transitionError.failedLayerIds];
          console.warn(`[Context] ${mode} activation failed; restoring previous layers`, activationError || 'not enabled');
        }
        this._contextMode = null;
        this._contextModeEntryIntent = null;
        this._contextModeReplacementIntent = null;
        this._syncContextModeButtons();
        try {
          await this._restoreContextSession({
            excludeLayerIds: [entryLayerId],
            notificationToken,
          });
        } catch (restoreError) {
          transitionError = mergeContextTransitionErrors(transitionError, restoreError);
          this._contextTransitionFailedLayerIds = [...(transitionError?.failedLayerIds || [])];
          throw transitionError;
        }
        // `null` means the requested entry was cancelled and its exact rollback
        // completed. The action wrapper treats that as a silent non-commit,
        // while callers still require literal `true` before expanding Context.
        return cancelledAndSettled ? null : false;
      }
      this._contextModeEntryIntent = null;
      return true;
    } finally {
      if (isCurrent()) {
        this._contextModeChanging = false;
        this._syncContextModeButtons();
      }
    }
  }

  async _deactivateContextForLayerChange({ notificationToken = null } = {}) {
    this._contextModeGeneration += 1;
    this._contextModeChanging = true;
    this._contextMode = null;
    this._contextModeEntryIntent = null;
    this._contextModeReplacementIntent = null;
    if (this.cockpitView?.active) this.cockpitView.exit({ restoreTracking: false });
    this._syncContextModeButtons();
    try {
      await this._restoreContextSession({ notificationToken });
    } finally {
      this._contextModeChanging = false;
      this._syncContextModeButtons();
    }
  }

  async _clearLayersOutsideContextMode(
    mode = null,
    { notificationToken = null, signal = null } = {},
  ) {
    const allowed = contextAllowedLayerIds(mode);
    const pending = [];
    for (const [layerId] of this._dataManager.layers || []) {
      // Effective visibility: a disallowed layer still mid-ENABLING must be
      // isolated too, or it settles ON inside the exclusive mode.
      if (!allowed.has(layerId) && this._dataManager.isEffectivelyEnabled(layerId)) {
        pending.push({
          layerId,
          transition: this._dataManager.setEnabled(layerId, false, {
            notificationToken,
            ...(signal ? { signal } : {}),
          }),
        });
      }
    }
    const results = await Promise.all(pending.map(({ transition }) => transition));
    const failed = pending
      .filter(({ layerId }, index) => results[index] === false || this._dataManager.isEnabled(layerId))
      .map(({ layerId }) => layerId);
    if (failed.length > 0) {
      const error = new Error(`Context isolation failed for: ${failed.join(', ')}`);
      error.failedLayerIds = failed;
      throw error;
    }
  }

  _handleContextLayerChange(change) {
    if (change?.layerId === 'radio' && [
      'visibility-transition',
      'visibility',
      'visibility-cancelled',
      'visibility-failed',
    ].includes(change.type)) {
      this._renderRadioState(radioLayer.getUIState());
    }
    if (change?.type === 'visibility-transition') return;
    // The effective mode must be read BEFORE the entering flag is cleared:
    // the entry layer's own enable event is the one that clears it, and the
    // session bookkeeping below needs to know a mode was being entered.
    const effectiveContextMode = this._contextModeEntering || this._contextMode;
    if (change?.type === 'visibility-cancelled') {
      const cancellationDisposition = spaceMissionEntryCancellationDisposition({
        change,
      });
      if (
        this._contextModeDeferredEntryIntent?.layerId === change.layerId
        && this._contextModeDeferredEntryIntent.intentEpoch === change.intentEpoch
      ) {
        if (cancellationDisposition !== 'replacement') {
          this._contextModeDeferredEntryIntent = null;
        }
      }
      if (cancellationDisposition === 'replacement') {
        this._contextModeEntering = 'space-missions';
        const entryIntent = this._contextModeEntryIntent;
        if (
          entryIntent?.generation === this._contextModeGeneration
          && entryIntent.layerId === change.layerId
          && entryIntent.intentEpoch === change.intentEpoch
        ) {
          this._contextModeReplacementIntent = {
            generation: entryIntent.generation,
            layerId: change.layerId,
            intentEpoch: change.successorIntentEpoch,
          };
        }
      } else if (cancellationDisposition === 'restore') {
        this._contextModeEntering = null;
        this._contextModeEntryIntent = null;
        this._contextModeReplacementIntent = null;
        if (this._contextSessionSnapshot && !this._contextModeChanging) {
          this._contextMode = null;
          void this._trackContextLayerReaction(this._runUserFacingContextAction(
            async (notificationToken) => {
              await this._restoreContextSessionAfterLayerSettles(
                change.layerId,
                { notificationToken },
              );
              return true;
            },
            'Space Missions cancellation could not restore the previous layer state',
          ));
        }
      }
      this._syncContextModeButtons();
      return;
    }
    if (
      change?.layerId === 'rocket-launches'
      && ['visibility', 'visibility-blocked', 'visibility-failed'].includes(change.type)
    ) {
      this._contextModeEntering = null;
    }
    if (change?.type === 'visibility-blocked') {
      if (!this._userFacingContextNotificationTokens.has(change.notificationToken)) {
        this._showToast(change.reason || 'That layer is unavailable in the current Context mode');
      }
      this._syncContextModeButtons();
      return;
    }
    if (change?.type === 'visibility-failed') {
      const failureMessage = `${change.layerId} could not ${change.enabled ? 'start' : 'stop'} cleanly`;
      // A failed direct Context-shell START has already had its siblings
      // cleared by the visibility guard. Wait outside the synchronous manager
      // notification for this queue to settle, then reconcile the complete
      // snapshot, including an uncertain failed shell.
      const needsDeferredShellRestore = (
        ['military-awareness', 'rocket-launches'].includes(change.layerId)
        && change.enabled
        && this._contextSessionSnapshot
        && !this._contextModeChanging
      );
      if (needsDeferredShellRestore) {
        this._contextMode = null;
        void this._trackContextLayerReaction(this._runUserFacingContextAction(
          async (notificationToken) => {
            await this._restoreContextSessionAfterLayerSettles(
              change.layerId,
              { notificationToken },
            );
            // The wrapper owns failure announcements. On a successful rollback
            // announce the original activation failure here so the same direct
            // action still produces exactly one accessible notification.
            this._showToast(failureMessage);
            return true;
          },
          failureMessage,
        ));
      } else if (!this._userFacingContextNotificationTokens.has(change.notificationToken)) {
        this._showToast(failureMessage);
      }
      this._syncContextModeButtons();
      return;
    }
    if (change?.type === 'visibility-will-change') {
      // Explicit entry capture happens on the synchronous visibility-requested
      // boundary. Keeping this later branch side-effect free prevents an
      // awaited Clear/guard from replacing that authoritative pre-entry view.
      return;
    }
    // Session bookkeeping must run BEFORE any exit path below: the exit
    // handlers restore `snapshot ∪ userAdded`, so a stale entry here becomes
    // a layer resurrected against the user's explicit disable.
    recordContextSessionUserChange({
      snapshot: this._contextSessionSnapshot,
      change,
      effectiveContextMode,
    });
    recordContextRestoreExplicitChange({
      restoreState: this._contextRestoreState,
      change,
    });
    if (shouldExitContextForLayerChange({
      contextMode: this._contextMode,
      globalContextEnabled: !!this._dataManager?.isEnabled('military-awareness'),
      change,
    })) {
      void this._trackContextLayerReaction(this._runUserFacingContextAction((notificationToken) => (
        this._deactivateContextForLayerChange({ notificationToken })
      )));
      return;
    }
    if (!this._contextModeChanging) {
      if (change.layerId === 'military-awareness') {
        // The coordinator remains manager-addressable for restoration and
        // programmatic routes, but Contacts is selected only from the
        // dedicated right-side Global Context chooser.
        this._contextMode = change.enabled
          ? null
          : (this._contextMode === 'flights' ? null : this._contextMode);
        if (change.enabled) {
          this._syncContextModeButtons();
        } else if (this._contextSessionSnapshot) {
          void this._trackContextLayerReaction(this._runUserFacingContextAction((notificationToken) => (
            this._deactivateContextForLayerChange({ notificationToken })
          )));
        }
      } else if (change.layerId === 'rocket-launches') {
        const ownsContextEntry = isExplicitUserIntentOrigin(change.origin, change.layerId)
          || this._contextMode === 'space-missions'
          || effectiveContextMode === 'space-missions';
        if (!ownsContextEntry) return;
        this._contextMode = change.enabled ? 'space-missions' : (this._contextMode === 'space-missions' ? null : this._contextMode);
        if (change.enabled) {
          this._syncContextModeButtons();
        } else if (this._contextSessionSnapshot) {
          void this._trackContextLayerReaction(this._runUserFacingContextAction((notificationToken) => (
            this._deactivateContextForLayerChange({ notificationToken })
          )));
        }
      } else if (
        this._contextMode === 'flights'
        && ['flights', 'military', 'ais-live-vessels', 'military-installations'].includes(change.layerId)
        && !change.enabled
      ) {
        void this._trackContextLayerReaction(this._runUserFacingContextAction((notificationToken) => (
          this._deactivateContextForLayerChange({ notificationToken })
        )));
      }
    }
    if (this.cockpitView?.active && !cockpitEntryAllowed({
      contextMode: this._contextMode,
      contextModeChanging: this._contextModeChanging,
      flightsEnabled: !!this._dataManager?.isEnabled('flights'),
      militaryEnabled: !!this._dataManager?.isEnabled('military'),
    })) {
      this.cockpitView.exit({ restoreTracking: false });
    }
    this._syncContextModeButtons();
  }

  _syncContextModeButtons() {
    const flightsActive = this._contextMode === 'flights';
    const missionsActive = this._contextMode === 'space-missions';
    const panel = document.getElementById('global-context-panel');
    panel?.classList.toggle('context-enabled', flightsActive || missionsActive);
    panel?.setAttribute('data-context-mode', this._contextMode || 'none');
    this._globalContextFlightsBtn?.classList.toggle('active', flightsActive);
    this._globalContextFlightsBtn?.setAttribute('aria-selected', String(flightsActive));
    this._globalContextMissionsBtn?.classList.toggle('active', missionsActive);
    this._globalContextMissionsBtn?.setAttribute('aria-selected', String(missionsActive));
    const transitionBusy = Boolean(this._contextModeChanging);
    // Both Context choices stay in the ordinary Tab sequence. Arrow keys still
    // provide tablist navigation, but must not be the only way to reach Space
    // Missions from the keyboard. Semantic busy state keeps them perceivable
    // while synchronous click guards prevent a second transition.
    for (const button of [this._globalContextFlightsBtn, this._globalContextMissionsBtn]) {
      if (!button) continue;
      button.disabled = false;
      button.tabIndex = 0;
      button.setAttribute('aria-disabled', String(transitionBusy));
      button.setAttribute('aria-busy', String(transitionBusy));
    }
    if (this._contextModeStandby) this._contextModeStandby.hidden = flightsActive || missionsActive;
    if (this._contextFlightsView) this._contextFlightsView.hidden = !flightsActive;
    if (this._contextMissionsView) this._contextMissionsView.hidden = !missionsActive;
    this.cockpitView?.syncEntry();
    // Every _contextMode mutation funnels through here; the sync no-ops until
    // the transaction settles, so this is the activation/deactivation edge.
    this._syncContactsDetection();
    this._scheduleRightPanelLayout();
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
      if (spec.pinnable) entry.pinned = panelEl.classList.contains('dock-pinned');
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
      const nextCollapsed = state.pinned && spec.pinnable ? false : state.collapsed;
      this.setPanelCollapsed(spec.id, nextCollapsed, {
        restore: true,
        persist: false,
        syncShare: false,
      });
    }
    this.shareLinkManager?.onPanelStateChange?.();
  }

  /**
   * Toggles "clean view" mode which hides all UI panels via a CSS body class.
   * @param {boolean} [forceEnabled] - Explicit on/off. Omit to toggle.
   * @returns {void}
   */
  toggleCleanView(forceEnabled) {
    const shouldEnable = typeof forceEnabled === 'boolean'
      ? forceEnabled
      : !document.body.classList.contains('ui-clean-view');
    document.body.classList.toggle('ui-clean-view', shouldEnable);
    if (this._cleanViewBtn) {
      this._cleanViewBtn.classList.toggle('active', shouldEnable);
    }
    this._scheduleLeftPanelLayout();
  }

  // ── Public control facade ──────────────────────────────────────────────
  // Deliberate API for voice tools and scripting. Every setter keeps the DOM
  // sliders, share-link state, and scene snapshots in sync, and returns
  // { ok, ...resultingState } so callers confirm only what actually happened.

  /**
   * Sets HUD visibility mode. 'auto' restores style-driven show/hide.
   * @param {'on'|'off'|'auto'} mode - Visibility mode.
   * @returns {{ok: boolean, visible?: boolean, layout?: string, error?: string}}
   */
  setHudVisible(mode) {
    const normalized = String(mode ?? '').toLowerCase();
    if (!['on', 'off', 'auto'].includes(normalized)) {
      return { ok: false, error: `Unknown HUD visibility mode: ${mode}` };
    }
    this.shareLinkManager?.claimRestoreLane?.('visual');
    this.hud.setMode(normalized);
    this._updateHudButtonState();
    this._syncShareState();
    return { ok: true, visible: !!this.hud.visible, mode: normalized, layout: this.hud.getVariant() };
  }

  /**
   * Switches the HUD layout variant.
   * @param {'tactical'|'operator'|'minimal'} variantName - Layout variant.
   * @returns {{ok: boolean, layout?: string, visible?: boolean, error?: string}}
   */
  setHudLayout(variantName) {
    const variant = String(variantName ?? '').toLowerCase();
    if (!['tactical', 'operator', 'minimal'].includes(variant)) {
      return { ok: false, error: `Unknown HUD layout: ${variantName}` };
    }
    this.shareLinkManager?.claimRestoreLane?.('visual');
    this._setHudVariant(variant);
    return { ok: true, layout: this.hud.getVariant(), visible: !!this.hud.visible };
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
      outsideOpacityPct: parseInt(this._detectionOpacitySlider?.value || '0', 10),
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
  setDetection({ enabled, mode, densityPct, allocationStrategy, fadePct, outsideOpacityPct } = {}) {
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return { ok: false, error: `Invalid detection enabled value: ${enabled}`, ...this.getDetectionState() };
    }
    let requestedProfile = null;
    if (typeof mode === 'string' && mode.trim()) {
      requestedProfile = normalizeProfile(mode);
      if (!requestedProfile) {
        return { ok: false, error: `Unknown detection mode: ${mode}`, ...this.getDetectionState() };
      }
    }
    let requestedDensity = null;
    if (densityPct != null) {
      if (!Number.isFinite(Number(densityPct))) {
        return { ok: false, error: `Invalid density: ${densityPct}`, ...this.getDetectionState() };
      }
      requestedDensity = canonicalizeDensity(Number(densityPct));
    }
    if (requestedProfile && requestedProfile !== 'OFF' && requestedDensity != null
      && profileForDensity(requestedDensity) !== requestedProfile) {
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
        return { ok: false, error: `Unknown allocation strategy: ${allocationStrategy}`, ...this.getDetectionState() };
      }
    }
    if (fadePct != null) {
      if (!Number.isFinite(Number(fadePct))) {
        return { ok: false, error: `Invalid fade distance: ${fadePct}`, ...this.getDetectionState() };
      }
    }
    if (outsideOpacityPct != null) {
      if (!Number.isFinite(Number(outsideOpacityPct))) {
        return { ok: false, error: `Invalid outside opacity: ${outsideOpacityPct}`, ...this.getDetectionState() };
      }
    }
    const hasExplicitVisualChange = typeof enabled === 'boolean'
      || requestedProfile !== null
      || requestedDensity !== null
      || requestedAllocation !== null
      || fadePct != null
      || outsideOpacityPct != null;
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
      this._detectionFadeSlider.value = String(Math.max(0, Math.min(40, Math.round(Number(fadePct)))));
    }
    if (outsideOpacityPct != null && this._detectionOpacitySlider) {
      this._detectionOpacitySlider.value = String(Math.max(0, Math.min(100, Math.round(Number(outsideOpacityPct)))));
    }
    if (fadePct != null || outsideOpacityPct != null) this._applyDetectionFadeFromUi();

    if (requestedProfile && requestedProfile !== 'OFF' && requestedDensity == null) {
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
      setDetectionModeByLabel(profileForDensity(
        requestedDensity ?? this._detectionDensitySlider?.value ?? 50,
      ));
    }
    this._syncDetectionUiFromEngine();
    this._syncShareState();
    return { ok: true, ...this.getDetectionState() };
  }

  /**
   * Switches the basemap stack and reports whether the switch landed.
   * @param {string} stackId - One of mapStackController.getStacks() ids.
   * @returns {Promise<{ok: boolean, activeStack?: string, error?: string|null, available?: string[]}>}
   */
  async setMapStack(stackId) {
    if (!this.mapStackController) {
      return { ok: false, error: 'Map stack controller unavailable' };
    }
    const stacks = this.mapStackController.getStacks();
    const target = stacks.find((stack) => stack.id === stackId);
    if (!target) {
      return { ok: false, error: `Unknown map stack: ${stackId}`, available: stacks.map((s) => s.id) };
    }
    if (!target.available) {
      return { ok: false, error: `${target.label} requires a Cesium ion token`, activeStack: this.mapStackController.getActiveId() };
    }
    await this._setMapStack(stackId);
    const state = this.mapStackController.getState();
    const landed = state.activeId === stackId;
    return {
      ok: landed,
      activeStack: state.activeId,
      error: landed ? null : (state.lastError || 'Map stack did not switch'),
    };
  }

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
      return { ok: false, orbiting: false, error: 'No active landmark to orbit — fly to a landmark first' };
    }
    this._toggleOrbit();
    return { ok: true, orbiting: !!this.orbitController?.active };
  }

  /**
   * Enables/disables clean view (hides all UI chrome).
   * @param {boolean} [enabled] - Omit to toggle.
   * @returns {{ok: boolean, cleanView: boolean}}
   */
  setCleanView(enabled) {
    this.toggleCleanView(enabled);
    return { ok: true, cleanView: document.body.classList.contains('ui-clean-view') };
  }

  /**
   * Reads global context mode state for voice/state-sync consumers.
   * @returns {{mode: 'flights'|'space-missions'|null, active: boolean, changing: boolean, entering: 'flights'|'space-missions'|null, snapshotCaptured: boolean}}
   */
  getContextModeState() {
    return {
      mode: this._contextMode || null,
      active: Boolean(this._contextMode),
      changing: Boolean(this._contextModeChanging),
      entering: this._contextModeEntering || null,
      canContact: !this._contextMode || this._contextMode === 'flights',
      canMission: !this._contextMode || this._contextMode === 'space-missions',
      snapshotCaptured: Boolean(this._contextSessionSnapshot),
    };
  }

  /**
   * Sets global context mode (Contacts / Space Missions / off) for voice.
   * @param {'contacts'|'space-missions'|'off'|null} mode - Requested context target.
   * @param {object} [options]
   * @param {string|Symbol|null} [options.notificationToken]
   * @param {AbortSignal|null} [options.signal]
   * @param {Function|null} [options.isCurrent]
   * @param {boolean} [options.claimVisualAuthority] Whether this request is a
   *   genuine operator/voice Context intent that should take the visual restore
   *   lane. Cockpit choreography calls this facade INTERNALLY for its own
   *   enter/rollback steps; those transitions are not a Context request by the
   *   operator and must stay inert, so they pass `false`.
   * @returns {Promise<{ok:boolean, mode:'flights'|'space-missions'|null, active:boolean, action:string, error?:string}>}
   */
  async setContextMode(mode, {
    notificationToken = null,
    signal = null,
    isCurrent = null,
    claimVisualAuthority = true,
  } = {}) {
    const requestIsCurrent = () => !signal?.aborted
      && (typeof isCurrent !== 'function' || isCurrent());
    const cancellationResult = () => ({
      ok: false,
      action: 'set_context_mode',
      cancelled: true,
      error: 'Context request was superseded by a newer voice turn',
      ...this.getContextModeState(),
      ...(this._contextTransitionFailedLayerIds?.length
        ? { failedLayerIds: [...this._contextTransitionFailedLayerIds] }
        : {}),
    });
    if (!requestIsCurrent()) return cancellationResult();
    try {
      if (!mode || mode === 'off') {
        // Validated explicit transition — Context owns detection, so take the
        // visual lane before a delayed shared restore can reclaim it. Internal
        // Cockpit choreography opts out: it is not an operator Context request.
        if (claimVisualAuthority) this._claimContextVisualAuthority();
        const result = await this._selectContextMode(null, { notificationToken, signal });
        if (result === null || (!requestIsCurrent() && result !== true)) return cancellationResult();
        const state = this.getContextModeState();
        return {
          ok: result === true,
          action: 'set_context_mode',
          mode: state.mode,
          ...state,
          ...(result === true ? {} : { error: 'Context mode transition did not complete' }),
          ...(this._contextTransitionFailedLayerIds?.length
            ? { failedLayerIds: [...this._contextTransitionFailedLayerIds] }
            : {}),
        };
      }
      const canonical = mode === 'contacts' ? 'flights' : mode;
      if (!['flights', 'space-missions'].includes(canonical)) {
        return {
          ok: false,
          action: 'set_context_mode',
          error: `Unknown context mode: ${mode}`,
          mode: this._contextMode,
          ...this.getContextModeState(),
        };
      }
      const priorMode = this._contextMode;
      // Claimed only after the mode enum validates above, so a rejected request
      // takes no authority and leaves the shared visual state eligible. Internal
      // Cockpit choreography opts out: it is not an operator Context request.
      if (claimVisualAuthority) this._claimContextVisualAuthority();
      const transitioned = await this._selectContextMode(canonical, { notificationToken, signal });
      if (transitioned === null || (!requestIsCurrent() && transitioned !== true)) return cancellationResult();
      const state = this.getContextModeState();
      // A cross-mode switch tears the prior mode down before it commits, so a
      // cancelled or failed switch rests on Context OFF. Say that plainly:
      // reporting a bare "did not complete" while the operator's Context is
      // gone is the dishonesty this whole path was fixed for. The state fields
      // below carry the same verdict, so text and state cannot disagree.
      const crossModeSwitchLost = transitioned !== true
        && Boolean(priorMode) && priorMode !== canonical && !state.mode;
      return {
        ok: transitioned === true,
        action: 'set_context_mode',
        mode: state.mode,
        ...state,
        ...(transitioned === true ? {} : {
          // Named in the operator's vocabulary, not the internal id: this
          // string is read by the voice model, which takes 'contacts'.
          error: crossModeSwitchLost
            ? `Switch to ${contextModeWord(canonical)} did not complete — Context is now off`
            : 'Context mode transition did not complete',
          ...(crossModeSwitchLost ? { contextOff: true, priorMode } : {}),
        }),
        ...(this._contextTransitionFailedLayerIds?.length
          ? { failedLayerIds: [...this._contextTransitionFailedLayerIds] }
          : {}),
      };
    } catch (error) {
      if (!requestIsCurrent()) {
        return {
          ...cancellationResult(),
          ...(Array.isArray(error?.failedLayerIds)
            ? { failedLayerIds: [...error.failedLayerIds] }
            : {}),
        };
      }
      return {
        ok: false,
        action: 'set_context_mode',
        error: error?.message || 'Context mode transition failed',
        ...(Array.isArray(error?.failedLayerIds)
          ? { failedLayerIds: [...error.failedLayerIds] }
          : {}),
        ...this.getContextModeState(),
      };
    }
  }

  /**
   * Returns cockpit status for voice/state sync and navigation operations.
   * @returns {{active:boolean, entryAllowed:boolean, visionMode:string, subject:{id:string,layerId:string}|null, navigation:{canPrevious:boolean,canNext:boolean,canFocus:boolean}|null, awareness?: object}|null}
   */
  getCockpitState() {
    const snapshot = militaryAwarenessLayer.getContextSnapshot?.();
    const info = this.cockpitView?.readAircraftInfo?.();
    const active = Boolean(this.cockpitView?.active);
    const gateOpen = Boolean(this.cockpitView?.isEntryAllowed?.());
    // "Could Cockpit be ENTERED right now" — so it is false while already
    // inside, unconditionally. Cockpit takes the entity off
    // `viewer.trackedEntity` on entry and NEXT puts one back, which made this
    // flip true/false between calls while `active` stayed true; readers
    // (including the voice model) read that as a broken half-entered state.
    const entryAllowed = !active && Boolean(
      gateOpen
      && info
      && this.viewer?.trackedEntity?.position,
    );
    return {
      active,
      entryAllowed,
      // Why entry is unavailable, so a refusal can be explained rather than
      // guessed at.
      entryBlockedReason: entryAllowed || active
        ? null
        : (!gateOpen
          ? (this._contextModeChanging ? 'contacts-starting' : 'contacts-inactive')
          : 'no-tracked-aircraft'),
      visionMode: this.cockpitView?.visionMode || null,
      subject: info ? {
        id: info.icao24 || info.id || null,
        layerId: info.layerId || null,
        callsign: info.callsign || null,
      } : null,
      navigation: snapshot ? {
        canPrevious: Boolean(snapshot.navigation?.canPrevious),
        canNext: Boolean(snapshot.navigation?.canNext),
        canFocus: Boolean(snapshot.navigation?.canFocus),
      } : null,
      awareness: snapshot ? {
        radiusM: Number.isFinite(snapshot.radiusM) ? snapshot.radiusM : null,
        subject: snapshot.subject ? {
          id: snapshot.subject.id || null,
          layerId: snapshot.subject.layerId || null,
        } : null,
        cohorts: Array.isArray(snapshot.cohorts)
          ? snapshot.cohorts.map((cohort) => ({
            id: cohort?.id || null,
            source: cohort?.source || null,
            count: Number.isFinite(cohort?.count) ? cohort.count : null,
            relationship: cohort?.relationship || null,
            reason: cohort?.reason || null,
            coverage: cohort?.coverage || null,
          }))
          : [],
        navigation: snapshot.navigation ? {
          canPrevious: Boolean(snapshot.navigation.canPrevious),
          canNext: Boolean(snapshot.navigation.canNext),
          canFocus: Boolean(snapshot.navigation.canFocus),
        } : null,
      } : null,
      activeTracked: this.cockpitView?.active ? Boolean(this.cockpitView?.trackedEntity) : false,
      activeMapView: !this.cockpitView?.active && entryAllowed,
    };
  }

  /**
   * Point Cockpit entry at a requested contact layer before it enters.
   *
   * Reuses the filtered Context navigation NEXT already uses, so "cockpit in
   * that military helicopter" lands on the same contact "next military
   * helicopter" would. Cockpit flies aircraft only; vessel and installation
   * layers are refused by name rather than silently ignored.
   * @param {object} options Retarget request.
   * @param {string} options.targetLayer Requested contact layer.
   * @param {string|null} options.aircraftClass Optional class filter.
   * @param {{layerId: string}|null} options.currentTarget Current tracker.
   * @param {{layerId: string}|null} options.selectedTarget Pending selection.
   * @returns {{ok: boolean, retargeted?: boolean, error?: string}} Outcome.
   */
  _retargetCockpitEntryLayer({ targetLayer, aircraftClass, currentTarget, selectedTarget }) {
    if (!['flights', 'military'].includes(targetLayer)) {
      return {
        ok: false,
        error: `Cockpit flies aircraft only — ${targetLayer} contacts cannot be entered`,
      };
    }
    const activeLayer = selectedTarget?.layerId || currentTarget?.layerId || null;
    const alreadyOnLayer = activeLayer === targetLayer;
    if (alreadyOnLayer && !aircraftClass) return { ok: true, retargeted: false };
    const moved = militaryAwarenessLayer?.navigateNext
      ? !!militaryAwarenessLayer.navigateNext({
        targetLayer,
        aircraftClass,
        origin: 'voice',
      })
      : false;
    if (moved) return { ok: true, retargeted: true };
    // A filter that matched nothing still enters, as long as the layer is
    // already right — the operator asked for that layer and is on it.
    if (alreadyOnLayer) return { ok: true, retargeted: false };
    const label = targetLayer === 'military' ? 'military' : 'civilian';
    const filtered = aircraftClass ? `${aircraftClass} ` : '';
    return {
      ok: false,
      error: `No ${filtered}${label} contact is available to enter — track one first, or say "next ${label}"`,
    };
  }

  /**
   * Controls cockpit entry/exit and context navigation.
   * @param {'enter'|'exit'|'next'|'previous'|'status'} action - Cockpit action.
   * @param {object} [options]
   * @param {string|Symbol|null} [options.notificationToken]
   * @param {'flights'|'military'|'ais-live-vessels'|'military-installations'|null} [options.targetLayer]
   * @param {string|null} [options.aircraftClass]
   * @param {{layerId:'flights'|'military',id:string}|null} [options.selectedTarget]
   * @param {{layerId:'flights'|'military',id:string}|null} [options.rollbackTarget]
   * @returns {{ok:boolean, action:string, error?:string, state?:object}}
   */
  controlCockpit(action, {
    notificationToken = null,
    targetLayer = null,
    aircraftClass = null,
    selectedTarget = null,
    rollbackTarget = undefined,
  } = {}) {
    const normalized = String(action || '').toLowerCase();
    if (!this.cockpitView) {
      return {
        ok: false,
        action: 'control_cockpit',
        error: 'Cockpit controller unavailable',
        state: this.getCockpitState(),
      };
    }
    if (normalized === 'status') {
      return {
        ok: true,
        action: 'control_cockpit',
        state: this.getCockpitState(),
        notificationToken: notificationToken || null,
      };
    }
    if (normalized === 'enter') {
      // Entry is gated exactly as the manual entry chip is. Attempting it while
      // the gate is shut produced the half-entered look the operator reported
      // (a plane anchored under the camera with no cockpit around it), so
      // refuse with the reason instead of trying.
      if (!this.cockpitView.isEntryAllowed?.()) {
        return {
          ok: false,
          action: 'control_cockpit',
          error: this._contextModeChanging
            ? 'Contacts is still starting up — try Cockpit again in a moment'
            : 'Contacts must be active to enter Cockpit — say "open contacts" first',
          state: this.getCockpitState(),
        };
      }
      let currentTarget = this.getAircraftTrackingTarget();
      const layerForTarget = (target) => target?.layerId === 'military'
        ? militaryFlightsLayer
        : target?.layerId === 'flights' ? flightsLayer : null;
      // A requested layer retargets BEFORE entry, through the same filtered
      // navigation NEXT uses. Ignoring it entered on whatever was already
      // tracked and reported success, so "cockpit in that military helicopter"
      // silently put the operator in an airliner.
      if (targetLayer) {
        const requested = this._retargetCockpitEntryLayer({
          targetLayer,
          aircraftClass,
          currentTarget,
          selectedTarget,
        });
        if (!requested.ok) {
          return {
            ok: false,
            action: 'control_cockpit',
            error: requested.error,
            state: this.getCockpitState(),
          };
        }
        if (requested.retargeted) {
          // The retarget is now the authority; a selection sampled before it
          // would drag entry back to the wrong layer.
          selectedTarget = null;
          rollbackTarget = rollbackTarget === undefined ? currentTarget : rollbackTarget;
          currentTarget = this.getAircraftTrackingTarget();
        }
      }
      const selectedLayer = selectedTarget?.layerId === 'military'
        ? militaryFlightsLayer
        : selectedTarget?.layerId === 'flights' ? flightsLayer : null;
      const entry = enterCockpitWithTracking({
        cockpitView: this.cockpitView,
        selectedLayer,
        selectedTarget,
        currentLayer: layerForTarget(currentTarget),
        rollbackLayer: layerForTarget(
          rollbackTarget === undefined ? currentTarget : rollbackTarget,
        ),
        rollbackTarget,
        selectionOrigin: 'voice',
      });
      return {
        ok: entry.entered,
        action: 'control_cockpit',
        state: this.getCockpitState(),
        error: entry.error,
      };
    }
    if (normalized === 'exit') {
      const exited = !!this.cockpitView.exit();
      return {
        ok: exited,
        action: 'control_cockpit',
        state: this.getCockpitState(),
        error: exited ? null : 'Cockpit was already inactive',
      };
    }
    if (normalized === 'next' || normalized === 'previous') {
      const changed = this.cockpitView.navigateContext(
        normalized === 'next' ? 1 : -1,
        {
          targetLayer,
          aircraftClass,
          origin: 'voice',
        },
      );
      return {
        ok: changed,
        action: 'control_cockpit',
        state: this.getCockpitState(),
        error: changed ? null : 'No further context target was available',
      };
    }
    return {
      ok: false,
      action: 'control_cockpit',
      error: `Unknown cockpit action: ${action}`,
      state: this.getCockpitState(),
    };
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
      hud: { visible: !!this.hud?.visible, layout: this.hud?.getVariant?.() || null },
      detection: this.getDetectionState(),
      bloom: {
        enabled: !!this.bloomEnabled,
        intensityPct: this._bloomSlider ? parseInt(this._bloomSlider.value, 10) : null,
      },
      sharpen: {
        enabled: !!this.sharpenEnabled,
        intensityPct: this._sharpenSlider ? parseInt(this._sharpenSlider.value, 10) : null,
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
        cameraState.alt
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
        outsideOpacityPct: parseInt(this._detectionOpacitySlider?.value || '0', 10),
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
        bloomState.version ?? state.bloomVersion ?? BLOOM_SCALE_VERSION
      );
      this._setBloomIntensity(intensity, { syncShare: false });
    }
    if (typeof bloomState.enabled === 'boolean') {
      this._setBloomEnabled(bloomState.enabled);
    }

    const sharpenState = state.sharpen || {};
    if (typeof sharpenState.intensity === 'number' && this._sharpenSlider) {
      const pct = Math.max(0, Math.min(100, Math.round(sharpenState.intensity)));
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
      if (this._scopeFeatherValue) this._scopeFeatherValue.textContent = `${pct}%`;
      setScopeMaskFeather(pct / 100);
    }

    const detectionState = state.detection || {};
    if (typeof detectionState.density === 'number' && this._detectionDensitySlider) {
      const pct = canonicalizeDensity(detectionState.density);
      this._detectionDensitySlider.value = String(pct);
      if (this._detectionDensityValue) this._detectionDensityValue.textContent = `${pct}%`;
      this._applyDetectionDensityFromUi();
    }
    if (detectionState.allocation) {
      this._setDetectionAllocation(detectionState.allocation, { syncShare: false });
    }
    if (typeof detectionState.fadePct === 'number' && this._detectionFadeSlider) {
      this._detectionFadeSlider.value = String(detectionState.fadePct);
    }
    if (typeof detectionState.outsideOpacityPct === 'number' && this._detectionOpacitySlider) {
      this._detectionOpacitySlider.value = String(detectionState.outsideOpacityPct);
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
      const genBefore = this.mapStackController?.getSwitchGeneration?.() ?? null;

      await this._setMapStack(state.mapStack, { syncShare: false });

      if (superseded()) {
        // Superseded DURING the switch, which the pre-check above cannot catch
        // and which has already moved the globe. The controller only
        // invalidates a switch when another setStack() arrives, and a winning
        // state that omits `mapStack` never issues one — every normalized scene
        // shot omits it — so this stale globe would simply stand. Put back what
        // the winner inherited.
        const genAfter = this.mapStackController?.getSwitchGeneration?.() ?? null;
        // _setMapStack issues exactly one setStack(), which advances the
        // generation once, or not at all when the stack was unavailable and
        // nothing was mutated. Anything past that is a NEWER switch whose
        // caller owns the globe now, and reverting would stomp a live intent.
        const globeIsStillOurs = genBefore !== null && genAfter !== null
          && genAfter <= genBefore + 1;
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

  /**
   * Resets the safe-frame overlay to its inactive state on init.
   * @returns {void}
   */
  _initRecordingOverlay() {
    if (!this._safeFrameOverlay || !this._safeFrameBox) return;
    this._safeFrameOverlay.classList.remove('active', 'ratio-9-16', 'ratio-16-9');
  }

  /**
   * Applies recording-friendly post-processing and shader uniform overrides.
   * @param {object} preset
   */
  applyCinematicPreset(preset = {}) {
    const bloomInput = typeof preset.bloom === 'object' ? preset.bloom : { intensity: preset.bloom };
    let decodedBloomIntensity = null;
    if (typeof bloomInput.intensity === 'number') {
      decodedBloomIntensity = decodeBloomIntensity(
        bloomInput.intensity,
        bloomInput.version ?? preset.bloomVersion ?? BLOOM_SCALE_VERSION
      );
      this._setBloomIntensity(decodedBloomIntensity, { syncShare: false });
    }
    if (typeof bloomInput.enabled === 'boolean') {
      this._setBloomEnabled(bloomInput.enabled);
    } else if (typeof bloomInput.intensity === 'number') {
      this._setBloomEnabled((decodedBloomIntensity ?? this._getBloomIntensity()) > 0);
    }

    const sharpenInput = typeof preset.sharpen === 'object' ? preset.sharpen : { enabled: preset.sharpen };
    if (typeof sharpenInput.intensity === 'number' && this._sharpenSlider) {
      const sharpenPct = Math.max(0, Math.min(100, Math.round(sharpenInput.intensity)));
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
    if (typeof preset.detectionDensity === 'number' && this._detectionDensitySlider) {
      const density = canonicalizeDensity(preset.detectionDensity);
      this._detectionDensitySlider.value = String(density);
      this._detectionDensityValue.textContent = `${density}%`;
      this._applyDetectionDensityFromUi();
    }
    if (preset.detectionAllocation) {
      this._setDetectionAllocation(preset.detectionAllocation, { syncShare: false });
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
    const { hidePanels = true, hudMode = 'minimal', safeFrame = '16:9' } = options;
    this._recordingMode = !!enabled;
    this._recordingConfig = { hidePanels, hudMode, safeFrame };

    document.body.classList.toggle('recording-mode', this._recordingMode && hidePanels);

    if (this._safeFrameOverlay) {
      this._safeFrameOverlay.classList.remove('ratio-9-16', 'ratio-16-9');
      this._safeFrameOverlay.classList.toggle('active', this._recordingMode);
      this._safeFrameOverlay.classList.add(safeFrame === '9:16' ? 'ratio-9-16' : 'ratio-16-9');
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
        if (this._hudLayoutSelect) this._hudLayoutSelect.value = this.hud.getVariant();
      } else {
        this.hud.setMode('auto');
      }
    } else {
      const saved = this._preRecordingHudState;
      this._preRecordingHudState = null;
      if (saved) {
        this.hud.setVariant(saved.variant);
        if (this._hudLayoutSelect) this._hudLayoutSelect.value = this.hud.getVariant();
      }
      this.hud.setMode(saved ? saved.mode : 'auto');
      if (this._safeFrameOverlay) {
        this._safeFrameOverlay.classList.remove('active', 'ratio-9-16', 'ratio-16-9');
      }
    }
    this._hudBtn.classList.toggle('active', this.hud.visible);
    this._syncShareState();
  }

  /**
   * Sample the manager's layer set and paint the global loading chip.
   * Driven by manager events AND by a ticker, because the underlying state
   * machine is TIME-driven (reveal delay, long-load threshold, terminal
   * dwell) — see _armLoadingFeedbackTicker.
   * @param {number} [now] - performance.now() sample.
   * @returns {void}
   */
  _updateGlobalLoadingFeedback(now = performance.now()) {
    if (!this._globalLoadingStatus) return;
    const summary = aggregateLayerLoading(this._dataManager?.getAll?.() || []);
    this._loadingFeedbackState = reduceLoadingFeedback(
      this._loadingFeedbackState,
      summary,
      now,
      this._loadingFeedbackEvent,
    );
    this._loadingFeedbackEvent = null;
    const presentation = presentGlobalLoadingStatus(
      this._globalStatusNotice,
      this._loadingFeedbackState,
      summary,
      now,
    );
    if (this._globalStatusNotice?.persistent !== true
        && Number.isFinite(this._globalStatusNotice?.hideAt)
        && now >= this._globalStatusNotice.hideAt) {
      this._globalStatusNotice = null;
    }
    // Loading phases and universal notices both have time-driven transitions.
    // Compute this after arbitration: a queued finite notice starts its dwell
    // only on its first visible frame, then keeps the ticker alive to expiry.
    const noticeNeedsTicker = Number.isFinite(this._globalStatusNotice?.hideAt);
    if (this._loadingFeedbackState?.phase !== 'idle' || noticeNeedsTicker) {
      this._armLoadingFeedbackTicker();
    }
    this._globalLoadingStatus.hidden = !presentation;
    if (!presentation) {
      delete this._globalLoadingStatus.dataset.state;
      if (this._globalLoadingAction) this._globalLoadingAction.hidden = true;
      return;
    }
    this._globalLoadingStatus.dataset.state = presentation.state;
    // Split-flap the LABEL only ("LOADING LIVE DATA" -> "LOAD COMPLETE").
    // setSplitFlapText is a no-op when the text is unchanged, which matters
    // here: this runs on every 60 ms and 500 ms tick. The detail line is the
    // live layer roster inside an ellipsised, width-capped span — flapping a
    // list that churns as layers join would be noise, not delight.
    setSplitFlapText(this._globalLoadingLabel, presentation.label);
    this._globalLoadingDetail.textContent = presentation.detail;
    // The button can only help where Provider Settings exists: on a local dev
    // server, keySetup.js keeps #key-setup; elsewhere it removes it.
    if (this._globalLoadingAction) {
      this._globalLoadingAction.hidden = presentation.state !== 'needs-key'
        || !document.getElementById('key-setup');
    }
  }

  /** Show a message in the universal top-center status banner. */
  _showGlobalStatusNotice(message, options = {}) {
    const now = performance.now();
    this._globalStatusNotice = createGlobalStatusNotice(message, now, options);
    this._updateGlobalLoadingFeedback(now);
  }

  /**
   * 500 ms DOM ticker for the traffic sync chip (was per-frame). It also
   * polls the loading chip as a safety net: a camera-driven layer can flip
   * its own `stats.loading` without emitting a manager event, and that is
   * the one loading start the event path cannot see.
   */
  _startTrafficChipTicker() {
    if (this._trafficChipTicker) return;
    this._trafficChipTicker = setInterval(() => {
      if (document.hidden) return;
      this._updateTrafficSyncChip();
      this._updateGlobalLoadingFeedback();
    }, 500);
  }

  /**
   * Self-stopping 60 ms ticker for the global loading chip.
   *
   * The chip used to ride the style rAF loop, which perf wave 2 made
   * self-stopping — leaving the chip frozen mid-state whenever no crossfade
   * or animated shader was running (it would never reveal, never cross the
   * long-load threshold, and never dwell out). Its reducer
   * (src/loadingFeedback.js) is time-driven, so it needs real ticks; it is
   * also pure DOM, so it takes NO governor hold and requests no render.
   * Armed by _updateGlobalLoadingFeedback whenever loading leaves idle or a
   * universal notice begins, and stops once both have settled.
   * (rebase 2026-08-16: main's loading chip vs wave 2's stopped loop)
   * @returns {void}
   */
  _armLoadingFeedbackTicker() {
    // Never arm behind a hidden tab: the reducer cannot usefully advance a
    // chip nobody can see, and the old `return` INSIDE the interval left the
    // 60ms timer scheduled for the entire hidden period (a batch completing
    // while hidden could never clear it — the idle check sat behind the
    // hidden guard). visibilitychange resamples and re-arms on return.
    if (this._loadingFeedbackTicker || document.hidden) return;
    this._loadingFeedbackTicker = setInterval(() => {
      if (document.hidden) {
        this._stopLoadingFeedbackTicker();
        return;
      }
      const now = performance.now();
      this._lastLoadingFeedbackUpdateAt = now;
      this._updateGlobalLoadingFeedback(now);
      const noticeNeedsTicker = Number.isFinite(this._globalStatusNotice?.hideAt);
      if (this._loadingFeedbackState?.phase === 'idle' && !noticeNeedsTicker) {
        this._stopLoadingFeedbackTicker();
      }
    }, 60);
  }

  /** Stop the loading-chip ticker if it is running. Idempotent. */
  _stopLoadingFeedbackTicker() {
    if (!this._loadingFeedbackTicker) return;
    clearInterval(this._loadingFeedbackTicker);
    this._loadingFeedbackTicker = null;
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

  /**
   * Displays a temporary toast notification for 2 seconds.
   * @param {string} message - Text to show in the toast.
   * @returns {void}
   */
  _showToast(message) {
    this._toast.textContent = message;
    this._toast.classList.add('visible');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this._toast.classList.remove('visible');
    }, 2000);
  }

  // ── HUD Toggle ───────────────────────────────

  /**
   * Wires the HUD toggle button, initializes the default HUD variant to 'tactical',
   * and sets up the detection mode cycle button.
   * @returns {void}
   */
  /**
   * Wires the DISPLAY-rail "3D" toggle to the flights layer's `models3d` param.
   * ON by default in `proximity` mode (owner directive 2026-08-22): the fleet
   * renders as 3D glTF models once the camera is zoomed in past the layer's
   * altitude ceiling, and only the nearest MODEL_MAX in view are admitted, so
   * the default costs nothing at globe scale. `all` is the deliberate opt-in;
   * turning the toggle off returns the fleet to flat billboards. The TRACKED
   * contact is independent of this toggle (see trackedModelRegime.js).
   * @returns {void}
   */
  /** One 3D toggle drives BOTH aircraft layers (commercial + military) so all planes flip together. */
  _setModels3dParams(params, { origin = 'user' } = {}) {
    this._dataManager?.setLayerParams('flights', params, { origin });
    this._dataManager?.setLayerParams('military', params, { origin });
  }

  _syncModels3dFromLayerState(state) {
    const options = state?.options?.flights;
    if (!options) return;
    this._models3dEnabled = options.models3d === true;
    this._models3dMode = options.models3dMode === 'all' ? 'all' : 'proximity';
    this._syncModels3dButtonState();
    this._models3dModeRow?.classList.toggle('visible', this._models3dEnabled);
    for (const button of this._models3dModeBtns || []) {
      if (!button) continue;
      const active = button.dataset.mode === this._models3dMode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', String(active));
    }
    this._layoutRightPanels();
  }

  _initModels3dToggle() {
    if (!this._models3dBtn) return;
    // The Proximity/All mode row is revealed only while 3D is on (mirrors the DETECT slider row).
    const syncModeRow = () => {
      if (this._models3dModeRow) this._models3dModeRow.classList.toggle('visible', this._models3dEnabled);
      this._layoutRightPanels();
    };
    this._models3dBtn.addEventListener('click', () => {
      this._setModels3dEnabled(!this._models3dEnabled);
      syncModeRow();
    });
    for (const btn of this._models3dModeBtns) {
      if (!btn) continue;
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode === 'all' ? 'all' : 'proximity';
        this._setModels3dMode(mode);
      });
    }
    this._syncModels3dButtonState();
    syncModeRow();
  }

  _setModels3dEnabled(enabled) {
    this._models3dEnabled = !!enabled;
    this._setModels3dParams({ models3d: this._models3dEnabled });
    this._syncModels3dButtonState();
  }

  _setModels3dMode(mode) {
    const normalized = mode === 'all' ? 'all' : 'proximity';
    this._models3dMode = normalized;
    this._setModels3dParams({ models3dMode: normalized });
    for (const button of this._models3dModeBtns) {
      if (!button) continue;
      const active = button.dataset.mode === normalized;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', String(active));
    }
    this._syncModels3dButtonState();
  }

  _syncModels3dButtonState() {
    this._models3dBtn?.classList.toggle('active', this._models3dEnabled);
    // The lit/dark state is a colour to a sighted operator and nothing at all to
    // a screen reader without this. It matters more now that the button ships
    // ACTIVE from markup (default-on, 2026-08-22): the very first thing assistive
    // tech reported was an unpressed-looking control over an armed layer.
    // Mirrors #scope-toggle, which has always carried aria-pressed.
    this._models3dBtn?.setAttribute('aria-pressed', String(this._models3dEnabled));
  }

  _initHUDToggle() {
    this._hudBtn.addEventListener('click', () => {
      this.shareLinkManager?.claimRestoreLane?.('visual');
      this.hud.toggle();
      this._updateHudButtonState();
      this._syncShareState();
    });

    if (this._hudLayoutSelect) {
      this._hudLayoutSelect.value = 'tactical';
    }
    this._setHudVariant('tactical');
    this.hud.setMode('on');
    this._updateHudButtonState();

    // Detection toggle button
    this._detectionBtn.addEventListener('click', () => {
      this.shareLinkManager?.claimRestoreLane?.('visual');
      this._detectionUserOverridden = true;
      cycleDetectionMode();
      this._syncShareState();
    });
    this._cockpitDisplayToggleBtn?.addEventListener('click', () => {
      const open = this._cockpitDisplayToggleBtn.getAttribute('aria-expanded') === 'true';
      this._setCockpitDisclosure?.('display', !open);
    });
    this._initCockpitDisplayPortal();
  }

  /**
   * Reuses the production Display controls inside Cockpit without cloning
   * stateful inputs or event listeners. Comment anchors preserve each group's
   * exact home in the standard Display panel for exit and teardown.
   * @returns {void}
   */
  _initCockpitDisplayPortal() {
    const definitions = [
      ['hud', this._hudBtn?.closest('.pp-toggle-group')],
      ['detection', this._detectionBtn?.closest('.pp-toggle-group')],
      ['parameters', this._sliderPanel],
      ['models3d', this._models3dBtn?.closest('.pp-toggle-group')],
    ];
    this._cockpitDisplayPortalRecords = definitions.flatMap(([name, group]) => {
      const slot = this._cockpitDisplayPanel?.querySelector(
        `[data-cockpit-display-slot="${name}"]`,
      );
      if (!group || !slot || !group.parentNode) return [];
      const anchor = document.createComment(`cockpit-display-home:${name}`);
      group.before(anchor);
      return [{ name, group, slot, anchor }];
    });
    this._standardDisplayScrollTop = this._ppToggles?.scrollTop || 0;
    this._cockpitDisplayScrollTop = this._cockpitDisplayPanel?.scrollTop || 0;
    this._standardDisplayScrollHandler = () => {
      if (!this._cockpitDisplayPortalActive) {
        this._standardDisplayScrollTop = this._ppToggles?.scrollTop || 0;
      }
    };
    this._cockpitDisplayScrollHandler = () => {
      if (this._cockpitDisplayPortalActive) {
        this._cockpitDisplayScrollTop = this._cockpitDisplayPanel?.scrollTop || 0;
      }
    };
    this._ppToggles?.addEventListener('scroll', this._standardDisplayScrollHandler, { passive: true });
    this._cockpitDisplayPanel?.addEventListener('scroll', this._cockpitDisplayScrollHandler, { passive: true });
    this._cockpitDisplayModeHandler = (event) => {
      this._setCockpitDisplayPortalActive(event?.detail?.active === true);
    };
    window.addEventListener('gev:cockpit-mode-changed', this._cockpitDisplayModeHandler);
    this._setCockpitDisplayPortalActive(document.body.classList.contains('cockpit-mode'));
  }

  /**
   * Moves the shared HUD, Detection, Parameters, and 3D controls into or out
   * of Cockpit.
   * @param {boolean} active Whether Cockpit owns the Display control groups.
   * @returns {void}
   */
  _setCockpitDisplayPortalActive(active) {
    const nextActive = active === true;
    if (this._cockpitDisplayPortalActive === nextActive) return;
    const focusedRecord = this._cockpitDisplayPortalRecords.find((record) => (
      record.group.contains(document.activeElement)
    ));
    const focusedElement = focusedRecord ? document.activeElement : null;
    this._displayPortalScrollRestoreOwner = nextActive ? 'cockpit' : 'standard';
    this._cockpitDisplayPortalActive = nextActive;
    for (const record of this._cockpitDisplayPortalRecords) {
      if (nextActive) {
        record.slot.append(record.group);
      } else if (record.anchor.parentNode) {
        record.anchor.after(record.group);
      }
    }
    this._cockpitDisplayPanel?.classList.toggle('uses-shared-display-controls', nextActive);
    requestAnimationFrame(() => {
      if (nextActive && this._cockpitDisplayPanel) {
        this._cockpitDisplayPanel.scrollTop = this._cockpitDisplayScrollTop;
      }
      if (!nextActive && this._ppToggles) {
        this._ppToggles.scrollTop = this._standardDisplayScrollTop;
      }
      focusedElement?.focus?.({ preventScroll: true });
      // Portal movement can trigger one more adaptive-layout/clamp pass after
      // the first frame. Reapply the owning surface's saved position once the
      // new layout has fully settled.
      requestAnimationFrame(() => {
        if (nextActive && this._cockpitDisplayPanel) {
          this._cockpitDisplayPanel.scrollTop = this._cockpitDisplayScrollTop;
        }
        if (!nextActive && this._ppToggles) {
          this._ppToggles.scrollTop = this._standardDisplayScrollTop;
        }
        if (this._displayPortalScrollRestoreOwner === (nextActive ? 'cockpit' : 'standard')) {
          this._displayPortalScrollRestoreOwner = null;
        }
      });
    });
    this._layoutRightPanels();
    this.cockpitView?.scheduleContextLayout();
  }

  /**
   * Syncs the HUD toggle button active class and HUD layout row visibility
   * with the current HUD visible state.
   * @returns {void}
   */
  _updateHudButtonState() {
    this._hudBtn.classList.toggle('active', this.hud.visible);
    if (this._hudLayoutRow) {
      this._hudLayoutRow.classList.toggle('visible', this.hud.visible);
    }
    this._scheduleAdaptivePanelLayout({ settle: true });
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
    btn.setAttribute('aria-label', enabled
      ? `Detection overlay: ${String(modeLabel).toLowerCase()}`
      : 'Detection overlay: off');
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
      this._detectionAllocationRow.classList.toggle('visible', modeLabel !== 'OFF');
    }
    if (this._detectionFadeRow) {
      this._detectionFadeRow.classList.toggle('visible', modeLabel !== 'OFF');
    }
    if (this._detectionOpacityRow) {
      this._detectionOpacityRow.classList.toggle('visible', modeLabel !== 'OFF');
    }
    this._layoutRightPanels();
  }

  /** Whether a share link was used to load the page */
  get hasShareState() {
    return !!this._hasShareState;
  }

  /** Terminal result for the complete initial share restoration. */
  get initialRestorePromise() {
    return this._initialShareRestorePromise || Promise.resolve({ status: 'not-requested' });
  }

  _settleInitialShareRestore(result) {
    if (!this._resolveInitialShareRestore) return;
    const resolve = this._resolveInitialShareRestore;
    this._resolveInitialShareRestore = null;
    resolve(result);
    window.dispatchEvent(new CustomEvent('gev:initial-share-restore-settled', { detail: result }));
  }

  /**
   * Tear down the StyleManager — cancel animation loop, clear intervals,
   * and release resources. Call this before discarding the instance to
   * prevent leaked rAF loops and event listeners.
   * @returns {Promise<void>} Resolves after focused-session state restoration.
   */
  async dispose() {
    if (this._disposed) return;
    this._shareTrackingNoticeGeneration += 1;
    this._shareTrackingAcquiringKey = null;
    this._globalStatusNotice = null;
    if (this._globalLoadingStatus) this._globalLoadingStatus.hidden = true;
    this._disposed = true;
    this._cancelMapSourceFocus?.();
    // Revoke persistence/hash authority before teardown can emit manager changes.
    this._layerStateCoordinator?.destroy();
    this._layerStateCoordinator = null;
    this._layerStateRestorePromise = null;
    clearTimeout(this._initialShareRestoreTimeout);
    this._initialShareRestoreTimeout = null;
    this._settleInitialShareRestore({ status: 'destroyed', share: null, layers: [] });
    if (this._initialShareGestureHandler) {
      this.viewer?.canvas?.removeEventListener('pointerdown', this._initialShareGestureHandler);
      this.viewer?.canvas?.removeEventListener('wheel', this._initialShareGestureHandler);
      this._initialShareGestureHandler = null;
    }
    this.shareLinkManager?.destroy();
    if (this._awarenessSelectedHandler) {
      window.removeEventListener('gev:awareness-subject-selected', this._awarenessSelectedHandler);
      this._awarenessSelectedHandler = null;
    }
    if (this._awarenessClearedHandler) {
      window.removeEventListener('gev:awareness-subject-cleared', this._awarenessClearedHandler);
      this._awarenessClearedHandler = null;
    }
    if (this._mapStackChangeHandler) {
      window.removeEventListener('gev:map-stack-changed', this._mapStackChangeHandler);
      this._mapStackChangeHandler = null;
    }
    // Invalidate any in-flight Context transaction the same way a newer request
    // would. Without this, a reinstatement already past its awaits could
    // re-enable a mode's entry layer and republish `_contextMode` while the
    // rest of teardown is tearing those very layers down.
    this._contextModeGeneration += 1;
    this._stampNavigation();
    // Close camera-entry seams synchronously. Context restoration may await
    // layer work, so leaving these listeners attached until afterward lets a
    // focus event release tracking or start a flight during teardown.
    this._removeCctvRequestFocusListener?.();
    this._removeCctvRequestFocusListener = null;
    this._cctvRequestFocusHandler = null;
    this._removeWorldRequestFocusListener?.();
    this._removeWorldRequestFocusListener = null;
    this._worldRequestFocusHandler = null;
    this._navigationOwnerChangedRemover?.();
    this._navigationOwnerChangedRemover = null;
    this._removeNavigationAuthorityListener?.();
    this._removeNavigationAuthorityListener = null;
    this._contextModeChanging = true;
    this._contextMode = null;
    await this._restoreContextSession();
    // IR boost teardown BEFORE detaching the data manager: restore fog and
    // un-boost both aircraft layers so a surviving viewer or replacement
    // manager doesn't inherit sensor state (review P2, 2026-08-16).
    if (this._irBoostActive) {
      if (this._irFogWasEnabled != null && this.viewer?.scene?.fog) {
        this.viewer.scene.fog.enabled = this._irFogWasEnabled;
      }
      this._dataManager?.setLayerParams('flights', { irBoost: false });
      this._dataManager?.setLayerParams('military', { irBoost: false });
      this._irBoostActive = false;
      this._irFogWasEnabled = null;
    }
    this.cockpitView?.dispose();
    if (this._cockpitDisplayModeHandler) {
      window.removeEventListener('gev:cockpit-mode-changed', this._cockpitDisplayModeHandler);
      this._cockpitDisplayModeHandler = null;
    }
    this._setCockpitDisplayPortalActive(false);
    this._ppToggles?.removeEventListener('scroll', this._standardDisplayScrollHandler);
    this._cockpitDisplayPanel?.removeEventListener('scroll', this._cockpitDisplayScrollHandler);
    this._standardDisplayScrollHandler = null;
    this._cockpitDisplayScrollHandler = null;
    for (const record of this._cockpitDisplayPortalRecords) record.anchor.remove();
    this._cockpitDisplayPortalRecords = [];
    this._dataManagerBeforeDestroyUnsubscribe?.();
    this._dataManagerBeforeDestroyUnsubscribe = null;
    this._dataManagerVisibilityGuardUnsubscribe?.();
    this._dataManagerVisibilityGuardUnsubscribe = null;
    this._dataManagerVisibilityRequestUnsubscribe?.();
    this._dataManagerVisibilityRequestUnsubscribe = null;
    this._dataManagerUnsubscribe?.();
    this._dataManagerUnsubscribe = null;
    this._disposeGlobeNavigation();
    this._cctvUnsubscribe?.();
    this._cctvUnsubscribe = null;
    this._disposePanelChrome();
    if (this._windowResizeHandler) {
      window.removeEventListener('resize', this._windowResizeHandler);
      this._windowResizeHandler = null;
    }
    if (this._loadingVisibilityHandler) {
      document.removeEventListener('visibilitychange', this._loadingVisibilityHandler);
      this._loadingVisibilityHandler = null;
    }
    this._stopLoadingFeedbackTicker();
    if (this._globalKeydownHandler) {
      document.removeEventListener('keydown', this._globalKeydownHandler);
      this._globalKeydownHandler = null;
    }
    this._disposeLocationBar();
    // Cancel the rAF animation loop and release its governor hold; also stop
    // the traffic-chip ticker the loop no longer carries. (perf wave 2 fix)
    if (this._animFrameId) {
      cancelAnimationFrame(this._animFrameId);
      this._animFrameId = null;
    }
    releaseContinuousRender('style-anim');
    if (this._trafficChipTicker) {
      clearInterval(this._trafficChipTicker);
      this._trafficChipTicker = null;
    }
    if (this._loadingFeedbackTicker) {
      clearInterval(this._loadingFeedbackTicker);
      this._loadingFeedbackTicker = null;
    }
    this._disposePanelLayout();
    this._disposeRadioPanel();
    destroyTrackedReadout();
    destroyDetection();
    destroyWorldOverlay();
    // Clear transitions
    this.transitions.clear();
  }
}

adoptMethods(StyleManager, RadioPanel);
adoptMethods(StyleManager, CctvPanel);
adoptMethods(StyleManager, PanelLayout);
adoptMethods(StyleManager, PanelChrome);
adoptMethods(StyleManager, LocationBar);
adoptMethods(StyleManager, GlobeNavigation);
adoptMethods(StyleManager, VisualStyles);
