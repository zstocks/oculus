import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { ingestFile } from './ingest.js';

// A file is ingested only once its mtime has settled, so we don't grab a half-written
// upload mid-transfer. rclone moves completed files into incoming/, but this guards
// against slow writers the same way the old agent did.
const STABLE_MS = 10000;

let running = false;

async function scanOnce() {
  if (running) return;
  running = true;
  try {
    let entries;
    try {
      entries = await readdir(config.incomingDir, { withFileTypes: true });
    } catch (err) {
      // Mount down or dir missing — log and bail; next tick retries.
      console.warn(`[scan] cannot read ${config.incomingDir}: ${err.message}`);
      return;
    }

    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      const path = join(config.incomingDir, entry.name);
      try {
        const st = await stat(path);
        if (now - st.mtimeMs < STABLE_MS) continue; // still settling

        const result = await ingestFile(path, entry.name);
        if (result.duplicate) console.log(`[scan] duplicate ${entry.name} -> photo ${result.id}`);
        else if (result.rejected) console.warn(`[scan] rejected ${entry.name}: ${result.reason}`);
        else console.log(`[scan] ingested ${entry.name} -> photo ${result.id}`);
      } catch (err) {
        // One bad file (or a transient mount hiccup) must not stop the loop.
        console.warn(`[scan] failed ${entry.name}: ${err.message}`);
      }
    }
  } finally {
    running = false;
  }
}

export function startScanner() {
  console.log(`[scan] watching ${config.incomingDir} every ${config.scanIntervalMs}ms`);
  scanOnce();
  setInterval(scanOnce, config.scanIntervalMs);
}
