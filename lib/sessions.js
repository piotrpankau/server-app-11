'use strict';
/* Login sessions (one per browser/computer) and their activity log.
   - every login gets a session id (sid) that is stored in the signed cookie,
   - a session can be logged out remotely (revoked),
   - important actions are written to an activity log (data/activity.log, JSON lines),
   - open pages keep a Server-Sent Events stream, used for "online" status and
     live notifications (new login, session revoked, someone watches a terminal). */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const ACTIVITY_FILE = path.join(DATA_DIR, 'activity.log');
const MAX_EVENTS = 20000;          // kept in memory
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const KEEP_REVOKED_MS = 7 * 24 * 3600 * 1000;

const bus = new EventEmitter();
bus.setMaxListeners(100);

let sessions = new Map();
let events = [];
let dirty = false;
let seq = 0;

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    sessions = new Map(arr.map((s) => [s.sid, s]));
  } catch { sessions = new Map(); }
  try {
    const lines = fs.readFileSync(ACTIVITY_FILE, 'utf8').trim().split('\n').slice(-MAX_EVENTS);
    events = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    seq = events.length ? events[events.length - 1].id : 0;
  } catch { events = []; }
}

function save() {
  if (!dirty) return;
  dirty = false;
  try {
    ensureDir();
    const now = Date.now();
    for (const [sid, s] of sessions) {
      if ((s.revoked && now - s.revoked > KEEP_REVOKED_MS) || (s.expires && s.expires < now - KEEP_REVOKED_MS)) sessions.delete(sid);
    }
    fs.writeFileSync(SESSIONS_FILE + '.tmp', JSON.stringify([...sessions.values()]), { mode: 0o600 });
    fs.renameSync(SESSIONS_FILE + '.tmp', SESSIONS_FILE);
  } catch (err) {
    console.error('[sessions] nie można zapisać:', err.message);
  }
}
setInterval(save, 15000).unref();
process.on('exit', save);
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { save(); process.exit(0); });
}

function clientIp(req) {
  return (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

function parseAgent(ua = '') {
  const osName = /Windows NT 10/.test(ua) ? 'Windows 10/11' : /Windows/.test(ua) ? 'Windows'
    : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Mac OS X/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'nieznany system';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'przeglądarka';
  return { os: osName, browser };
}

function create(req, hours) {
  const sid = crypto.randomBytes(12).toString('hex');
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);
  const now = Date.now();
  const s = {
    sid,
    ip: clientIp(req),
    userAgent: ua,
    ...parseAgent(ua),
    label: '',
    created: now,
    lastSeen: now,
    expires: now + hours * 3600 * 1000,
    revoked: 0,
    windows: []
  };
  sessions.set(sid, s);
  dirty = true;
  save();
  return s;
}

const isValid = (sid) => {
  const s = sid && sessions.get(sid);
  return !!s && !s.revoked && (!s.expires || s.expires > Date.now());
};

function touch(sid, req) {
  const s = sessions.get(sid);
  if (!s) return;
  const now = Date.now();
  if (now - s.lastSeen > 5000) {
    s.lastSeen = now;
    const ip = clientIp(req);
    if (ip && ip !== s.ip) { s.ip = ip; }
    dirty = true;
  }
}

function revoke(sid, reason) {
  const s = sessions.get(sid);
  if (!s || s.revoked) return false;
  s.revoked = Date.now();
  s.revokeReason = reason || '';
  dirty = true;
  save();
  bus.emit('revoke', sid);
  sendTo(sid, 'revoked', { reason: reason || '' });
  return true;
}

function setLabel(sid, label) {
  const s = sessions.get(sid);
  if (!s) return;
  s.label = String(label || '').trim().slice(0, 60);
  dirty = true;
}

function setState(sid, state) {
  const s = sessions.get(sid);
  if (!s) return;
  if (Array.isArray(state.windows)) {
    s.windows = state.windows.slice(0, 30).map((w) => ({ app: String(w.app || '').slice(0, 30), title: String(w.title || '').slice(0, 120), focused: !!w.focused }));
  }
  if (typeof state.browser === 'string' && state.browser) s.browser = state.browser.slice(0, 30);
  if (typeof state.screen === 'string') s.screen = state.screen.slice(0, 20);
  s.stateAt = Date.now();
  dirty = true;
}

// ---------- activity log ----------
function log(sid, type, text, extra) {
  const e = { id: ++seq, t: Date.now(), sid: sid || null, type, text: String(text).slice(0, 2000) };
  if (extra) e.x = extra;
  events.push(e);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  try {
    ensureDir();
    fs.appendFileSync(ACTIVITY_FILE, JSON.stringify(e) + '\n', { mode: 0o600 });
    const st = fs.statSync(ACTIVITY_FILE);
    if (st.size > MAX_LOG_BYTES) {
      // Keep the newest half of the log.
      const lines = fs.readFileSync(ACTIVITY_FILE, 'utf8').trim().split('\n');
      fs.writeFileSync(ACTIVITY_FILE, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n', { mode: 0o600 });
    }
  } catch { /* logging must never break the request */ }
  bus.emit('activity', e);
  return e;
}

function activity({ sid, before, limit = 200, type } = {}) {
  const out = [];
  for (let i = events.length - 1; i >= 0 && out.length < limit; i--) {
    const e = events[i];
    if (before && e.id >= before) continue;
    if (sid && e.sid !== sid) continue;
    if (type && e.type !== type) continue;
    out.push(e);
  }
  return out;
}

// ---------- live connections (Server-Sent Events) ----------
const streams = new Map(); // sid -> Set<res>

function addStream(sid, res) {
  if (!streams.has(sid)) streams.set(sid, new Set());
  streams.get(sid).add(res);
  const first = streams.get(sid).size === 1;
  if (first) bus.emit('presence', sid, true);
  return () => {
    const set = streams.get(sid);
    if (!set) return;
    set.delete(res);
    if (!set.size) { streams.delete(sid); bus.emit('presence', sid, false); }
  };
}

function write(res, type, data) {
  try { res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* closed */ }
}
function sendTo(sid, type, data) {
  for (const res of streams.get(sid) || []) write(res, type, data);
}
function broadcast(type, data, exceptSid) {
  for (const [sid, set] of streams) if (sid !== exceptSid) for (const res of set) write(res, type, data);
}

const online = (sid) => streams.has(sid);

function list(currentSid) {
  return [...sessions.values()]
    .map((s) => ({
      ...s,
      userAgent: undefined,
      online: online(s.sid),
      current: s.sid === currentSid,
      active: isValid(s.sid)
    }))
    .sort((a, b) => (b.current - a.current) || (b.active - a.active) || (b.online - a.online) || b.lastSeen - a.lastSeen);
}

function describe(sid) {
  const s = sessions.get(sid);
  if (!s) return 'nieznana sesja';
  return s.label || `${s.browser} na ${s.os} (${s.ip})`;
}

load();

module.exports = {
  bus, create, isValid, touch, revoke, setLabel, setState, log, activity,
  addStream, sendTo, broadcast, online, list, describe, get: (sid) => sessions.get(sid), clientIp
};
