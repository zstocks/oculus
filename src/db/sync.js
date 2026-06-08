import { db } from './index.js';

const enqueue = db.prepare("INSERT INTO sync_queue (photo_id, op, status) VALUES (?, 'upload', 'pending')");

const pending = db.prepare(`
  SELECT q.id AS queue_id, p.id AS photo_id, p.hash, p.rel_path, p.format
  FROM sync_queue q
  JOIN photos p ON p.id = q.photo_id
  WHERE q.op = 'upload' AND q.status = 'pending'
  ORDER BY q.id ASC
  LIMIT ?
`);

const bump = db.prepare('UPDATE sync_queue SET attempts = attempts + 1 WHERE id = ?');
const doneQueue = db.prepare("UPDATE sync_queue SET status = 'done' WHERE id = ?");
const syncedPhoto = db.prepare("UPDATE photos SET sync_status = 'synced', staged = 0 WHERE id = ?");

export function enqueueUpload(photoId) { enqueue.run(photoId); }
export function pendingUploads(limit = 20) { return pending.all(limit); }
export function bumpAttempt(queueId) { bump.run(queueId); }

// Mark the photo synced and the queue row done atomically.
export const markSynced = db.transaction((queueId, photoId) => {
  syncedPhoto.run(photoId);
  doneQueue.run(queueId);
});