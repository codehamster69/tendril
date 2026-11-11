const { protocol } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const SCHEME = 'app';
const HOST = 'tendril';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json',
};

/** Must run before the app is ready. A secure, standard scheme gives workers, IndexedDB and fetch a real origin. */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
}

/** Maps app://tendril/<path> onto files under distDir, and nothing else. */
function resolveRequest(distDir, requestUrl) {
  let url;
  try { url = new URL(requestUrl); } catch { return null; }
  if (url.protocol !== `${SCHEME}:` || url.host !== HOST) return null;
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return null; }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = path.resolve(distDir, `.${pathname}`);
  return file.startsWith(path.resolve(distDir) + path.sep) ? file : null;
}

function serveApp(distDir) {
  protocol.handle(SCHEME, async (request) => {
    const file = resolveRequest(distDir, request.url);
    if (!file) return new Response('Not found', { status: 404 });
    try {
      const body = await fs.readFile(file);
      return new Response(body, { headers: { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

module.exports = { registerScheme, serveApp, resolveRequest, SCHEME, HOST };
