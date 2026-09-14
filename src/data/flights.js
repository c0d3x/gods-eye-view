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
import * as Cesium from 'cesium';
import {
  CLASS_MODEL_REAL,
  CLASS_MODEL_URL,
  CLASS_SCALE_3D,
  classifyAircraft,
} from './aircraftClass.js';
import {
  approxDistanceKm,
  contactLabel,
  createAircraftLayer,
  normalizeIcao,
} from './aircraftLayerCore.js';
import { stickyNumber, stickyText } from './aircraftMeta.js';
import { formatFlightLevel } from './detectionDraw.js';
import { cachedGroundFloor, floorAltitudeM } from './groundFloor.js';
import { isMilitaryIcao } from './militaryRegistry.js';
import {
  trailAnchorForModel,
  visualCenterForModel,
} from './modelVisualAnchor.js';
import {
  geoidSurfaceLastResortM,
  pickRenderAltitudeM,
} from './renderAltitude.js';
import { isTr3b, tr3bAircraftClass, tr3bTypeLabel } from './tr3bRegistry.js';

/** Amber tint for known-military aircraft rendered by this layer (matches the military layer's icon color). */
const MIL_TINT = Cesium.Color.fromCssColorString('#FFB800');
/** Cockpit's far-contact dot for a civil aircraft. */
const COCKPIT_CIVILIAN_COLOR = Cesium.Color.fromCssColorString('#DCEEFF');

// Landed fast-cull thresholds (see the core's _likelyLanded): below ~150 m baro
// (MSL, so this only fires near sea-level-ish fields — deliberately
// conservative; a high-elevation airport ghost just falls back to the normal
// grace) AND below ~45 kts ground speed (≈23 m/s — rollout/taxi; nothing in
// normal FLIGHT is this slow, so cruise planes always keep the full grace that
// absorbs real feed gaps).
/** @constant {number} Max baro altitude (m, MSL) for the landed fast cull. */
const LANDED_ALT_MAX_M = 150;
/** @constant {number} Max ground speed (m/s) for the landed fast cull (~45 kts). */
const LANDED_SPEED_MAX_MPS = 23;

// --- 3D models -------------------------------------------------------------------------
const PLANE_MODEL_URL = '/models/airplane.glb';
const MODEL_NATIVE_RADIUS_M = 34.41;
const MODEL_SCALE = 1; // airplane.glb is transform-applied and baked to real-world meters
// Grounded-model belly offset: airplane.glb's centred origin sits 6.719 m ABOVE its
// lowest vertex (glTF Y-up scene AABB with node transforms applied — same reader as
// modelScale.test.mjs, measured after its 24× transform bake). × class multiplier ≈ 5.0–9.7 m
// of lift, so a ground-snapped model rests its lowest geometry (gear/belly) ON the sampled
// tile skin instead of sinking to the fuselage-centerline origin. Locked against the GLB
// by modelScale.test.mjs.
const MODEL_BELLY_OFFSET_NATIVE = 6.719;

/** Per-class model spec. Hangar-fleet classes (CLASS_MODEL_REAL) ship GLBs
 *  vertex-baked to real-world METERS in the airplane.glb axis convention, so
 *  they render at scale 1 with their own measured belly lift and bounding
 *  radius. Every other class keeps the shared-airplane.glb formula
 *  (MODEL_SCALE × CLASS_SCALE_3D). nativeRadiusM is PER SCALE UNIT — pixel-cap
 *  math multiplies it by `scale`, so world radius = nativeRadiusM × scale in
 *  both branches. The core's code-side MIX tint dominates every existing asset
 *  so class silhouettes stay light without modifying third-party GLBs/textures. */
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
  const scale = MODEL_SCALE * (CLASS_SCALE_3D[klass] || 1);
  const url = CLASS_MODEL_URL[klass] || PLANE_MODEL_URL;
  return {
    url,
    scale,
    nativeRadiusM: MODEL_NATIVE_RADIUS_M,
    bellyM: MODEL_BELLY_OFFSET_NATIVE * scale,
    visualCenterNative: visualCenterForModel(url),
    trailAnchorNative: trailAnchorForModel(url),
  };
}

// --- OpenSky feed ------------------------------------------------------------------------

/** @constant {string} API_URL - Vite proxy endpoint for OpenSky /states/all */
const API_URL = '/api/opensky';
/** A snapshot older than this keeps the layer's STALE cue up. */
const SOURCE_STALE_MS = 120_000;
// Field-test rounds 1+3 (2026-07-06): below-ground floor clamp scope. Only
// contacts rendering below the alt ceiling are ever clamped/warmed (terrain
// tops out well under it outside the extreme Himalaya; cruise traffic can't
// be below ground and costs zero lookups). The radius bounds the FLEET clamp
// to viewer-visible traffic — clamping thousands of global contacts would
// need unbounded terrain resolution (the tracked contact clamps regardless).
/** @constant {number} Max render altitude (m, ellipsoidal) eligible for the ground-floor clamp. */
const GROUND_FLOOR_WARM_MAX_ALT_M = 4500;
/** @constant {number} Max viewer distance (km) for the fleet ground-floor clamp. */
const GROUND_FLOOR_CLAMP_RADIUS_KM = 150;

/** The OpenSky proxy URL, centered on the camera once it has a position. */
function openSkyUrl(viewer) {
  const cartographic = viewer?.camera?.positionCartographic;
  if (!cartographic) return API_URL;
  const latitude = Cesium.Math.toDegrees(cartographic.latitude);
  const longitude = Cesium.Math.toDegrees(cartographic.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return API_URL;
  const params = new URLSearchParams({
    lat: latitude.toFixed(4),
    lon: longitude.toFixed(4),
  });
  return `${API_URL}?${params}`;
}

/**
 * Normalize a value to a trimmed lowercase string.
 * @param {*} value - Any value (typically a header string or null).
 * @returns {string} Lowercase trimmed string, or '' if falsy.
 */
function toLowerText(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

/**
 * Map OpenSky proxy response headers into a human-readable auth error string.
 * The Vite proxy forwards `x-opensky-auth-mode-used` and `x-opensky-auth-reason`
 * headers so the client can display a meaningful diagnostic.
 * @param {object} params
 * @param {string} params.detail  - Error body text from the proxy, if any.
 * @param {string} params.authMode - Normalized auth mode header value.
 * @param {string} params.authReason - Normalized auth reason header value.
 * @returns {string} Concise error description for UI display.
 */
function deriveOpenSkyAuthError({ detail, authMode, authReason }) {
  const reason = toLowerText(authReason);
  const mode = toLowerText(authMode);

  if (reason === 'oauth_invalid_or_missing') {
    return 'OpenSky OAuth client missing/invalid';
  }
  if (reason === 'oauth_invalid_credentials') {
    return 'OpenSky OAuth rejected credentials';
  }
  if (reason === 'basic_invalid_credentials') {
    return 'OpenSky username/password rejected';
  }
  if (
    reason === 'missing_basic_creds' ||
    reason === 'missing_oauth_and_basic_creds'
  ) {
    return 'OpenSky auth missing';
  }
  if (reason === 'auth_required') {
    return 'OpenSky auth required';
  }
  if (reason.startsWith('oauth_') || reason.startsWith('basic_')) {
    return 'OpenSky auth invalid';
  }
  if (reason === 'forced_anonymous' || mode === 'anon') {
    return 'OpenSky auth required';
  }
  if (detail) return detail;
  return 'OpenSky auth failed';
}

function isUsableOpenSkyState(state) {
  if (
    !Array.isArray(state) ||
    typeof state[0] !== 'string' ||
    !normalizeIcao(state[0])
  ) {
    return false;
  }
  return Number.isFinite(state[5]) && Number.isFinite(state[6]);
}

/** An error body's `error` text, or '' when the body is missing or unreadable. */
async function errorDetail(response, signal) {
  try {
    const body = await response.json();
    signal.throwIfAborted();
    return typeof body?.error === 'string' ? body.error.trim() : '';
  } catch {
    return '';
  }
}

/**
 * Read one OpenSky proxy response: HTTP 429 (rate limit) and 401/403 (auth)
 * back off for longer than other failures; a success yields the usable state
 * vectors, the snapshot time and the source the proxy served.
 * @param {Response} response
 * @param {{signal: AbortSignal}} options
 * @returns {Promise<object>} `{ failure }` or `{ rows, sourceEpochMs, staleError, source, coverage }`.
 */
async function readOpenSkySnapshot(response, { signal }) {
  const responseSource = response.headers.get('x-flight-source');
  const responseCoverage = response.headers.get('x-flight-coverage');
  const authMode = toLowerText(
    response.headers.get('x-opensky-auth-mode-used') ||
      response.headers.get('x-opensky-auth'),
  );
  const authReason = toLowerText(response.headers.get('x-opensky-auth-reason'));

  if (response.status === 429) {
    console.warn('[Data:Flights] Rate limited, backing off to 30s');
    return {
      failure: {
        longBackoff: true,
        error:
          authMode && authMode !== 'anon'
            ? 'OpenSky rate limited'
            : 'OpenSky rate limited (anonymous)',
      },
    };
  }

  if (response.status === 401 || response.status === 403) {
    console.warn(
      `[Data:Flights] OpenSky unavailable (${response.status}), backing off`,
    );
    const detail = await errorDetail(response, signal);
    return {
      failure: {
        longBackoff: true,
        error: deriveOpenSkyAuthError({ detail, authMode, authReason }),
      },
    };
  }

  if (!response.ok) {
    console.warn(`[Data:Flights] API returned ${response.status}`);
    const detail = await errorDetail(response, signal);
    return {
      failure: {
        longBackoff: false,
        error: detail || `OpenSky HTTP ${response.status}`,
      },
    };
  }

  const data = await response.json();
  signal.throwIfAborted();
  if (!data || !Array.isArray(data.states)) {
    return {
      failure: { longBackoff: false, error: 'Malformed OpenSky response' },
    };
  }

  const rows = data.states.filter(isUsableOpenSkyState);
  if (data.states.length > 0 && rows.length === 0) {
    return {
      failure: { longBackoff: false, error: 'Malformed OpenSky aircraft rows' },
    };
  }

  const sourceEpochMs =
    Number.isFinite(Number(data.time)) && Number(data.time) > 0
      ? Number(data.time) * 1000
      : null;
  const sourceAgeMs =
    sourceEpochMs == null ? 0 : Math.max(0, Date.now() - sourceEpochMs);
  return {
    rows,
    sourceEpochMs,
    staleError:
      sourceAgeMs > SOURCE_STALE_MS
        ? `Source snapshot ${Math.max(2, Math.round(sourceAgeMs / 60_000))} min old`
        : null,
    source: responseSource || 'OpenSky Network',
    coverage: responseCoverage || 'worldwide upstream snapshot',
  };
}

/**
 * Destructure one OpenSky state vector (indices per API spec):
 * [0] icao24, [1] callsign, [2] origin_country, [3] time_position,
 * [4] last_contact, [5] longitude, [6] latitude, [7] baro_altitude,
 * [8] on_ground, [9] velocity, [10] true_track, [11] vertical_rate,
 * [12] sensors, [13] geo_altitude (WGS84 ellipsoidal — the CORRECT
 * globe-render height when present; height-datum fix Task 6).
 */
function parseOpenSkyRow(state) {
  const [
    rawIcao24,
    callsign,
    originCountry,
    timePosition,
    lastContact,
    lon,
    lat,
    baroAlt,
    onGround,
    velocity,
    trueTrack,
    ,
    ,
    geoAlt,
  ] = state;
  return {
    icao24: normalizeIcao(rawIcao24),
    lat,
    lon,
    callsign,
    originCountry,
    timePosition,
    lastContact,
    baroAlt,
    onGround: onGround === true,
    velocity,
    trueTrack,
    geoAlt,
    category: Number.isFinite(state[17]) ? state[17] : null, // extended=1 emitter category
    verticalRate: Number.isFinite(state[11]) ? state[11] : null, // m/s, + = climbing
  };
}

/**
 * Turn one parsed state vector into the layer's record and pick where it
 * renders. See the core's update() for the bookkeeping around it.
 * @returns {{meta: object, fixEpochMs: number}}
 */
function buildOpenSkyRecord(
  contact,
  prevMeta,
  { geoidN, isTracked, viewerLatDeg, viewerLonDeg, floorWarmPoints },
) {
  const { lat, lon, onGround } = contact;
  // Grounded planes with no baro reading sit at 0 m, not the 10 km
  // airborne default (a parked plane must never float).
  // NOTE (height-datum fix): `alt` stays the AVIATION field — the sticky
  // barometric/MSL altitude read by labels (FL/altitude readout),
  // route-plausibility, and follow-camera range heuristics. It is
  // NEVER overwritten or renamed. Where the aircraft actually RENDERS
  // on the ellipsoidal globe is a SEPARATE value (renderAltitudeM,
  // below) — geo_altitude when OpenSky reports it (already WGS84
  // ellipsoidal), else baro+geoid as a visual fallback, else ground
  // surface when parked. `Cartesian3.fromDegrees` gets renderAltitudeM,
  // never `alt` directly.
  const alt = stickyNumber(
    contact.baroAlt,
    prevMeta?.altitude,
    onGround ? 0 : 10000,
  );

  // on_ground surface prior: ONLY synchronous warm-cache reads here —
  // never a per-aircraft network fetch inside the poll loop (see the
  // batch resolve call after it, which fills this cache for NEXT poll). A
  // Round 5 SIMPLIFICATION (owner directive: one floor, evenly applied):
  // the grounded surface is the round-4 choke point and nothing else —
  // rendered-mesh cell first, real (never fallback-poisoned) DEM cell
  // second. The old exact-5-decimal warm chain is GONE: it minted a new
  // key per parked-jitter poll for every grounded contact ON EARTH,
  // hammering Re:Earth into the very failures that poisoned the cache.
  let surfaceM = null;
  if (onGround) {
    surfaceM = cachedGroundFloor(lat, lon); // mesh ?? real DEM (coarse cell)
    // Taxiing crosses into a fresh cold cell every poll — always one
    // step ahead of the warm batch — so fall back to LAST poll's cell
    // (warmed by last poll's batch; aprons are flat across adjacent
    // 111 m cells). Round-5 verify caught taxiing contacts stuck at
    // the geoid without this (round 2's lesson, at cell granularity).
    if (
      surfaceM == null &&
      Number.isFinite(prevMeta?.rawLat) &&
      Number.isFinite(prevMeta?.rawLon)
    ) {
      surfaceM = cachedGroundFloor(prevMeta.rawLat, prevMeta.rawLon);
    }
    // Grounded contacts near the viewer feed the floor warm/sampler
    // (the only ones whose exact height is visible; far contacts are
    // subpixel and always-on-top anyway).
    if (
      viewerLatDeg != null &&
      approxDistanceKm(viewerLatDeg, viewerLonDeg, lat, lon) <=
        GROUND_FLOOR_CLAMP_RADIUS_KM
    ) {
      floorWarmPoints.push({ lat, lon });
    }
    // Last synchronous resort for a BRAND-NEW grounded contact with NO
    // altitude data at all (nothing warm yet, not even the coarse
    // cell): the geoid surface. At the sea-level airports where most
    // grounded traffic sits, geoidN IS the local ellipsoidal ground to
    // within metres — instantly right — and at elevated fields it is
    // far less wrong than the raw 0 m ellipsoid default for the one
    // poll until the coarse cell warms. STRICTLY gated on "no geo, no
    // baro": a reported baro already reflects the field elevation, and
    // pickRenderAltitudeM's surfaceM branch would let this crude guess
    // outrank it (caught by the ground-3d track regression).
    //
    // 2026-08-21: the rule moved to geoidSurfaceLastResortM, which adds
    // one more gate — a contact that already HAS a render height keeps
    // it. Leaving surfaceM null routes it through the sentinel path
    // below, which holds that height.
    if (surfaceM == null) {
      surfaceM = geoidSurfaceLastResortM({
        geoAltM: contact.geoAlt,
        baroAltM: contact.baroAlt,
        priorRenderM: prevMeta?.renderAltitudeM,
        geoidN,
      });
    }
  }

  const geoAltitudeM = Number.isFinite(contact.geoAlt) ? contact.geoAlt : null;
  const pickedAltM = pickRenderAltitudeM({
    geoAltM: geoAltitudeM,
    baroAltM: Number.isFinite(contact.baroAlt) ? contact.baroAlt : null,
    onGround,
    surfaceM,
    geoidN,
  });
  // pickRenderAltitudeM returns the sentinel `null` only when NEITHER
  // geo_altitude nor baro_altitude was reported THIS poll. Two fallbacks,
  // in priority order:
  //   (1) hold the previous geoid-corrected render height if we have one —
  //       a one-poll baro dropout must NOT snap the plane down by the geoid
  //       undulation N (~46 m in London) and back up next poll. `alt` stays
  //       sticky for labels, so holding the last render height keeps the two
  //       layers consistent through the gap.
  //   (2) otherwise the SAME default policy `alt` already uses, so the two
  //       never disagree on the genuine "no data yet" case (a never-reported
  //       aircraft has no prior render height, so it lands here unchanged).
  let renderAltitudeM;
  if (pickedAltM != null) {
    renderAltitudeM = pickedAltM;
  } else if (Number.isFinite(prevMeta?.renderAltitudeM)) {
    renderAltitudeM = prevMeta.renderAltitudeM;
  } else {
    renderAltitudeM = alt;
  }
  // Field-test fix (WAKE01/RS46 class, 2026-07-06; widened round 3):
  // floor a low airborne contact's render height at the local coarse
  // ground so it can never dive below the mesh. Round 3 (Austin
  // fleet-underground): baro can read BELOW an elevated field — SWA696
  // showed 450 ft at Austin's 542 ft field elevation — and rollout/taxi
  // traffic that OpenSky hasn't flagged on_ground yet renders from that
  // baro, so the whole fleet sat buried at AUS in 2D. Clamping every
  // global contact would need unbounded terrain resolution; instead the
  // clamp covers the TRACKED contact (always) plus every low contact
  // within GROUND_FLOOR_CLAMP_RADIUS_KM of the viewer — the only ones
  // whose burial is visible. Cells warm in one batch after the loop.
  // Airborne only (grounded planes keep the surface-cache path above).
  if (
    !onGround &&
    renderAltitudeM < GROUND_FLOOR_WARM_MAX_ALT_M &&
    (isTracked ||
      (viewerLatDeg != null &&
        approxDistanceKm(viewerLatDeg, viewerLonDeg, lat, lon) <=
          GROUND_FLOOR_CLAMP_RADIUS_KM))
  ) {
    renderAltitudeM = floorAltitudeM(
      renderAltitudeM,
      cachedGroundFloor(lat, lon),
    );
    floorWarmPoints.push({ lat, lon });
  }

  // Store flight metadata for click-to-track labels
  const cat = stickyNumber(contact.category, prevMeta?.category, null);
  const meta = {
    callsign: stickyText(contact.callsign, prevMeta?.callsign),
    altitude: alt,
    // geoAltitudeM/renderAltitudeM are ADDITIVE fields alongside the
    // untouched aviation `altitude` — never rename/replace it (labels,
    // FL readout, route-plausibility, and follow-camera range math all
    // still read `altitude`/baro).
    geoAltitudeM,
    renderAltitudeM,
    onGround,
    // Round 7: sticky airborne history — the landed fast-cull only
    // applies to contacts that actually flew this session.
    wasAirborne: prevMeta?.wasAirborne === true || !onGround,
    // Round 6: lifted occlusion-test point for contacts rendering
    // at/below the ellipsoid (fleet pass reads it — see the occluder
    // note there). Null for the overwhelmingly common airborne case.
    cullPosition:
      renderAltitudeM < 10 ? Cesium.Cartesian3.fromDegrees(lon, lat, 12) : null,
    velocity: stickyNumber(contact.velocity, prevMeta?.velocity, 0),
    true_track: stickyNumber(contact.trueTrack, prevMeta?.true_track, 0),
    category: cat,
    // An adsbdb-enriched type code outranks the coarse OpenSky category.
    klass: classifyAircraft({
      typeCode: prevMeta?.typeCode ?? null,
      category: cat,
    }),
    turnRateDps: prevMeta?.turnRateDps || 0,
    verticalRate: stickyNumber(
      contact.verticalRate,
      prevMeta?.verticalRate,
      null,
    ),
    // Analyst seam: OpenSky origin_country (state[2]) — additive, sticky
    // like callsign so a transient blank row doesn't blank the field.
    originCountry:
      stickyText(contact.originCountry, prevMeta?.originCountry) || null,
    // OpenSky distinguishes the last position epoch from the last
    // transponder message. The fleet coast horizon uses this actual
    // contact time so a temporarily old position does not hard-freeze
    // while fresh velocity/track messages are still arriving.
    lastContactEpochMs: stickyNumber(
      Number.isFinite(contact.lastContact) ? contact.lastContact * 1000 : null,
      prevMeta?.lastContactEpochMs,
      null,
    ),
    // adsbdb enrichment — written by the enrichment callbacks, carried across polls:
    typeCode: prevMeta?.typeCode ?? null,
    typeName: prevMeta?.typeName ?? null,
    registration: prevMeta?.registration ?? null,
    airline: prevMeta?.airline ?? null,
    route: prevMeta?.route ?? null,
    // The RAW poll fix lat/lon (this tick's OpenSky state-vector
    // coords, pre-dead-reckon) — kept distinct from the continuously
    // dead-reckoned billboard position for any consumer that needs the
    // actual reported fix.
    rawLat: lat,
    rawLon: lon,
  };

  // The FEED's fix epoch (time_position): OpenSky positions arrive 5-15 s
  // stale, so receipt time would misplace them.
  const fixEpochMs =
    Number.isFinite(contact.timePosition) && contact.timePosition > 0
      ? contact.timePosition * 1000
      : Date.now();
  return { meta, fixEpochMs };
}

/**
 * The tracked aircraft's OpenSky /tracks waypoints for the trail backfill:
 * [time, latitude, longitude, baro_altitude, true_track, on_ground]. /tracks
 * only ever reports barometric/MSL altitude, with no per-waypoint geo_altitude.
 * @param {string} icao24
 * @returns {Promise<object|null>} `{ points, leadingAltM }`, or null.
 */
async function fetchOpenSkyTrack(icao24) {
  const response = await fetch(
    `/api/opensky-track?icao24=${encodeURIComponent(icao24)}`,
    {
      signal: AbortSignal.timeout(8000),
    },
  );
  if (!response.ok) return null;
  const data = await response.json();
  if (!Array.isArray(data?.path)) return null;
  const points = [];
  for (const waypoint of data.path) {
    if (!Array.isArray(waypoint)) continue;
    const [t, lat, lon, baroAlt] = waypoint;
    points.push({
      t,
      lat,
      lon,
      baroAltM: Number.isFinite(baroAlt) ? baroAlt : null,
    });
  }
  // Leading waypoints with no baro and no warm floor keep the old 10 km
  // airborne default.
  return { points, leadingAltM: 10000 };
}

// --- Wording ------------------------------------------------------------------------------

/** Multi-line tracked presentation text: "CS · FL · kts" + "Airline · Type" +
 *  "ORIG → DEST". `route` is the enriched route, already checked for
 *  plausibility; `stale` adds the missed-poll cue to the first line. */
function trackedLabelText(icao24, info, { stale, route }) {
  if (!info) return icao24;
  // A whitespace-only callsign ("   ") is truthy, so `(info.callsign || icao24)`
  // kept it, then .trim() emptied it → the callsign slot dropped out of the
  // readout. `contactLabel` trims FIRST, then falls through registration to
  // the ICAO hex, so a callsign-less enriched contact heads its readout with
  // the tail number rather than raw hex.
  const cs = contactLabel(icao24, info);
  const altFt = Math.round((info.altitude || 0) * 3.28084);
  const fl = altFt >= 18000 ? `FL${Math.round(altFt / 100)}` : `${altFt} ft`;
  const spd = info.velocity ? `${Math.round(info.velocity * 1.944)} kts` : '';
  const lines = [
    [cs, fl, spd, stale ? 'STALE' : ''].filter(Boolean).join(' · '),
  ];
  // Converted contacts report their class as TR-3B and nothing else — the
  // operator/type identity is exactly what the Easter egg is replacing.
  const ident = isTr3b(icao24)
    ? tr3bTypeLabel(icao24)
    : [info.airline, info.typeName || info.typeCode]
        .filter(Boolean)
        .join(' · ');
  if (ident) lines.push(ident);
  if (route) lines.push(`${route.origin.code} → ${route.destination.code}`);
  return lines.join('\n');
}

/** Context-slot wording: adsbdb airline and type, altitude in feet, and the
 *  descriptor's route (already plausibility-gated). */
function contextProperties(_icao24, described) {
  const altFt = Math.round((described.altitudeM || 0) * 3.28084);
  return {
    operator: described.airline || '',
    type: described.typeName || described.typeCode || '',
    altitude: described.onGround
      ? 'on ground'
      : `${altFt.toLocaleString('en-US')} ft`,
    route: described.route
      ? `${described.route.origin.code} → ${described.route.destination.code}`
      : '',
  };
}

/** getNearby's per-contact fields beyond the shared label, identity and distance. */
function nearbyFields(icao24, info) {
  return {
    callsign: info?.callsign?.trim() || null,
    aircraftClass: tr3bAircraftClass(
      icao24,
      String(info?.klass || '')
        .trim()
        .toLowerCase() || null,
    ),
    altitudeM: info?.altitude ?? null,
    velocityMps: info?.velocity ?? null,
    track: info?.true_track ?? null,
  };
}

/** Detection card metric: the barometric altitude as a flight level. */
function labelDetection(object, _icao24, info) {
  const altitude = info?.altitude;
  if (object._altitude !== altitude) {
    object._altitude = altitude;
    object.metric = formatFlightLevel(altitude); // altitude is metres
  }
}

/**
 * Map one aircraft's internal poll record to a plain JSON-safe analyst
 * record (analyst query engine seam). Pure — no Cesium types, no fetches;
 * enrichment fields read the CACHED adsbdb values only. Missing/unknown
 * fields are null, never NaN/undefined. The route-plausibility verdict is
 * computed by the CALLER (it needs the billboard position) and passed in,
 * so an implausible cached route is never surfaced as fact.
 * @param {string} icao24 - ICAO 24-bit transponder address.
 * @param {Object|null|undefined} info - `_flightData` record for this aircraft.
 * @param {{military?: boolean, routeOk?: boolean}} [flags] - Shared-registry
 *   military flag + route-plausibility verdict.
 * @returns {{id: string, icao24: string, callsign: string|null, lat: number|null,
 *   lon: number|null, altitudeM: number|null, speedMps: number|null,
 *   heading: number|null, verticalRateMps: number|null, onGround: boolean,
 *   military: boolean, aircraftClass: string|null, originCountry: string|null,
 *   operator: string|null, routeOrigin: string|null, routeDestination: string|null}}
 */
export function mapAnalystRecord(
  icao24,
  info,
  { military = false, routeOk = false } = {},
) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const text = (v) => {
    const t = String(v ?? '').trim();
    return t || null;
  };
  const callsign = text(info?.callsign);
  return {
    // Display identity for the narration layer. `id` is NOT a queryable field
    // (see ANALYST_LAYERS) and follow-ups carry whole records, so this is a
    // label, not a key — the engine keys on `icao24` below.
    id: callsign || text(info?.registration) || icao24,
    icao24,
    callsign,
    lat: num(info?.rawLat),
    lon: num(info?.rawLon),
    altitudeM: num(info?.altitude), // barometric/MSL — the aviation field, not the render height
    speedMps: num(info?.velocity),
    heading: num(info?.true_track),
    verticalRateMps: num(info?.verticalRate),
    onGround: info?.onGround === true,
    military,
    // A converted contact reports the class it RENDERS as, so an analyst
    // filter/superlative agrees with the triangle on screen.
    aircraftClass: tr3bAircraftClass(icao24, text(info?.klass)),
    originCountry: text(info?.originCountry),
    operator: text(info?.airline),
    routeOrigin: routeOk ? text(info?.route?.origin?.code) : null,
    routeDestination: routeOk ? text(info?.route?.destination?.code) : null,
  };
}

const { layer: flightsLayer, exports: core } = createAircraftLayer({
  id: 'flights',
  name: 'Live Flights',
  icon: '✈️',
  focusOwner: 'flights',
  logLabel: 'Flights',
  feedName: 'OpenSky',
  sourceName: 'OpenSky Network',
  sourceCoverage: 'worldwide upstream snapshot',
  updateInterval: 30000,
  renderDelaySec: 30,
  trackingParam: 'selectedFlightsTrackingId',
  trailColor: '#00d4ff',
  trailHeadIdPrefix: 'fl',
  trackedLabelColor: '#39d0ff',
  // White fleet, amber for known-military contacts, cyan when tracked. Ground
  // traffic gets no special tint (owner verdict 2026-07-03 field test).
  fleetColor: (icao24) =>
    isMilitaryIcao(icao24) ? MIL_TINT : Cesium.Color.WHITE,
  cockpitFarColor: (icao24) =>
    isMilitaryIcao(icao24) ? MIL_TINT : COCKPIT_CIVILIAN_COLOR,
  trackedColor: Cesium.Color.CYAN,
  trackedFadeColor: Cesium.Color.CYAN.withAlpha(0),
  billboardScale: 1,
  modelSpec,
  preloadModelUrl: PLANE_MODEL_URL,
  // The OpenSky feed and its records: meters, m/s and degrees under the
  // state-vector names.
  feedUrl: openSkyUrl,
  readSnapshot: readOpenSkySnapshot,
  parseRow: parseOpenSkyRow,
  buildRecord: buildOpenSkyRecord,
  fetchTrack: fetchOpenSkyTrack,
  speedMpsOf: (info) => info?.velocity,
  trackDegOf: (info) => info?.true_track,
  altitudeMOf: (info) => info?.altitude,
  verticalRateMpsOf: (info) => info?.verticalRate,
  isLowAndSlow: (info) =>
    Number.isFinite(info.altitude) &&
    info.altitude < LANDED_ALT_MAX_M &&
    Number.isFinite(info.velocity) &&
    info.velocity < LANDED_SPEED_MAX_MPS,
  // adsbdb type and route enrichment; the display-time ground floor for
  // grounded contacts; the military layer's contacts yield to it; and the
  // DEV focus-evidence seam qa-focus-evidence.mjs drives.
  enrichment: true,
  displayFloor: true,
  yieldsMilitaryContacts: true,
  focusEvidence: true,
  trackedLabelText,
  contextProperties,
  nearbyFields,
  labelDetection,
  analystRecord: (icao24, info, { routeOk }) =>
    mapAnalystRecord(icao24, info, {
      military: isMilitaryIcao(icao24),
      routeOk,
    }),
});

export const {
  TRACKED_MODEL_MAX_PX,
  _floorGroundedDisplayPositionForTest,
  _clearDisplayFloorStateForTest,
  _setTrackedRefreshStateForTest: _setTrackedFlightRefreshStateForTest,
  _setTrackingRefreshOutcomeForTest: _setFlightTrackingRefreshOutcomeForTest,
  _addTrackingCandidateForTest: _addFlightTrackingCandidateForTest,
  _militaryLayerSuppressesForTest,
  _armTrackingRestoreForTest: _armFlightTrackingRestoreForTest,
  _pendingTrackingRestoreForTest: _pendingFlightTrackingRestoreForTest,
  _applyPendingTrackingRestoreForTest:
    _applyPendingFlightTrackingRestoreForTest,
  _setCockpitDetectionSubjectForTest,
  _trackedModelRegimeActiveForTest,
  _updateTrackedModelForTest,
  _trackedBillboardColorForTest,
  _driveFleetModelHandoffForTest,
  _ensureFleetModelForTest,
} = core;

export default flightsLayer;
