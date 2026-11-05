#!/usr/bin/env node
/**
 * Local development server for S-Way:  npm start  →  http://127.0.0.1:8000
 *
 * Serves the static site with the same security headers recommended for production
 * (see deployment/_headers). GET/HEAD only, no directory listings, no path traversal,
 * binds to localhost. No logging of request paths beyond a status line.
 */
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { resolve, join, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.gz': 'application/gzip',
  '.bcmap': 'application/octet-stream', '.ipynb': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf', '.ico': 'image/x-icon',
};

/** Paths that are never served (research data, tests, tooling). Executed notebooks are published for the in-app viewer. */
const BLOCKED = [/^\/(tests|tools|node_modules|deployment|vendor-src)\//, /^\/notebooks\/(?!(index\.json|[0-9]{2}_[a-z0-9_]+\.ipynb)$)/, /^\/\./, /\.(py|md|map)$/];

export const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; frame-src 'none'; media-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), clipboard-read=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

const server = createServer((req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
  let path;
  try { path = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
  if (path.includes('\0') || BLOCKED.some((re) => re.test(path))) { res.writeHead(404).end('Not found'); return; }
  if (path.endsWith('/')) path += 'index.html';
  const file = resolve(join(ROOT, path));
  if (!file.startsWith(ROOT + sep)) { res.writeHead(404).end('Not found'); return; }
  let st;
  try { st = statSync(file); } catch { res.writeHead(404).end('Not found'); return; }
  if (!st.isFile()) { res.writeHead(404).end('Not found'); return; } // no directory listings
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Content-Length': st.size });
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(file).pipe(res);
});

server.headersTimeout = 10_000;
server.requestTimeout = 15_000;
server.listen(PORT, HOST, () => console.log(`S-Way running at http://${HOST}:${PORT}/  (Ctrl+C to stop)`));
