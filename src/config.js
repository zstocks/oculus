import { join } from 'node:path';

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`[oculus] missing required config: ${name}`);
    process.exit(1);
  }
  return v;
}

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data');

export const config = {
  port: Number(process.env.PORT) || 3000,
  dataDir: DATA_DIR,
  thumbDir: process.env.THUMB_DIR || join(DATA_DIR, 'thumbnails'),
  stagingDir: process.env.STAGING_DIR || join(DATA_DIR, 'staging'),
  agentToken: required('AGENT_TOKEN'),
  agentUrl: required('AGENT_URL'),
  syncIntervalMs: Number(process.env.SYNC_INTERVAL_MS) || 15000,
};

if (config.agentToken.length < 16) {
  console.error('[oculus] AGENT_TOKEN must be at least 16 characters');
  process.exit(1);
}