/**
 * How the production build splits the app's startup code into chunks.
 *
 * Until the layers load on first use, the app loads all of their code at
 * startup. Splitting it by feature keeps every startup chunk well under
 * Vite's 500 kB warning size, and leaves the others cached when one feature
 * changes.
 *
 * Only startup modules are grouped (Rolldown's `$initial` tag). Code the app
 * loads later through a dynamic import (the voice stack, the tools catalog,
 * Mapillary's viewer, hls.js) keeps the chunks Rolldown gives it, so a group
 * never pulls it into startup.
 *
 * A group also takes the modules it imports, so shared code goes to whichever
 * group claims it first, in priority order: the overlay host, then each layer
 * family, then the scene tools, the cockpit and the feature panels, then the
 * rest of the data layer, and last the shell's panels. What no group claims
 * stays in the entry chunk.
 */

/** A path separator in a module id, on any platform. */
const SEP = String.raw`[\\/]`;
/** Any character of one path segment. */
const SEGMENT = String.raw`[^\\/]`;

/**
 * Matches module ids under `src/<one of dirs>/`.
 * @param {...string} dirs
 */
function under(...dirs) {
  return new RegExp(`${SEP}src${SEP}(?:${dirs.join('|')})${SEP}`);
}

/**
 * Matches modules in `src/<dir>/` whose file name starts with a prefix.
 * @param {string} dir
 * @param {...string} prefixes
 */
function named(dir, ...prefixes) {
  return new RegExp(
    String.raw`${SEP}src${SEP}${dir}(?:${prefixes.join('|')})${SEGMENT}*\.js$`,
  );
}

const LAYER_FAMILY = new RegExp(
  `${SEP}src${SEP}layers${SEP}(${SEGMENT}+)${SEP}`,
);

/**
 * The chunk a layer family's modules go to (`layer-<family>`), if any.
 * @param {string} moduleId
 */
export function layerFamilyChunk(moduleId) {
  const family = LAYER_FAMILY.exec(moduleId)?.[1];
  return family ? `layer-${family}` : null;
}

/** Startup chunk groups, highest priority first. */
export const APP_CHUNK_GROUPS = Object.freeze([
  { name: 'overlays', test: under('overlays'), priority: 50 },
  // One chunk per directory under src/layers/.
  { name: layerFamilyChunk, debugName: 'layers', priority: 40 },
  {
    name: 'scene-tools',
    test: under('annotations', 'scenes', 'director'),
    priority: 35,
  },
  {
    name: 'cockpit',
    test: new RegExp(
      String.raw`${SEP}src${SEP}(?:ui${SEP})?cockpit${SEGMENT}*\.js$`,
    ),
    priority: 35,
  },
  {
    name: 'feature-panels',
    test: named(
      `ui${SEP}`,
      'radio',
      'cctv',
      'streetLevel',
      'recentImagery',
      'imageryBox',
      'localSdr',
      'weather',
    ),
    priority: 35,
  },
  { name: 'data', test: under('data', 'sources', 'services'), priority: 30 },
  { name: 'ui', test: under('ui'), priority: 20 },
]);

/** Rolldown's `output.codeSplitting` for the app's production build. */
export function appCodeSplitting() {
  return {
    groups: APP_CHUNK_GROUPS.map((group) => ({
      ...group,
      tags: /** @type {Array<'$initial'>} */ (['$initial']),
    })),
  };
}
