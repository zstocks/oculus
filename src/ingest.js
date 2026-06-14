import { mkdir, rename, copyFile, unlink, stat, writeFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { config } from './config.js';
import { getByHash, insertPhoto } from './db/photos.js';
import { hashFile, readImageMeta, makeThumbnail } from './media.js';

// Move a file that may cross filesystems (local tmp/incoming -> box mount).
// rename() is atomic within one fs but throws EXDEV across devices; fall back to copy+unlink.
async function moveFile(src, dest) {
  try {
    await rename(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await copyFile(src, dest);
    await unlink(src);
  }
}

function relPathFor(meta, hash, originalFilename) {
  const ext = (extname(originalFilename) || '.jpg').toLowerCase();
  const d = meta.taken_at ? new Date(meta.taken_at) : new Date();
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${yyyy}/${mm}/${hash}${ext}`;
}

// Single ingest path for both phone uploads and the incoming-folder scanner.
// `srcPath` is a local file we own; on every outcome it is consumed (moved or deleted).
// Returns { id, duplicate } on success, or { rejected: true, reason } on a non-image.
export async function ingestFile(srcPath, originalFilename) {
  const hash = await hashFile(srcPath);

  const existing = getByHash(hash);
  if (existing) {
    await unlink(srcPath).catch(() => {});
    return { id: existing.id, duplicate: true };
  }

  let meta;
  try {
    meta = await readImageMeta(srcPath);
  } catch (err) {
    // Not a decodable image (or exceeds decode limits): drop it, never insert a row.
    await unlink(srcPath).catch(() => {});
    return { rejected: true, reason: err.message || 'unsupported_image' };
  }

  await writeFile(join(config.thumbDir, `${hash}.webp`), await makeThumbnail(srcPath, 400));

  const relPath = relPathFor(meta, hash, originalFilename);
  const dest = join(config.originalsDir, relPath);
  await mkdir(dirname(dest), { recursive: true });
  await moveFile(srcPath, dest);

  const info = insertPhoto({
    hash, rel_path: relPath, original_filename: originalFilename, kind: 'image',
    format: meta.format, width: meta.width, height: meta.height, file_size: (await stat(dest)).size,
    duration: null, taken_at: meta.taken_at, camera_make: meta.camera_make, camera_model: meta.camera_model,
    gps_lat: meta.gps_lat, gps_lon: meta.gps_lon, sync_status: 'synced', staged: 0,
  });

  return { id: Number(info.lastInsertRowid), duplicate: false };
}
