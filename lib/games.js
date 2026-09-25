'use strict';
/* Game server hosting: create, install, start/stop and back up dedicated game servers,
   the way a game-hosting panel does. Each server:
   - lives in its own folder under the games root,
   - installs through SteamCMD (for Steam games) in a background job,
   - runs inside a detached tmux session (survives a restart of the panel; the console
     can be attached live), started on boot by a small systemd unit when systemd is present,
   - is described by a template (Valheim, CS2, Minecraft, …) or a custom command. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE = path.join(DATA_DIR, 'games.json');
const EXIT_MARK = '__WP_EXIT__:';

let cfg = null;
let servers = new Map();

function gamesRoot() {
  return (cfg && cfg.gamesDir) || '/opt/webpulpit-games';
}
function steamDir() {
  return path.join(gamesRoot(), 'steamcmd');
}
function serverDir(id) {
  return path.join(gamesRoot(), 'servers', id);
}
const session = (id) => 'wpg_' + id;
const isRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
function httpErr(status, msg) { return Object.assign(new Error(msg), { status }); }

// ---------- templates ----------
// build(s) -> { startCmd, env } using the server's settings.
// settings: fields shown in the UI. save: folders to back up (relative to dir).
const TEMPLATES = {
  valheim: {
    label: 'Valheim', steam: true, appId: '896660', icon: '#5b8f3a',
    ports: (s) => [`${s.settings.port || 2456}/udp`, `${(+s.settings.port || 2456) + 1}/udp`],
    settings: [
      { key: 'serverName', label: 'Nazwa serwera na liście', def: 'Serwer Valheim' },
      { key: 'world', label: 'Nazwa świata', def: 'Dedicated' },
      { key: 'password', label: 'Hasło (min. 5 znaków)', def: '', type: 'password' },
      { key: 'port', label: 'Port (UDP)', def: '2456', type: 'number' },
      { key: 'crossplay', label: 'Crossplay', def: true, type: 'bool' }
    ],
    save: ['.config/unity3d/IronGate/Valheim/worlds_local'],
    build: (s) => ({
      env: { LD_LIBRARY_PATH: './linux64:$LD_LIBRARY_PATH', SteamAppId: '892970', HOME: serverDir(s.id) },
      startCmd: `./valheim_server.x86_64 -name ${shq(s.settings.serverName || 'Valheim')} -port ${+s.settings.port || 2456} -world ${shq(s.settings.world || 'Dedicated')} -password ${shq(s.settings.password || '')} -nographics -batchmode${s.settings.crossplay ? ' -crossplay' : ''}`
    })
  },
  cs2: {
    label: 'Counter-Strike 2', steam: true, appId: '730', anonymous: true, icon: '#d98f28',
    ports: (s) => [`${s.settings.port || 27015}/udp`, `${s.settings.port || 27015}/tcp`],
    settings: [
      { key: 'port', label: 'Port', def: '27015', type: 'number' },
      { key: 'maxPlayers', label: 'Maks. graczy', def: '10', type: 'number' },
      { key: 'map', label: 'Mapa startowa', def: 'de_dust2' },
      { key: 'gslt', label: 'Token GSLT (steamcommunity.com/dev/managegameservers)', def: '' },
      { key: 'extra', label: 'Dodatkowe parametry', def: '' }
    ],
    save: ['game/csgo/cfg'],
    build: (s) => ({
      env: {},
      startCmd: `./game/bin/linuxsteamrt64/cs2 -dedicated -console -usercon +game_type 0 +game_mode 1 +map ${shq(s.settings.map || 'de_dust2')} -port ${+s.settings.port || 27015} +sv_setsteamaccount ${shq(s.settings.gslt || '')} +maxplayers ${+s.settings.maxPlayers || 10} ${s.settings.extra || ''}`
    })
  },
  minecraft: {
    label: 'Minecraft (Java)', steam: false, java: true, icon: '#4a9e3f',
    ports: (s) => [`${s.settings.port || 25565}/tcp`],
    settings: [
      { key: 'version', label: 'Wersja (np. 1.21.4 albo „latest”)', def: 'latest' },
      { key: 'memory', label: 'Pamięć RAM (MB)', def: '2048', type: 'number' },
      { key: 'port', label: 'Port', def: '25565', type: 'number' },
      { key: 'motd', label: 'Opis serwera (MOTD)', def: 'Serwer WebPulpit' }
    ],
    save: ['world', 'world_nether', 'world_the_end'],
    configFiles: [{ path: 'server.properties', label: 'server.properties' }],
    stopCmd: 'stop',
    build: (s) => ({ env: {}, startCmd: `java -Xmx${+s.settings.memory || 2048}M -Xms${Math.min(+s.settings.memory || 2048, 1024)}M -jar server.jar nogui` }),
    // Custom installer (no Steam): fetch the server.jar from Mojang's manifest.
    install: async (s, run) => {
      await run('echo "==> Pobieranie Minecraft server.jar"');
      const ver = (s.settings.version || 'latest').trim();
      await run(`cat > install-mc.mjs <<'MJS'
const want = ${JSON.stringify(ver)};
const man = await (await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')).json();
const id = (want === 'latest' || !want) ? man.latest.release : want;
const entry = man.versions.find(v => v.id === id);
if (!entry) { console.error('Nie znaleziono wersji ' + id); process.exit(1); }
const meta = await (await fetch(entry.url)).json();
const url = meta.downloads.server.url;
console.log('Wersja ' + id + ' → ' + url);
const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
require('fs').writeFileSync('server.jar', buf);
console.log('Zapisano server.jar (' + buf.length + ' bajtów)');
MJS`);
      await run('node install-mc.mjs && rm -f install-mc.mjs');
      await run('echo eula=true > eula.txt');
      const props = defaultMcProps(s);
      await run(`cat > server.properties <<'PROPS'\n${props}\nPROPS`);
    }
  },
  steam_custom: {
    label: 'Inna gra ze Steam', steam: true, icon: '#3a6ea5',
    settings: [
      { key: 'appId', label: 'Numer aplikacji Steam (AppID serwera dedykowanego)', def: '' },
      { key: 'startCmd', label: 'Polecenie startowe (w folderze serwera)', def: './start.sh' },
      { key: 'ports', label: 'Porty (np. 27015/udp, 27016/tcp)', def: '' },
      { key: 'anonymous', label: 'Logowanie anonimowe do Steam', def: true, type: 'bool' }
    ],
    ports: (s) => String(s.settings.ports || '').split(',').map((x) => x.trim()).filter(Boolean),
    appIdOf: (s) => String(s.settings.appId || '').trim(),
    anonymousOf: (s) => s.settings.anonymous !== false,
    build: (s) => ({ env: {}, startCmd: s.settings.startCmd || './start.sh' })
  },
  command: {
    label: 'Własny serwer (dowolne polecenie)', steam: false, icon: '#6b7785',
    settings: [
      { key: 'startCmd', label: 'Polecenie startowe', def: '' },
      { key: 'ports', label: 'Porty (np. 8080/tcp)', def: '' }
    ],
    ports: (s) => String(s.settings.ports || '').split(',').map((x) => x.trim()).filter(Boolean),
    build: (s) => ({ env: {}, startCmd: s.settings.startCmd || 'echo "brak polecenia startowego"; sleep 5' })
  }
};

function defaultMcProps(s) {
  return [
    'server-port=' + (+s.settings.port || 25565),
    'motd=' + (s.settings.motd || 'Serwer WebPulpit'),
    'max-players=20',
    'online-mode=true',
    'enable-command-block=false',
    'spawn-protection=0'
  ].join('\n');
}

function templateList() {
  return Object.entries(TEMPLATES).map(([id, t]) => ({
    id, label: t.label, steam: !!t.steam, java: !!t.java,
    settings: t.settings, icon: t.icon
  }));
}

// ---------- store ----------
function load(config) {
  cfg = config;
  try {
    const arr = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    servers = new Map(arr.map((s) => [s.id, s]));
  } catch { servers = new Map(); }
}
function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(STORE + '.tmp', JSON.stringify([...servers.values()], null, 2), { mode: 0o600 });
  fs.renameSync(STORE + '.tmp', STORE);
}

// ---------- shell helpers ----------
function sh(command, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile('/bin/bash', ['-lc', command], { maxBuffer: 8 * 1024 * 1024, timeout: opts.timeout || 30000, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; return reject(err); }
      resolve(String(stdout));
    });
  });
}
async function tmuxRunning(id) {
  try { await sh(`tmux has-session -t ${shq(session(id))} 2>/dev/null`); return true; } catch { return false; }
}

// ---------- background jobs (install/update) ----------
function jobLog(id) { return path.join(serverDir(id), '.wp-job.log'); }
function jobStatus(id) {
  const file = jobLog(id);
  let text = '';
  let mtime = 0;
  try { text = fs.readFileSync(file, 'utf8'); mtime = fs.statSync(file).mtimeMs; } catch { return { running: false, exists: false }; }
  const m = text.match(new RegExp(EXIT_MARK + '(-?\\d+)'));
  const running = !m && Date.now() - mtime < 6 * 3600 * 1000;
  return { running, exists: true, exitCode: m ? Number(m[1]) : null, log: text.replace(new RegExp(EXIT_MARK + '-?\\d+\\s*$'), '').slice(-40000) };
}
async function startJob(id, script) {
  if (jobStatus(id).running) throw httpErr(409, 'Dla tego serwera trwa już instalacja lub aktualizacja');
  const dir = serverDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const file = jobLog(id);
  fs.writeFileSync(file, `[${new Date().toLocaleString('pl-PL')}] Start\n`, { mode: 0o600 });
  const wrapped = `cd ${shq(dir)}; ( ${script} ) >> ${shq(file)} 2>&1; echo "${EXIT_MARK}$?" >> ${shq(file)}`;
  if (fs.existsSync('/run/systemd/system')) {
    try {
      await sh(`systemd-run --unit wpg-job-${id}-${Date.now()} --collect --quiet /bin/bash -c ${shq(wrapped)}`);
      return;
    } catch (err) { if (err.code !== 'ENOENT') { /* fall through to spawn */ } }
  }
  const child = spawn('/bin/bash', ['-c', wrapped], { detached: true, stdio: 'ignore' });
  child.unref();
}

// A job step used by custom installers.
function stepRunner(id) {
  const file = jobLog(id);
  const dir = serverDir(id);
  return (command) => new Promise((resolve, reject) => {
    fs.appendFileSync(file, `\n$ ${command}\n`);
    const child = spawn('/bin/bash', ['-lc', command], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => fs.appendFileSync(file, d));
    child.stderr.on('data', (d) => fs.appendFileSync(file, d));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('krok zakończony kodem ' + code))));
    child.on('error', reject);
  });
}

// ---------- CRUD ----------
function pub(s, user) {
  const t = TEMPLATES[s.template];
  return {
    id: s.id, name: s.name, template: s.template, templateLabel: t ? t.label : s.template,
    icon: t ? t.icon : '#6b7785', settings: s.settings, ports: t && t.ports ? safe(() => t.ports(s), []) : [],
    autostart: !!s.autostart, created: s.created, ownerId: s.ownerId,
    installed: s.installed, dir: serverDir(s.id),
    canManage: !user || user.role === 'admin' || s.ownerId === user.id
  };
}
function safe(fn, def) { try { return fn(); } catch { return def; } }

function visibleTo(user) {
  const all = [...servers.values()];
  if (!user || user.role === 'admin') return all;
  return all.filter((s) => s.ownerId === user.id || (user.games || []).includes(s.id));
}
function get(id) { return servers.get(id); }

function create(user, { name, template, settings }) {
  if (!TEMPLATES[template]) throw httpErr(400, 'Nieznany typ serwera');
  name = String(name || '').trim();
  if (name.length < 2 || name.length > 40) throw httpErr(400, 'Nazwa serwera: 2–40 znaków');
  const t = TEMPLATES[template];
  const s = {
    id: crypto.randomBytes(5).toString('hex'),
    name, template, ownerId: user.id,
    settings: {}, autostart: false, created: Date.now(), installed: false
  };
  for (const f of t.settings) {
    const v = settings ? settings[f.key] : undefined;
    s.settings[f.key] = v != null ? v : f.def;
  }
  servers.set(s.id, s);
  fs.mkdirSync(serverDir(s.id), { recursive: true });
  persist();
  return pub(s, user);
}

function updateSettings(id, settings) {
  const s = servers.get(id);
  if (!s) throw httpErr(404, 'Nie ma takiego serwera');
  const t = TEMPLATES[s.template];
  for (const f of t.settings) if (settings[f.key] !== undefined) s.settings[f.key] = settings[f.key];
  if (settings.name && String(settings.name).trim().length >= 2) s.name = String(settings.name).trim();
  if (settings.autostart !== undefined) s.autostart = !!settings.autostart;
  persist();
  writeAutostart(s).catch(() => {});
  return pub(s);
}

// ---------- install ----------
async function install(id) {
  const s = servers.get(id);
  if (!s) throw httpErr(404, 'Nie ma takiego serwera');
  const t = TEMPLATES[s.template];
  const dir = serverDir(id);
  fs.mkdirSync(dir, { recursive: true });

  if (t.steam) {
    const appId = t.appIdOf ? t.appIdOf(s) : t.appId;
    if (!appId) throw httpErr(400, 'Podaj numer aplikacji Steam (AppID) w ustawieniach serwera');
    const anon = t.anonymousOf ? t.anonymousOf(s) : (t.anonymous !== false);
    const login = anon ? '+login anonymous' : '+login anonymous'; // only anonymous is supported from the panel
    const script = [
      'echo "==> Przygotowanie SteamCMD"',
      `mkdir -p ${shq(steamDir())}`,
      `if [ ! -x ${shq(path.join(steamDir(), 'steamcmd.sh'))} ]; then curl -sSL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz | tar -xz -C ${shq(steamDir())}; fi`,
      'echo "==> Pobieranie / aktualizacja gry (to może potrwać dłuższą chwilę)"',
      `${shq(path.join(steamDir(), 'steamcmd.sh'))} +force_install_dir ${shq(dir)} ${login} +app_update ${appId} validate +quit`,
      'echo "==> Gotowe"'
    ].join('\n');
    await startJob(id, script);
  } else if (t.install) {
    // Custom installer (e.g. Minecraft) - run inline in a background job.
    const file = jobLog(id);
    fs.writeFileSync(file, `[${new Date().toLocaleString('pl-PL')}] Start\n`, { mode: 0o600 });
    (async () => {
      try {
        await t.install(s, stepRunner(id));
        fs.appendFileSync(file, `\n${EXIT_MARK}0\n`);
        s.installed = true;
        persist();
      } catch (err) {
        fs.appendFileSync(file, `\nBŁĄD: ${err.message}\n${EXIT_MARK}1\n`);
      }
    })();
  } else {
    // "command" template: nothing to install.
    s.installed = true;
    persist();
    fs.writeFileSync(jobLog(id), `Ten typ serwera nie wymaga instalacji.\n${EXIT_MARK}0\n`, { mode: 0o600 });
  }
  return jobStatus(id);
}

// After a Steam/custom job finishes with code 0, mark installed on next status read.
function refreshInstalled(id) {
  const s = servers.get(id);
  if (!s || s.installed) return;
  const st = jobStatus(id);
  if (st.exists && !st.running && st.exitCode === 0) { s.installed = true; persist(); }
}

// ---------- run ----------
async function start(id) {
  const s = servers.get(id);
  if (!s) throw httpErr(404, 'Nie ma takiego serwera');
  if (await tmuxRunning(id)) return { running: true };
  if (jobStatus(id).running) throw httpErr(409, 'Trwa instalacja tego serwera');
  const t = TEMPLATES[s.template];
  const dir = serverDir(id);
  const built = t.build(s);
  const env = Object.entries(built.env || {}).map(([k, v]) => `export ${k}=${shq(String(v))};`).join(' ');
  // The command runs inside a tmux session named wpg_<id>. A trailing shell keeps the
  // pane open after the game exits, so the last log lines stay visible.
  const inner = `cd ${shq(dir)}; ${env} ${built.startCmd}; echo; echo '[Serwer zatrzymany. Naciśnij Enter, aby zamknąć konsolę]'; read _`;
  await sh(`tmux new-session -d -s ${shq(session(id))} -x 220 -y 50 ${shq('/bin/bash -lc ' + shq(inner))}`, { timeout: 15000 });
  // Cosmetic: hide tmux's own status bar and keep more scrollback for the console view.
  await sh(`tmux set-option -t ${shq(session(id))} status off \\; set-option -t ${shq(session(id))} history-limit 20000`).catch(() => {});
  s.lastStart = Date.now();
  persist();
  return { running: true };
}

async function stop(id) {
  const s = servers.get(id);
  if (!s) throw httpErr(404, 'Nie ma takiego serwera');
  if (!(await tmuxRunning(id))) return { running: false };
  const t = TEMPLATES[s.template];
  const stopCmd = t.stopCmd;
  try {
    if (stopCmd) {
      // Graceful: type the game's stop command (e.g. Minecraft "stop"), then wait.
      await sh(`tmux send-keys -t ${shq(session(id))} -- ${shq(stopCmd)} Enter`);
      for (let i = 0; i < 20; i++) { if (!(await tmuxRunning(id))) break; await new Promise((r) => setTimeout(r, 1000)); }
    } else {
      await sh(`tmux send-keys -t ${shq(session(id))} C-c`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  } catch { /* fall through to kill */ }
  if (await tmuxRunning(id)) { try { await sh(`tmux kill-session -t ${shq(session(id))}`); } catch { /* gone */ } }
  return { running: false };
}

async function restart(id) {
  await stop(id);
  return start(id);
}

async function status(id) {
  const s = servers.get(id);
  if (!s) return null;
  refreshInstalled(id);
  const job = jobStatus(id);
  let dirSize = null;
  try { dirSize = Number((await sh(`du -sb ${shq(serverDir(id))} 2>/dev/null | cut -f1`)).trim()) || 0; } catch { /* ignore */ }
  return {
    id, running: await tmuxRunning(id), installed: s.installed,
    installing: job.running, job: { running: job.running, exitCode: job.exitCode },
    size: dirSize, ports: safe(() => TEMPLATES[s.template].ports(s), [])
  };
}

async function consoleTail(id, lines = 200) {
  if (!(await tmuxRunning(id))) return '(serwer nie jest uruchomiony)';
  try { return await sh(`tmux capture-pane -p -t ${shq(session(id))} -S -${Math.min(2000, lines)}`); } catch { return ''; }
}

async function sendCommand(id, cmd) {
  if (!(await tmuxRunning(id))) throw httpErr(409, 'Serwer nie jest uruchomiony');
  await sh(`tmux send-keys -t ${shq(session(id))} -- ${shq(String(cmd))} Enter`);
}

// ---------- backups ----------
function backupDir(id) { return path.join(serverDir(id), 'wp-backups'); }
async function backup(id) {
  const s = servers.get(id);
  if (!s) throw httpErr(404, 'Nie ma takiego serwera');
  const t = TEMPLATES[s.template];
  const dir = serverDir(id);
  const bdir = backupDir(id);
  fs.mkdirSync(bdir, { recursive: true });
  const targets = (t.save && t.save.length ? t.save : ['.']).filter((p) => fs.existsSync(path.join(dir, p)));
  if (!targets.length) throw httpErr(400, 'Nie ma jeszcze żadnych danych do zarchiwizowania (uruchom serwer choć raz)');
  const name = `kopia-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.tar.gz`;
  await sh(`cd ${shq(dir)} && tar --warning=no-file-changed -czf ${shq(path.join(bdir, name))} ${targets.map(shq).join(' ')}`, { timeout: 300000 });
  return listBackups(id);
}
function listBackups(id) {
  const bdir = backupDir(id);
  let files = [];
  try { files = fs.readdirSync(bdir).filter((f) => f.endsWith('.tar.gz')); } catch { return []; }
  return files.map((f) => { const st = fs.statSync(path.join(bdir, f)); return { name: f, size: st.size, mtime: st.mtimeMs }; })
    .sort((a, b) => b.mtime - a.mtime);
}
function deleteBackup(id, name) {
  if (!/^kopia-[\d-]+\.tar\.gz$/.test(name)) throw httpErr(400, 'Nieprawidłowa nazwa kopii');
  try { fs.unlinkSync(path.join(backupDir(id), name)); } catch { /* gone */ }
}

// ---------- delete ----------
async function remove(id, deleteFiles) {
  const s = servers.get(id);
  if (!s) return;
  try { await stop(id); } catch { /* ignore */ }
  await removeAutostart(s).catch(() => {});
  servers.delete(id);
  persist();
  if (deleteFiles) {
    const dir = serverDir(id);
    if (dir.startsWith(gamesRoot() + path.sep)) await sh(`rm -rf ${shq(dir)}`, { timeout: 120000 }).catch(() => {});
  }
}

// ---------- autostart on boot (systemd) ----------
function unitName(id) { return `wpgame-${id}.service`; }
async function writeAutostart(s) {
  if (!isRoot() || !fs.existsSync('/run/systemd/system')) return;
  const unit = `/etc/systemd/system/${unitName(s.id)}`;
  if (!s.autostart) return removeAutostart(s);
  const node = process.execPath;
  const helper = path.join(__dirname, '..', 'scripts', 'game-run.js');
  const content = `[Unit]
Description=WebPulpit gra: ${s.name}
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${node} ${helper} start ${s.id}
ExecStop=${node} ${helper} stop ${s.id}
User=${os.userInfo().username}

[Install]
WantedBy=multi-user.target
`;
  fs.writeFileSync(unit, content);
  await sh(`systemctl daemon-reload && systemctl enable ${unitName(s.id)}`).catch(() => {});
}
async function removeAutostart(s) {
  if (!isRoot() || !fs.existsSync('/run/systemd/system')) return;
  const unit = `/etc/systemd/system/${unitName(s.id)}`;
  if (fs.existsSync(unit)) {
    await sh(`systemctl disable ${unitName(s.id)} 2>/dev/null; rm -f ${shq(unit)}; systemctl daemon-reload`).catch(() => {});
  }
}

// ---------- live console over WebSocket ----------
function attachConsole(server, config) {
  const { WebSocketServer } = require('ws');
  const pty = require('node-pty');
  const auth = require('./auth');
  const users = require('./users');
  const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws/game') return; // other handlers deal with their own paths
    let same = false;
    try { same = !!req.headers.origin && new URL(req.headers.origin).host === req.headers.host; } catch { /* invalid */ }
    const tok = same && auth.sessionFromRequest(config, req);
    const id = url.searchParams.get('id');
    const s = tok && servers.get(id);
    const user = tok && users.byId(config, tok.uid);
    if (!s || !users.canUseGame(user, id, s.ownerId)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => runConsole(ws, id));
  });

  async function runConsole(ws, id) {
    if (!(await tmuxRunning(id))) { ws.send('\r\n\x1b[90m[Serwer nie jest uruchomiony]\x1b[0m\r\n'); return ws.close(); }
    // Attach as a tmux client. Closing the socket kills this client (detach), the
    // game's own tmux session keeps running.
    const term = pty.spawn('tmux', ['attach', '-t', session(id)], {
      name: 'xterm-256color', cols: 200, rows: 50, env: { ...process.env, TERM: 'xterm-256color' }
    });
    term.onData((d) => { if (ws.readyState === ws.OPEN) ws.send(d); });
    term.onExit(() => { if (ws.readyState === ws.OPEN) ws.close(); });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.t === 'i' && typeof m.d === 'string') term.write(m.d);
      else if (m.t === 'r') { try { term.resize(Math.max(20, m.c | 0), Math.max(5, m.r | 0)); } catch { /* closed */ } }
    });
    const ping = setInterval(() => { if (ws.readyState === ws.OPEN) ws.ping(); }, 30000);
    ws.on('close', () => { clearInterval(ping); try { term.kill(); } catch { /* gone */ } });
  }
}

module.exports = {
  load, templateList, templates: TEMPLATES,
  visibleTo, get, pub, create, updateSettings, install, jobStatus,
  start, stop, restart, status, consoleTail, sendCommand,
  backup, listBackups, deleteBackup, backupDir, remove,
  serverDir, gamesRoot, session, tmuxRunning, attachConsole
};
