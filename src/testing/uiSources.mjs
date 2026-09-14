// The text of src/ui.js and of the modules its panels move into (#46), for the
// tests that read UI code as text. They read it all as one string, so a panel
// that moves out of ui.js does not break them: its module joins this list.
import { readFileSync } from 'node:fs';

/** src/ui.js, then each module extracted from it, relative to src/. */
export const UI_SOURCE_FILES = Object.freeze([
  'ui.js',
  'ui/cockpitView.js',
  'ui/radioPanel.js',
  'ui/cctvPanel.js',
  'ui/panelLayout.js',
  'ui/panelChrome.js',
  'ui/locationBar.js',
  'ui/globeNavigation.js',
  'ui/styleConfig.js',
  'ui/visualStyles.js',
  'ui/detectionControls.js',
  'ui/cockpitControls.js',
  'ui/contextPanel.js',
  'ui/shareState.js',
  'ui/statusFeedback.js',
  'ui/hudControls.js',
  'ui/recordingControls.js',
  'ui/mapStackControl.js',
  'ui/sceneState.js',
]);

/**
 * The files in UI_SOURCE_FILES, read and joined in that order.
 * @returns {string}
 */
export function readUiSource() {
  return UI_SOURCE_FILES.map((file) =>
    readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'),
  ).join('\n');
}

/**
 * A regex source for `text` that accepts the line shapes a formatter may
 * give it: any whitespace run between tokens, whitespace after an opening
 * bracket or a comma, and a trailing comma before a closing bracket.
 * @param {string} text - Source text, such as a member's signature.
 * @returns {string}
 */
export function looseSourcePattern(text) {
  let out = '';
  for (const char of text) {
    if (/\s/.test(char)) {
      if (!out.endsWith('\\s*')) out += '\\s*';
    } else if ('([{'.includes(char)) {
      out += `\\${char}\\s*`;
    } else if (')]}'.includes(char)) {
      out = `${out.replace(/(?:\\s\*)+$/, '')},?\\s*\\${char}`;
    } else if (char === ',') {
      out += ',\\s*';
    } else {
      out += char.replace(/[.*+?^$|\\/]/g, '\\$&');
    }
  }
  return out.replace(/(?:\\s\*){2,}/g, '\\s*');
}

/**
 * Where `text` first appears in `source` at or after `from`, allowing the
 * line shapes looseSourcePattern() allows. Leading indentation stays exact.
 * @param {string} source
 * @param {string} text
 * @param {number} [from]
 * @returns {number} The index, or -1.
 */
export function looseIndexOf(source, text, from = 0) {
  const indent = /^ */.exec(text)[0];
  const pattern = new RegExp(
    indent + looseSourcePattern(text.slice(indent.length)),
    'g',
  );
  pattern.lastIndex = from;
  return pattern.exec(source)?.index ?? -1;
}

/**
 * One class member of `source`, from its signature through its closing brace.
 * Members move between ui.js and the panel modules, so a member ends at its
 * own brace rather than at whichever member follows it, and its signature
 * matches however the formatter wrapped it.
 * @param {string} source - Usually readUiSource().
 * @param {string} signature - The member's first line as written, indentation
 *   included, such as '  setOrbit(enabled) {'.
 * @returns {string} The member's text, or '' when it is missing.
 */
export function memberSource(source, signature) {
  const indent = /^ */.exec(signature)[0];
  const pattern = new RegExp(
    `\\n${indent}${looseSourcePattern(signature.slice(indent.length))}`,
  );
  const match = pattern.exec(source);
  if (!match) return '';
  const end = source.indexOf('\n  }\n', match.index + match[0].length);
  return end < 0 ? '' : source.slice(match.index + 1, end + '\n  }'.length);
}
