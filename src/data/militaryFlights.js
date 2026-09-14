/**
 * @module militaryFlights
 * @description Real-time military flight tracking layer powered by the adsb.lol API.
 *
 * Renders aircraft as amber chevron billboards in a single BillboardCollection
 * for GPU-efficient batch drawing. Supports click-to-track: selecting an aircraft
 * spawns an Entity the camera follows, whose position is driven by a
 * dead-reckoning CallbackProperty. The whole fleet renders at
 * now - RENDER_DELAY_SEC so positions interpolate BETWEEN two known fixes
 * instead of extrapolating ahead and snapping back when the next poll lands.
 *
 * The layer is the aircraft layer core (aircraftLayerCore.js) configured for
 * adsb.lol's military feed: this module supplies the feed, the records it
 * builds, and the layer's amber presentation and wording.
 */
import * as Cesium from 'cesium';
import { classifyAircraft, CLASS_MODEL_REAL, CLASS_SCALE_3D } from './aircraftClass.js';
import { cleanText, createAircraftLayer, normalizeIcao } from './aircraftLayerCore.js';
import { stickyNumber, stickyText } from './aircraftMeta.js';
import { formatFlightLevel } from './detectionDraw.js';
import { cachedGroundFloor, floorAltitudeM } from './groundFloor.js';
import { registerMilitaryIcaos, setMilitaryLayerActive } from './militaryRegistry.js';
import { trailAnchorForModel, visualCenterForModel } from './modelVisualAnchor.js';
import { pickRenderAltitudeM } from './renderAltitude.js';
import { tr3bAircraftClass, tr3bTypeLabel } from './tr3bRegistry.js';

/** @constant {string} API endpoint proxied to adsb.lol military feed */
const API_URL = '/api/adsblol/mil';
/** @constant {number} Base billboard display scale */
const BILLBOARD_SCALE = 0.7;

// TINT: full-strength amber on the ground and in the air (owner verdict
// 2026-07-03 field test: the day-1 slate-gray 50%-alpha muted tint was
// unreadable — "in NYC I can barely see them"). "On the ground" reads from the
// ×0.8 scale + missing trail; "feed-dropped, coasting" stays the 45%-alpha
// stale fade.
/** @constant {Cesium.Color} Default amber tint for untracked military billboards */
const MIL_ICON_COLOR = Cesium.Color.fromCssColorString('#FFB800');
/** @constant {Cesium.Color} Lighter amber tint applied to the actively tracked aircraft */
const TRACKED_ICON_COLOR = Cesium.Color.fromCssColorString('#FFD166');
/** Amber fade target for the tracked billboard once the model takes over. */
const AMBER_TRANSPARENT = MIL_ICON_COLOR.withAlpha(0);

// --- 3D models --------------------------------------------------------------------------
// Military aircraft render as 3D glTF jet models once the camera is below the
// core's model ceiling. Distinct assets + amber tint set this layer apart from
// the commercial flights layer.
const JET_MODEL_URL = '/models/jet.glb';
const MODEL_NATIVE_RADIUS_M = 29.83;
// jet.glb is transform-applied at real-world scale — native bounding radius
// 29.83 m at scale 1. ×1 → ~22–43 m aircraft across CLASS_SCALE_3D, matching
// the flights layer's world sizes. At the old copied ×24, models rendered
// 600–1000 m across (invisible at the ~6 km follow range where minimumPixelSize
// dominates, but zoom under ~1 km put the camera INSIDE the plane). Locked by
// modelScale.test.mjs.
const MODEL_SCALE = 1;
// Grounded-model belly offset: jet.glb's centred origin sits 5.631 native units (= meters — this
// asset is real-world scale) ABOVE its lowest vertex (glTF Y-up scene AABB with node
// transforms applied — same reader as modelScale.test.mjs, measured 2026-07-03).
// × MODEL_SCALE(1) × class multiplier ≈ 4.4–8.6 m of lift, so a ground-snapped model
// rests its lowest geometry (gear/belly) ON the sampled tile skin instead of sinking to
// the fuselage-centerline origin. Locked against the GLB by modelScale.test.mjs.
const MODEL_BELLY_OFFSET_NATIVE = 5.631;
// airplane.glb (the shared 747) constants for this layer's heavy classes. The
// asset has its former 24× runtime calibration baked into transform-applied
// meter-scale geometry; these values mirror the flights layer and are
// regression-pinned.
const PLANE_MODEL_URL = '/models/airplane.glb';
const PLANE_MODEL_SCALE = 1;
const PLANE_NATIVE_RADIUS_M = 34.41;
const PLANE_BELLY_OFFSET_NATIVE = 6.719;

/** Per-class model spec for THIS layer (2026-08-16, owner playtest ask:
 *  military contacts should read as their WEIGHT CLASS, always in this layer's
 *  amber). Real Hangar GLBs serve the classes they cover (meters);
 *  airliner/quadjet/glider get the shared 747 silhouette (airplane.glb —
 *  C-5M/RC-135-style heavies stop rendering as bizjets); fastjet and unknown
 *  keep jet.glb. Every aircraft GLB is exported nose −X, the core's default
 *  heading offset. The core's MIX tint stays dominant everywhere — military is
 *  amber, tracked is TRACKED_ICON_COLOR, and the tint must dominate any livery
 *  (owner: "stays yellow"). */
function modelSpec(klass) {
  const real = CLASS_MODEL_REAL[klass];
  if (real) {
    return {
      url: real.url,
      scale: 1,
      nativeRadiusM: real.radiusM,
      bellyM: real.bellyM,
      visualCenterNative: visualCenterForModel(real.url),
      trailAnchorNative: trailAnchorForModel(real.url),
    };
  }
  if (klass === 'airliner' || klass === 'quadjet' || klass === 'glider') {
    const scale = PLANE_MODEL_SCALE * (CLASS_SCALE_3D[klass] || 1);
    return {
      url: PLANE_MODEL_URL,
      scale,
      nativeRadiusM: PLANE_NATIVE_RADIUS_M,
      bellyM: PLANE_BELLY_OFFSET_NATIVE * scale,
      visualCenterNative: visualCenterForModel(PLANE_MODEL_URL),
      trailAnchorNative: trailAnchorForModel(PLANE_MODEL_URL),
    };
  }
  const scale = MODEL_SCALE * (CLASS_SCALE_3D[klass] || 1);
  return {
    url: JET_MODEL_URL,
    scale,
    nativeRadiusM: MODEL_NATIVE_RADIUS_M,
    bellyM: MODEL_BELLY_OFFSET_NATIVE * scale,
    visualCenterNative: visualCenterForModel(JET_MODEL_URL),
    trailAnchorNative: trailAnchorForModel(JET_MODEL_URL),
  };
}

// --- Landed-plane fast cull (owner field report 2026-07-02: "phantom" planes
// lingered ~2 min at airports after touchdown). Thresholds: below ~500 ft baro
// (≈150 m MSL — near-sea-level fields only; a high-elevation airport ghost falls
// back to the normal grace) AND below ~45 kts ground speed (≈23 m/s —
// rollout/taxi; nothing in normal FLIGHT is this slow, so cruise planes always
// keep the full grace).
/** @constant {number} Max baro altitude (ft, MSL) for the landed fast cull (~150 m). */
const LANDED_ALT_MAX_FT = 500;
/** @constant {number} Max ground speed (m/s) for the landed fast cull (~45 kts). */
const LANDED_SPEED_MAX_MPS = 23;
// Field-test fix (RS46, 2026-07-06): only contacts rendering below this
// ellipsoidal height get the below-ground floor clamp + a coarse floor-cell
// warm. Terrain outside the extreme Himalaya tops out well under this, so
// cruise traffic (which can never be below ground) costs zero terrain
// lookups; low pattern/heli work — the class that actually clips hillsides —
// gets the floor.
/** @constant {number} Max render altitude (m, ellipsoidal) eligible for the ground-floor clamp. */
const GROUND_FLOOR_WARM_MAX_ALT_M = 4500;

/**
 * Coerce a value to a finite number, returning null if not possible.
 * Handles both numeric and string inputs (e.g. API fields that may arrive as strings).
 * @param {*} value - Raw value from the API response
 * @returns {number|null} Finite number or null
 */
function toFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number.parseFloat(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Format an altitude value in feet for display, with fallback text.
 * @param {number|null|undefined} altitudeFt - Barometric altitude in feet
 * @returns {string} Formatted altitude string (e.g. "35000 ft" or "Alt unknown")
 */
function formatAltitude(altitudeFt) {
  if (!Number.isFinite(altitudeFt)) return 'Alt unknown';
  return `${Math.round(altitudeFt)} ft`;
}

// --- adsb.lol feed ---------------------------------------------------------------------

function isUsableMilitaryAircraft(aircraft) {
  if (!aircraft || Array.isArray(aircraft) || typeof aircraft !== 'object') return false;
  if (typeof aircraft.hex !== 'string' || !normalizeIcao(aircraft.hex)) return false;
  return Number.isFinite(toFiniteNumber(aircraft.lon))
    && Number.isFinite(toFiniteNumber(aircraft.lat));
}

/**
 * Read one adsb.lol response: a 429 gets the LONGER cooldown and a friendly
 * rate-limit label instead of the generic transient backoff, so we don't
 * hammer the upstream and the UI reads honestly. A success yields the usable
 * aircraft rows.
 * @param {Response} response
 * @param {{signal: AbortSignal}} options
 * @returns {Promise<object>} `{ failure }` or `{ rows }`.
 */
async function readAdsbLolSnapshot(response, { signal }) {
  if (!response.ok) {
    if (response.status === 429) {
      return { failure: { longBackoff: true, error: 'adsb.lol rate limited' } };
    }
    let detail = '';
    try {
      const body = await response.json();
      signal.throwIfAborted();
      detail = cleanText(body?.error || body?.message);
    } catch {
      detail = '';
    }
    return { failure: { longBackoff: false, error: detail || `adsb.lol HTTP ${response.status}` } };
  }

  // adsb.lol returns { ac: [...aircraft], msg: "...", ... }
  const data = await response.json();
  signal.throwIfAborted();
  if (!data || !Array.isArray(data.ac)) {
    return { failure: { longBackoff: false, error: 'Malformed adsb.lol response' } };
  }

  const rows = data.ac.filter(isUsableMilitaryAircraft);
  if (data.ac.length > 0 && rows.length === 0) {
    return { failure: { longBackoff: false, error: 'Malformed adsb.lol aircraft rows' } };
  }
  return { rows };
}

/**
 * One adsb.lol aircraft record's identity and position. Fields used by the
 * record builder: hex (ICAO), lon, lat, alt_baro (ft, barometric/MSL),
 * alt_geom (ft, geometric/WGS84 ellipsoidal — probed live 2026-07-05: present
 * on ~45% of records; readsb omits it when the aircraft hasn't reported a
 * geometric altitude this cycle), track (deg true), gs (ground speed in
 * knots), seen_pos (age of last position, seconds), flight (callsign), t
 * (type), r (registration), ownOp (operator).
 */
function parseAdsbLolRow(aircraft) {
  return {
    icao24: cleanText(aircraft?.hex).toLowerCase(),
    lat: toFiniteNumber(aircraft?.lat),
    lon: toFiniteNumber(aircraft?.lon),
    aircraft,
  };
}

/**
 * Turn one adsb.lol aircraft into the layer's record and pick where it
 * renders. See the core's update() for the bookkeeping around it.
 * @returns {{meta: object, fixEpochMs: number}}
 */
function buildAdsbLolRecord({ aircraft, lat, lon }, prevMeta, { geoidN, modelOwnsVisual, floorWarmPoints, receiptNowMs }) {
  // adsb.lol/readsb reports GROUND traffic as alt_baro === "ground" (no
  // separate boolean). Grounded planes fall back to their last known
  // altitude (field elevation is unknowable here), else 0 m — never the
  // 3 km airborne default (a parked plane must not float).
  const rawAltBaro = aircraft?.alt_baro;
  const onGround = typeof rawAltBaro === 'string' && rawAltBaro.trim().toLowerCase() === 'ground';
  const altitudeFt = toFiniteNumber(rawAltBaro);
  const altitudeM = Number.isFinite(altitudeFt)
    ? altitudeFt * 0.3048
    : (onGround
      ? (Number.isFinite(prevMeta?.altitudeFt) ? prevMeta.altitudeFt * 0.3048 : 0)
      : 3048);
  const track = toFiniteNumber(aircraft?.track) || 0;
  // Convert ground speed from knots to meters/sec for dead reckoning
  const speedKt = toFiniteNumber(aircraft?.gs);
  const speedMps = Number.isFinite(speedKt) ? speedKt * 0.514444 : 0;
  // Analyst seam (additive): readsb baro_rate is ft/min; keep m/s.
  const baroRateFtMin = toFiniteNumber(aircraft?.baro_rate);
  const verticalRateMps = Number.isFinite(baroRateFtMin) ? baroRateFtMin * 0.00508 : null;

  const callsign = cleanText(aircraft?.flight);
  const type = cleanText(aircraft?.t);
  const registration = cleanText(aircraft?.r);
  const operator = cleanText(aircraft?.ownOp);
  const seenSec = toFiniteNumber(aircraft?.seen);

  // Height-datum fix (Task 7, mirror of the flights layer's Task 6): `altitudeM`
  // (above) stays the AVIATION field — the sticky barometric/MSL altitude
  // read by labels (FL/altitude readout) and the landed-fast-cull
  // heuristic. It is NEVER overwritten or renamed. Where the aircraft
  // actually RENDERS on the ellipsoidal globe (billboard path only — a
  // ground-snapped 3D MODEL uses groundSnap.js's own tileset sample and
  // ignores this value entirely) is a SEPARATE value, renderAltitudeM:
  // alt_geom when readsb reports it (already WGS84 ellipsoidal), else
  // alt_baro+geoid as a visual fallback, else ground surface when parked.
  const altGeomFt = toFiniteNumber(aircraft?.alt_geom);
  const geoAltitudeM = Number.isFinite(altGeomFt) ? altGeomFt * 0.3048 : null;
  const baroAltitudeM = Number.isFinite(altitudeFt) ? altitudeFt * 0.3048 : null;

  // GROUND-SNAP INTERPLAY (brief item 3 — "don't double-correct"): a
  // grounded plane's MODEL already rides groundSnap.js's one-shot tileset
  // sample (_modelDisplayPosition), which is the visual on the ground, and
  // its billboard is depth-test-free (_groundDepthDistance) so its exact
  // height is cosmetic. Deliberately pass surfaceM=null so
  // pickRenderAltitudeM's on-ground surface branch never fires here:
  //  1. It would be the SECOND correction of the same grounded plane
  //     (model tileset-snap is the first) — the exact double-correct the
  //     brief forbids.
  //  2. Military ground rows carry NO baro ("alt_baro":"ground"), so the
  //     grounded billboard sits at 0 m until a surface value warms; letting
  //     surfaceM then jump it 0 -> ~surface (often ~100 m) BETWEEN polls
  //     drags the model's ground-snap input past groundSnap's 50 m
  //     move-invalidation threshold and forces a re-sample every time the
  //     cache warms — breaking the ONE-SHOT-per-(camera,regime) invariant
  //     the track regression locks (qa: sampleHeight count must stay flat).
  // Grounded planes therefore keep the pre-existing `altitudeM` default
  // (last-known baro / 0). The datum fix (alt_geom -> baro+geoidN) is what
  // matters for AIRBORNE military planes — the actual "renders at MSL" bug.
  const pickedAltM = pickRenderAltitudeM({
    geoAltM: geoAltitudeM,
    baroAltM: baroAltitudeM,
    onGround,
    surfaceM: null,
    geoidN,
  });
  // pickRenderAltitudeM returns the sentinel `null` only when NEITHER
  // alt_geom nor alt_baro was ever reported for this aircraft (not even
  // stickily) — fall back to the SAME existing default policy `altitudeM`
  // already uses (which also carries the on-ground 0 m / last-known-baro
  // case), so the two never disagree on the "no data yet" case.
  let renderAltitudeM = pickedAltM != null ? pickedAltM : altitudeM;
  // Field-test fix (RS46 heli-in-hillside, 2026-07-06): a baro-only
  // AIRBORNE contact near steep terrain can compute a render height
  // BELOW the local surface (no alt_geom; baro+N carries QNH error
  // larger than the height above ground). Floor it at the coarse-grid
  // ellipsoidal ground (warm-cache read only — the batch warm after the
  // loop fills cells for later polls). Grounded contacts are handled below.
  if (!onGround && renderAltitudeM < GROUND_FLOOR_WARM_MAX_ALT_M) {
    renderAltitudeM = floorAltitudeM(renderAltitudeM, cachedGroundFloor(lat, lon));
    floorWarmPoints.push({ lat, lon });
  } else if (onGround) {
    // Grounded contacts: warm the floor cell, and — round 4 — when NO
    // 3D model owns this contact's visual, lift the billboard itself
    // onto the floor (mesh-first): the R20053 heli sat "straight up in
    // the ground" because grounded rows render at the legacy ~0 m.
    // With a model present the billboard stays put (it hides behind
    // the tileset-snapped model, and moving it would drag groundSnap's
    // input past its move-invalidation threshold — the T7 one-shot
    // invariant the track regression locks).
    floorWarmPoints.push({ lat, lon });
    if (!modelOwnsVisual()) {
      const floor = cachedGroundFloor(lat, lon);
      if (Number.isFinite(floor)) {
        renderAltitudeM = floorAltitudeM(renderAltitudeM, floor);
      }
    }
  }

  // Sticky merge — adsb.lol intermittently drops flight/t/r/ownOp; hold
  // last-known-good (bounded by the layer's eviction, which deletes the entry).
  const stickyType = stickyText(type, prevMeta?.type);
  const meta = {
    callsign: stickyText(callsign, prevMeta?.callsign),
    type: stickyType,
    // Type outranks category automatically inside classifyAircraft.
    klass: classifyAircraft({ typeCode: stickyType, category: aircraft?.category }),
    registration: stickyText(registration, prevMeta?.registration),
    operator: stickyText(operator, prevMeta?.operator),
    altitudeFt: stickyNumber(altitudeFt, prevMeta?.altitudeFt, null),
    // geoAltitudeM/renderAltitudeM are ADDITIVE fields alongside the
    // untouched aviation `altitudeFt` — never rename/replace it (labels,
    // the FL readout, and the landed-fast-cull heuristic all still read
    // altitudeFt/baro).
    geoAltitudeM,
    renderAltitudeM,
    speedMps: stickyNumber(speedMps, prevMeta?.speedMps, null),
    track: stickyNumber(track, prevMeta?.track, null),
    // Analyst seam (additive): sticky like the other kinematics.
    verticalRateMps: stickyNumber(verticalRateMps, prevMeta?.verticalRateMps, null),
    lastContactEpochMs: stickyNumber(
      Number.isFinite(seenSec) ? receiptNowMs - seenSec * 1000 : null,
      prevMeta?.lastContactEpochMs,
      null,
    ),
    turnRateDps: prevMeta?.turnRateDps || 0,
    onGround,
    // Round 7: sticky airborne history (see the core's _likelyLanded).
    wasAirborne: prevMeta?.wasAirborne === true || !onGround,
    // Round 6: lifted occlusion-test point for at/below-ellipsoid renders
    // (the fleet pass's occluder reads it).
    cullPosition: renderAltitudeM < 10 ? Cesium.Cartesian3.fromDegrees(lon, lat, 12) : null,
    // Raw poll-fix coords (pre-dead-reckon) — the stale-grounded re-floor
    // sweep keys floors off these.
    rawLat: lat,
    rawLon: lon,
  };

  // adsb.lol's seen_pos is the AGE in seconds of the last position report,
  // so the fix epoch is receipt time minus that age.
  const seenPos = toFiniteNumber(aircraft?.seen_pos);
  const fixEpochMs = receiptNowMs - (Number.isFinite(seenPos) ? seenPos * 1000 : 0);
  return { meta, fixEpochMs };
}

/**
 * The tracked aircraft's readsb trace for the trail backfill. A trace point's
 * altitude is barometric feet (the same datum as the live alt_baro, NOT
 * geometric): [secondsAfterTimestamp, lat, lon, alt_ft|'ground'|null, gs_kt,
 * track, flags, ...].
 * @param {string} icao24
 * @returns {Promise<object|null>} `{ points, leadingAltM, thinToBudget }`, or null.
 */
async function fetchAdsbLolTrace(icao24) {
  const response = await fetch('/api/adsblol/trace?hex=' + encodeURIComponent(icao24), {
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return null;
  const data = await response.json();
  const baseEpochSec = Number(data?.timestamp);
  const trace = Array.isArray(data?.trace) ? data.trace : null;
  if (!trace || !Number.isFinite(baseEpochSec)) return null;
  const points = [];
  for (const point of trace) {
    if (!Array.isArray(point)) continue;
    const altFt = point[3];
    points.push({
      t: baseEpochSec + Number(point[0]),
      lat: Number(point[1]),
      lon: Number(point[2]),
      // A 'ground'/null point sits ON the local surface once its floor is
      // warm — the old fixed 50 m sentinel rendered ~1.5 km underground at
      // Kirtland AFB (field ~1590 m ellipsoidal) and dragged the whole
      // pattern-work loop with it.
      baroAltM: (altFt === 'ground' || altFt == null || !Number.isFinite(Number(altFt)))
        ? null
        : Number(altFt) * 0.3048,
    });
  }
  // Leading points with nothing to carry keep the old low breadcrumb sentinel
  // (an arbitrary placeholder, never a reported altitude). Traces run long,
  // so the backfill is stride-thinned to fit the trail cap.
  return { points, leadingAltM: 50, thinToBudget: true };
}

/** @type {Cesium.Cartographic} Scratch for trailFloorPosition (per-frame safe). */
const _scratchTrailCarto = new Cesium.Cartographic();

/**
 * Field-test round 2 (2026-07-06): floors a trail-bound position at the warm
 * coarse ground cell — a pure LIFT (above-floor positions pass through
 * untouched, unknown floors change nothing). Grounded military billboards
 * deliberately render at the pre-datum default height (T7 groundSnap
 * invariant), so every position entering the TRAIL subsystem (seed, append,
 * per-frame head) goes through this instead — the visible taxi history sits
 * on the surface without touching the billboard/model machinery.
 * @param {Cesium.Cartesian3} position - Owned position (mutated/replaced freely).
 * @returns {Cesium.Cartesian3} The same or a lifted position.
 */
function trailFloorPosition(position) {
  const carto = Cesium.Cartographic.fromCartesian(position, Cesium.Ellipsoid.WGS84, _scratchTrailCarto);
  if (!carto) return position;
  const latDeg = Cesium.Math.toDegrees(carto.latitude);
  const lonDeg = Cesium.Math.toDegrees(carto.longitude);
  const floored = floorAltitudeM(carto.height, cachedGroundFloor(latDeg, lonDeg));
  if (floored == null || floored === carto.height) return position;
  return Cesium.Cartesian3.fromDegrees(lonDeg, latDeg, floored);
}

// --- Wording ------------------------------------------------------------------------------

/**
 * Build the multi-line presentation text for the protected tracked host card.
 * Lines: callsign, type/registration, operator/altitude. `stale` puts a
 * "· STALE" cue on the first line while the plane is in its missed-poll grace.
 * @param {string} icao24 - ICAO hex identifier (fallback display name)
 * @param {Object|null} info - Flight metadata from the layer's records
 * @param {{stale: boolean}} cues
 * @returns {string} Newline-separated label text
 */
function trackedLabelText(icao24, info, { stale }) {
  const callsign = (cleanText(info?.callsign) || cleanText(info?.registration) || icao24)
    + (stale ? ' · STALE' : '');
  // Converted contacts report their class as TR-3B — that override is exactly
  // what the Easter egg replaces the real type with.
  const type = tr3bTypeLabel(icao24, cleanText(info?.type) || 'Type unknown');
  const registration = cleanText(info?.registration) || 'Reg unknown';
  const operator = cleanText(info?.operator) || 'Operator unknown';
  const altitude = formatAltitude(info?.altitudeFt);
  const speedKt = info?.speedMps ? Math.round(info.speedMps * 1.944) : null;
  const tail = speedKt ? `${altitude} · ${speedKt} kt` : altitude;
  return [
    callsign,
    `${type} · ${registration}`,
    `${operator} · ${tail}`,
  ].join('\n');
}

/** Context-slot wording: operator, converted type, and altitude in feet. */
function contextProperties(icao24, described, info) {
  return {
    operator: cleanText(info?.operator) || '',
    // Converted contacts report their class as TR-3B — the same override
    // the readout and Contacts card show.
    type: tr3bTypeLabel(icao24, cleanText(info?.type) || ''),
    altitude: described.onGround ? 'on ground' : formatAltitude(info?.altitudeFt),
  };
}

/** getNearby's per-contact fields beyond the shared label, identity and distance. */
function nearbyFields(icao24, info) {
  return {
    aircraftClass: tr3bAircraftClass(icao24, String(info?.klass || info?.type || '').trim().toLowerCase() || null),
    track: info?.track ?? null,
    // Display type — converted too, so a Contacts row can't still name the
    // airframe the triangle replaced (the filter matcher reads this as a
    // fallback candidate as well).
    type: tr3bTypeLabel(icao24, info?.type || null),
    registration: info?.registration || null,
    operator: info?.operator || null,
    altitudeFt: info?.altitudeFt ?? null,
  };
}

/** Detection card class and altitude metric. */
function labelDetection(object, icao24, info) {
  // detectionDraw composes the card's secondary line from `[src.klass,
  // src.metric]`, so a converted contact's card must name the TR-3B, not the
  // airframe underneath it.
  const klass = tr3bTypeLabel(icao24, info?.type || 'MIL');
  if (object.klass !== klass) object.klass = klass;
  const altitudeFt = info?.altitudeFt ?? 0;
  if (object._altitudeFt !== altitudeFt) {
    object._altitudeFt = altitudeFt;
    // military metadata stores altitudeFt (feet); the helper takes metres
    object.metric = formatFlightLevel(altitudeFt * 0.3048);
  }
}

/**
 * Map one military aircraft's internal poll record to a plain JSON-safe
 * analyst record (analyst query engine seam) — same shape as the flights
 * layer's mapAnalystRecord, with `military` always true. Pure — no Cesium
 * types, no fetches. Missing/unknown fields are null, never NaN/undefined.
 * adsb.lol carries no origin-country field and this layer has no route
 * enrichment, so originCountry/routeOrigin/routeDestination are always null.
 * @param {string} icao24 - ICAO hex identifier of the aircraft.
 * @param {Object|null|undefined} info - The layer's record for this aircraft.
 * @returns {{id: string, icao24: string, callsign: string|null, lat: number|null,
 *   lon: number|null, altitudeM: number|null, speedMps: number|null,
 *   heading: number|null, verticalRateMps: number|null, onGround: boolean,
 *   military: boolean, aircraftClass: string|null, originCountry: null,
 *   operator: string|null, routeOrigin: null, routeDestination: null}}
 */
export function mapAnalystRecord(icao24, info) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const text = (v) => { const t = String(v ?? '').trim(); return t || null; };
  const callsign = text(info?.callsign);
  return {
    id: callsign || text(info?.registration) || icao24,
    icao24,
    callsign,
    lat: num(info?.rawLat),
    lon: num(info?.rawLon),
    // altitudeFt is the sticky barometric/MSL aviation field — converted to
    // meters here for shape parity with the flights layer.
    altitudeM: Number.isFinite(info?.altitudeFt) ? info.altitudeFt * 0.3048 : null,
    speedMps: num(info?.speedMps),
    heading: num(info?.track),
    verticalRateMps: num(info?.verticalRateMps),
    onGround: info?.onGround === true,
    military: true,
    // A converted contact reports the class it RENDERS as (as in the flights
    // layer), so an analyst filter/superlative agrees with the triangle.
    aircraftClass: tr3bAircraftClass(icao24, text(info?.klass)),
    originCountry: null,
    operator: text(info?.operator),
    routeOrigin: null,
    routeDestination: null,
  };
}

const { layer: militaryFlightsLayer, exports: core } = createAircraftLayer({
  id: 'military',
  name: 'Military Flights',
  icon: '🎖️',
  focusOwner: 'militaryFlights',
  logLabel: 'Military',
  feedName: 'adsb.lol',
  sourceName: 'adsb.lol',
  updateInterval: 15000,
  renderDelaySec: 15,
  trackingParam: 'selectedMilitaryTrackingId',
  trailColor: '#FFB800',
  trailHeadIdPrefix: 'mil',
  trackedLabelColor: '#ffd166',
  fleetColor: () => MIL_ICON_COLOR,
  cockpitFarColor: () => MIL_ICON_COLOR,
  trackedColor: TRACKED_ICON_COLOR,
  trackedFadeColor: AMBER_TRANSPARENT,
  billboardScale: BILLBOARD_SCALE,
  modelSpec,
  preloadModelUrl: JET_MODEL_URL,
  // The adsb.lol feed and its records: feet for altitude, m/s and degrees
  // for the kinematics.
  feedUrl: () => API_URL,
  readSnapshot: readAdsbLolSnapshot,
  parseRow: parseAdsbLolRow,
  buildRecord: buildAdsbLolRecord,
  fetchTrack: fetchAdsbLolTrace,
  speedMpsOf: (info) => info?.speedMps,
  trackDegOf: (info) => info?.track,
  altitudeMOf: (info) => (Number.isFinite(info?.altitudeFt) ? info.altitudeFt * 0.3048 : null),
  verticalRateMpsOf: (info) => info?.verticalRateMps,
  isLowAndSlow: (info) => Number.isFinite(info.altitudeFt) && info.altitudeFt < LANDED_ALT_MAX_FT
    && Number.isFinite(info.speedMps) && info.speedMps < LANDED_SPEED_MAX_MPS,
  // Grounded billboards keep the pre-datum height a tileset-snapped model
  // needs (the T7 one-shot invariant), so trails are floored instead and the
  // stale re-floor leaves model-owned contacts alone.
  trailFloor: trailFloorPosition,
  groundFloorYieldsToModels: true,
  // The flights layer suppresses its military duplicates while this layer
  // renders them, and takes them back (amber) while it is off; the registry
  // it classifies them by is fed from every poll.
  onEnable: () => setMilitaryLayerActive(true),
  onDisable: () => setMilitaryLayerActive(false),
  afterPoll: (currentIcaos) => registerMilitaryIcaos(currentIcaos),
  statsFields: { fallback: false },
  detectionFields: { tier: 'military' },
  trackedLabelText,
  contextProperties,
  nearbyFields,
  labelDetection,
  analystRecord: (icao24, info) => mapAnalystRecord(icao24, info),
});

Object.assign(militaryFlightsLayer, {
  /** @deprecated Compatibility alias for {@link enable}. */
  show(viewer) {
    this.enable(viewer);
  },

  /** @deprecated Compatibility alias for {@link disable}. */
  hide(viewer) {
    this.disable(viewer);
  },
});

export const {
  TRACKED_MODEL_MAX_PX,
  _setTrackedRefreshStateForTest: _setTrackedMilitaryRefreshStateForTest,
  _setTrackingRefreshOutcomeForTest: _setMilitaryTrackingRefreshOutcomeForTest,
  _addTrackingCandidateForTest: _addMilitaryTrackingCandidateForTest,
  _pendingTrackingRestoreForTest: _pendingMilitaryTrackingRestoreForTest,
  _applyPendingTrackingRestoreForTest: _applyPendingMilitaryTrackingRestoreForTest,
  _setCockpitDetectionSubjectForTest,
  _trackedModelRegimeActiveForTest,
  _updateTrackedModelForTest,
  _trackedBillboardColorForTest,
  _driveFleetModelHandoffForTest,
  _ensureFleetModelForTest,
} = core;

export default militaryFlightsLayer;
