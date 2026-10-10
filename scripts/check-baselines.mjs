/**
 * Fails when a change grows one of the three baselines that exempt upstream's
 * code from the fork's checks: typecheck-baseline.json, biome-baseline.json
 * and knip-baseline.json. It compares each file at a base commit with the
 * same file at HEAD:
 *
 * - typecheck: a new file, or a file with more type errors;
 * - Biome: a new rule, or a new file in a rule's includes;
 * - knip: a new file, or a new issue type for a file.
 *
 * Fixing a finding shrinks a baseline, which always passes. Only a merge of
 * upstream may grow one, since it brings in upstream code that `pnpm run
 * baseline` covers and the merge's reviewer reads. A range with such a merge
 * reports its growth without failing. An upstream merge is a merge whose
 * second parent is not on the fork's first-parent history: the history it
 * brings in branched off somewhere else, so the merge base of its parents is
 * not on the first parent's first-parent chain. A merge of a fork branch, or
 * the merge commit GitHub tests a pull request on, branched off that chain.
 *
 * Usage: node scripts/check-baselines.mjs --base <commit> [--head <commit>]
 * An empty or all-zero base (the push of a new branch) skips the check.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const BASELINES = Object.freeze({
  typecheck: 'typecheck-baseline.json',
  biome: 'biome-baseline.json',
  knip: 'knip-baseline.json',
});

/**
 * One baseline as a flat list of what it allows. `count` caps an entry;
 * `parent` names the entry it belongs to, so a new rule or file is reported
 * once rather than once per file or issue type under it.
 * @typedef {{count?: number, parent?: string}} Entry
 * @typedef {Map<string, Entry>} Entries
 */

/**
 * typecheck-baseline.json: `{project: {file: errorCount}}`. A project's list
 * of files, the format before error counts, allows each file without a cap.
 * @param {unknown} baseline
 * @returns {Entries}
 */
export function typecheckEntries(baseline) {
  /** @type {Entries} */
  const entries = new Map();
  for (const [project, files] of Object.entries(asObject(baseline))) {
    const counts = Array.isArray(files)
      ? Object.fromEntries(files.map((file) => [file, undefined]))
      : asObject(files);
    for (const [file, count] of Object.entries(counts)) {
      entries.set(`${project}: ${file}`, {
        count: typeof count === 'number' ? count : undefined,
      });
    }
  }
  return entries;
}

/**
 * biome-baseline.json: overrides that each switch off one check for the
 * files in their `includes`.
 * @param {unknown} baseline
 * @returns {Entries}
 */
export function biomeEntries(baseline) {
  /** @type {Entries} */
  const entries = new Map();
  const { overrides } = /** @type {{overrides?: unknown}} */ (
    asObject(baseline)
  );
  for (const override of Array.isArray(overrides) ? overrides : []) {
    const { includes, ...setting } = asObject(override);
    for (const rule of overrideRules(setting)) {
      entries.set(rule, {});
      for (const file of Array.isArray(includes) ? includes : []) {
        entries.set(`${rule}: ${file}`, { parent: rule });
      }
    }
  }
  return entries;
}

/**
 * The Biome checks an override switches off, named as Biome names their
 * diagnostics: `format`, `lint/<group>/<rule>` or `assist/<group>/<action>`.
 * @param {Record<string, unknown>} setting The override without `includes`.
 * @returns {string[]}
 */
function overrideRules(setting) {
  /** @type {string[]} */
  const rules = [];
  for (const [key, value] of Object.entries(setting)) {
    const option = asObject(value);
    if (key === 'formatter') {
      rules.push('format');
    } else if (key === 'linter' || key === 'assist') {
      const groups = asObject(key === 'linter' ? option.rules : option.actions);
      const kind = key === 'linter' ? 'lint' : 'assist';
      for (const [group, names] of Object.entries(groups)) {
        for (const name of Object.keys(asObject(names))) {
          rules.push(`${kind}/${group}/${name}`);
        }
      }
    } else {
      rules.push(`${key} ${JSON.stringify(value)}`);
    }
  }
  return rules;
}

/**
 * knip-baseline.json: `{file: [issueType, ...]}`.
 * @param {unknown} baseline
 * @returns {Entries}
 */
export function knipEntries(baseline) {
  /** @type {Entries} */
  const entries = new Map();
  for (const [file, types] of Object.entries(asObject(baseline))) {
    entries.set(file, {});
    for (const type of Array.isArray(types) ? types : []) {
      entries.set(`${file}: ${type}`, { parent: file });
    }
  }
  return entries;
}

/**
 * What `after` allows that `before` did not: each new entry whose parent is
 * not new itself, and each entry whose count went up.
 * @param {Entries} before
 * @param {Entries} after
 * @returns {string[]}
 */
export function growth(before, after) {
  /** @type {string[]} */
  const grown = [];
  for (const [label, { count, parent }] of after) {
    const previous = before.get(label);
    if (!previous) {
      if (parent !== undefined && !before.has(parent)) continue;
      grown.push(count === undefined ? label : `${label} (${count})`);
    } else if (
      count !== undefined &&
      previous.count !== undefined &&
      count > previous.count
    ) {
      grown.push(`${label} (${previous.count} → ${count})`);
    }
  }
  return grown;
}

const ENTRIES = Object.freeze({
  typecheck: typecheckEntries,
  biome: biomeEntries,
  knip: knipEntries,
});

/**
 * How each baseline grew from one version of the three files to another.
 * @param {Record<string, unknown>} before Parsed files, by BASELINES key.
 * @param {Record<string, unknown>} after
 * @returns {Record<string, string[]>} The growth, by baseline file.
 */
export function baselineGrowth(before, after) {
  /** @type {Record<string, string[]>} */
  const result = {};
  for (const [name, entries] of Object.entries(ENTRIES)) {
    const grown = growth(entries(before[name]), entries(after[name]));
    if (grown.length) {
      result[BASELINES[/** @type {keyof typeof BASELINES} */ (name)]] = grown;
    }
  }
  return result;
}

/**
 * Whether a merge brings in history that branched off outside the fork's
 * first-parent history: upstream's.
 * @param {string | undefined} mergeBase The merge base of the merge's first
 *   two parents; undefined when they share no history.
 * @param {ReadonlySet<string>} firstParentChain The first parent and its
 *   first-parent ancestors.
 */
export function isUpstreamMerge(mergeBase, firstParentChain) {
  return mergeBase === undefined || !firstParentChain.has(mergeBase);
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/**
 * @param {string[]} args
 * @param {string} cwd
 */
function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * The upstream merges in `base..head`, as `<sha> <subject>` lines.
 * @param {string} base
 * @param {string} head
 * @param {string} [cwd]
 */
export function upstreamMerges(base, head, cwd = ROOT) {
  const merges = git(
    ['rev-list', '--merges', '--parents', `${base}..${head}`],
    cwd,
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' '));
  return merges
    .filter(([, first, second]) => {
      let mergeBase;
      try {
        mergeBase = git(['merge-base', first, second], cwd);
      } catch {
        mergeBase = undefined;
      }
      const chain = new Set(
        git(['rev-list', '--first-parent', first], cwd).split('\n'),
      );
      return isUpstreamMerge(mergeBase, chain);
    })
    .map(([merge]) => git(['log', '-1', '--format=%h %s', merge], cwd));
}

/**
 * The three baselines as committed at `ref`; a missing file reads as empty.
 * @param {string} ref
 * @param {string} [cwd]
 * @returns {Record<string, unknown>}
 */
export function baselinesAt(ref, cwd = ROOT) {
  /** @type {Record<string, unknown>} */
  const files = {};
  for (const [name, file] of Object.entries(BASELINES)) {
    let text;
    try {
      text = git(['show', `${ref}:${file}`], cwd);
    } catch {
      text = '{}';
    }
    files[name] = JSON.parse(text);
  }
  return files;
}

/**
 * @param {string[]} argv
 * @returns {{base: string, head: string}}
 */
export function parseArgs(argv) {
  const options = { base: '', head: 'HEAD' };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined || (flag !== '--base' && flag !== '--head')) {
      throw new Error(
        'Usage: node scripts/check-baselines.mjs --base <commit> [--head <commit>]',
      );
    }
    if (flag === '--base') options.base = value;
    else options.head = value;
  }
  return options;
}

/** @param {string[]} argv */
function main(argv) {
  const { base, head } = parseArgs(argv);
  if (!base || /^0+$/.test(base)) {
    console.log(
      'No base commit (a new branch): the baselines are not compared.',
    );
    return;
  }
  /** @param {string} ref */
  const commit = (ref) => {
    try {
      return git(['rev-parse', '--verify', `${ref}^{commit}`], ROOT);
    } catch {
      console.error(
        `${ref} is not a commit in this clone. The check needs the full history (fetch-depth: 0).`,
      );
      process.exit(1);
    }
  };
  const baseCommit = commit(base);
  const headCommit = commit(head);
  const grown = baselineGrowth(
    baselinesAt(baseCommit),
    baselinesAt(headCommit),
  );
  const files = Object.keys(grown);
  if (!files.length) {
    console.log(`The baselines did not grow from ${base} to ${head}.`);
    return;
  }
  for (const file of files) {
    console.log(
      `${file} grew:\n${grown[file].map((l) => `  ${l}`).join('\n')}`,
    );
  }
  const merges = upstreamMerges(baseCommit, headCommit);
  if (merges.length) {
    console.log(
      `Not failing: the range merges upstream (${merges.join('; ')}), whose code the baselines cover. Read the growth above: only upstream files belong in a baseline.`,
    );
    return;
  }
  console.error(
    `The baselines grew from ${base} to ${head}. Fix the new findings instead of regenerating a baseline; only an upstream merge may grow one (docs/UPSTREAM-SYNC.md).`,
  );
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
