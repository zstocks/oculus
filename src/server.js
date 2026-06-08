import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import './db/index.js'; // ensures migrations have run before the data layer loads
import { isAgent } from './auth.js';
import { getByHash, insertPhoto, countPhotos } from './db/photos.js';

mkdirSync(config.thumbDir, { recursive: true });

const server = http.createServer(async (req, res) => {
  const { method, url } = req;
  try {
    if (url === '/health' && (method === 'GET' || method === 'HEAD')) {
      return sendJson(req, res, 200, { status: 'ok', app: 'oculus' });
    }
    if (url === '/' && (method === 'GET' || method === 'HEAD')) {
      return sendJson(req, res, 200, { app: 'oculus', message: 'Oculus is running' });
    }

    // Machine-to-machine endpoints (agent <-> VPS), guarded by the shared token.
    if (url.startsWith('/api/')) {
      if (!isAgent(req)) return sendJson(req, res, 401, { error: 'unauthorized' });

      if (url === '/api/agent/ingest' && method === 'POST') {
        return await handleIngest(req, res);
      }
      if (url === '/api/photos/count' && method === 'GET') {
        return sendJson(req, res, 200, { count: countPhotos() });
      }
      return sendJson(req, res, 404, { error: 'not_found' });
    }

    sendJson(req, res, 404, { error: 'not_found' });
  } catch (err) {
    console.error('[oculus] request error:', err);
    sendJson(req, res, 500, { error: 'server_error' });
  }
});

async function handleIngest(req, res) {
  const body = await readJson(req, 16 * 1024 * 1024); // 16MB cap
  const photo = body?.photo;
  const thumbB64 = body?.thumbnail_b64;
  if (!photo?.hash || !thumbB64) {
    return sendJson(req, res, 400, { error: 'bad_request' });
  }

  const existing = getByHash(photo.hash);
  if (existing) {
    return sendJson(req, res, 200, { status: 'duplicate', rel_path: existing.rel_path });
  }

  writeFileSync(join(config.thumbDir, `${photo.hash}.webp`), Buffer.from(thumbB64, 'base64'));
  insertPhoto({ ...photo, sync_status: 'synced', staged: 0 });

  return sendJson(req, res, 201, { status: 'created' });
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); reject(new Error('payload_too_large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(req, res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(req.method === 'HEAD' ? undefined : payload);
}

server.listen(config.port, () => {
  console.log(`[oculus] listening on :${config.port}`);
  console.log(`[oculus] thumbnails: ${config.thumbDir}`);
});
