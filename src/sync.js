import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { pendingUploads, markSynced, bumpAttempt } from './db/sync.js';

let running = false;

async function pushOne(row) {
  const staged = join(config.stagingDir, row.hash);

  let bytes;
  try {
    bytes = await readFile(staged);
  } catch {
    // Staging file is gone but the row is still pending — clear it to avoid looping.
    markSynced(row.queue_id, row.photo_id);
    return;
  }

  const url = config.agentUrl.replace(/\/$/, '') + '/receive?rel=' + encodeURIComponent(row.rel_path);
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.agentToken}`, 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  if (!res.ok) throw new Error('agent receive ' + res.status);

  markSynced(row.queue_id, row.photo_id);
  await unlink(staged).catch(() => {});
}

export async function drainQueue() {
  if (running) return;
  running = true;
  try {
    for (const row of pendingUploads(20)) {
      try {
        await pushOne(row);
        console.log(`[sync] pushed photo ${row.photo_id} -> ${row.rel_path}`);
      } catch (e) {
        bumpAttempt(row.queue_id);
        console.warn(`[sync] photo ${row.photo_id} failed: ${e.message} (will retry)`);
      }
    }
  } finally {
    running = false;
  }
}

export function startSync() {
  console.log(`[sync] worker every ${config.syncIntervalMs}ms`);
  drainQueue();
  setInterval(drainQueue, config.syncIntervalMs);
}

// Fire-and-forget nudge so an upload pushes immediately if the agent is online.
export const kickSync = () => { drainQueue(); };