'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const express = require('express');

const config = require('./lib/config');
const auth = require('./lib/auth');
const taskmgr = require('./lib/taskmgr');
const updates = require('./lib/updates');
const { createFiles, HttpError } = require('./lib/files');
const { attachTerminal } = require('./lib/terminal');

const cfg = config.load();
if (!cfg.username || !cfg.passwordHash || !cfg.sessionSecret) {
  console.error('Konfiguracja niekompletna. Uruchom: node scripts/setup.js');
  process.exit(1);
}

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
  const ok = username === cfg.username && auth.verifyPassword(password || '', cfg.passwordHash);
  if (!ok) {
    auth.registerFailure(ip);
    console.warn(`[login] nieudane logowanie z ${ip} (użytkownik: ${String(username).slice(0, 40)})`);
    return res.status(401).json({ error: 'Nieprawidłowy login lub hasło' });
  }
  auth.clearFailures(ip);
  console.log(`[login] zalogowano z ${ip}`);
  res.setHeader('Set-Cookie', auth.cookieHeader(cfg, auth.createToken(cfg), cfg.sessionHours * 3600));
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', auth.cookieHeader(cfg, '', 0));
  res.json({ ok: true });
});

// ---------- Everything below requires a session ----------
app.use((req, res, next) => {
  if (auth.sessionFromRequest(cfg, req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sesja wygasła, zaloguj się ponownie' });
  return res.redirect('/login');
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
    username: cfg.username,
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

app.post('/api/kill', json, wrap(async (req, res) => {
  const pid = validPid(req.body.pid);
  const signal = SIGNALS.includes(req.body.signal) ? req.body.signal : 'SIGTERM';
  if (req.body.tree) return res.json({ killed: taskmgr.killTree(pid, signal) });
  process.kill(pid, signal);
  res.json({ killed: 1 });
}));
app.post('/api/renice', json, wrap(async (req, res) => {
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
  if (!auth.verifyPassword(oldPassword || '', cfg.passwordHash)) throw new HttpError(403, 'Obecne hasło jest nieprawidłowe');
  if (typeof newPassword !== 'string' || newPassword.length < 8) throw new HttpError(400, 'Nowe hasło musi mieć co najmniej 8 znaków');
  cfg.passwordHash = auth.hashPassword(newPassword);
  const stored = JSON.parse(fs.readFileSync(config.CONFIG_PATH, 'utf8'));
  stored.passwordHash = cfg.passwordHash;
  config.save(stored);
  res.setHeader('Set-Cookie', auth.cookieHeader(cfg, auth.createToken(cfg), cfg.sessionHours * 3600));
  res.json({ ok: true });
}));

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

attachTerminal(server, cfg);

server.listen(cfg.port, cfg.host, () => {
  const proto = cfg.https ? 'https' : 'http';
  console.log(`WebPulpit działa: ${proto}://${cfg.host === '0.0.0.0' ? '<IP-serwera>' : cfg.host}:${cfg.port}`);
  console.log(`Pliki jako użytkownik systemowy: ${os.userInfo().username}`);
});
