/**
 * The AISStream relay: one backend websocket, driven through the adapter in
 * streamAdapter.mjs, and /api/ais-live, which serves the vessels and recent
 * tracks it collects as same-origin JSON.
 */

import { createRequire } from 'node:module';
import {
  createAisStreamAdapter,
  isRecognizedAisEnvelope,
} from './streamAdapter.mjs';
import { parseSilenceTimeoutEnv } from './watchdog.mjs';

// ---------------------------------------------------------------------------
// AISStream subscription, cache and watchdog settings
// ---------------------------------------------------------------------------
const AISSTREAM_URL = 'wss://stream.aisstream.io/v0/stream';
const AISSTREAM_DEFAULT_BBOXES = [
  [
    [-90, -180],
    [90, 180],
  ],
];
const AISSTREAM_DEFAULT_MESSAGE_TYPES = [
  'PositionReport',
  'StandardClassBPositionReport',
  'ExtendedClassBPositionReport',
  'ShipStaticData',
  'StaticDataReport',
];
const AISSTREAM_CACHE_MAX = 50000;
const AISSTREAM_STALE_MS = 30 * 60 * 1000;
// Per-MMSI recent-path ring buffers (PRD WS-F F3). Float32 lat/lon (~1m
// precision, fine for 25m thinning) + Uint32 epoch seconds ≈ 12B/sample;
// 64 samples × 50k MMSIs worst case ≈ 38MB. Tracks exist only while the dev
// server runs — this is "recent path", not voyage history.
const AIS_TRACK_SAMPLES = 64;
const AIS_TRACK_MIN_GAP_SEC = 30;
const AIS_TRACK_MIN_MOVE_M = 25;
/**
 * One vessel's track ring buffer: `len` samples, the next written at `head`.
 * @typedef {{lats: Float32Array, lons: Float32Array, times: Uint32Array,
 *   head: number, len: number}} AisTrack
 */
// Watchdog budgets (policy lives in server/ais/watchdog.mjs). Silence is
// REPORTED quickly and ACTED ON slowly: a dead feed must read as dead within
// ~2 min, but recycling the socket is throttled so recovery can never become a
// reconnect cycle against AISStream's one-connection-per-key limit.
const AISSTREAM_SILENCE_REPORT_MS = 120_000;
/** Recycle threshold as a multiple of the report threshold. */
const AISSTREAM_RECYCLE_RATIO = 2.5;
const AISSTREAM_BACKOFF_MS = Object.freeze([5_000, 15_000, 60_000, 300_000]);
/** Slow retry cadence once the ladder is spent and the feed reads DOWN. */
const AISSTREAM_DOWN_RETRY_MS = 900_000;
/**
 * Probe cadence while AISStream is rejecting the key. Retrying cannot fix a
 * bad credential, so this exists only to recover from an upstream-side
 * mistake — it must never approach the ladder's pace.
 */
const AISSTREAM_AUTH_PROBE_MS = 3_600_000;
/** How often the watchdog re-evaluates without request traffic. */
const AISSTREAM_TICK_MS = 15_000;

/**
 * Load the `ws` constructor.
 *
 * Node's built-in WebSocket cannot be used here: it has no terminate(), and
 * its close() waits forever for a close frame a black-holed peer never sends
 * (verified in server/ais/watchdogTransport.test.mjs). A socket parked in
 * CLOSING keeps holding AISStream's single per-key connection, which is how
 * the reverted watchdog wedged.
 *
 * Loaded lazily rather than imported at the top of this file so a missing
 * optional dependency degrades the vessel feed honestly instead of breaking
 * the whole dev server and build.
 *
 * @returns {new (url: string, options?: object) => any}
 */
function requireWs() {
  return createRequire(import.meta.url)('ws');
}

/**
 * Create a relay: the AISStream connection, and the vessel and track caches it
 * fills. The dev server runs one for the life of this module (see
 * `aisLiveProxy`); tests build their own around a fake transport, clock and
 * interval timer.
 *
 * Settings are read from `env` when they are used, never here: module
 * evaluation happens before Vite's loadEnv() copies .env into process.env.
 *
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env] process.env by default.
 * @param {() => (new (url: string, options?: object) => any)} [options.loadWebSocket] Returns the `ws`
 *   constructor, and throws when it is unavailable.
 * @param {{wall: () => number, mono: () => number}} [options.clock] The
 *   watchdog's clock.
 * @param {() => number} [options.now] Wall-clock ms for the vessel cache.
 * @param {typeof setInterval} [options.setInterval]
 * @param {typeof clearInterval} [options.clearInterval]
 * @param {(...args: unknown[]) => void} [options.warn]
 */
export function createAisRelay({
  env = process.env,
  loadWebSocket = requireWs,
  clock,
  now = () => Date.now(),
  setInterval: startInterval = setInterval,
  clearInterval: stopInterval = clearInterval,
  warn = (...args) => console.warn(...args),
} = {}) {
  /**
   * @type {ReturnType<typeof createAisStreamAdapter>|null}
   * Kept for the relay's lifetime, across dispose(): it owns the
   * socket-generation namespace, which must never restart across a dev-server
   * reload (see the ownership rules in server/ais/streamAdapter.mjs).
   */
  let _aisAdapter = null;
  /** @type {{silenceWatch:boolean,reportMs:number,recycleMs:number,url:string}|null} */
  let _aisWatchdogPolicy = null;
  /** @type {ReturnType<typeof setInterval>|null} */
  let _aisStreamTickTimer = null;
  /** Set by dispose so the next ensure() re-derives budgets from a reloaded .env. */
  let _aisNeedsRearm = false;
  /** @type {(new (url: string, options?: object) => any)|null|undefined} `ws` constructor; null = unavailable, undefined = not yet probed. */
  let _aisWebSocketImpl;
  /** @type {Map<string, Record<string, any>>} */
  const _aisStreamVessels = new Map();
  /** @type {Map<string, Record<string, any>>} */
  const _aisStreamStatic = new Map();
  /** @type {Map<string, AisTrack>} mmsi -> track ring buffer */
  const _aisStreamTracks = new Map();
  /** @type {Map<string,{lat:number,lon:number,epochSec:number}>} mmsi -> first fix awaiting second (lazy buffer allocation) */
  const _aisStreamTrackPending = new Map();
  /** @type {string|null} The AIS key last seen. */
  let _aisKeySeen = null;
  /** How many distinct keys have been seen so far. */
  let _aisKeyGeneration = 0;

  /** The `ws` constructor, loaded once; null when it is unavailable. */
  function aisWebSocketImpl() {
    if (_aisWebSocketImpl !== undefined) return _aisWebSocketImpl;
    try {
      _aisWebSocketImpl = loadWebSocket();
    } catch (error) {
      _aisWebSocketImpl = null;
      warn(
        '[AISStream] `ws` is unavailable; the live vessel feed is off.',
        error?.message || '',
      );
    }
    return _aisWebSocketImpl;
  }

  /**
   * Resolve the watchdog policy from the environment, once.
   *
   * Read lazily because module evaluation happens before Vite's loadEnv() copies
   * .env into process.env — the reverted watchdog read these at import time and
   * silently ignored every .env value, including its own kill switch.
   *
   * A custom subscription (one harbor, one message type) can be legitimately
   * silent for minutes, so the silence watch only self-arms for the default
   * worldwide subscription. An operator with a narrow filter opts back in by
   * setting AISSTREAM_SILENCE_TIMEOUT_MS to a value sized for that filter; 0 is
   * an explicit kill switch.
   */
  function aisWatchdogPolicy() {
    if (_aisWatchdogPolicy) return _aisWatchdogPolicy;
    const customSubscription = Boolean(
      env.AISSTREAM_BOUNDING_BOXES || env.AISSTREAM_MESSAGE_TYPES,
    );
    const override = parseSilenceTimeoutEnv(
      env.AISSTREAM_SILENCE_TIMEOUT_MS,
      (message) => warn(message),
    );
    const reportMs =
      override.kind === 'timeout'
        ? override.value
        : AISSTREAM_SILENCE_REPORT_MS;
    _aisWatchdogPolicy = {
      silenceWatch:
        override.kind === 'off'
          ? false
          : override.kind === 'timeout' || !customSubscription,
      reportMs,
      recycleMs: Math.round(reportMs * AISSTREAM_RECYCLE_RATIO),
      // Overridable so the watchdog can be exercised end-to-end against a local
      // stand-in upstream without opening a connection to AISStream (which
      // allows only one per key).
      url: env.AISSTREAM_URL || AISSTREAM_URL,
    };
    return _aisWatchdogPolicy;
  }

  /**
   * The transport adapter, built on first use and kept for the relay's
   * lifetime.
   *
   * Never rebuilt: it owns the socket-generation namespace, and a restarted
   * namespace would let a pre-disposal handler act on its successor's socket.
   */
  function aisAdapter() {
    if (_aisAdapter) return _aisAdapter;
    _aisAdapter = createAisStreamAdapter({
      createSocket: (url) => {
        const WebSocketCtor = aisWebSocketImpl();
        if (!WebSocketCtor) throw new Error('ws transport unavailable');
        // AISStream messages are a few KB; ws would otherwise accept 100 MiB.
        return new WebSocketCtor(url, { maxPayload: 1024 * 1024 });
      },
      resolveUrl: () => aisWatchdogPolicy().url,
      buildSubscription: aisStreamSubscription,
      ingestEnvelope: ingestAisStreamEnvelope,
      clock,
      warn: (message) => warn(message),
    });
    _aisAdapter.setWatchdogOptions(aisWatchdogBudgets());
    return _aisAdapter;
  }

  /** Watchdog budgets derived from the resolved environment policy. */
  function aisWatchdogBudgets() {
    const policy = aisWatchdogPolicy();
    return {
      staleMs: policy.reportMs,
      recycleAfterMs: policy.recycleMs,
      backoffMs: [...AISSTREAM_BACKOFF_MS],
      downRetryMs: AISSTREAM_DOWN_RETRY_MS,
      authProbeMs: AISSTREAM_AUTH_PROBE_MS,
    };
  }

  /**
   * Names the current credential so a key change can clear the terminal
   * auth-failed state: a counter that moves whenever the key does. Nothing
   * derived from the key itself leaves the relay.
   * @returns {string|null} `key-<n>`, or null while no key is set.
   */
  function aisKeyFingerprint() {
    const key = env.AISSTREAM_API_KEY;
    if (!key) return null;
    if (key !== _aisKeySeen) {
      _aisKeySeen = key;
      _aisKeyGeneration += 1;
    }
    return `key-${_aisKeyGeneration}`;
  }

  /**
   * Drive the watchdog once. Called on every /api/ais-live request and on the
   * background interval, so recovery does not depend on browser traffic.
   */
  function ensureAisStreamConnection() {
    const adapter = aisAdapter();
    if (_aisNeedsRearm) {
      // Post-dispose re-arm, now that the restarted server's .env is loaded. The
      // adapter keeps its generation namespace across this.
      _aisNeedsRearm = false;
      adapter.setWatchdogOptions(aisWatchdogBudgets());
    }
    const policy = aisWatchdogPolicy();
    adapter.ensure({
      hasKey: Boolean(env.AISSTREAM_API_KEY),
      hasTransport: Boolean(aisWebSocketImpl()),
      silenceWatch: policy.silenceWatch,
      keyFingerprint: aisKeyFingerprint(),
    });
  }

  /** Status metadata for /api/ais-live, safe to call before the first connect. */
  function aisStreamStatusSnapshot() {
    const snapshot = _aisAdapter ? _aisAdapter.snapshot() : null;
    if (snapshot) return snapshot;
    return {
      status: env.AISSTREAM_API_KEY ? 'idle' : 'missing-key',
      error: env.AISSTREAM_API_KEY ? null : 'AISSTREAM_API_KEY is not set',
      lastMessageAt: null,
      silentForMs: null,
      reconnectAttempt: 0,
      nextAttemptAt: null,
      watchdog: 'armed',
      staleAfterMs: AISSTREAM_SILENCE_REPORT_MS,
    };
  }

  /**
   * Start the background watchdog tick. Unref'd so it never holds the dev server
   * open, and idempotent so a Vite in-process restart cannot stack intervals.
   */
  function startAisStreamWatchdogTick() {
    if (_aisStreamTickTimer) return;
    _aisStreamTickTimer = startInterval(() => {
      try {
        ensureAisStreamConnection();
      } catch (error) {
        warn('[AISStream] watchdog tick failed', error?.message || '');
      }
    }, AISSTREAM_TICK_MS);
    _aisStreamTickTimer.unref?.();
  }

  /**
   * Tear down every timer and socket this relay owns.
   *
   * Vite restarts the dev server in-process on a config change while module
   * state survives, so without this each reload stacked another interval and
   * another reconnect chain. The cached policy is dropped too, so a restart
   * re-reads .env.
   *
   * The adapter instance itself is deliberately KEPT: it owns the socket
   * generation namespace, which must stay monotonic across restarts so a
   * pre-disposal handler can never collide with a post-disposal socket.
   */
  function disposeAisStream() {
    if (_aisStreamTickTimer) {
      stopInterval(_aisStreamTickTimer);
      _aisStreamTickTimer = null;
    }
    if (_aisAdapter) _aisAdapter.dispose();
    // Drop the cached policy and re-arm LAZILY. Re-deriving budgets here would
    // read process.env before the restarted server's loadEnv() has repopulated
    // it, caching the outgoing configuration; the next ensure() runs after that.
    _aisWatchdogPolicy = null;
    _aisNeedsRearm = true;
  }

  function aisStreamSubscription() {
    return {
      APIKey: env.AISSTREAM_API_KEY,
      BoundingBoxes: parseJsonEnv(
        env,
        'AISSTREAM_BOUNDING_BOXES',
        AISSTREAM_DEFAULT_BBOXES,
        warn,
      ),
      FilterMessageTypes: parseCsvOrJsonEnv(
        env,
        'AISSTREAM_MESSAGE_TYPES',
        AISSTREAM_DEFAULT_MESSAGE_TYPES,
      ),
    };
  }

  /**
   * Store one parsed AIS envelope.
   *
   * The return value is the feed's ONLY liveness proof, so it is true strictly
   * when the envelope carried a real AIS record. Malformed frames and error
   * envelopes never reach here — the adapter classifies those — and a JSON
   * object without an MMSI proves nothing about the feed.
   *
   * @param {Record<string, any>} envelope Parsed, non-error AIS envelope.
   * @returns {boolean} True when an AIS record was recognised.
   */
  function ingestAisStreamEnvelope(envelope) {
    // Single shared recognition rule (also used by the adapter's tests), so the
    // liveness predicate that ships is the one under test. An envelope carrying
    // only an MMSI is not proof the feed works.
    if (!isRecognizedAisEnvelope(envelope)) return false;

    const messageType = envelope?.MessageType;
    const message = envelope?.Message?.[messageType] || {};
    const metadata = envelope?.MetaData || envelope?.Metadata || {};
    const mmsi = stringValue(
      metadata.MMSI ?? message.UserID ?? message.UserId ?? message.Mmsi,
    );
    if (!mmsi) return false;

    if (
      messageType === 'ShipStaticData' ||
      messageType === 'StaticDataReport'
    ) {
      const staticData = {
        name: vesselNameFromAis(metadata, message, _aisStreamStatic.get(mmsi)),
        type: vesselTypeFromAis(message, _aisStreamStatic.get(mmsi)),
        destination: stringValue(message.Destination),
        imo: stringValue(message.ImoNumber ?? message.IMO),
      };
      _aisStreamStatic.set(mmsi, staticData);
      mergeAisStaticIntoLiveVessel(mmsi, staticData);
    }

    const lat = numberValue(
      metadata.latitude ?? metadata.Latitude ?? message.Latitude,
    );
    const lon = numberValue(
      metadata.longitude ?? metadata.Longitude ?? message.Longitude,
    );
    // A positionless but well-formed record (static data) is still the feed
    // delivering AIS traffic, so it counts as liveness.
    if (
      lat === null ||
      lon === null ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon)
    )
      return true;

    const staticData = _aisStreamStatic.get(mmsi) || {};
    _aisStreamVessels.set(mmsi, {
      lat,
      lon,
      name: vesselNameFromAis(metadata, message, staticData) || `MMSI ${mmsi}`,
      mmsi,
      imo: stringValue(message.ImoNumber ?? message.IMO ?? staticData.imo),
      type: vesselTypeFromAis(message, staticData),
      destination: stringValue(message.Destination ?? staticData.destination),
      speed: numberValue(message.Sog ?? message.SOG),
      course: numberValue(message.Cog ?? message.COG),
      heading: normalizedHeading(message.TrueHeading ?? message.Heading),
      last_position_UTC: normalizeAisTimestamp(
        metadata.time_utc ?? metadata.TimeUtc,
      ),
      // Use the AIS message's own report time, not server ingest wall-clock —
      // trail spacing and dead reckoning depend on true fix epochs.
      last_position_epoch: aisEpochSeconds(
        metadata.time_utc ?? metadata.TimeUtc,
      ),
      _updatedAt: now(),
    });

    appendAisTrackSample(
      mmsi,
      lat,
      lon,
      aisEpochSeconds(metadata.time_utc ?? metadata.TimeUtc),
    );

    pruneAisStreamCache();
    return true;
  }

  /**
   * Appends a thinned position sample to a vessel's track ring buffer.
   * Buffers allocate lazily on the second fix (most MMSIs are seen once);
   * samples are kept only when >=AIS_TRACK_MIN_GAP_SEC and
   * >=AIS_TRACK_MIN_MOVE_M from the previous stored sample, so anchored
   * vessels collapse to a single point.
   * @param {string} mmsi
   * @param {number} lat
   * @param {number} lon
   * @param {number} epochSec
   */
  function appendAisTrackSample(mmsi, lat, lon, epochSec) {
    let track = _aisStreamTracks.get(mmsi);
    if (!track) {
      const pending = _aisStreamTrackPending.get(mmsi);
      if (!pending) {
        _aisStreamTrackPending.set(mmsi, { lat, lon, epochSec });
        return;
      }
      if (epochSec - pending.epochSec < AIS_TRACK_MIN_GAP_SEC) return;
      if (
        approxMetersBetween(pending.lat, pending.lon, lat, lon) <
        AIS_TRACK_MIN_MOVE_M
      )
        return;
      track = {
        lats: new Float32Array(AIS_TRACK_SAMPLES),
        lons: new Float32Array(AIS_TRACK_SAMPLES),
        times: new Uint32Array(AIS_TRACK_SAMPLES),
        head: 0,
        len: 0,
      };
      _aisStreamTracks.set(mmsi, track);
      _aisStreamTrackPending.delete(mmsi);
      writeAisTrackSample(track, pending.lat, pending.lon, pending.epochSec);
      writeAisTrackSample(track, lat, lon, epochSec);
      return;
    }

    const lastIdx = (track.head - 1 + AIS_TRACK_SAMPLES) % AIS_TRACK_SAMPLES;
    const lastEpoch = track.times[lastIdx];
    if (epochSec - lastEpoch < AIS_TRACK_MIN_GAP_SEC) return;
    if (
      approxMetersBetween(track.lats[lastIdx], track.lons[lastIdx], lat, lon) <
      AIS_TRACK_MIN_MOVE_M
    )
      return;
    writeAisTrackSample(track, lat, lon, epochSec);
  }

  /**
   * Reads a vessel's accumulated track in chronological order.
   * @param {string} mmsi
   * @returns {Array<{lat:number,lon:number,t:number}>}
   */
  function readAisTrack(mmsi) {
    const track = _aisStreamTracks.get(mmsi);
    if (!track?.len) return [];
    const samples = [];
    const start =
      (track.head - track.len + AIS_TRACK_SAMPLES) % AIS_TRACK_SAMPLES;
    for (let i = 0; i < track.len; i++) {
      const idx = (start + i) % AIS_TRACK_SAMPLES;
      samples.push({
        lat: track.lats[idx],
        lon: track.lons[idx],
        t: track.times[idx],
      });
    }
    return samples;
  }

  /**
   * @param {string} mmsi
   * @param {{name: string, type: string, destination: string,
   *   imo: string}} staticData
   */
  function mergeAisStaticIntoLiveVessel(mmsi, staticData) {
    const existing = _aisStreamVessels.get(mmsi);
    if (!existing) return;
    if (staticData.name && (!existing.name || existing.name === `MMSI ${mmsi}`))
      existing.name = staticData.name;
    if (staticData.type && !existing.type) existing.type = staticData.type;
    if (staticData.destination && !existing.destination)
      existing.destination = staticData.destination;
    if (staticData.imo && !existing.imo) existing.imo = staticData.imo;
  }

  /** @param {number} maxRows */
  function aisStreamRows(maxRows) {
    const cutoff = now() - AISSTREAM_STALE_MS;
    const rows = [];
    for (const row of _aisStreamVessels.values()) {
      if (row._updatedAt >= cutoff) rows.push(row);
    }
    rows.sort((a, b) => b._updatedAt - a._updatedAt);
    return rows.slice(0, maxRows).map(({ _updatedAt, ...row }) => row);
  }

  function pruneAisStreamCache() {
    const cutoff = now() - AISSTREAM_STALE_MS;
    for (const [mmsi, row] of _aisStreamVessels) {
      if (row._updatedAt < cutoff) {
        _aisStreamVessels.delete(mmsi);
        _aisStreamTracks.delete(mmsi);
        _aisStreamTrackPending.delete(mmsi);
      }
    }
    // Pending single-fix entries for vessels never seen again must not leak
    const pendingCutoffSec = Math.floor(cutoff / 1000);
    for (const [mmsi, pending] of _aisStreamTrackPending) {
      if (pending.epochSec < pendingCutoffSec)
        _aisStreamTrackPending.delete(mmsi);
    }
    if (_aisStreamVessels.size <= AISSTREAM_CACHE_MAX) return;
    const ordered = [..._aisStreamVessels.entries()].sort(
      (a, b) => a[1]._updatedAt - b[1]._updatedAt,
    );
    for (const [mmsi] of ordered.slice(
      0,
      _aisStreamVessels.size - AISSTREAM_CACHE_MAX,
    )) {
      _aisStreamVessels.delete(mmsi);
      _aisStreamTracks.delete(mmsi);
      _aisStreamTrackPending.delete(mmsi);
    }
  }

  return {
    /** Drive the watchdog once; see ensureAisStreamConnection. */
    ensure: ensureAisStreamConnection,
    /** The feed's status metadata for /api/ais-live. */
    status: aisStreamStatusSnapshot,
    /** Vessels heard from in the last 30 minutes, newest first. */
    rows: aisStreamRows,
    /** One vessel's recent track, oldest sample first. */
    track: readAisTrack,
    hasKey: () => Boolean(env.AISSTREAM_API_KEY),
    keyFingerprint: aisKeyFingerprint,
    startTick: startAisStreamWatchdogTick,
    dispose: disposeAisStream,
  };
}

/** The relay the dev server runs, for the life of this module. */
const sharedRelay = createAisRelay();

/**
 * Vite plugin: AISStream live vessel cache.
 *
 * AISStream does not support browser CORS and requires a private API key, so
 * the Vite server keeps one backend websocket open and exposes a same-origin
 * JSON snapshot to the Cesium layer.
 *
 * @param {object} [options]
 * @param {ReturnType<typeof createAisRelay>} [options.relay] The shared relay
 *   by default.
 * @returns {import('vite').Plugin}
 */
export function aisLiveProxy({ relay = sharedRelay } = {}) {
  /** @param {import('vite').Connect.Server} middlewares */
  function install(middlewares) {
    middlewares.use('/api/ais-live', async (req, res) => {
      try {
        relay.ensure();
        const incoming = new URL(req.url || '', 'http://localhost');

        // Track sub-route MUST be handled before the rows snapshot — this
        // mount prefix-matches every subpath, so without this branch
        // /api/ais-live/track would be silently answered with vessel rows.
        if (
          incoming.pathname === '/track' ||
          incoming.pathname.startsWith('/track/')
        ) {
          const mmsi = String(incoming.searchParams.get('mmsi') || '').trim();
          res.statusCode = /^\d{5,10}$/.test(mmsi) ? 200 : 400;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          if (res.statusCode !== 200) {
            res.end(
              JSON.stringify({
                error: 'mmsi query param required',
                samples: [],
              }),
            );
            return;
          }
          res.end(
            JSON.stringify({
              mmsi,
              samples: relay.track(mmsi),
              source: 'AISStream (accumulated since server start)',
              retainedSec: Math.floor(AISSTREAM_STALE_MS / 1000),
            }),
          );
          return;
        }

        const maxRows = clampInt(
          incoming.searchParams.get('maxRows'),
          1,
          AISSTREAM_CACHE_MAX,
          AISSTREAM_CACHE_MAX,
        );
        const rows = relay.rows(maxRows);

        const feed = relay.status();

        res.statusCode = relay.hasKey() ? 200 : 503;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(
          JSON.stringify({
            rows,
            source: 'AISStream',
            status: feed.status,
            error: feed.error,
            refreshing: feed.status !== 'live',
            newestPositionAt: newestAisPositionAt(rows),
            lastMessageAt: feed.lastMessageAt,
            // Honest-failure metadata: how long the feed has been quiet, which
            // recovery attempt we are on, and when the next one lands.
            silentForMs: feed.silentForMs,
            reconnectAttempt: feed.reconnectAttempt,
            nextAttemptAt: feed.nextAttemptAt,
            staleAfterMs: feed.staleAfterMs,
            watchdog: feed.watchdog,
          }),
        );
      } catch (error) {
        console.warn('[AIS Live]', error?.message || error);
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ error: 'AIS live stream error', rows: [] }));
      }
    });
  }

  return {
    name: 'ais-live-proxy',
    configureServer(server) {
      install(server.middlewares);
      relay.startTick();
      // Vite restarts the server in-process on a config change while this
      // module's state survives; without teardown each reload stacks another
      // interval and another socket.
      server.httpServer?.on('close', relay.dispose);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
      relay.startTick();
      server.httpServer?.on('close', relay.dispose);
    },
    // Middleware-mode backstop: there is no httpServer to hang 'close' on.
    closeBundle() {
      relay.dispose();
    },
  };
}

/**
 * The shared relay's name for the current AIS key: `key-<n>`, where the
 * counter moves whenever the key does, or null while no key is set.
 */
export function aisKeyFingerprint() {
  return sharedRelay.keyFingerprint();
}

/**
 * Parses an AISStream UTC timestamp into epoch seconds (fallback: now).
 * @param {unknown} value
 */
function aisEpochSeconds(value) {
  const ms = Date.parse(normalizeAisTimestamp(value));
  return Number.isFinite(ms)
    ? Math.floor(ms / 1000)
    : Math.floor(Date.now() / 1000);
}

/**
 * @param {AisTrack} track
 * @param {number} lat
 * @param {number} lon
 * @param {number} epochSec
 */
function writeAisTrackSample(track, lat, lon, epochSec) {
  track.lats[track.head] = lat;
  track.lons[track.head] = lon;
  track.times[track.head] = epochSec;
  track.head = (track.head + 1) % AIS_TRACK_SAMPLES;
  track.len = Math.min(track.len + 1, AIS_TRACK_SAMPLES);
}

/**
 * Equirectangular distance approximation — plenty for 25m thinning.
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 */
function approxMetersBetween(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * 111320;
  const dLon =
    (lon2 - lon1) * 111320 * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  return Math.hypot(dLat, dLon);
}

/**
 * @param {Record<string, any>} metadata The envelope's MetaData block.
 * @param {Record<string, any>} message The message body.
 * @param {Record<string, any>} [staticData] Cached static fields.
 */
function vesselNameFromAis(metadata, message, staticData = {}) {
  return stringValue(
    metadata.ShipName ??
      message.Name ??
      message.ShipName ??
      message.ReportA?.Name ??
      staticData.name,
  );
}

/**
 * @param {Record<string, any>} message The message body.
 * @param {Record<string, any>} [staticData] Cached static fields.
 */
function vesselTypeFromAis(message, staticData = {}) {
  return stringValue(
    message.Type ??
      message.ShipType ??
      message.ReportB?.ShipType ??
      staticData.type,
  );
}

/** @param {Array<Record<string, any>>} rows Newest first. */
function newestAisPositionAt(rows) {
  return rows[0]?.last_position_UTC || null;
}

/**
 * @param {Record<string, string|undefined>} env
 * @param {string} key
 * @param {unknown} fallback
 * @param {(message: string) => void} warn
 */
function parseJsonEnv(env, key, fallback, warn) {
  const value = env[key];
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    warn(`[AISStream] Invalid ${key}; using default.`);
    return fallback;
  }
}

/**
 * @param {Record<string, string|undefined>} env
 * @param {string} key
 * @param {Array<string>} fallback
 */
function parseCsvOrJsonEnv(env, key, fallback) {
  const value = env[key];
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 */
function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(String(value), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

/** @param {unknown} value */
function stringValue(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

/** @param {unknown} value */
function numberValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** @param {unknown} value */
function normalizedHeading(value) {
  const heading = numberValue(value);
  return heading !== null && heading >= 0 && heading <= 360 ? heading : null;
}

/** @param {unknown} value */
function normalizeAisTimestamp(value) {
  const text = stringValue(value);
  if (!text) return new Date().toISOString();
  const normalized = text.replace(' +0000 UTC', 'Z').replace(' UTC', 'Z');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString();
}
