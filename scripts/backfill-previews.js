// Backfill ~2048px previews for the existing library.
//
// Idempotent + resumable: any image that already has a preview is skipped, so it is
// safe to re-run after an interruption. Runs SEQUENTIALLY on purpose — each miss reads
// the original across the high-latency SSHFS link to the box, and we don't want to
// hammer it. New uploads already get a preview at ingest; this is only for the backlog.
//
// Run where both the box mount and ./data are visible — i.e. inside the container:
//   docker compose exec oculus node scripts/backfill-previews.js
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { listAllPhotoFiles } from '../src/db/photos.js';
import { generatePreview, previewPath } from '../src/preview.js';

async function main() {
  const photos = listAllPhotoFiles();
  console.log(`[backfill] ${photos.length} photos in library; checking previews…`);

  let made = 0, skipped = 0, failed = 0;
  for (let i = 0; i < photos.length; i++) {
    const { hash, rel_path } = photos[i];
    const progress = `(${i + 1}/${photos.length})`;

    if (!rel_path) { console.warn(`[backfill] ${progress} skip ${hash.slice(0, 12)}… (no rel_path)`); skipped++; continue; }
    if (existsSync(previewPath(hash))) { skipped++; continue; }

    try {
      await generatePreview(join(config.originalsDir, rel_path), hash);
      made++;
      console.log(`[backfill] ${progress} generated ${hash.slice(0, 12)}…  (made ${made}, skipped ${skipped})`);
    } catch (err) {
      failed++;
      console.warn(`[backfill] ${progress} FAILED ${hash.slice(0, 12)}…: ${err.message}`);
    }
  }

  console.log(`[backfill] done: ${made} generated, ${skipped} already present, ${failed} failed.`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error('[backfill] fatal:', err); process.exit(1); });
