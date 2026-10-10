/**
 * Start the voice stack after startup, from a chunk of its own.
 *
 * The Realtime voice controller and the app actions it runs are a large part
 * of the bundle, and nothing needs them before first paint. The application
 * tools (src/app/tools.js) load them with a dynamic import once everything else
 * is attached; the mic control and the debug handles appear when the chunk
 * arrives. A teardown that comes first means voice never starts, and nothing
 * reaches the actions before they have loaded: run() waits for them.
 *
 * @typedef {object} VoiceCommands
 * @property {(name: string, args: unknown, options: {signal?: AbortSignal}) => unknown} runner
 *   Runs one app action.
 * @property {(options: {removeUi: boolean}) => void} stop Stops voice.
 */

/** How long after a failed voice chunk load the next action may retry it. */
const RETRY_AFTER_MS = 10_000;

/**
 * @param {object} options
 * @param {() => Promise<object>} options.load Imports the voice module.
 * @param {(module: object) => VoiceCommands} options.start Starts the voice
 *   commands from the loaded module.
 * @param {(commands: VoiceCommands) => void} [options.onReady] Called once
 *   started.
 * @param {(dispose: () => void) => void} options.defer Registers teardown.
 * @param {AbortSignal} [options.signal] The application's lifetime.
 * @param {() => number} [options.now] The clock the retry spacing reads.
 */
export function startDeferredVoice({
  load,
  start,
  onReady,
  defer,
  signal,
  now = Date.now,
}) {
  /** @type {VoiceCommands | null} */
  let commands = null;
  let closed = false;
  defer(() => {
    closed = true;
    if (!commands) return;
    commands.stop({ removeUi: true });
    const windowRef =
      /** @type {{__gevVoiceCommands?: VoiceCommands} | undefined} */ (
        globalThis.window
      );
    if (windowRef?.__gevVoiceCommands === commands)
      delete windowRef.__gevVoiceCommands;
  });
  let failedAt = Number.NEGATIVE_INFINITY;
  const attempt = () =>
    Promise.resolve()
      .then(load)
      .then((module) => {
        if (closed || signal?.aborted) return null;
        commands = start(module);
        onReady?.(commands);
        return commands;
      })
      .catch((error) => {
        console.warn(
          '[GEV] Voice control failed to load:',
          error?.message || error,
        );
        failedAt = now();
        return null;
      });
  let ready = attempt();
  return {
    /** Resolves to the started commands, or null when voice never started. */
    get ready() {
      return ready;
    },
    /** The started commands, or null until they are. */
    get commands() {
      return commands;
    },
    /**
     * Run one app action once the actions have loaded.
     * @param {string} name
     * @param {unknown} args
     */
    async run(name, args) {
      let loaded = await ready;
      // A chunk that failed to load (a network blip, or a redeploy that
      // replaced its hash) is tried again, at most every RETRY_AFTER_MS.
      if (
        !loaded &&
        !closed &&
        !signal?.aborted &&
        now() - failedAt >= RETRY_AFTER_MS
      ) {
        ready = attempt();
        loaded = await ready;
      }
      if (!loaded) return { ok: false, error: 'App actions are not available' };
      return loaded.runner(name, args, { signal });
    },
  };
}
