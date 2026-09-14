/**
 * @module flights
 * @description Real-time flight tracking layer powered by the OpenSky Network API
 * (authenticated via Vite dev-server proxy at /api/opensky).
 *
 * Rendering strategy: all aircraft are drawn as billboards in a single
 * BillboardCollection for GPU-efficient batching (handles 5000+ aircraft).
 * Each billboard's alignedAxis is set to the WGS84 ellipsoid surface normal
 * so that the rotation value (derived from true_track heading) operates in
 * the local tangent plane (0 deg = north, 90 deg = east).
 *
 * Click-to-track: clicking a billboard creates a tracked Entity whose
 * position is driven by a dead-reckoning CallbackProperty.  Between API
 * refreshes (every ~10-30 s) the aircraft advances smoothly using ENU frame
 * math.  When a new API fix arrives, a 1-second lerp blends the current
 * dead-reckoned position into the corrected fix to avoid visual snapping.
 *
 * Press Escape or click empty space to deselect a tracked flight — the camera
 * is released IN PLACE (no flyTo), so the user keeps the context they were
 * looking at (owner decision 2026-07-02).
 */
import { createAircraftLayer } from './aircraftLayerCore.js';

const { layer: flightsLayer, exports: core } = createAircraftLayer();

export const {
  TRACKED_MODEL_MAX_PX,
  _floorGroundedDisplayPositionForTest,
  _clearDisplayFloorStateForTest,
  _setTrackedFlightRefreshStateForTest,
  _setFlightTrackingRefreshOutcomeForTest,
  _addFlightTrackingCandidateForTest,
  _militaryLayerSuppressesForTest,
  _armFlightTrackingRestoreForTest,
  _pendingFlightTrackingRestoreForTest,
  _applyPendingFlightTrackingRestoreForTest,
  _setCockpitDetectionSubjectForTest,
  _trackedModelRegimeActiveForTest,
  _updateTrackedModelForTest,
  _trackedBillboardColorForTest,
  _driveFleetModelHandoffForTest,
  _ensureFleetModelForTest,
  mapAnalystRecord,
} = core;

export default flightsLayer;
