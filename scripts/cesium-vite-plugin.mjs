import { createReadStream } from 'node:fs';
import { cp, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseAst } from 'vite';

// Cesium's prebuilt distributions: Cesium for builds, CesiumUnminified for
// development, each with the Workers, Assets, ThirdParty and Widgets it loads.
const CESIUM_BUILD = path.join(
  path.dirname(createRequire(import.meta.url).resolve('cesium/package.json')),
  'Build',
);
const SHIPPED = ['Assets', 'ThirdParty', 'Workers', 'Widgets', 'Cesium.js'];
const GLOBAL = 'globalThis.Cesium';
/** @type {Record<string, string>} */
const CONTENT_TYPES = {
  '.cjs': 'application/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.xml': 'application/xml',
};

/**
 * Rewrite one module's `cesium` imports to the global that Cesium.js defines.
 * Returns null when the module does not import cesium.
 * @param {string} code
 */
export function rewriteCesiumImports(code, id = 'module.js') {
  if (!code.includes('cesium')) return null;
  const ast = parseAst(code);
  /** @type {Array<{node: import('vite').ESTree.Span, text: string}>} */
  const edits = [];
  /**
   * @param {import('vite').ESTree.Span} node
   * @param {string} text
   */
  const replace = (node, text) => {
    // Keep line numbers stable for any later source maps.
    const lines = code.slice(node.start, node.end).split('\n').length - 1;
    edits.push({ node, text: text + '\n'.repeat(lines) });
  };
  for (const node of ast.body) {
    if (!('source' in node) || node.source?.value !== 'cesium') continue;
    if (node.type !== 'ImportDeclaration') {
      throw new Error(
        `${id}: export a local binding instead of re-exporting cesium`,
      );
    }
    replace(node, node.specifiers.map(bindGlobal).join(' '));
  }
  visit(ast, (node) => {
    if (node.type === 'ImportExpression' && node.source.value === 'cesium') {
      replace(
        /** @type {import('vite').ESTree.ImportExpression} */ (node),
        `Promise.resolve(${GLOBAL})`,
      );
    }
  });
  if (!edits.length) return null;
  let rewritten = code;
  for (const { node, text } of edits.sort(
    (a, b) => b.node.start - a.node.start,
  )) {
    rewritten =
      rewritten.slice(0, node.start) + text + rewritten.slice(node.end);
  }
  return { code: rewritten, map: null };
}

/**
 * The fields of an import specifier the rewrite reads. Only a named import
 * has `imported`: an identifier (`name`) or a string literal (`value`).
 * @param {{
 *   local: {name: string},
 *   imported?: {name?: string, value?: string},
 * }} specifier
 */
function bindGlobal(specifier) {
  const local = specifier.local.name;
  const imported =
    specifier.imported?.name ?? specifier.imported?.value ?? 'default';
  if (imported === 'default') {
    // The namespace and the default export are the global itself, so a
    // namespace already named Cesium needs no binding.
    return local === 'Cesium' ? '' : `const ${local} = ${GLOBAL};`;
  }
  return `const ${local} = ${GLOBAL}[${JSON.stringify(imported)}];`;
}

/**
 * @param {Record<string, any> | Array<unknown> | null} node An AST node,
 *   an array of them, or null.
 * @param {(node: Record<string, any>) => void} callback
 */
function visit(node, callback) {
  if (Array.isArray(node)) {
    for (const child of node) visit(child, callback);
  } else if (node && typeof node.type === 'string') {
    callback(node);
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') visit(value, callback);
    }
  }
}

/**
 * A request reaching dev-server middleware. Node's HTTP server sets `url` on
 * the requests it receives; the typings leave it optional only because client
 * responses share the class.
 * @typedef {import('vite').Connect.IncomingMessage & {url: string}} DevRequest
 */

/**
 * Serve a directory's files with the headers serve-static used for Cesium.
 * @param {string} dir
 * @returns {(req: DevRequest, res: import('node:http').ServerResponse,
 *   next: import('vite').Connect.NextFunction) => void}
 */
function serveDirectory(dir) {
  return async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let pathname;
    try {
      pathname = decodeURIComponent(
        new URL(req.url, 'http://localhost').pathname,
      );
    } catch {
      return next();
    }
    // Only plain paths inside the directory name a Cesium asset: reject NUL
    // bytes, backslashes (separators on Windows), dotfiles and parent segments.
    if (
      /[\0\\]/.test(pathname) ||
      pathname.split('/').some((part) => part.startsWith('.'))
    ) {
      return next();
    }
    const file = path.join(dir, pathname);
    if (!file.startsWith(dir + path.sep)) return next();
    let stats;
    try {
      stats = await stat(file);
    } catch {
      return next();
    }
    if (stats.isDirectory() && !pathname.endsWith('/')) {
      res.statusCode = 301;
      res.setHeader(
        'Location',
        `${(req.originalUrl ?? req.url).split('?')[0]}/`,
      );
      return res.end();
    }
    if (!stats.isFile()) return next();
    const etag = `W/"${stats.size.toString(16)}-${stats.mtime.getTime().toString(16)}"`;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=0');
    res.setHeader('Last-Modified', stats.mtime.toUTCString());
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
      res.statusCode = 304;
      return res.end();
    }
    res.setHeader(
      'Content-Type',
      CONTENT_TYPES[path.extname(file).toLowerCase()] ??
        'application/octet-stream',
    );
    res.setHeader('Content-Length', stats.size);
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).on('error', next).pipe(res);
  };
}

/**
 * Load Cesium as its prebuilt global build instead of bundling the engine.
 * Development serves the unminified build at /cesium/ and defines
 * CESIUM_BASE_URL; builds load /cesium/Cesium.js, read `cesium` imports from
 * its global and copy its runtime files into the output directory.
 * @returns {import('vite').Plugin}
 */
export default function cesium() {
  let command = 'serve';
  let baseUrl = '/cesium/';
  let outDir = 'dist';
  return {
    name: 'gods-eye-view:cesium',
    config(config, env) {
      command = env.command;
      const base = config.base === undefined ? '/' : config.base || './';
      baseUrl = path.posix.join(base, 'cesium/');
      return command === 'build'
        ? { build: { rolldownOptions: { external: ['cesium'] } } }
        : { define: { CESIUM_BASE_URL: JSON.stringify(baseUrl) } };
    },
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use(
        path.posix.join('/', baseUrl),
        serveDirectory(path.join(CESIUM_BUILD, 'CesiumUnminified')),
      );
    },
    transform(code, id) {
      if (command !== 'build' || id.startsWith('\0')) return null;
      if (!/\.(?:[cm]?js|jsx)$/.test(id.split('?')[0])) return null;
      return rewriteCesiumImports(code, id);
    },
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (
          chunk.type === 'chunk' &&
          [...chunk.imports, ...chunk.dynamicImports].includes('cesium')
        ) {
          this.error(`${chunk.fileName} still imports cesium`);
        }
      }
    },
    async closeBundle() {
      if (command !== 'build') return;
      const from = path.join(CESIUM_BUILD, 'Cesium');
      const to = path.join(outDir, 'cesium');
      await Promise.all(
        SHIPPED.map((entry) =>
          cp(path.join(from, entry), path.join(to, entry), { recursive: true }),
        ),
      );
    },
    transformIndexHtml() {
      /** @type {import('vite').HtmlTagDescriptor[]} */
      const tags = [
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href: path.posix.join(baseUrl, 'Widgets/widgets.css'),
          },
        },
      ];
      if (command === 'build') {
        tags.push({
          tag: 'script',
          attrs: { src: path.posix.join(baseUrl, 'Cesium.js') },
        });
      }
      return tags;
    },
  };
}
