import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

const expected = Buffer.from(config.agentToken);

// Verifies the shared secret the agent presents when pushing ingest data.
export function isAgent(req) {
  const header = req.headers['authorization'] || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!provided) return false;

  const given = Buffer.from(provided);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}
