'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const express = require('express');

const config = require('./lib/config');
const auth = require('./lib/auth');
const users = require('./lib/users');
const sessions = require('./lib/sessions');
const taskmgr = require('./lib/taskmgr');
const updates = require('./lib/updates');
const { createFiles, HttpError } = require('./lib/files');
const terminal = require('./lib/terminal');
const assistant = require('./lib/assistant');
const games = require('./lib/games');

const cfg = config.load();
if (!cfg.sessionSecret || (!cfg.passwordHash && !(cfg.users && cfg.users.length))) {
  console.error('Konfiguracja niekompletna. Uruchom: node scripts/setup.js');
  process.exit(1);
}
users.ensure(cfg);      // migrate a single-user config into the users[] list
games.load(cfg);

const files = createFiles(cfg);
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

const PUBLIC = path.join(__dirname, 'public');
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- Public routes (login) ----------
app.get('/login', (req, res) => res.sendFile(path.join(PUBLIC, 'login.html')));
app.use('/css', express.static(path.join(PUBLIC, 'css')));
app.get('/favicon.svg', (req, res) => res.sendFile(path.join(PUBLIC, 'favicon.svg')));

app.post('/api/login', express.json({ limit: '10kb' }), (req, res) => {
  const ip = req.ip;
  const locked = auth.isLocked(ip);
  if (locked) {
    return res.status(429).json({ error: `Za dużo prób. Spróbuj za ${Math.ceil(locked / 60000)} min.` });
  }
  const { username, password } = req.body || {};
  const user = users.verifyLogin(cfg, username, password);
  if (!user) {
    auth.registerFailure(ip);
    console.warn(`[login] nieudane logowanie z ${ip} (użytkownik: ${String(username).slice(0, 40)})`);
    return res.status(401).json({ error: 'Nieprawidłowy login lub hasło' });
  }
  auth.clearFailures(ip);
  const session = sessions.create(req, cfg.sessionHours);
  session.user = user.username;
  console.log(`[login] zalogowano ${user.username} z ${ip} (${session.browser}, ${session.os})`);
  sessions.log(session.sid, 'login', `Zalogowano jako ${user.username} z ${session.ip} (${session.browser} na ${session.os})`);
  sessions.broadcast('login', { sid: session.sid, ip: session.ip, browser: session.browser, os: session.os, user: user.username }, session.sid);
  res.setHeader('Set-Cookie', auth.cookieHeader(cfg, auth.createToken(cfg, session.sid, user), cfg.sessionHours * 3600));
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const tok = auth.sessionFromRequest(cfg, req);
  if (tok) {
    sessions.log(tok.s, 'logout', 'Wylogowano');
    sessions.revoke(tok.s, 'wylogowano');
  }
  res.setHeader('Set-Cookie', auth.cookieHeader(cfg, '', 0));
  res.json({ ok: true });
});

// ---------- Everything below requires a session ----------
app.use((req, res, next) => {
  const tok = auth.sessionFromRequest(cfg, req);
  if (tok) {
    req.sid = tok.s;
    req.user = users.byId(cfg, tok.uid) || users.byName(cfg, tok.u);
    req.isAdmin = tok.role === 'admin';
    sessions.touch(tok.s, req);
    return next();
  }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sesja wygasła, zaloguj się ponownie' });
  return res.redirect('/login');
});

// Regular (non-admin) users only get the Game servers app and their own account.
// Everything else - files, terminal, system, users, updates - is admin-only.
const ADMIN_ONLY = [
  '/api/list', '/api/stat', '/api/read', '/api/write', '/api/mkdir', '/api/touch',
  '/api/rename', '/api/delete', '/api/copy', '/api/move', '/api/chmod', '/api/extract',
  '/api/compress', '/api/raw', '/api/download', '/api/upload',
  '/api/perf', '/api/procs', '/api/proc', '/api/kill', '/api/renice', '/api/run',
  '/api/services', '/api/service', '/api/service-logs',
  '/api/version', '/api/update', '/api/reboot',
  '/api/users', '/api/panel', '/api/assistant'
];
app.use('/api', (req, res, next) => {
  if (req.isAdmin) return next();
  const full = req.baseUrl + req.path;
  if (ADMIN_ONLY.some((p) => full === p || full.startsWith(p + '/'))) {
    return res.status(403).json({ error: 'Ta funkcja jest dostępna tylko dla administratora' });
  }
  next();
});

// ---------- Activity log: what each session does ----------
const few = (paths) => {
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  return list.slice(0, 5).join(', ') + (list.length > 5 ? ` i ${list.length - 5} innych` : '');
};
const ACTIVITY = {
  'POST /api/write': ['file', (q) => `Zapisano plik ${q.body.path}`],
  'POST /api/mkdir': ['file', (q) => `Utworzono folder ${q.body.path}`],
  'POST /api/touch': ['file', (q) => `Utworzono plik ${q.body.path}`],
  'POST /api/rename': ['file', (q) => `Zmieniono nazwę ${q.body.from} → ${path.basename(String(q.body.to))}`],
  'POST /api/delete': ['delete', (q) => `Usunięto: ${few(q.body.paths)}`],
  'POST /api/copy': ['file', (q) => `Skopiowano ${few(q.body.paths)} do ${q.body.dest}`],
  'POST /api/move': ['file', (q) => `Przeniesiono ${few(q.body.paths)} do ${q.body.dest}`],
  'POST /api/chmod': ['file', (q) => `Zmieniono uprawnienia ${q.body.path} na ${q.body.mode}`],
  'POST /api/extract': ['file', (q) => `Wypakowano ${q.body.path}`],
  'POST /api/compress': ['file', (q) => `Spakowano do ZIP: ${few(q.body.paths)}`],
  'POST /api/upload': ['upload', (q) => `Wysłano plik ${q.query.path}`, (q) => ({ size: Number(q.headers['content-length']) || 0, dir: path.dirname(String(q.query.path)) })],
  'GET /api/download': ['download', (q) => `Pobrano ${q.query.paths ? few(JSON.parse(q.query.paths)) : q.query.path}`],
  'GET /api/read': ['file', (q) => `Otworzono w edytorze ${q.query.path}`],
  'POST /api/kill': ['process', (q) => `${q.body.signal === 'SIGKILL' ? 'Wymuszono zakończenie' : q.body.signal === 'SIGSTOP' ? 'Wstrzymano' : q.body.signal === 'SIGCONT' ? 'Wznowiono' : 'Zakończono'}${q.body.tree ? ' drzewo procesów' : ' proces'} ${q.procName || ''} (PID ${q.body.pid})`],
  'POST /api/renice': ['process', (q) => `Zmieniono priorytet ${q.procName || ''} (PID ${q.body.pid}) na nice ${q.body.nice}`],
  'POST /api/run': ['command', (q) => `Uruchomiono zadanie w tle: ${q.body.command}`],
  'POST /api/service': ['service', (q) => `Usługa ${q.body.name}: ${{ start: 'uruchomiono', stop: 'zatrzymano', restart: 'uruchomiono ponownie', enable: 'włączono autostart', disable: 'wyłączono autostart' }[q.body.action] || q.body.action}`],
  'POST /api/update/app': ['system', () => 'Rozpoczęto aktualizację WebPulpit'],
  'POST /api/update/system': ['system', () => 'Rozpoczęto aktualizację pakietów systemu'],
  'POST /api/reboot': ['system', () => 'Uruchomiono ponownie serwer'],
  'POST /api/password': ['security', () => 'Zmieniono hasło do panelu'],
  'POST /api/assistant/settings': ['assistant', (q) => (typeof q.body.apiKey === 'string' ? (q.body.apiKey ? 'Zmieniono klucz API asystenta' : 'Usunięto klucz API asystenta') : 'Zmieniono ustawienia asystenta')],
  'POST /api/assistant/conv/delete': ['assistant', () => 'Usunięto rozmowę z asystentem'],
  'POST /api/panel/revoke': ['security', (q) => `Wylogowano sesję: ${q.revokedName || q.body.sid}`],
  'POST /api/panel/revoke-others': ['security', (q) => `Wylogowano wszystkie inne sesje (${q.revokedCount || 0})`]
};
app.use('/api', (req, res, next) => {
  const rule = ACTIVITY[`${req.method} ${req.baseUrl}${req.path}`];
  if (!rule) return next();
  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    try {
      req.body = req.body || {};
      sessions.log(req.sid, rule[0], rule[1](req), rule[2] ? rule[2](req) : undefined);
    } catch { /* never break a request because of logging */ }
  });
  next();
});

// State-changing requests must carry a custom header, which a foreign site cannot add
// without a CORS preflight (that we never answer) - protection against CSRF.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.get('X-WebPulpit') !== '1') {
    return res.status(403).json({ error: 'Brak nagłówka X-WebPulpit' });
  }
  next();
});

app.use(express.static(PUBLIC, { index: 'index.html' }));
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules/@xterm/xterm')));
app.use('/vendor/xterm-fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit')));

const json = express.json({ limit: '50mb' });

app.get('/api/info', (req, res) => {
  const u = os.userInfo();
  const home = u.homedir;
  const desktop = path.join(home, 'Desktop');
  try { fs.mkdirSync(desktop, { recursive: true }); } catch { /* read-only home */ }
  res.json({
    username: req.user ? req.user.username : '',
    uid: req.user ? req.user.id : '',
    role: req.user ? req.user.role : 'user',
    systemUser: u.username,
    home,
    desktop,
    root: files.root,
    hostname: os.hostname(),
    version: updates.versionInfo().version
  });
});

app.get('/api/list', wrap(async (req, res) => res.json(await files.list(req.query.path || '/'))));
app.get('/api/stat', wrap(async (req, res) => res.json(await files.stat(req.query.path))));

app.get('/api/read', wrap(async (req, res) => {
  res.type('text/plain; charset=utf-8').send(await files.readText(req.query.path));
}));

app.post('/api/write', json, wrap(async (req, res) => {
  await files.writeText(req.body.path, req.body.content);
  res.json({ ok: true });
}));

app.post('/api/mkdir', json, wrap(async (req, res) => res.json({ path: await files.mkdir(req.body.path) })));
app.post('/api/touch', json, wrap(async (req, res) => res.json({ path: await files.touch(req.body.path) })));
app.post('/api/rename', json, wrap(async (req, res) => res.json({ path: await files.rename(req.body.from, req.body.to) })));

function pathList(v) {
  if (!Array.isArray(v) || v.length === 0) throw new HttpError(400, 'Nie wybrano plików');
  return v;
}

app.post('/api/delete', json, wrap(async (req, res) => {
  await files.remove(pathList(req.body.paths));
  res.json({ ok: true });
}));
app.post('/api/copy', json, wrap(async (req, res) => res.json({ paths: await files.copy(pathList(req.body.paths), req.body.dest) })));
app.post('/api/move', json, wrap(async (req, res) => res.json({ paths: await files.move(pathList(req.body.paths), req.body.dest) })));
app.post('/api/chmod', json, wrap(async (req, res) => {
  await files.chmod(req.body.path, req.body.mode);
  res.json({ ok: true });
}));
app.post('/api/extract', json, wrap(async (req, res) => res.json({ path: await files.extract(req.body.path) })));
app.post('/api/compress', json, wrap(async (req, res) => {
  res.json({ path: await files.compress(pathList(req.body.paths), req.body.dest, req.body.name) });
}));

// Raw file (images, video, audio, PDF) - supports Range requests for seeking.
app.get('/api/raw', wrap(async (req, res, next) => {
  const abs = files.resolve(req.query.path);
  res.sendFile(abs, { dotfiles: 'allow', headers: { 'Cache-Control': 'no-cache' } }, (err) => {
    if (err && !res.headersSent) next(err);
  });
}));

function zipName(name) {
  return encodeURIComponent(name).replace(/['()]/g, escape);
}

app.get('/api/download', wrap(async (req, res, next) => {
  const paths = req.query.paths ? JSON.parse(req.query.paths) : [req.query.path];
  const abs = paths.map(files.resolve);
  const single = abs.length === 1 ? fs.statSync(abs[0]) : null;
  if (single && !single.isDirectory()) {
    return res.download(abs[0], path.basename(abs[0]), { dotfiles: 'allow' }, (err) => {
      if (err && !res.headersSent) next(err);
    });
  }
  const name = (abs.length === 1 ? path.basename(abs[0]) || 'root' : 'pliki') + '.zip';
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${zipName(name)}`);
  const archive = files.zipTo(res, abs);
  archive.on('error', (err) => {
    console.error('[zip]', err.message);
    res.destroy(err);
  });
  req.on('close', () => { if (!res.writableEnded) archive.abort(); });
}));

// Upload: the raw request body is streamed straight to disk, so there is no size limit
// other than free disk space. Parent folders are created automatically (folder uploads).
app.post('/api/upload', wrap(async (req, res) => {
  const target = files.resolve(req.query.path);
  const overwrite = req.query.overwrite === '1';
  if (!overwrite && await files.exists(target)) throw new HttpError(409, `Plik „${path.basename(target)}” już istnieje`);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.upload-${process.pid}-${Date.now()}`);
  const out = fs.createWriteStream(tmp);
  let aborted = false;
  req.on('close', () => {
    if (!req.complete) { aborted = true; out.destroy(); }
  });
  await new Promise((resolve, reject) => {
    req.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    out.on('close', () => { if (aborted) reject(new HttpError(499, 'Przerwano wysyłanie')); });
  }).catch(async (err) => {
    await fs.promises.rm(tmp, { force: true });
    throw err;
  });
  await fs.promises.rename(tmp, target);
  res.json({ path: target });
}));

// ---------- Task Manager ----------
app.get('/api/perf', wrap(async (req, res) => res.json(await taskmgr.perf())));
app.get('/api/procs', wrap(async (req, res) => res.json(taskmgr.processes())));
app.get('/api/proc', wrap(async (req, res) => res.json(taskmgr.processDetail(req.query.pid))));

function validPid(v) {
  const pid = Number(v);
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) throw new HttpError(400, 'Nieprawidłowy PID (nie można zakończyć samego panelu)');
  return pid;
}
const SIGNALS = ['SIGTERM', 'SIGKILL', 'SIGSTOP', 'SIGCONT', 'SIGHUP', 'SIGINT'];

function procName(pid) {
  try { return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { return ''; }
}

app.post('/api/kill', json, wrap(async (req, res) => {
  const pid = validPid(req.body.pid);
  req.procName = procName(pid);
  const signal = SIGNALS.includes(req.body.signal) ? req.body.signal : 'SIGTERM';
  if (req.body.tree) return res.json({ killed: taskmgr.killTree(pid, signal) });
  process.kill(pid, signal);
  res.json({ killed: 1 });
}));
app.post('/api/renice', json, wrap(async (req, res) => {
  req.procName = procName(Number(req.body.pid));
  taskmgr.setPriority(validPid(req.body.pid), req.body.nice);
  res.json({ ok: true });
}));
app.post('/api/run', json, wrap(async (req, res) => {
  const command = String(req.body.command || '').trim();
  if (!command) throw new HttpError(400, 'Wpisz polecenie');
  res.json({ pid: taskmgr.runTask(command, req.body.cwd) });
}));
app.get('/api/services', wrap(async (req, res) => res.json(await taskmgr.services())));
app.post('/api/service', json, wrap(async (req, res) => {
  await taskmgr.serviceAction(String(req.body.name || ''), String(req.body.action || ''));
  res.json({ ok: true });
}));
app.get('/api/service-logs', wrap(async (req, res) => {
  res.type('text/plain; charset=utf-8').send(await taskmgr.serviceLogs(String(req.query.name || '')));
}));
app.get('/api/sessions', wrap(async (req, res) => res.json(await taskmgr.sessions())));

// ---------- Updates ----------
app.get('/api/version', (req, res) => res.json({ ...updates.versionInfo(), root: updates.isRoot() }));
app.get('/api/update/app', wrap(async (req, res) => res.json(await updates.checkApp(cfg))));
app.post('/api/update/app', wrap(async (req, res) => res.json(await updates.updateApp(cfg))));
app.get('/api/update/system', wrap(async (req, res) => res.json(await updates.checkSystem())));
app.post('/api/update/system', wrap(async (req, res) => res.json(await updates.upgradeSystem())));
app.get('/api/update/job', (req, res) => {
  const name = req.query.name === 'system' ? 'system' : 'app';
  res.json(updates.jobStatus(name));
});
app.post('/api/reboot', wrap(async (req, res) => {
  await updates.reboot();
  res.json({ ok: true });
}));

app.post('/api/password', json, wrap(async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!req.user || !users.verifyPassword(oldPassword || '', req.user.passwordHash)) throw new HttpError(403, 'Obecne hasło jest nieprawidłowe');
  if (typeof newPassword !== 'string' || newPassword.length < 8) throw new HttpError(400, 'Nowe hasło musi mieć co najmniej 8 znaków');
  users.update(cfg, req.user.id, { password: newPassword });
  // Only this user's other sessions become invalid (their token no longer matches).
  for (const s of sessions.list(req.sid)) if (s.active && !s.current && s.user === req.user.username) sessions.revoke(s.sid, 'zmiana hasła');
  res.setHeader('Set-Cookie', auth.cookieHeader(cfg, auth.createToken(cfg, req.sid, req.user), cfg.sessionHours * 3600));
  res.json({ ok: true });
}));

// ---------- Users (admin only; gated above) ----------
app.get('/api/users', (req, res) => res.json(users.list(cfg)));
app.post('/api/users', json, wrap(async (req, res) => res.json(users.add(cfg, req.body || {}))));
app.post('/api/users/update', json, wrap(async (req, res) => {
  const before = users.byId(cfg, req.body.id);
  const out = users.update(cfg, req.body.id, req.body);
  // A password reset or role change invalidates that user's active sessions.
  if (before && (req.body.password || req.body.role)) {
    for (const s of sessions.list(req.sid)) if (s.active && s.user === before.username && s.sid !== req.sid) sessions.revoke(s.sid, 'zmiana konta przez administratora');
  }
  res.json(out);
}));
app.post('/api/users/delete', json, wrap(async (req, res) => {
  const u = users.byId(cfg, req.body.id);
  if (u && u.id === req.user.id) throw new HttpError(400, 'Nie możesz usunąć własnego konta');
  users.remove(cfg, req.body.id);
  if (u) for (const s of sessions.list(req.sid)) if (s.user === u.username) sessions.revoke(s.sid, 'konto usunięte');
  res.json({ ok: true });
}));

// ---------- Panel sessions (logged-in computers) ----------
app.get('/api/panel/sessions', (req, res) => {
  const terms = terminal.list();
  res.json(sessions.list(req.sid).map((s) => ({ ...s, terminals: terms.filter((t) => t.sid === s.sid) })));
});
app.get('/api/panel/activity', (req, res) => {
  res.json(sessions.activity({
    sid: req.query.sid || undefined,
    before: Number(req.query.before) || undefined,
    limit: Math.min(500, Number(req.query.limit) || 200),
    type: req.query.type || undefined
  }));
});
app.post('/api/panel/revoke', json, wrap(async (req, res) => {
  const sid = String(req.body.sid || '');
  req.revokedName = sessions.describe(sid);
  if (!sessions.revoke(sid, 'wylogowano zdalnie z innej sesji')) throw new HttpError(404, 'Ta sesja jest już nieaktywna');
  res.json({ ok: true });
}));
app.post('/api/panel/revoke-others', (req, res) => {
  let n = 0;
  for (const s of sessions.list(req.sid)) if (s.active && !s.current && sessions.revoke(s.sid, 'wylogowano zdalnie z innej sesji')) n++;
  req.revokedCount = n;
  res.json({ revoked: n });
});
app.post('/api/panel/label', json, (req, res) => {
  sessions.setLabel(String(req.body.sid || ''), req.body.label);
  res.json({ ok: true });
});
app.post('/api/panel/state', json, (req, res) => {
  sessions.setState(req.sid, req.body || {});
  res.json({ ok: true });
});
app.post('/api/panel/terminal/kill', json, (req, res) => {
  const t = terminal.list().find((x) => x.id === req.body.id);
  if (!t) throw new HttpError(404, 'Ten terminal jest już zamknięty');
  terminal.kill(t.id);
  sessions.log(req.sid, 'terminal', `Zamknięto terminal sesji ${sessions.describe(t.sid)}`);
  res.json({ ok: true });
});

// Live notifications for the open page (Server-Sent Events).
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ sid: req.sid })}\n\n`);
  const remove = sessions.addStream(req.sid, res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); remove(); });
});

// ---------- Game servers ----------
function loadGame(req) {
  const s = games.get(req.params.id);
  if (!s) throw new HttpError(404, 'Nie ma takiego serwera gry');
  if (!users.canUseGame(req.user, s.id, s.ownerId)) throw new HttpError(403, 'Nie masz dostępu do tego serwera');
  return s;
}
const gameLog = (req, text) => sessions.log(req.sid, 'game', text);

app.get('/api/games/templates', (req, res) => res.json(games.templateList()));
app.get('/api/games', (req, res) => res.json(games.visibleTo(req.user).map((s) => games.pub(s, req.user))));
app.post('/api/games', json, wrap(async (req, res) => {
  const s = games.create(req.user, req.body || {});
  gameLog(req, `Utworzono serwer gry „${s.name}” (${s.templateLabel})`);
  res.json(s);
}));
app.get('/api/games/:id', wrap(async (req, res) => { loadGame(req); res.json(await games.status(req.params.id)); }));
app.get('/api/games/:id/info', wrap(async (req, res) => res.json(games.pub(loadGame(req), req.user))));
app.post('/api/games/:id/settings', json, wrap(async (req, res) => {
  loadGame(req);
  res.json(games.updateSettings(req.params.id, req.body || {}));
}));
app.post('/api/games/:id/install', wrap(async (req, res) => {
  const s = loadGame(req);
  gameLog(req, `Instalacja / aktualizacja serwera „${s.name}”`);
  res.json(await games.install(req.params.id));
}));
app.get('/api/games/:id/job', wrap(async (req, res) => { loadGame(req); res.json(games.jobStatus(req.params.id)); }));
for (const action of ['start', 'stop', 'restart']) {
  app.post(`/api/games/:id/${action}`, wrap(async (req, res) => {
    const s = loadGame(req);
    gameLog(req, `${{ start: 'Uruchomiono', stop: 'Zatrzymano', restart: 'Zrestartowano' }[action]} serwer „${s.name}”`);
    res.json(await games[action](req.params.id));
  }));
}
app.get('/api/games/:id/console', wrap(async (req, res) => {
  loadGame(req);
  res.type('text/plain; charset=utf-8').send(await games.consoleTail(req.params.id, Number(req.query.lines) || 200));
}));
app.post('/api/games/:id/command', json, wrap(async (req, res) => {
  const s = loadGame(req);
  await games.sendCommand(req.params.id, req.body.command);
  gameLog(req, `Konsola „${s.name}”: ${String(req.body.command).slice(0, 200)}`);
  res.json({ ok: true });
}));
app.get('/api/games/:id/backups', wrap(async (req, res) => { loadGame(req); res.json(games.listBackups(req.params.id)); }));
app.post('/api/games/:id/backup', wrap(async (req, res) => {
  const s = loadGame(req);
  const out = await games.backup(req.params.id);
  gameLog(req, `Utworzono kopię zapasową serwera „${s.name}”`);
  res.json(out);
}));
app.post('/api/games/:id/backup/delete', json, wrap(async (req, res) => {
  loadGame(req);
  games.deleteBackup(req.params.id, String(req.body.name || ''));
  res.json({ ok: true });
}));
app.get('/api/games/:id/backup/download', wrap(async (req, res, next) => {
  loadGame(req);
  const name = String(req.query.name || '');
  if (!/^kopia-[\d-]+\.tar\.gz$/.test(name)) throw new HttpError(400, 'Nieprawidłowa nazwa kopii');
  res.download(path.join(games.backupDir(req.params.id), name), name, (err) => { if (err && !res.headersSent) next(err); });
}));
// Config file editing, confined to the template's declared config files.
function configFileName(s, name) {
  const t = games.templates[s.template];
  const allowed = (t.configFiles || []).map((c) => c.path);
  if (!allowed.includes(name)) throw new HttpError(400, 'Ten plik nie jest edytowalny w tym serwerze');
  return path.join(games.serverDir(s.id), name);
}
app.get('/api/games/:id/config', wrap(async (req, res) => {
  const s = loadGame(req);
  const t = games.templates[s.template];
  res.json({ files: t.configFiles || [] });
}));
app.get('/api/games/:id/config/file', wrap(async (req, res) => {
  const s = loadGame(req);
  const file = configFileName(s, String(req.query.name || ''));
  let content = '';
  try { content = fs.readFileSync(file, 'utf8'); } catch { /* not created yet */ }
  res.type('text/plain; charset=utf-8').send(content);
}));
app.post('/api/games/:id/config/file', json, wrap(async (req, res) => {
  const s = loadGame(req);
  const file = configFileName(s, String(req.body.name || ''));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(req.body.content ?? ''), 'utf8');
  gameLog(req, `Zmieniono plik ${req.body.name} serwera „${s.name}”`);
  res.json({ ok: true });
}));
app.post('/api/games/:id/delete', json, wrap(async (req, res) => {
  const s = loadGame(req);
  if (req.user.role !== 'admin' && s.ownerId !== req.user.id) throw new HttpError(403, 'Tylko właściciel lub administrator może usunąć serwer');
  gameLog(req, `Usunięto serwer „${s.name}”${req.body.files ? ' wraz z plikami' : ''}`);
  await games.remove(req.params.id, !!req.body.files);
  res.json({ ok: true });
}));

// ---------- Asystent Claude ----------
app.get('/api/assistant/settings', (req, res) => res.json(assistant.publicSettings(cfg)));
app.post('/api/assistant/settings', json, wrap(async (req, res) => res.json(assistant.saveSettings(cfg, req.body || {}))));
app.get('/api/assistant/convs', (req, res) => res.json(assistant.listConvs()));
app.get('/api/assistant/conv', wrap(async (req, res) => {
  const conv = assistant.loadConv(req.query.id);
  if (!conv) throw new HttpError(404, 'Nie ma takiej rozmowy');
  res.json(conv);
}));
app.post('/api/assistant/conv/delete', json, wrap(async (req, res) => {
  assistant.deleteConv(req.body.id);
  res.json({ ok: true });
}));
app.get('/api/assistant/claude-code', (req, res) => {
  require('child_process').execFile('/bin/bash', ['-lc', 'command -v claude'], (err, stdout) => {
    res.json({ installed: !err && !!stdout.trim(), path: stdout.trim() });
  });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Nie znaleziono' }));

// Error handler: map filesystem errors to readable Polish messages.
const FS_ERRORS = {
  ENOENT: [404, 'Nie znaleziono pliku lub folderu'],
  EACCES: [403, 'Brak uprawnień'],
  EPERM: [403, 'Operacja niedozwolona'],
  EEXIST: [409, 'Element już istnieje'],
  ENOTEMPTY: [409, 'Folder nie jest pusty'],
  ENOTDIR: [400, 'To nie jest folder'],
  EISDIR: [400, 'To jest folder'],
  ENOSPC: [507, 'Brak miejsca na dysku'],
  EROFS: [403, 'System plików tylko do odczytu'],
  EBUSY: [409, 'Zasób jest zajęty'],
  ESRCH: [404, 'Nie ma takiego procesu']
};

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  let status = err.status || 500;
  let message = err.message || 'Błąd serwera';
  if (err.code && FS_ERRORS[err.code]) [status, message] = FS_ERRORS[err.code];
  else if (err instanceof SyntaxError) [status, message] = [400, 'Nieprawidłowe dane'];
  if (status >= 500) console.error('[error]', req.method, req.path, err);
  if (res.headersSent) return res.destroy();
  res.status(status).json({ error: message });
});

let server;
if (cfg.https && cfg.https.cert && cfg.https.key) {
  server = https.createServer({
    cert: fs.readFileSync(cfg.https.cert),
    key: fs.readFileSync(cfg.https.key)
  }, app);
} else {
  server = http.createServer(app);
}
// Large uploads can take a long time - disable the default 5 minute request timeout.
server.requestTimeout = 0;
server.headersTimeout = 60000;

terminal.attachTerminal(server, cfg);
assistant.attachAssistant(server, cfg, files);
games.attachConsole(server, cfg);

server.listen(cfg.port, cfg.host, () => {
  const proto = cfg.https ? 'https' : 'http';
  console.log(`WebPulpit działa: ${proto}://${cfg.host === '0.0.0.0' ? '<IP-serwera>' : cfg.host}:${cfg.port}`);
  console.log(`Pliki jako użytkownik systemowy: ${os.userInfo().username}`);
});
