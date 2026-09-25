'use strict';
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const auth = require('./auth');
const sessions = require('./sessions');

const SCROLLBACK = 200 * 1024; // output kept for live viewers joining later
const terminals = new Map();   // id -> terminal record

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][0-9A-Za-z]|[@-_])/g;
const PASSWORD_PROMPT = /(password|passphrase|hasło|haslo|pin)[^\n]*:\s*$/i;

// Reconstructs the command lines typed into a terminal (for the activity log).
// Lines typed at a password prompt or inside full-screen programs (nano, vim, htop)
// are not recorded.
function trackInput(rec, data) {
  const clean = data.replace(ANSI, '');
  for (const ch of clean) {
    if (ch === '\r' || ch === '\n') {
      const cmd = rec.line.trim();
      rec.line = '';
      if (!cmd || rec.alt) continue;
      rec.lastInput = Date.now();
      if (PASSWORD_PROMPT.test(rec.tail.replace(ANSI, ''))) {
        sessions.log(rec.sid, 'command', '(wpisano hasło – ukryto)', { term: rec.id });
      } else {
        sessions.log(rec.sid, 'command', cmd.slice(0, 500), { term: rec.id });
        rec.lastCommand = cmd.slice(0, 200);
      }
    } else if (ch === '\x7f' || ch === '\b') {
      rec.line = rec.line.slice(0, -1);
    } else if (ch === '\x03' || ch === '\x15') {
      rec.line = ''; // Ctrl+C, Ctrl+U
    } else if (ch >= ' ') {
      if (rec.line.length < 2000) rec.line += ch;
    }
  }
}

function trackOutput(rec, data) {
  rec.buffer += data;
  if (rec.buffer.length > SCROLLBACK) rec.buffer = rec.buffer.slice(-SCROLLBACK);
  rec.tail = (rec.tail + data).slice(-400);
  // Alternate screen = a full-screen program is running.
  const on = data.lastIndexOf('\x1b[?1049h');
  const off = data.lastIndexOf('\x1b[?1049l');
  if (on > off) rec.alt = true;
  else if (off > on) rec.alt = false;
}

function list() {
  return [...terminals.values()].map((t) => ({
    id: t.id,
    sid: t.sid,
    cwd: t.cwd,
    started: t.started,
    cols: t.cols,
    rows: t.rows,
    watchers: t.watchers.size,
    lastCommand: t.lastCommand || '',
    lastInput: t.lastInput || 0,
    fullscreen: t.alt
  }));
}

function kill(id) {
  const t = terminals.get(id);
  if (!t) return false;
  try { t.pty.kill(); } catch { /* gone */ }
  try { t.ws.close(1000, 'zamknięto z innej sesji'); } catch { /* gone */ }
  return true;
}

// A revoked (logged out) session loses its terminals and live views immediately.
sessions.bus.on('revoke', (sid) => {
  for (const t of terminals.values()) {
    if (t.sid === sid) kill(t.id);
    for (const w of t.watchers) if (w.sid === sid) w.ws.close(1000, 'wylogowano');
  }
});

function attachTerminal(server, cfg) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws/terminal') {
      // Other WebSocket endpoints (e.g. /ws/assistant) have their own handlers.
      if (url.pathname.startsWith('/ws/')) return;
      return socket.destroy();
    }

    // Block cross-site WebSocket hijacking: the page must come from this same host.
    const origin = req.headers.origin;
    let sameOrigin = false;
    try { sameOrigin = !!origin && new URL(origin).host === req.headers.host; } catch { /* invalid origin */ }
    const tok = sameOrigin && auth.sessionFromRequest(cfg, req);
    if (!tok || tok.role !== 'admin') {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (url.searchParams.get('watch')) watch(ws, url.searchParams.get('watch'), tok.s);
      else open(ws, url, tok.s);
    });
  });
}

function open(ws, url, sid) {
  const user = os.userInfo();
  const shell = process.env.SHELL || user.shell || '/bin/bash';
  let cwd = url.searchParams.get('cwd') || user.homedir;
  try { if (!fs.statSync(cwd).isDirectory()) cwd = user.homedir; } catch { cwd = user.homedir; }
  const cols = Math.max(20, Math.min(500, Number(url.searchParams.get('cols')) || 80));
  const rows = Math.max(5, Math.min(200, Number(url.searchParams.get('rows')) || 24));

  const term = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: Object.assign({}, process.env, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: process.env.LANG || 'C.UTF-8',
      HOME: user.homedir,
      USER: user.username,
      SHELL: shell
    })
  });

  const rec = {
    id: crypto.randomBytes(6).toString('hex'),
    sid, ws, pty: term, cwd, cols, rows,
    started: Date.now(),
    buffer: '', tail: '', line: '', alt: false,
    watchers: new Set()
  };
  terminals.set(rec.id, rec);
  sessions.log(sid, 'terminal', `Otwarto terminal (${cwd})`, { term: rec.id });

  const toWatchers = (msg) => {
    const s = JSON.stringify(msg);
    for (const w of rec.watchers) if (w.ws.readyState === w.ws.OPEN) w.ws.send(s);
  };

  term.onData((data) => {
    trackOutput(rec, data);
    if (ws.readyState === ws.OPEN) ws.send(data);
    if (rec.watchers.size) toWatchers({ t: 'o', d: data });
  });
  term.onExit(({ exitCode }) => {
    terminals.delete(rec.id);
    toWatchers({ t: 'exit' });
    for (const w of rec.watchers) w.ws.close(1000, 'terminal zamknięty');
    sessions.log(sid, 'terminal', 'Zamknięto terminal', { term: rec.id });
    if (ws.readyState === ws.OPEN) ws.close(1000, `exit ${exitCode}`);
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.t === 'i' && typeof msg.d === 'string') {
      trackInput(rec, msg.d);
      term.write(msg.d);
    } else if (msg.t === 'r') {
      const c = Math.max(20, Math.min(500, Number(msg.c) || 80));
      const r = Math.max(5, Math.min(200, Number(msg.r) || 24));
      rec.cols = c;
      rec.rows = r;
      try { term.resize(c, r); } catch { /* pty already closed */ }
      toWatchers({ t: 'size', cols: c, rows: r });
    }
  });

  const ping = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 30000);

  ws.on('close', () => {
    clearInterval(ping);
    try { term.kill(); } catch { /* already gone */ }
  });
}

// Read-only live view of another session's terminal.
function watch(ws, id, sid) {
  const rec = terminals.get(id);
  if (!rec) {
    ws.send(JSON.stringify({ t: 'gone' }));
    return ws.close(1000, 'brak terminala');
  }
  const viewer = { ws, sid };
  rec.watchers.add(viewer);
  ws.send(JSON.stringify({ t: 'init', cols: rec.cols, rows: rec.rows, data: rec.buffer, owner: sessions.describe(rec.sid) }));
  if (rec.sid !== sid) {
    sessions.sendTo(rec.sid, 'watched', { by: sessions.describe(sid), on: true });
    sessions.log(sid, 'watch', `Podgląd terminala sesji ${sessions.describe(rec.sid)}`);
  }
  ws.on('message', () => { /* read-only */ });
  ws.on('close', () => {
    rec.watchers.delete(viewer);
    if (rec.sid !== sid) sessions.sendTo(rec.sid, 'watched', { by: sessions.describe(sid), on: false });
  });
}

module.exports = { attachTerminal, list, kill };
