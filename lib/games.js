'use strict';
/* Game server hosting: create, install, start/stop and back up dedicated game servers,
   the way a game-hosting panel does. Each server:
   - lives in its own folder under the games root,
   - installs through SteamCMD (for Steam games) in a background job,
   - runs either inside a detached tmux session (generic servers) or as its own systemd
     unit with its own Linux user and plan limits (hosted Valheim, runtime 'systemd'),
   - is described by a template (Valheim, CS2, Minecraft, …) or a custom command. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');
const plansLib = require('./plans');
const runtime = require('./runtime');
const valheim = require('./valheim');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE = path.join(DATA_DIR, 'games.json');
const EXIT_MARK = '__WP_EXIT__:';

let cfg = null;
let servers = new Map();

function runDir() { return path.join(gamesRoot(), 'run'); }
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
    label: 'Valheim', steam: true, appId: '896660', icon: '#5b8f3a', hosted: true,
    ports: (s) => [`${s.settings.port || 2456}/udp`, `${(+s.settings.port || 2456) + 1}/udp`],
    settings: [
      { key: 'serverName', label: 'Nazwa serwera na liście', def: 'Serwer Valheim' },
      { key: 'world', label: 'Nazwa świata', def: 'Dedicated' },
      { key: 'password', label: 'Hasło (min. 5 znaków, bez nazwy świata)', def: '', type: 'password' },
      { key: 'port', label: 'Port (UDP, serwer używa 3 kolejnych)', def: '2456', type: 'number' },
      { key: 'crossplay', label: 'Crossplay (Xbox / Game Pass)', def: false, type: 'bool' },
      { key: 'public', label: 'Pokaż na publicznej liście serwerów', def: false, type: 'bool' },
      { key: 'saveinterval', label: 'Zapis świata co (sekundy)', def: '1800', type: 'number' },
      { key: 'backupsKeep', label: 'Liczba automatycznych kopii Valheima', def: '4', type: 'number' }
    ],
    // What a customer may change on their own. Everything else is admin only.
    clientKeys: ['serverName', 'password', 'crossplay', 'public'],
    save: ['.config/unity3d/IronGate/Valheim/worlds_local'],
    build: (s) => ({
      env: { LD_LIBRARY_PATH: './linux64', SteamAppId: '892970', HOME: serverDir(s.id) },
      startCmd: `./valheim_server.x86_64 -name ${shq(s.settings.serverName || 'Valheim')} -port ${+s.settings.port || 2456} -world ${shq(s.settings.world || 'Dedicated')}${s.settings.password ? ' -password ' + shq(s.settings.password) : ''} -public ${s.settings.public === true || s.settings.public === 'true' ? 1 : 0} -saveinterval ${Math.max(60, +s.settings.saveinterval || 1800)} -backups ${Math.max(1, +s.settings.backupsKeep || 4)} -nographics -batchmode${s.settings.crossplay === true || s.settings.crossplay === 'true' ? ' -crossplay' : ''}`
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
      startCmd: `./game/bin/linuxsteamrt64/cs2 -dedicated -console -usercon +game_type 0 +game_mode 1 +map ${shq(s.settings.map || 'de_dust2')} -port ${+s.settings.port || 27015} +sv_setsteamaccount ${shq(s.settings.gslt || '')} +maxplayers ${+s.settings.maxPlayers || 10} ${String(s.settings.extra || '').replace(/[;&|`$()<>\\\n\r]/g, ' ')}`
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
    label: 'Inna gra ze Steam', steam: true, adminOnly: true, icon: '#3a6ea5',
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
    label: 'Własny serwer (dowolne polecenie)', steam: false, adminOnly: true, icon: '#6b7785',
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

function templateList(user) {
  const isAdmin = !user || user.role === 'admin';
  return Object.entries(TEMPLATES).filter(([, t]) => isAdmin || !t.adminOnly).map(([id, t]) => ({
    id, label: t.label, steam: !!t.steam, java: !!t.java, hosted: !!t.hosted,
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

// ---------- locks and rate limits ----------
// One operation at a time per server (start/stop/reset/restore must never overlap).
const busy = new Map();
async function exclusive(id, label, fn) {
  if (busy.has(id)) throw httpErr(409, `Trwa inna operacja na tym serwerze: ${busy.get(id)}`);
  busy.set(id, label);
  try { return await fn(); } finally { busy.delete(id); }
}
const lastAction = new Map();
// Customers cannot hammer restart/reset: it costs the whole machine CPU.
function gate(id, key, seconds) {
  const k = id + ':' + key;
  const left = (lastAction.get(k) || 0) + seconds * 1000 - Date.now();
  if (left > 0) throw httpErr(429, `Poczekaj ${Math.ceil(left / 1000)} s przed kolejną taką operacją`);
  lastAction.set(k, Date.now());
}

const isSystemd = (s) => !!s && s.runtime === 'systemd';
const limitsOf = (s) => plansLib.limitsFor(cfg, s);

// ---------- CRUD ----------
function pub(s, user) {
  const t = TEMPLATES[s.template];
  const isAdmin = !user || user.role === 'admin';
  const lim = limitsOf(s);
  const out = {
    id: s.id, name: s.name, template: s.template, templateLabel: t ? t.label : s.template,
    icon: t ? t.icon : '#6b7785', settings: s.settings, ports: t && t.ports ? safe(() => t.ports(s), []) : [],
    autostart: !!s.autostart, created: s.created, ownerId: s.ownerId,
    installed: s.installed, runtime: s.runtime || 'tmux',
    canManage: isAdmin || (user.role !== 'client' && s.ownerId === user.id),
    plan: s.plan || null, addons: s.addons || [], limits: lim,
    paid: plansLib.paidState(s),
    schedule: Object.assign({ restartAt: null, backupEveryH: 0 }, s.schedule || {}),
    discordSet: !!s.discordWebhook,
    clientKeys: t && t.clientKeys ? t.clientKeys : null
  };
  if (isAdmin) { out.dir = serverDir(s.id); out.paidUntil = s.paidUntil || null; out.note = s.note || ''; }
  if (user && user.role === 'client') { delete out.ownerId; out.settings = clientSettings(s); }
  return out;
}
function clientSettings(s) {
  const t = TEMPLATES[s.template];
  const keys = new Set([...(t.clientKeys || []), 'port', 'world', 'saveinterval']);
  const o = {};
  for (const k of keys) if (s.settings[k] !== undefined) o[k] = s.settings[k];
  return o;
}
function safe(fn, def) { try { return fn(); } catch { return def; } }

function visibleTo(user) {
  const all = [...servers.values()];
  if (!user || user.role === 'admin') return all;
  return all.filter((s) => s.ownerId === user.id || (user.games || []).includes(s.id));
}
function get(id) { return servers.get(id); }

// First free UDP port block (3 ports per server), outside the main server's 2456-2458.
function allocPort(except) {
  const used = [];
  for (const s of servers.values()) if (s.id !== except && s.template === 'valheim') used.push(+s.settings.port || 2456);
  for (let p = 2466; p < 2800; p += 3) if (!used.some((u) => Math.abs(u - p) < 3)) return p;
  throw httpErr(507, 'Brak wolnych portów dla serwerów Valheim');
}
function checkPortFree(id, port) {
  for (const s of servers.values()) {
    if (s.id === id || s.template !== 'valheim') continue;
    if (Math.abs((+s.settings.port || 2456) - port) < 3) throw httpErr(409, `Port ${port} koliduje z serwerem „${s.name}”`);
  }
}

function create(user, { name, template, settings, plan, addons, paidUntil }) {
  const t = TEMPLATES[template];
  if (!t) throw httpErr(400, 'Nieznany typ serwera');
  const isAdmin = user.role === 'admin';
  if (user.role === 'client') throw httpErr(403, 'Serwer zakłada administrator');
  if (t.adminOnly && !isAdmin) throw httpErr(403, 'Ten typ serwera może utworzyć tylko administrator');
  name = String(name || '').trim();
  if (name.length < 2 || name.length > 40) throw httpErr(400, 'Nazwa serwera: 2–40 znaków');
  const s = {
    id: crypto.randomBytes(5).toString('hex'),
    name, template, ownerId: user.id,
    settings: {}, autostart: false, created: Date.now(), installed: false,
    runtime: t.hosted && runtime.available() ? 'systemd' : 'tmux'
  };
  for (const f of t.settings) {
    const v = settings ? settings[f.key] : undefined;
    s.settings[f.key] = v != null ? v : f.def;
  }
  if (template === 'valheim') {
    const port = +s.settings.port || 2456;
    if (s.runtime === 'systemd' && (!settings || settings.port == null || port === 2456)) s.settings.port = String(allocPort());
    else checkPortFree(s.id, port);
    if (!valheim.validWorld(s.settings.world)) throw httpErr(400, 'Nazwa świata: 1–30 liter, cyfr, spacji, _ lub -');
    for (const k of ['crossplay', 'public']) s.settings[k] = s.settings[k] === true || s.settings[k] === 'true';
  }
  if (isAdmin) applyAdminFields(s, { plan, addons, paidUntil });
  servers.set(s.id, s);
  fs.mkdirSync(serverDir(s.id), { recursive: true });
  persist();
  return pub(s, user);
}

function applyAdminFields(s, { plan, addons, paidUntil, note }) {
  if (plan !== undefined) {
    if (plan && !plansLib.plans(cfg)[plan]) throw httpErr(400, 'Nieznany pakiet');
    s.plan = plan || null;
  }
  if (addons !== undefined) {
    const known = plansLib.addons(cfg);
    const list = (Array.isArray(addons) ? addons : []).map(String);
    if (list.some((a) => !known[a])) throw httpErr(400, 'Nieznana opcja dodatkowa');
    s.addons = [...new Set(list)];
  }
  if (paidUntil !== undefined) {
    if (paidUntil === null || paidUntil === '') s.paidUntil = null;
    else if (Number.isFinite(+paidUntil) && +paidUntil > 0) s.paidUntil = +paidUntil;
    else throw httpErr(400, 'Nieprawidłowa data ważności');
  }
  if (note !== undefined) s.note = String(note).slice(0, 500);
}

// Admin: plan, add-ons, validity. Limits apply from the next start.
function adminSet(id, patch) {
  const s = servers.get(id);
  if (!s) throw httpErr(404, 'Nie ma takiego serwera');
  applyAdminFields(s, patch || {});
  persist();
  return pub(s);
}

function updateSettings(id, settings, who = {}) {
  const s = servers.get(id);
  if (!s) throw httpErr(404, 'Nie ma takiego serwera');
  const t = TEMPLATES[s.template];
  const byAdmin = who.admin !== false;
  const lim = limitsOf(s);
  if (!byAdmin && t.adminOnly) throw httpErr(403, 'Ten serwer może zmieniać tylko administrator');
  const allowed = (key) => byAdmin || (t.clientKeys ? t.clientKeys.includes(key) : who.role !== 'client');
  const next = Object.assign({}, s.settings);
  for (const f of t.settings) {
    if (settings[f.key] === undefined) continue;
    if (!allowed(f.key)) throw httpErr(403, `Ustawienia „${f.label}” zmienia tylko administrator`);
    next[f.key] = settings[f.key];
  }
  if (s.template === 'valheim') {
    for (const k of ['crossplay', 'public']) next[k] = next[k] === true || next[k] === 'true';
    if (!byAdmin && next.crossplay && !lim.crossplay) throw httpErr(403, 'Crossplay nie wchodzi w Twój pakiet');
    const name = String(next.serverName || '').trim();
    if (!name || name.length > 50 || /[\r\n\0]/.test(name)) throw httpErr(400, 'Nazwa serwera: 1–50 znaków');
    next.serverName = name;
    if (!valheim.validWorld(next.world)) throw httpErr(400, 'Nazwa świata: 1–30 liter, cyfr, spacji, _ lub -');
    try { valheim.checkPassword(next.password, next.world, next.public); } catch (e) { throw httpErr(400, e.message); }
    const port = +next.port;
    if (!Number.isInteger(port) || port < 1024 || port > 65000) throw httpErr(400, 'Port musi być z zakresu 1024–65000');
    if (byAdmin) checkPortFree(id, port);
    next.port = String(port);
  }
  s.settings = next;
  if (settings.name && String(settings.name).trim().length >= 2 && String(settings.name).trim().length <= 40) s.name = String(settings.name).trim();
  if (settings.autostart !== undefined) s.autostart = !!settings.autostart;
  if (byAdmin) applyAdminFields(s, { plan: settings.plan, addons: settings.addons, paidUntil: settings.paidUntil, note: settings.note });
  persist();
  writeAutostart(s).catch(() => {});
  return pub(s, who.user);
}

// ---------- install ----------
async function install(id) {
  const s = servers.get(id);
  if (!s) throw httpErr(404, 'Nie ma takiego serwera');
  const t = TEMPLATES[s.template];
  const dir = serverDir(id);
  fs.mkdirSync(dir, { recursive: true });
  if (isSystemd(s)) await runtime.ensureUser(id, dir);

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
      ...(isSystemd(s) ? [`chown -R ${runtime.userName(id)}:${runtime.userName(id)} ${shq(dir)}`] : []),
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
  if (st.exists && !st.running && st.exitCode === 0) { s.installed = true; s.owned = isSystemd(s); persist(); }
}

// ---------- run ----------
async function isRunning(id) {
  const s = servers.get(id);
  return isSystemd(s) ? runtime.isActive(id) : tmuxRunning(id);
}

function checkMayRun(s, opts = {}) {
  if (opts.admin) return;
  if (plansLib.paidState(s).state === 'expired') throw httpErr(402, 'Usługa wygasła. Skontaktuj się z administratorem, aby ją przedłużyć.');
}

async function startSystemd(s) {
  const t = TEMPLATES[s.template];
  const dir = serverDir(s.id);
  if (s.template === 'valheim') {
    try { valheim.checkPassword(s.settings.password, s.settings.world, s.settings.public === true || s.settings.public === 'true'); } catch (e) { throw httpErr(400, e.message); }
    if (!fs.existsSync(path.join(dir, 'valheim_server.x86_64'))) throw httpErr(409, 'Pliki serwera nie są jeszcze zainstalowane');
  }
  await runtime.ensureUser(s.id, dir);
  if (!s.owned) { await runtime.chownDir(s.id, dir); s.owned = true; persist(); }
  const built = t.build(s);
  await runtime.install(s, { runDir: runDir(), dir, env: built.env, startCmd: built.startCmd, limits: limitsOf(s) });
  await runtime.start(s.id);
}

async function _start(id, opts) {
  const s = servers.get(id);
  if (!s) throw httpErr(404, 'Nie ma takiego serwera');
  if (await isRunning(id)) return { running: true };
  if (jobStatus(id).running) throw httpErr(409, 'Trwa instalacja tego serwera');
  checkMayRun(s, opts);
  if (isSystemd(s)) {
    await startSystemd(s);
    s.lastStart = Date.now();
    persist();
    notify(s, `▶️ Serwer „${s.settings.serverName || s.name}” uruchomiony`);
    return { running: true };
  }
  const t = TEMPLATES[s.template];
  const dir = serverDir(id);
  const built = t.build(s);
  const env = Object.entries(built.env || {}).map(([k, v]) => `export ${k}=${shq(String(v))};`).join(' ');
  // The command runs inside a tmux session named wpg_<id>. A trailing shell keeps the
  // pane open after the game exits, so the last log lines stay visible.
  const inner = `cd ${shq(dir)}; ${env} ${built.startCmd}; echo; echo '[Serwer zatrzymany. Naciśnij Enter, aby zamknąć konsolę]'; read _`;
  await sh(`tmux new-session -d -s ${shq(session(id))} -x 220 -y 50 ${shq('/bin/bash -lc ' + shq(inner))}`, { timeout: 15000 });
  // Cosmetic: hide tmux's own status bar and keep more scrollback for the console view.
  await sh(`tmux set-option -t ${shq(session(id))} status off \; set-option -t ${shq(session(id))} history-limit 20000`).catch(() => {});
  s.lastStart = Date.now();
  persist();
  return { running: true };
}

async function _stop(id) {
  const s = servers.get(id);
  if (!s) throw httpErr(404, 'Nie ma takiego serwera');
  if (isSystemd(s)) {
    if (!(await runtime.isActive(id))) return { running: false };
    await runtime.stop(id);          // SIGINT, waits up to 5 minutes for the world to be saved
    onlineCache.delete(id);
    notify(s, `⏹️ Serwer „${s.settings.serverName || s.name}” zatrzymany`);
    return { running: false };
  }
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

const start = (id, opts = {}) => exclusive(id, 'uruchamianie', () => { if (!opts.admin) gate(id, 'power', 10); return _start(id, opts); });
const stop = (id, opts = {}) => exclusive(id, 'zatrzymywanie', () => { if (!opts.admin) gate(id, 'power', 10); return _stop(id); });
const restart = (id, opts = {}) => exclusive(id, 'restart', async () => {
  if (!opts.admin) gate(id, 'restart', 60);
  await _stop(id);
  return _start(id, opts);
});

async function status(id) {
  const s = servers.get(id);
  if (!s) return null;
  refreshInstalled(id);
  const job = jobStatus(id);
  let dirSize = null;
  try { dirSize = Number((await sh(`du -sb ${shq(serverDir(id))} 2>/dev/null | cut -f1`)).trim()) || 0; } catch { /* ignore */ }
  return {
    id, running: await isRunning(id), installed: s.installed, runtime: s.runtime || 'tmux',
    installing: job.running, job: { running: job.running, exitCode: job.exitCode },
    busy: busy.get(id) || null,
    size: dirSize, ports: safe(() => TEMPLATES[s.template].ports(s), []),
    paid: plansLib.paidState(s)
  };
}

async function consoleTail(id, lines = 200) {
  const s = servers.get(id);
  if (isSystemd(s)) {
    const out = await runtime.logs(id, Math.min(2000, lines));
    return out || '(brak logów – serwer jeszcze nie był uruchomiony)';
  }
  if (!(await tmuxRunning(id))) return '(serwer nie jest uruchomiony)';
  try { return await sh(`tmux capture-pane -p -t ${shq(session(id))} -S -${Math.min(2000, lines)}`); } catch { return ''; }
}

async function sendCommand(id, cmd) {
  const s = servers.get(id);
  if (isSystemd(s)) throw httpErr(400, 'Serwery Valheim nie mają konsoli komend. Zarządzaj nimi przyciskami i listami graczy.');
  if (!(await tmuxRunning(id))) throw httpErr(409, 'Serwer nie jest uruchomiony');
  await sh(`tmux send-keys -t ${shq(session(id))} -- ${shq(String(cmd))} Enter`);
}

// ---------- who is online (Valheim) ----------
const onlineCache = new Map();
async function online(id) {
  const s = servers.get(id);
  if (!s) throw httpErr(404, 'Nie ma takiego serwera');
  if (!isSystemd(s) || s.template !== 'valheim') return { supported: false, count: 0, ids: [] };
  const hit = onlineCache.get(id);
  if (hit && Date.now() - hit.t < 8000) return hit.v;
  let v = { supported: true, running: false, count: 0, ids: [] };
  if (await runtime.isActive(id)) {
    const u = await runtime.usage(id);
    const text = await runtime.logsSince(id, u.since && u.since !== 'n/a' ? u.since : null);
    v = Object.assign({ supported: true, running: true }, valheim.parseOnline(text));
  }
  onlineCache.set(id, { t: Date.now(), v });
  return v;
}
async function usage(id) {
  const s = servers.get(id);
  if (!s) throw httpErr(404, 'Nie ma takiego serwera');
  const lim = limitsOf(s);
  let u = { active: false };
  if (isSystemd(s)) u = await runtime.usage(id);
  let dirSize = null;
  try { dirSize = Number((await sh(`du -sb ${shq(serverDir(id))} 2>/dev/null | cut -f1`)).trim()) || 0; } catch { /* ignore */ }
  return Object.assign(u, { memoryLimitBytes: lim.memoryMb ? lim.memoryMb * 1048576 : null, cpuQuota: lim.cpuQuota, diskBytes: dirSize });
}

// ---------- player lists ----------
function homeOf(s) {
  if (s.template !== 'valheim') throw httpErr(400, 'Listy graczy są dostępne tylko dla serwerów Valheim');
  return serverDir(s.id);
}
function players(id) {
  const s = servers.get(id);
  if (!s) throw httpErr(404, 'Nie ma takiego serwera');
  const home = homeOf(s);
  return { permitted: valheim.readList(home, 'permitted'), admin: valheim.readList(home, 'admin'), banned: valheim.readList(home, 'banned') };
}
function setPlayers(id, kind, ids) {
  const s = servers.get(id);
  if (!s) throw httpErr(404, 'Nie ma takiego serwera');
  const home = homeOf(s);
  if (!Array.isArray(ids)) throw httpErr(400, 'Oczekiwano listy identyfikatorów');
  let out;
  try { out = valheim.writeList(home, kind, ids); } catch (e) { throw e.status ? e : httpErr(400, e.message); }
  if (isSystemd(s)) {
    const file = path.join(valheim.saveDir(home), valheim.LISTS[kind]);
    try { fs.chownSync(file, +execFileSync('id', ['-u', runtime.userName(id)]).toString().trim(), +execFileSync('id', ['-g', runtime.userName(id)]).toString().trim()); } catch { /* user not created yet */ }
  }
  return out;
}

// ---------- backups ----------
function backupDir(id) { return path.join(serverDir(id), 'wp-backups'); }
const BACKUP_RE = /^kopia-[\d-]+\.tar\.gz$/;
async function backup(id, { rotate = true } = {}) {
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
  if (rotate) rotateBackups(id);
  return listBackups(id);
}
// Keep only as many copies as the plan allows (oldest go first).
function rotateBackups(id) {
  const s = servers.get(id);
  const max = s ? limitsOf(s).backups : null;
  if (!max) return;
  const all = listBackups(id);
  for (const b of all.slice(max)) { try { fs.unlinkSync(path.join(backupDir(id), b.name)); } catch { /* gone */ } }
}
function listBackups(id) {
  const bdir = backupDir(id);
  let files = [];
  try { files = fs.readdirSync(bdir).filter((f) => BACKUP_RE.test(f)); } catch { return []; }
  return files.map((f) => { const st = fs.statSync(path.join(bdir, f)); return { name: f, size: st.size, mtime: st.mtimeMs }; })
    .sort((a, b) => b.mtime - a.mtime);
}
function deleteBackup(id, name) {
  if (!BACKUP_RE.test(name)) throw httpErr(400, 'Nieprawidłowa nazwa kopii');
  try { fs.unlinkSync(path.join(backupDir(id), name)); } catch { /* gone */ }
}

async function restoreBackup(id, name, opts = {}) {
  const s = servers.get(id);
  if (!s) throw httpErr(404, 'Nie ma takiego serwera');
  if (!BACKUP_RE.test(String(name))) throw httpErr(400, 'Nieprawidłowa nazwa kopii');
  const file = path.join(backupDir(id), name);
  if (!fs.existsSync(file)) throw httpErr(404, 'Nie ma takiej kopii');
  return exclusive(id, 'przywracanie kopii', async () => {
    if (!opts.admin) gate(id, 'restart', 60);
    const t = TEMPLATES[s.template];
    const dir = serverDir(id);
    const wasRunning = await isRunning(id);
    if (wasRunning) await _stop(id);
    // Safety copy of the current state first, then replace the saved data with the chosen copy.
    try { await backup(id, { rotate: false }); } catch { /* nothing to save yet */ }
    for (const p of (t.save || [])) {
      const target = path.join(dir, p);
      if (target.startsWith(dir + path.sep) && fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    }
    await sh(`tar -xzf ${shq(file)} -C ${shq(dir)} --no-same-owner`, { timeout: 300000 });
    if (isSystemd(s)) await runtime.chownDir(id, dir).catch(() => {});
    rotateBackups(id);
    if (wasRunning) await _start(id, opts);
    return { ok: true, restarted: wasRunning };
  });
}

// ---------- world reset (Valheim) ----------
// mode 'wipe': back up, delete the current world, the server creates a fresh one (new seed) under the same name.
// mode 'keep': back up, switch to a new world name and keep the old world files (needs the "drugi świat" add-on).
async function resetWorld(id, { mode, newWorld } = {}, opts = {}) {
  const s = servers.get(id);
  if (!s) throw httpErr(404, 'Nie ma takiego serwera');
  if (s.template !== 'valheim') throw httpErr(400, 'Reset świata działa tylko dla serwerów Valheim');
  const lim = limitsOf(s);
  mode = mode === 'keep' ? 'keep' : 'wipe';
  if (mode === 'keep') {
    if (!opts.admin && !lim.world2) throw httpErr(403, 'Zachowanie starego świata wymaga opcji „Drugi świat”');
    if (!valheim.validWorld(newWorld)) throw httpErr(400, 'Nazwa nowego świata: 1–30 liter, cyfr, spacji, _ lub -');
    if (String(newWorld).toLowerCase() === String(s.settings.world).toLowerCase()) throw httpErr(400, 'Nowy świat musi mieć inną nazwę');
    try { valheim.checkPassword(s.settings.password, newWorld, s.settings.public); } catch (e) { throw httpErr(400, e.message); }
  }
  return exclusive(id, 'reset świata', async () => {
    if (!opts.admin) gate(id, 'restart', 60);
    const home = serverDir(id);
    const wasRunning = await isRunning(id);
    if (wasRunning) await _stop(id);
    let backedUp = true;
    try { await backup(id); } catch { backedUp = false; }
    const old = s.settings.world;
    let removed = [];
    if (mode === 'wipe') removed = valheim.deleteWorld(home, old);
    else { s.settings.world = String(newWorld); persist(); }
    notify(s, `🌍 Świat „${old}” został ${mode === 'wipe' ? 'zresetowany' : 'zastąpiony nowym: ' + newWorld}`);
    if (wasRunning) await _start(id, opts);
    return { ok: true, mode, world: s.settings.world, removed: removed.length, backedUp, restarted: wasRunning };
  });
}

// ---------- plan, schedule, Discord ----------
function setSchedule(id, { restartAt, backupEveryH }, opts = {}) {
  const s = servers.get(id);
  if (!s) throw httpErr(404, 'Nie ma takiego serwera');
  const lim = limitsOf(s);
  const next = Object.assign({ restartAt: null, backupEveryH: 0 }, s.schedule || {});
  if (restartAt !== undefined) {
    if (restartAt && !opts.admin && !lim.schedule) throw httpErr(403, 'Harmonogram restartów nie wchodzi w Twój pakiet');
    if (restartAt && !/^([01]\d|2[0-3]):[0-5]\d$/.test(restartAt)) throw httpErr(400, 'Godzina w formacie GG:MM');
    next.restartAt = restartAt || null;
  }
  if (backupEveryH !== undefined) {
    const h = Number(backupEveryH) || 0;
    if (h && !opts.admin && !lim.autoBackup) throw httpErr(403, 'Automatyczne kopie nie wchodzą w Twój pakiet');
    if (![0, 1, 2, 3, 4, 6, 8, 12, 24, 48, 72, 168].includes(h)) throw httpErr(400, 'Dozwolone interwały: 1, 2, 3, 4, 6, 8, 12, 24, 48, 72, 168 godzin');
    next.backupEveryH = h;
  }
  s.schedule = next;
  persist();
  return next;
}
const WEBHOOK_RE = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;
function setDiscord(id, url, opts = {}) {
  const s = servers.get(id);
  if (!s) throw httpErr(404, 'Nie ma takiego serwera');
  if (!opts.admin && !limitsOf(s).discord) throw httpErr(403, 'Powiadomienia Discord to opcja dodatkowa');
  url = String(url || '').trim();
  if (url && !WEBHOOK_RE.test(url)) throw httpErr(400, 'To nie wygląda na adres webhooka Discorda (https://discord.com/api/webhooks/…)');
  s.discordWebhook = url || null;
  persist();
  return { discordSet: !!s.discordWebhook };
}
function notify(s, text) {
  if (!s || !s.discordWebhook || !WEBHOOK_RE.test(s.discordWebhook) || !limitsOf(s).discord) return;
  fetch(s.discordWebhook, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: String(text).slice(0, 1800), allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(8000)
  }).catch(() => {});
}

// ---------- scheduler: restarts, auto backups, expiry, Discord join/leave ----------
const tzNow = () => {
  const tz = (cfg && cfg.timezone) || 'Europe/Warsaw';
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t).value;
  return { day: `${g('year')}-${g('month')}-${g('day')}`, hm: `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}` };
};
const joinState = new Map();
async function schedulerTick() {
  const now = Date.now();
  const local = tzNow();
  for (const s of [...servers.values()]) {
    try {
      if (!isSystemd(s) || busy.has(s.id)) continue;
      const running = await runtime.isActive(s.id);
      s.sched = s.sched || {};
      // 1. expired service: stop after the grace period.
      if (running && plansLib.paidState(s, now).state === 'expired') {
        notify(s, '⛔ Usługa wygasła – serwer zatrzymany');
        await exclusive(s.id, 'wygaśnięcie usługi', () => _stop(s.id));
        continue;
      }
      // 2. automatic backups.
      const every = (s.schedule && s.schedule.backupEveryH) || 0;
      if (every && now - (s.sched.lastBackup || 0) >= every * 3600e3) {
        s.sched.lastBackup = now;
        persist();
        try { await exclusive(s.id, 'kopia automatyczna', () => backup(s.id)); } catch { /* no data yet */ }
      }
      // 3. daily restart, only when nobody is online (postponed up to 60 minutes).
      const at = s.schedule && s.schedule.restartAt;
      if (at && running && s.sched.lastRestartDay !== local.day && local.hm >= at) {
        s.sched.pendingSince = s.sched.pendingSince || now;
        const o = await online(s.id);
        if (o.count === 0) {
          s.sched.lastRestartDay = local.day; s.sched.pendingSince = null; persist();
          await exclusive(s.id, 'restart z harmonogramu', async () => { await _stop(s.id); await _start(s.id, { admin: true }); });
        } else if (now - s.sched.pendingSince > 3600e3) {
          s.sched.lastRestartDay = local.day; s.sched.pendingSince = null; persist(); // skip today
        }
      }
      // 4. Discord: who joined / left.
      if (running && s.discordWebhook && limitsOf(s).discord) {
        const o = await online(s.id);
        const prev = joinState.get(s.id);
        if (prev) {
          for (const id of o.ids) if (!prev.includes(id)) notify(s, `🟢 Gracz ${id} dołączył`);
          for (const id of prev) if (!o.ids.includes(id)) notify(s, `🔴 Gracz ${id} wyszedł`);
        }
        joinState.set(s.id, o.ids);
      } else joinState.delete(s.id);
    } catch (err) { console.error('[games] scheduler:', s.id, err.message); }
  }
}
let schedTimer = null;
function startScheduler() {
  if (schedTimer) return;
  schedTimer = setInterval(() => { schedulerTick().catch(() => {}); }, 30000);
  schedTimer.unref();
}

// ---------- move a legacy tmux server to the systemd runtime ----------
async function migrate(id) {
  const s = servers.get(id);
  if (!s) throw httpErr(404, 'Nie ma takiego serwera');
  if (isSystemd(s)) throw httpErr(400, 'Ten serwer już działa w trybie systemd');
  if (!runtime.available()) throw httpErr(400, 'Ten host nie obsługuje trybu systemd (wymagany root i systemd)');
  if (!TEMPLATES[s.template].hosted) throw httpErr(400, 'Tryb systemd jest dostępny tylko dla Valheima');
  return exclusive(id, 'migracja', async () => {
    const wasRunning = await tmuxRunning(id);
    if (wasRunning) await _stop(id);
    await removeAutostart(s).catch(() => {});
    s.runtime = 'systemd';
    s.owned = false;
    persist();
    await runtime.ensureUser(id, serverDir(id));
    if (s.autostart) await writeAutostart(s);
    if (wasRunning) await _start(id, { admin: true });
    return pub(s);
  });
}

// ---------- delete ----------
async function remove(id, deleteFiles) {
  const s = servers.get(id);
  if (!s) return;
  try { await exclusive(id, 'usuwanie', () => _stop(id)); } catch { /* ignore */ }
  await removeAutostart(s).catch(() => {});
  if (isSystemd(s)) await runtime.remove(id, runDir()).catch(() => {});
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
  if (isSystemd(s)) {
    // Its own unit exists once the server was started at least once; enabling needs the unit file.
    if (s.autostart && fs.existsSync(`/etc/systemd/system/${runtime.unitName(s.id)}`)) await runtime.enable(s.id).catch(() => {});
    else if (!s.autostart) await runtime.disable(s.id);
    return;
  }
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
// tmux servers: attach to the tmux session (interactive). systemd servers: read-only journal stream.
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
    // Customers use the log view of the "Mój serwer" app; they never get an interactive terminal.
    if (!s || !user || user.role === 'client' || !users.canUseGame(user, id, s.ownerId)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => (isSystemd(s) ? streamJournal(ws, id) : runConsole(ws, id)));
  });

  function streamJournal(ws, id) {
    const child = spawn('journalctl', ['-u', runtime.unitName(id), '-n', '200', '-f', '-o', 'cat', '--no-pager'], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', (d) => { if (ws.readyState === ws.OPEN) ws.send(d.toString('utf8')); });
    child.on('close', () => { if (ws.readyState === ws.OPEN) ws.close(); });
    ws.on('close', () => { try { child.kill(); } catch { /* gone */ } });
  }

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
  visibleTo, get, pub, create, updateSettings, adminSet, install, jobStatus,
  start, stop, restart, status, consoleTail, sendCommand,
  backup, listBackups, deleteBackup, restoreBackup, backupDir, remove,
  resetWorld, players, setPlayers, online, usage, setSchedule, setDiscord, migrate,
  startScheduler, schedulerTick,
  serverDir, gamesRoot, session, tmuxRunning, attachConsole, limitsOf
};
