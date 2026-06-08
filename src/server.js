import http from 'node:http';
import { initDb } from './db/index.js';

const PORT = Number(process.env.PORT) || 3000;

// Open the database and apply any pending migrations before serving.
initDb();

const server = http.createServer((req, res) => {
  const { method, url } = req;

  if (method !== 'GET' && method !== 'HEAD') {
    return sendJson(req, res, 405, { error: 'method_not_allowed' });
  }

  if (url === '/health') {
    return sendJson(req, res, 200, { status: 'ok', app: 'oculus' });
  }

  if (url === '/') {
    return sendJson(req, res, 200, { app: 'oculus', message: 'Oculus is running' });
  }

  sendJson(req, res, 404, { error: 'not_found' });
});

function sendJson(req, res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(req.method === 'HEAD' ? undefined : payload);
}

server.listen(PORT, () => {
  console.log(`[oculus] listening on :${PORT}`);
});
