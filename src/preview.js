import { writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { makeThumbnail, PREVIEW_PX } from './media.js';

// A preview is a permanent, bounded local derivative (like the thumbnail), keyed by
// hash to mirror the thumbnail naming. It is NOT a cache and never needs eviction.
export function previewPath(hash) {
  return join(config.previewDir, `${hash}.webp`);
}

// Encode a ~2048px webp preview from `srcPath` and write it atomically: encode to a
// unique <hash>.webp.<uuid>.tmp, then rename() into place. A crash mid-encode can
// never leave a half-written file that the existence check would treat as valid, and
// the unique tmp name keeps any two writers from clobbering one another.
export async function generatePreview(srcPath, hash) {
  const dest = previewPath(hash);
  const tmp = `${dest}.${randomUUID()}.tmp`;
  const buf = await makeThumbnail(srcPath, PREVIEW_PX);
  try {
    await writeFile(tmp, buf);
    await rename(tmp, dest);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return dest;
}

// Generate-on-miss with concurrency dedupe. The first request for a missing hash
// generates from the original on the box; concurrent requests for the same hash
// await the same promise, so the high-latency box read happens exactly once and
// there is no write race. The entry is dropped on settle so a failure can retry.
const inFlight = new Map();

export function ensurePreview(hash, relPath) {
  const pending = inFlight.get(hash);
  if (pending) return pending;

  const p = generatePreview(join(config.originalsDir, relPath), hash)
    .finally(() => inFlight.delete(hash));
  inFlight.set(hash, p);
  return p;
}
