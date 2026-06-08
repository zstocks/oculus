import http from 'node:http';
import { mkdirSync, writeFileSync, createReadStream, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { config } from './config.js';
import './db/index.js';
import { isAgent } from './auth.js';
import {
  getByHash, insertPhoto, countPhotos, searchPhotos, listUntagged, getById, getRelPath,
} from './db/photos.js';
import { listTags, getPhotoTags, applyTags, removeTags } from './db/tags.js';
import { parse, QueryError } from './query/parse.js';
import { compile } from './query/compile.js';

mkdirSync(config.thumbDir, { recursive: true });

const isGet = (m) => m === 'GET' || m === 'HEAD';
const HASH_RE = /^[0-9a-f]{64}$/;

const server = http.createServer(async (req, res) => {
  const { method } = req;
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  try {
    if (path === '/health' && isGet(method)) return sendJson(req, res, 200, { status: 'ok', app: 'oculus' });
    if (path === '/' && isGet(method)) return sendJson(req, res, 200, { app: 'oculus' });

    // Machine-to-machine (agent <-> VPS), guarded by the shared token.
    if (path.startsWith('/api/agent/')) {
      if (!isAgent(req)) return sendJson(req, res, 401, { error: 'unauthorized' });
      if (path === '/api/agent/ingest' && method === 'POST') return await handleIngest(req, res);
      return sendJson(req, res, 404, { error: 'not_found' });
    }

    // Browser API. Session auth is added in a later step; for now these are only
    // reachable on loopback / the tailnet (no public Nginx vhost yet).
    if (path === '/api/photos' && isGet(method)) return handleListPhotos(req, res, url);
    if (path === '/api/photos/count' && isGet(method)) return sendJson(req, res, 200, { count: countPhotos() });
    if (path.startsWith('/api/thumb/') && isGet(method)) return handleThumb(req, res, path);
    if (path.startsWith('/api/original/') && method === 'GET') return await handleOriginal(req, res, path);
    if (path.startsWith('/api/photos/') && isGet(method)) return handleGetPhoto(req, res, path);
    if (path === '/api/tags' && isGet(method)) return sendJson(req, res, 200, { tags: listTags() });
    if (path === '/api/tags/apply' && method === 'POST') return await handleTagOp(req, res, applyTags);
    if (path === '/api/tags/remove' && method === 'POST') return await handleTagOp(req, res, removeTags);

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

// Serve a thumbnail from the local cache (hash-addressed, immutable).
function handleThumb(req, res, path) {
  const hash = path.slice('/api/thumb/'.length).replace(/\.webp$/, '');
  if (!HASH_RE.test(hash)) return sendJson(req, res, 400, { error: 'bad_request' });
  const file = join(config.thumbDir, `${hash}.webp`);
  let st;
  try { st = statSync(file); } catch { return sendJson(req, res, 404, { error: 'not_found' }); }
  res.writeHead(200, {
    'Content-Type': 'image/webp',
    'Content-Length': st.size,
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

// Proxy a full-resolution original from the agent over Tailscale.
async function handleOriginal(req, res, path) {
  const id = Number(path.slice('/api/original/'.length));
  if (!Number.isInteger(id)) return sendJson(req, res, 400, { error: 'bad_request' });
  const rel = getRelPath(id);
  if (!rel) return sendJson(req, res, 404, { error: 'not_found' });

  let agentRes;
  try {
    agentRes = await fetch(
      config.agentUrl.replace(/\/$/, '') + '/original?rel=' + encodeURIComponent(rel),
      { headers: { Authorization: `Bearer ${config.agentToken}` } },
    );
  } catch {
    return sendJson(req, res, 503, { error: 'agent_unreachable' }); // Maingear offline
  }
  if (!agentRes.ok) return sendJson(req, res, agentRes.status, { error: 'agent_error' });

  const headers = { 'Content-Type': agentRes.headers.get('content-type') || 'application/octet-stream' };
  const len = agentRes.headers.get('content-length');
  if (len) headers['Content-Length'] = len;
  res.writeHead(200, headers);
  Readable.fromWeb(agentRes.body).pipe(res);
}

async function handleTagOp(req, res, op) {
  const body = await readJson(req, 1024 * 1024);
  const photoIds = Array.isArray(body?.photo_ids) ? body.photo_ids.filter(Number.isInteger) : [];
  const tags = Array.isArray(body?.tags)
    ? body.tags.map((t) => String(t).trim()).filter((t) => t.length > 0)
    : [];
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
});
