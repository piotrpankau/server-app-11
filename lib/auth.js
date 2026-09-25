'use strict';
const crypto = require('crypto');

const COOKIE = 'wp_session';

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [algo, saltHex, hashHex] = stored.split('$');
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// A token is signed with the session secret and tied to the current password hash,
// so changing the password logs out every existing session.
function passwordVersion(cfg) {
  return crypto.createHash('sha256').update(cfg.passwordHash).digest('hex').slice(0, 16);
}

function sign(cfg, payload) {
  return crypto.createHmac('sha256', cfg.sessionSecret).update(payload).digest('base64url');
}

function createToken(cfg) {
  const payload = Buffer.from(JSON.stringify({
    u: cfg.username,
    v: passwordVersion(cfg),
    exp: Date.now() + cfg.sessionHours * 3600 * 1000
  })).toString('base64url');
  return `${payload}.${sign(cfg, payload)}`;
}

function verifyToken(cfg, token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig || !safeEqual(sig, sign(cfg, payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.exp < Date.now() || data.u !== cfg.username || data.v !== passwordVersion(cfg)) return null;
    return data;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionFromRequest(cfg, req) {
  return verifyToken(cfg, parseCookies(req.headers.cookie)[COOKIE]);
}

function cookieHeader(cfg, token, maxAgeSec) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
  if (cfg.https) parts.push('Secure');
  return parts.join('; ');
}

// Simple brute-force protection: after 5 failed logins an IP is locked for 5 minutes.
const failures = new Map();
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;

function isLocked(ip) {
  const f = failures.get(ip);
  if (!f) return 0;
  if (f.lockedUntil && f.lockedUntil > Date.now()) return f.lockedUntil - Date.now();
  if (f.lockedUntil) failures.delete(ip);
  return 0;
}

function registerFailure(ip) {
  const f = failures.get(ip) || { count: 0, lockedUntil: 0 };
  f.count += 1;
  if (f.count >= MAX_FAILS) {
    f.lockedUntil = Date.now() + LOCK_MS;
    f.count = 0;
  }
  failures.set(ip, f);
}

function clearFailures(ip) {
  failures.delete(ip);
}

module.exports = {
  COOKIE, hashPassword, verifyPassword, createToken, verifyToken,
  sessionFromRequest, cookieHeader, isLocked, registerFailure, clearFailures
};
