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

  // --- browser auth ---
  sessionSecret: required('SESSION_SECRET'),
  appPassword: required('APP_PASSWORD'),
  sessionTtlMs: (Number(process.env.SESSION_TTL_DAYS) || 30) * 24 * 60 * 60 * 1000,
};

if (config.agentToken.length < 16) { console.error('[oculus] AGENT_TOKEN must be at least 16 characters'); process.exit(1); }
if (config.sessionSecret.length < 16) { console.error('[oculus] SESSION_SECRET must be at least 16 characters'); process.exit(1); }
if (config.appPassword.length < 8) { console.error('[oculus] APP_PASSWORD must be at least 8 characters'); process.exit(1); }