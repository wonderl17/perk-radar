import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { ROOT, isMain, readJson } from './lib.mjs';
import { createFeed } from './build.mjs';

const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.xml': 'application/rss+xml; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
export function resolvePublicPath(pathname, root, dist = false) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some(segment => segment === '..' || segment.startsWith('.'))) return null;
  if (dist) {
    const base = resolve(root, 'dist');
    const target = resolve(base, `.${decoded === '/' ? '/index.html' : decoded}`);
    return target.startsWith(base + sep) ? target : null;
  }
  if (decoded === '/' || decoded === '/index.html') return resolve(root, 'index.html');
  if (decoded === '/data/offers.json') return resolve(root, 'data/offers.json');
  if (decoded.startsWith('/src/')) return resolve(root, `.${decoded}`);
  if (decoded.split('/').some(segment => segment.startsWith('.'))) return null;
  return resolve(root, 'public', `.${decoded}`);
}
export function createPreviewServer({ root = ROOT, dist = false, getScanStatus } = {}) {
  return createServer(async (request, response) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return; }
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (getScanStatus && pathname === '/api/health') {
        const status = await getScanStatus();
        const scanner = Object.fromEntries(['status', 'startedAt', 'lastAttemptAt', 'lastSuccessAt', 'nextScanAt'].filter(key => typeof status?.[key] === 'string' || status?.[key] === null).map(key => [key, status[key]]));
        if (status?.lastResult) scanner.lastResult = Object.fromEntries(['examined', 'published', 'updated', 'flagged', 'held', 'rejected', 'failed'].filter(key => Number.isFinite(status.lastResult[key]) && status.lastResult[key] >= 0).map(key => [key, status.lastResult[key]]));
        const body = JSON.stringify({ status: 'ok', scanner });
        response.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        response.end(request.method === 'HEAD' ? undefined : body); return;
      }
      if (!dist && pathname === '/feed.xml') {
        const document = await readJson(resolve(root, 'data/offers.json'));
        const site = await readJson(resolve(root, 'data/site.json'), {});
        const body = createFeed(document, process.env.SITE_URL || site.siteUrl);
        response.writeHead(200, { 'Content-Type': MIME['.xml'], 'Cache-Control': 'no-store' }); response.end(request.method === 'HEAD' ? undefined : body); return;
      }
      const path = resolvePublicPath(pathname, root, dist);
      if (!path) { response.writeHead(403); response.end('Forbidden'); return; }
      // The preview server serves checked-in assets only, never hidden files or directory listings.
      const info = await stat(path);
      if (!info.isFile()) throw Object.assign(new Error('Not found'), { code: 'ENOENT' });
      const content = await readFile(path);
      response.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) { response.writeHead(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 500); response.end(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'Not found' : 'Server error'); }
  });
}
if (isMain(import.meta.url)) {
  const index = process.argv.indexOf('--port');
  const port = Number(index === -1 ? process.env.PORT || 4173 : process.argv[index + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const server = createPreviewServer({ dist: process.argv.includes('--dist') });
  server.listen(port, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${port}/`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
