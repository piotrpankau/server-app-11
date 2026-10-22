'use strict';
/* Two-step login with an authenticator app (Google Authenticator, Authy, ...): RFC 6238 TOTP,
   6 digits, 30 s step. After a correct code the device gets a "trusted device" token, so the
   desktop app and a remembered browser do not ask for a code on every login. */
const crypto = require('crypto');

const STEP = 30;
const TRUST_DAYS = 30;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of String(str).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

const newSecret = () => base32Encode(crypto.randomBytes(20));

function codeAt(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

// One step of clock drift either way; a code that was already used cannot be used again.
const lastStep = new Map();
function verify(secret, code, key) {
  code = String(code || '').replace(/\s/g, '');
  if (!secret || !/^\d{6}$/.test(code)) return false;
  const now = Math.floor(Date.now() / 1000 / STEP);
  for (const step of [now, now - 1, now + 1]) {
    if (!crypto.timingSafeEqual(Buffer.from(codeAt(secret, step)), Buffer.from(code))) continue;
    if (key && (lastStep.get(key) || 0) >= step) return false;
    if (key) lastStep.set(key, step);
    return true;
  }
  return false;
}

function uri(secret, username, issuer) {
  const label = encodeURIComponent(`${issuer}:${username}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;
}

// The trusted-device token dies when the user turns 2FA off/on again (new secret) or changes the password.
function version(user) {
  return crypto.createHash('sha256').update(`${user.totpSecret}|${user.passwordHash}`).digest('hex').slice(0, 16);
}

function sign(cfg, payload) {
  return crypto.createHmac('sha256', cfg.sessionSecret).update('trust.' + payload).digest('base64url');
}

function trustToken(cfg, user) {
  const payload = Buffer.from(JSON.stringify({ u: user.username, v: version(user), exp: Date.now() + TRUST_DAYS * 86400000 })).toString('base64url');
  return `${payload}.${sign(cfg, payload)}`;
}

function checkTrust(cfg, user, token) {
  if (!token || typeof token !== 'string') return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(cfg, payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return d.exp > Date.now() && d.u.toLowerCase() === user.username.toLowerCase() && d.v === version(user);
  } catch {
    return false;
  }
}

module.exports = { TRUST_DAYS, newSecret, verify, uri, trustToken, checkTrust, codeAt, STEP };
