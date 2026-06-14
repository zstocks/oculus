import http from 'node:http';
import { mkdirSync, createReadStream, createWriteStream, statSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import './db/index.js';
import {
  countPhotos, searchPhotos, listUntagged, getById, getOriginalInfo, renamePhoto,
} from './db/photos.js';
import { listTags, getPhotoTags, applyTags, removeTags } from './db/tags.js';
import { parse, QueryError } from './query/parse.js';
import { compile } from './query/compile.js';
import { serveStatic } from './static.js';
import { formatToMime } from './media.js';
import { ingestFile } from './ingest.js';
import { startScanner } from './scanner.js';
import { issueToken, isLoggedIn, checkPassword, sessionCookie, clearCookie } from './session.js';
import { tooMany, recordFail, recordSuccess } from './ratelimit.js';

mkdirSync(config.thumbDir, { recursive: true });
mkdirSync(config.tmpDir, { recursive: true });

const isGet = (m) => m === 'GET' || m === 'HEAD';
const HASH_RE = /^[0-9a-f]{64}$/;
// Icons must be reachable before login (login page + browsers' bare /favicon.ico probe).
const PUBLIC_ASSETS = new Set(['/favicon.ico', '/favicon.svg', '/apple-touch-icon.png']);

const server = http.createServer(async (req, res) => {
  const { method } = req;
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  try {
    if (path === '/health' && isGet(method)) return sendJson(req, res, 200, { status: 'ok', app: 'oculus' });

    // --- auth surface (open) ---
    if (PUBLIC_ASSETS.has(path) && isGet(method) && serveStatic(req, res, path)) return;
    if (path === '/login' && isGet(method)) { serveStatic(req, res, '/login.html'); return; }
    if (path === '/login' && method === 'POST') return await handleLogin(req, res);
    if (path === '/logout' && method === 'POST') {
      res.setHeader('Set-Cookie', clearCookie(isHttps(req)));
      return sendJson(req, res, 200, { status: 'ok' });
    }

    // --- everything past here requires a valid session ---
    if (!isLoggedIn(req)) {
      if (path.startsWith('/api/')) return sendJson(req, res, 401, { error: 'unauthorized' });
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }

    if (path === '/api/photos' && isGet(method)) return handleListPhotos(req, res, url);
    if (path === '/api/photos/count' && isGet(method)) return sendJson(req, res, 200, { count: countPhotos() });
    if (path === '/api/upload' && method === 'POST') return await handleUpload(req, res);
    if (path.startsWith('/api/thumb/') && isGet(method)) return handleThumb(req, res, path);
    if (path.startsWith('/api/original/') && method === 'GET') return await handleOriginal(req, res, path);
    if (path.startsWith('/api/download/') && method === 'GET') return await handleDownload(req, res, path);
    if (path.startsWith('/api/photos/') && isGet(method)) return handleGetPhoto(req, res, path);
    if (path.startsWith('/api/photos/') && method === 'PATCH') return await handleRenamePhoto(req, res, path);
    if (path === '/api/tags' && isGet(method)) return sendJson(req, res, 200, { tags: listTags() });
    if (path === '/api/tags/apply' && method === 'POST') return await handleTagOp(req, res, applyTags);
    if (path === '/api/tags/remove' && method === 'POST') return await handleTagOp(req, res, removeTags);

    if (isGet(method) && serveStatic(req, res, path)) return;

    sendJson(req, res, 404, { error: 'not_found' });
  } catch (err) {
    if (err instanceof QueryError) return sendJson(req, res, 400, { error: 'bad_query', message: err.message });
    console.error('[oculus] request error:', err);
    sendJson(req, res, 500, { error: 'server_error' });
  }
});

function handleListPhotos(req, res, url) {
  const limit = clampInt(url.searchParams.get('limit'), 100, 1, 500);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 1e9);
  if (url.searchParams.get('untagged') === '1') {
    return sendJson(req, res, 200, { photos: listUntagged(limit, offset) });
  }
  const q = url.searchParams.get('q') || '';
  const { where, params } = compile(parse(q));
  return sendJson(req, res, 200, { photos: searchPhotos(where, params, limit, offset) });
}

function handleGetPhoto(req, res, path) {
  const id = Number(path.slice('/api/photos/'.length));
  if (!Number.isInteger(id)) return sendJson(req, res, 400, { error: 'bad_request' });
  const photo = getById(id);
  if (!photo) return sendJson(req, res, 404, { error: 'not_found' });
  return sendJson(req, res, 200, { photo: { ...photo, tags: getPhotoTags(id) } });
}

async function handleRenamePhoto(req, res, path) {
  const id = Number(path.slice('/api/photos/'.length));
  if (!Number.isInteger(id)) return sendJson(req, res, 400, { error: 'bad_request' });

  let body;
  try { body = await readJson(req, 64 * 1024); }
  catch { return sendJson(req, res, 400, { error: 'bad_request' }); }

  const name = typeof body?.original_filename === 'string' ? body.original_filename.trim() : '';
  if (!name || name.length > 255) return sendJson(req, res, 400, { error: 'bad_request' });

  if (renamePhoto(id, name) === 0) return sendJson(req, res, 404, { error: 'not_found' });
  return sendJson(req, res, 200, { status: 'ok', original_filename: name });
}

function handleThumb(req, res, path) {
  const hash = path.slice('/api/thumb/'.length).replace(/\.webp$/, '');
  if (!HASH_RE.test(hash)) return sendJson(req, res, 400, { error: 'bad_request' });
  const file = join(config.thumbDir, `${hash}.webp`);
  let st;
  try { st = statSync(file); } catch { return sendJson(req, res, 404, { error: 'not_found' }); }
  res.writeHead(200, {
    'Content-Type': 'image/webp', 'Content-Length': st.size,
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

// Stream the original straight from the box mount. Mount down -> the read errors -> 503;
// row exists but file is missing -> 404. Keeps the :id validation guard above.
async function handleOriginal(req, res, path) {
  const id = Number(path.slice('/api/original/'.length));
  if (!Number.isInteger(id)) return sendJson(req, res, 400, { error: 'bad_request' });
  const info = getOriginalInfo(id);
  if (!info || !info.rel_path) return sendJson(req, res, 404, { error: 'not_found' });

  streamFromMount(req, res, info.rel_path, { 'Content-Type': formatToMime(info.format) });
}

// Download the original to the requesting device — same mount read, attachment headers.
async function handleDownload(req, res, path) {
  const id = Number(path.slice('/api/download/'.length));
  if (!Number.isInteger(id)) return sendJson(req, res, 400, { error: 'bad_request' });
  const info = getOriginalInfo(id);
  if (!info || !info.rel_path) return sendJson(req, res, 404, { error: 'not_found' });

  streamFromMount(req, res, info.rel_path, downloadHeaders(formatToMime(info.format), downloadName(info)));
}

function streamFromMount(req, res, relPath, headers) {
  const file = join(config.originalsDir, relPath);
  let st;
  try {
    st = statSync(file);
  } catch (err) {
    // ENOENT -> the row outlived its file; anything else (mount down) -> unavailable.
    if (err.code === 'ENOENT') return sendJson(req, res, 404, { error: 'not_found' });
    return sendJson(req, res, 503, { error: 'storage_unavailable' });
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  const stream = createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

function downloadName(info) {
  const base = (info.original_filename || '').trim().replace(/[/\\]/g, '_');
  if (base) return base;
  const ext = info.format ? '.' + info.format : '';
  return info.hash.slice(0, 16) + ext;
}

function downloadHeaders(mime, filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename);
  return {
    'Content-Type': mime,
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`,
    'Cache-Control': 'no-store',
  };
}

async function handleUpload(req, res) {
  const filename = req.headers['x-filename'] ? decodeURIComponent(req.headers['x-filename']) : 'upload';
  const tmp = join(config.tmpDir, 'up-' + randomUUID());

  try {
    await streamToFile(req, tmp, 200 * 1024 * 1024);
  } catch {
    await unlink(tmp).catch(() => {});
    return sendJson(req, res, 413, { error: 'too_large' });
  }

  let result;
  try {
    result = await ingestFile(tmp, filename); // consumes tmp on every outcome
  } catch (err) {
    await unlink(tmp).catch(() => {});
    console.error('[oculus] ingest failed:', err);
    return sendJson(req, res, 500, { error: 'server_error' });
  }

  if (result.rejected) return sendJson(req, res, 400, { error: 'unsupported_image' });
  if (result.duplicate) return sendJson(req, res, 200, { status: 'duplicate', id: result.id });
  return sendJson(req, res, 201, { status: 'created', id: result.id });
}

async function handleTagOp(req, res, op) {
  const body = await readJson(req, 1024 * 1024);
  const photoIds = Array.isArray(body?.photo_ids) ? body.photo_ids.filter(Number.isInteger) : [];
  const tags = Array.isArray(body?.tags) ? body.tags.map((t) => String(t).trim()).filter((t) => t.length > 0) : [];
  if (photoIds.length === 0 || tags.length === 0) return sendJson(req, res, 400, { error: 'bad_request' });
  return sendJson(req, res, 200, { changed: op(photoIds, tags) });
}

async function handleLogin(req, res) {
  const ip = clientIp(req);
  if (tooMany(ip)) return sendJson(req, res, 429, { error: 'too_many_attempts' });

  let body;
  try { body = await readJson(req, 4 * 1024); }
  catch { return sendJson(req, res, 400, { error: 'bad_request' }); }

  if (!checkPassword(body?.password)) {
    recordFail(ip);
    return sendJson(req, res, 401, { error: 'invalid_password' });
  }

  recordSuccess(ip);
  const token = issueToken(config.sessionTtlMs);
  res.setHeader('Set-Cookie', sessionCookie(token, config.sessionTtlMs, isHttps(req)));
  return sendJson(req, res, 200, { status: 'ok' });
}

function clientIp(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

function isHttps(req) {
  return req.headers['x-forwarded-proto'] === 'https';
}

function streamToFile(req, path, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const ws = createWriteStream(path);
    req.on('data', (c) => { size += c.length; if (size > limit) { req.destroy(); ws.destroy(); reject(new Error('too_large')); } });
    req.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
    req.pipe(ws);
  });
}

function clampInt(value, def, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { req.destroy(); reject(new Error('payload_too_large')); return; } chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function sendJson(req, res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(req.method === 'HEAD' ? undefined : payload);
}

server.listen(config.port, () => {
  console.log(`[oculus] listening on :${config.port}`);
  console.log(`[oculus] thumbnails: ${config.thumbDir}`);
  console.log(`[oculus] originals:  ${config.originalsDir}`);
  startScanner();
});