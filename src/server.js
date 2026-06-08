import http from 'node:http';
import { mkdirSync, writeFileSync, createReadStream, createWriteStream, statSync } from 'node:fs';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { config } from './config.js';
import './db/index.js';
import { isAgent } from './auth.js';
import {
  getByHash, insertPhoto, countPhotos, searchPhotos, listUntagged, getById, getRelPath, getOriginalInfo,
} from './db/photos.js';
import { listTags, getPhotoTags, applyTags, removeTags } from './db/tags.js';
import { parse, QueryError } from './query/parse.js';
import { compile } from './query/compile.js';
import { serveStatic } from './static.js';
import { hashFile, readImageMeta, makeThumbnail, formatToMime } from './media.js';
import { enqueueUpload, kickSync, startSync } from './sync.js';

mkdirSync(config.thumbDir, { recursive: true });
mkdirSync(config.stagingDir, { recursive: true });

const isGet = (m) => m === 'GET' || m === 'HEAD';
const HASH_RE = /^[0-9a-f]{64}$/;

const server = http.createServer(async (req, res) => {
  const { method } = req;
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  try {
    if (path === '/health' && isGet(method)) return sendJson(req, res, 200, { status: 'ok', app: 'oculus' });

    if (path.startsWith('/api/agent/')) {
      if (!isAgent(req)) return sendJson(req, res, 401, { error: 'unauthorized' });
      if (path === '/api/agent/ingest' && method === 'POST') return await handleIngest(req, res);
      return sendJson(req, res, 404, { error: 'not_found' });
    }

    // Browser API (session auth added in a later step).
    if (path === '/api/photos' && isGet(method)) return handleListPhotos(req, res, url);
    if (path === '/api/photos/count' && isGet(method)) return sendJson(req, res, 200, { count: countPhotos() });
    if (path === '/api/upload' && method === 'POST') return await handleUpload(req, res);
    if (path.startsWith('/api/thumb/') && isGet(method)) return handleThumb(req, res, path);
    if (path.startsWith('/api/original/') && method === 'GET') return await handleOriginal(req, res, path);
    if (path.startsWith('/api/photos/') && isGet(method)) return handleGetPhoto(req, res, path);
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

async function handleOriginal(req, res, path) {
  const id = Number(path.slice('/api/original/'.length));
  if (!Number.isInteger(id)) return sendJson(req, res, 400, { error: 'bad_request' });
  const info = getOriginalInfo(id);
  if (!info) return sendJson(req, res, 404, { error: 'not_found' });

  // Not yet synced to the Maingear -> serve the staged original from the VPS.
  if (info.staged) {
    const file = join(config.stagingDir, info.hash);
    let st;
    try { st = statSync(file); } catch { return sendJson(req, res, 404, { error: 'not_found' }); }
    res.writeHead(200, { 'Content-Type': formatToMime(info.format), 'Content-Length': st.size });
    createReadStream(file).pipe(res);
    return;
  }

  if (!info.rel_path) return sendJson(req, res, 404, { error: 'not_found' });
  let agentRes;
  try {
    agentRes = await fetch(
      config.agentUrl.replace(/\/$/, '') + '/original?rel=' + encodeURIComponent(info.rel_path),
      { headers: { Authorization: `Bearer ${config.agentToken}` } },
    );
  } catch {
    return sendJson(req, res, 503, { error: 'agent_unreachable' });
  }
  if (!agentRes.ok) return sendJson(req, res, agentRes.status, { error: 'agent_error' });

  const headers = { 'Content-Type': agentRes.headers.get('content-type') || 'application/octet-stream' };
  const len = agentRes.headers.get('content-length');
  if (len) headers['Content-Length'] = len;
  res.writeHead(200, headers);
  Readable.fromWeb(agentRes.body).pipe(res);
}

async function handleUpload(req, res) {
  const filename = req.headers['x-filename'] ? decodeURIComponent(req.headers['x-filename']) : 'upload';
  const tmp = join(config.stagingDir, 'tmp-' + randomUUID());

  try {
    await streamToFile(req, tmp, 200 * 1024 * 1024);
  } catch {
    await unlink(tmp).catch(() => {});
    return sendJson(req, res, 413, { error: 'too_large' });
  }

  const hash = await hashFile(tmp);
  if (getByHash(hash)) {
    await unlink(tmp).catch(() => {});
    return sendJson(req, res, 200, { status: 'duplicate' });
  }

  let meta;
  try { meta = await readImageMeta(tmp); }
  catch { await unlink(tmp).catch(() => {}); return sendJson(req, res, 400, { error: 'unsupported_image' }); }

  const ext = (extname(filename) || '.jpg').toLowerCase();
  const d = meta.taken_at ? new Date(meta.taken_at) : new Date();
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const relPath = `${yyyy}/${mm}/${hash}${ext}`;

  writeFileSync(join(config.thumbDir, `${hash}.webp`), await makeThumbnail(tmp, 400));

  const staged = join(config.stagingDir, hash);
  await rename(tmp, staged);

  const info = insertPhoto({
    hash, rel_path: relPath, original_filename: filename, kind: 'image',
    format: meta.format, width: meta.width, height: meta.height, file_size: statSync(staged).size,
    duration: null, taken_at: meta.taken_at, camera_make: meta.camera_make, camera_model: meta.camera_model,
    gps_lat: meta.gps_lat, gps_lon: meta.gps_lon, sync_status: 'pending', staged: 1,
  });
  const id = Number(info.lastInsertRowid);
  enqueueUpload(id);
  kickSync(); // try to push immediately if the agent is online

  return sendJson(req, res, 201, { status: 'created', id });
}

async function handleTagOp(req, res, op) {
  const body = await readJson(req, 1024 * 1024);
  const photoIds = Array.isArray(body?.photo_ids) ? body.photo_ids.filter(Number.isInteger) : [];
  const tags = Array.isArray(body?.tags) ? body.tags.map((t) => String(t).trim()).filter((t) => t.length > 0) : [];
  if (photoIds.length === 0 || tags.length === 0) return sendJson(req, res, 400, { error: 'bad_request' });
  return sendJson(req, res, 200, { changed: op(photoIds, tags) });
}

async function handleIngest(req, res) {
  const body = await readJson(req, 16 * 1024 * 1024);
  const photo = body?.photo;
  const thumbB64 = body?.thumbnail_b64;
  if (!photo?.hash || !thumbB64) return sendJson(req, res, 400, { error: 'bad_request' });
  const existing = getByHash(photo.hash);
  if (existing) return sendJson(req, res, 200, { status: 'duplicate', rel_path: existing.rel_path });
  writeFileSync(join(config.thumbDir, `${photo.hash}.webp`), Buffer.from(thumbB64, 'base64'));
  insertPhoto({ ...photo, sync_status: 'synced', staged: 0 });
  return sendJson(req, res, 201, { status: 'created' });
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
  startSync();
});