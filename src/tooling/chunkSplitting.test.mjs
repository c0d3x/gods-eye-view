import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import test from 'node:test';
import {
  APP_CHUNK_GROUPS,
  appCodeSplitting,
  layerFamilyChunk,
} from '../../build/chunks.js';
import { panelBuildConfig } from '../../build/panel.js';
import { createBrowserViteConfig } from '../../build/vite.js';

/** The chunk a startup module lands in: the first group, by priority, to take it. */
function chunkFor(moduleId) {
  const groups = [...APP_CHUNK_GROUPS].sort((a, b) => b.priority - a.priority);
  for (const group of groups) {
    if (typeof group.name === 'function') {
      const name = group.name(moduleId);
      if (name) return name;
    } else if (group.test.test(moduleId)) return group.name;
  }
  return null;
}

test('the app build splits startup code by feature, and only startup code', () => {
  const output = createBrowserViteConfig().build.rolldownOptions.output;
  assert.deepEqual(output.codeSplitting, appCodeSplitting());
  // Code loaded through a dynamic import keeps its own chunks: a group that
  // took it would pull it into startup.
  for (const group of output.codeSplitting.groups)
    assert.deepEqual(group.tags, ['$initial'], String(group.debugName));
});

test('each startup area has its chunk', () => {
  const root = '/repo/src/';
  for (const [moduleId, chunk] of [
    ['overlays/worldOverlay.js', 'overlays'],
    ['layers/flights/index.js', 'layer-flights'],
    ['layers/cctv/rendering/cards.js', 'layer-cctv'],
    ['annotations/index.js', 'scene-tools'],
    ['scenes/director.js', 'scene-tools'],
    ['director/packs/source.js', 'scene-tools'],
    ['cockpitMath.js', 'cockpit'],
    ['ui/cockpitController.js', 'cockpit'],
    ['ui/radioBindings.js', 'feature-panels'],
    ['ui/recentImagery.js', 'feature-panels'],
    ['data/lifecycle.js', 'data'],
    ['sources/requestDeadline.js', 'data'],
    ['services/application.js', 'data'],
    ['ui/applicationShell.js', 'ui'],
    // Left to the entry chunk, or to the chunks of a dynamic import.
    ['main.js', null],
    ['app/tools.js', null],
    ['voice/gevRealtime.js', null],
  ])
    assert.equal(chunkFor(root + moduleId), chunk, moduleId);
  assert.equal(
    chunkFor(String.raw`C:\repo\src\layers\radio\source.js`),
    'layer-radio',
    'Windows paths match too',
  );
  assert.equal(chunkFor('/repo/node_modules/mapillary-js/dist/x.js'), null);
});

test('every layer family gets a chunk of its own', () => {
  const families = readdirSync(new URL('../layers/', import.meta.url), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.ok(families.length > 10);
  for (const family of families)
    assert.equal(
      layerFamilyChunk(`/repo/src/layers/${family}/index.js`),
      `layer-${family}`,
    );
});

test('the MCP panel build stays one script without the feature chunks', () => {
  const config = panelBuildConfig(createBrowserViteConfig());
  assert.deepEqual(config.build.rolldownOptions.output, {
    inlineDynamicImports: true,
  });
});
