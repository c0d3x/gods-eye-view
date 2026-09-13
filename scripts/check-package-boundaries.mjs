import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, normalizePath } from 'vite';

/** Build each browser export group and reject imports outside its declared ownership. */
export async function checkPackageBoundaries(root) {
  root = await realpath(root);
  const readJson = async (name) =>
    JSON.parse(await readFile(path.join(root, name), 'utf8'));
  const pkg = await readJson('package.json');
  const groups = await readJson('scripts/package-boundaries.json');
  const declaredExports = Object.keys(pkg.exports || {}).sort();
  const classifiedExports = Object.values(groups)
    .flatMap((group) => group.exports)
    .sort();
  if (
    !declaredExports.length ||
    JSON.stringify(declaredExports) !== JSON.stringify(classifiedExports)
  ) {
    throw new Error(
      'Every package export must belong to exactly one boundary group',
    );
  }
  const reports = [];
  for (const [name, group] of Object.entries(groups)) {
    if (
      !Array.isArray(group.modules) ||
      !group.modules.length ||
      !Array.isArray(group.external)
    ) {
      throw new Error(`Invalid package boundary: ${name}`);
    }
    const allowed = new Set();
    for (const module of group.modules) {
      if (
        typeof module !== 'string' ||
        path.isAbsolute(module) ||
        module.includes('\\') ||
        module.split('/').includes('..')
      ) {
        throw new Error(`Boundary modules must be repository paths: ${name}`);
      }
      const resolved = await realpath(path.join(root, module));
      const relative = path.relative(root, resolved);
      if (
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        throw new Error(`Boundary module escapes repository: ${name}`);
      }
      allowed.add(normalizePath(resolved));
    }
    for (const external of group.external) {
      if (
        !Object.hasOwn(pkg.dependencies || {}, external) &&
        !Object.hasOwn(pkg.peerDependencies || {}, external)
      ) {
        throw new Error(
          `Boundary external must be a declared runtime dependency: ${external}`,
        );
      }
    }
    const input = group.exports.map((key) => {
      const target = pkg.exports[key];
      if (
        typeof target !== 'string' ||
        !target.startsWith('./') ||
        !allowed.has(normalizePath(path.resolve(root, target)))
      ) {
        throw new Error(`Export must point to an owned module: ${key}`);
      }
      return path.resolve(root, target);
    });
    const seen = new Set();
    await build({
      root,
      configFile: false,
      envFile: false,
      publicDir: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'check-package-ownership',
          moduleParsed(info) {
            if (!allowed.has(info.id)) {
              throw new Error(
                `Package boundary ${name} imports an unowned module: ${path.relative(root, info.id)}`,
              );
            }
            seen.add(info.id);
          },
        },
      ],
      build: {
        lib: { entry: input, formats: ['es'] },
        write: false,
        minify: false,
        assetsInlineLimit: 0,
        rolldownOptions: {
          input,
          external: group.external,
          // Unused imports must still obey ownership; tree shaking is not a boundary.
          treeshake: false,
          preserveEntrySignatures: 'strict',
        },
      },
    });
    reports.push({ name, exports: input.length, modules: seen.size });
  }
  return reports;
}

/** Whether an import specifier names a package rather than a file. */
function isPackageSpecifier(id) {
  return !(
    id.startsWith('.') ||
    id.startsWith('/') ||
    id.startsWith('\0') ||
    path.isAbsolute(id)
  );
}

/**
 * Build the app's browser graph from `entry` and reject every import of a
 * module under server/: the dev server's code never ships to the browser.
 * Packages stay external, so only this repository's modules are followed.
 */
export async function checkServerBoundary(root, entry = 'src/main.js') {
  root = await realpath(root);
  const server = `${normalizePath(path.join(root, 'server'))}/`;
  const inServer = (id) => normalizePath(id).startsWith(server);
  const relative = (id) => normalizePath(path.relative(root, id));
  const crossings = new Set();
  const modules = new Set();
  await build({
    root,
    configFile: false,
    envFile: false,
    publicDir: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'check-server-boundary',
        enforce: 'pre',
        resolveId(source, importer) {
          if (!importer || isPackageSpecifier(source)) return null;
          const from = importer.split('?')[0];
          const file = source.split('?')[0];
          let target = path.resolve(path.dirname(from), file);
          if (path.isAbsolute(file)) {
            target = normalizePath(file).startsWith(normalizePath(root))
              ? file
              : path.join(root, file);
          }
          if (inServer(target) && !inServer(from)) {
            crossings.add(`${relative(from)} → ${relative(target)}`);
          }
          return null;
        },
        moduleParsed(info) {
          modules.add(info.id);
        },
      },
    ],
    worker: { format: 'es' },
    build: {
      lib: { entry: path.resolve(root, entry), formats: ['es'] },
      write: false,
      minify: false,
      target: 'esnext',
      assetsInlineLimit: 0,
      rolldownOptions: {
        external: isPackageSpecifier,
        treeshake: false,
      },
    },
  });
  if (crossings.size) {
    throw new Error(
      `Browser code imports from server/: ${[...crossings].join(', ')}`,
    );
  }
  return { name: 'browser', modules: modules.size };
}

const invoked = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invoked) {
  try {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const reports = await checkPackageBoundaries(root);
    for (const report of reports)
      console.log(
        `Checked ${report.name}: ${report.exports} exports, ${report.modules} owned modules.`,
      );
    const browser = await checkServerBoundary(root);
    console.log(
      `Checked ${browser.name}: ${browser.modules} modules, none from server/.`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
