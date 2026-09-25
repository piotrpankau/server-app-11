'use strict';
const os = require('os');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const auth = require('./auth');

function attachTerminal(server, cfg) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws/terminal') return socket.destroy();

    // Block cross-site WebSocket hijacking: the page must come from this same host.
    const origin = req.headers.origin;
    let sameOrigin = false;
    try { sameOrigin = !!origin && new URL(origin).host === req.headers.host; } catch { /* invalid origin */ }
    if (!sameOrigin || !auth.sessionFromRequest(cfg, req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, url));
  });

  wss.on('connection', (ws, url) => {
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

    term.onData((data) => {
      if (ws.readyState === ws.OPEN) ws.send(data);
    });
    term.onExit(({ exitCode }) => {
      if (ws.readyState === ws.OPEN) ws.close(1000, `exit ${exitCode}`);
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.t === 'i' && typeof msg.d === 'string') term.write(msg.d);
      else if (msg.t === 'r') {
        const c = Math.max(20, Math.min(500, Number(msg.c) || 80));
        const r = Math.max(5, Math.min(200, Number(msg.r) || 24));
        try { term.resize(c, r); } catch { /* pty already closed */ }
      }
    });

    const ping = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.ping();
    }, 30000);

    ws.on('close', () => {
      clearInterval(ping);
      try { term.kill(); } catch { /* already gone */ }
    });
  });
}

module.exports = { attachTerminal };
