import { db } from './index.js';

const insert = db.prepare(`
  INSERT INTO photos
    (hash, rel_path, original_filename, kind, format, width, height, file_size,
     duration, taken_at, camera_make, camera_model, gps_lat, gps_lon, sync_status, staged)
  VALUES
    (@hash, @rel_path, @original_filename, @kind, @format, @width, @height, @file_size,
     @duration, @taken_at, @camera_make, @camera_model, @gps_lat, @gps_lon, @sync_status, @staged)
`);

const byHash = db.prepare('SELECT id, hash, rel_path FROM photos WHERE hash = ?');
const count = db.prepare('SELECT COUNT(*) AS n FROM photos');

export function getByHash(hash) {
  return byHash.get(hash);
}

export function insertPhoto(p) {
  // Coerce undefined -> null; better-sqlite3 rejects undefined bound values.
  return insert.run({
    hash: p.hash,
    rel_path: p.rel_path ?? null,
    original_filename: p.original_filename ?? null,
    kind: p.kind ?? 'image',
    format: p.format ?? null,
    width: p.width ?? null,
    height: p.height ?? null,
    file_size: p.file_size ?? null,
    duration: p.duration ?? null,
    taken_at: p.taken_at ?? null,
    camera_make: p.camera_make ?? null,
    camera_model: p.camera_model ?? null,
    gps_lat: p.gps_lat ?? null,
    gps_lon: p.gps_lon ?? null,
    sync_status: p.sync_status ?? 'pending',
    staged: p.staged ?? 0,
  });
}

export function countPhotos() {
  return count.get().n;
}
