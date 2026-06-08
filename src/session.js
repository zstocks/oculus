import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

const COOKIE = 'oculus_session';

function sign(data) {
  return createHmac('sha256', config.sessionSecret).update(data).digest('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// token = base64url(JSON{ exp }) + "." + hmacHex(payload)
export function issueToken(ttlMs) {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + ttlMs })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!safeEqual(mac, sign(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!Number.isFinite(data.exp) || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

export function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function isLoggedIn(req) {
  return verifyToken(parseCookies(req)[COOKIE]) !== null;
}

export function checkPassword(provided) {
  return safeEqual(provided ?? '', config.appPassword);
}

export function sessionCookie(token, ttlMs, secure) {
  const attrs = [`${COOKIE}=${token}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${Math.floor(ttlMs / 1000)}`];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearCookie(secure) {
  const attrs = [`${COOKIE}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}