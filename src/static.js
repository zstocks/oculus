import { createReadStream, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, sep, extname } from 'node:path';

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

// Serve a file from public/ (mapping '/' -> index.html). Returns true if served.
export function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const abs = resolve(PUBLIC_DIR, rel);
  if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + sep)) return false; // traversal guard

  let st;
  try { st = statSync(abs); } catch { return false; }
  if (!st.isFile()) return false;

  res.writeHead(200, {
    'Content-Type': TYPES[extname(abs).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size,
  });
  if (req.method === 'HEAD') { res.end(); return true; }
  createReadStream(abs).pipe(res);
  return true;
}