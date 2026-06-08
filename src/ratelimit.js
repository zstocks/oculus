// Per-IP failed-login throttle. In-memory; resets on restart, which is fine
// for a single-process app — a brute-force run won't outlast a redeploy.
const attempts = new Map(); // ip -> { count, resetAt }

function bucket(ip, windowMs) {
  const now = Date.now();
  let rec = attempts.get(ip);
  if (!rec || rec.resetAt < now) {
    rec = { count: 0, resetAt: now + windowMs };
    attempts.set(ip, rec);
  }
  return rec;
}

export function tooMany(ip, max = 10, windowMs = 15 * 60 * 1000) {
  return bucket(ip, windowMs).count >= max;
}

export function recordFail(ip, windowMs = 15 * 60 * 1000) {
  bucket(ip, windowMs).count += 1;
}

export function recordSuccess(ip) {
  attempts.delete(ip);
}