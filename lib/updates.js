'use strict';
/* Updates from inside the running app:
   - WebPulpit itself (git pull in the source checkout + install.sh),
   - Ubuntu packages (apt),
   - server reboot.
   Long jobs run in their own transient systemd unit (systemd-run), so they survive
   the restart of the webpulpit service that the app update performs. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const APP_DIR = path.join(__dirname, '..');
const LOG_DIR = '/var/tmp';
const EXIT_MARK = '__WEBPULPIT_EXIT__:';

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, timeout: 120000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.message = (stderr || err.message || '').trim();
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

const isRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const logPath = (name) => path.join(LOG_DIR, `webpulpit-${name}.log`);

// ---------- background jobs ----------
function jobStatus(name) {
  const file = logPath(name);
  let text = '';
  let mtime = 0;
  try {
    text = fs.readFileSync(file, 'utf8');
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return { name, exists: false, running: false };
  }
  const m = text.match(new RegExp(EXIT_MARK + '(\\d+)'));
  // A job without an exit marker that has not written anything for 2 hours is considered dead.
  const running = !m && Date.now() - mtime < 2 * 3600 * 1000;
  return {
    name,
    exists: true,
    running,
    exitCode: m ? Number(m[1]) : null,
    finishedAt: m ? mtime : null,
    log: text.replace(new RegExp(EXIT_MARK + '\\d+\\s*$'), '').slice(-30000)
  };
}

async function startJob(name, script, env = {}) {
  const st = jobStatus(name);
  if (st.running) throw httpError(409, 'To zadanie już trwa');
  const file = logPath(name);
  fs.writeFileSync(file, `[${new Date().toLocaleString('pl-PL')}] Start\n`, { mode: 0o600 });
  // A subshell, so that an "exit" inside the script still lets us write the exit marker.
  const wrapped = `( ${script} ) >> ${shq(file)} 2>&1; echo "${EXIT_MARK}$?" >> ${shq(file)}`;
  const envArgs = Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`);
  if (fs.existsSync('/run/systemd/system')) {
    try {
      await run('systemd-run', ['--unit', `webpulpit-${name}-${Date.now()}`, '--collect', '--quiet', ...envArgs, '/bin/bash', '-c', wrapped]);
      return jobStatus(name);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        fs.appendFileSync(file, `systemd-run: ${err.message}\n${EXIT_MARK}1\n`);
        throw httpError(500, 'Nie udało się uruchomić zadania: ' + err.message);
      }
    }
  }
  // No systemd: run detached (will not survive a restart of the panel itself).
  const child = spawn('/bin/bash', ['-c', wrapped], { detached: true, stdio: 'ignore', env: { ...process.env, ...env } });
  child.unref();
  return jobStatus(name);
}

// ---------- WebPulpit version / self update ----------
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function git(dir, args) {
  return run('git', ['-c', 'safe.directory=*', '-C', dir, ...args], { timeout: 90000 }).then((s) => s.trim());
}

function versionInfo() {
  const pkg = readJson(path.join(APP_DIR, 'package.json')) || {};
  const v = readJson(path.join(APP_DIR, 'version.json')) || {};
  return { version: pkg.version || '?', commit: v.commit || null, date: v.date || null, branch: v.branch || null };
}

function sourceDir(cfg) {
  if (cfg.sourceDir && fs.existsSync(path.join(cfg.sourceDir, '.git'))) return cfg.sourceDir;
  if (fs.existsSync(path.join(APP_DIR, '.git'))) return APP_DIR; // running straight from a clone
  return null;
}

async function checkApp(cfg) {
  const current = versionInfo();
  const src = sourceDir(cfg);
  if (!src) {
    return { current, supported: false, reason: 'Nie znam folderu z kodem (git clone). Zainstaluj ponownie najnowszym install.sh z folderu repozytorium.' };
  }
  try {
    await git(src, ['fetch', '--quiet']);
  } catch (err) {
    throw httpError(502, 'Nie udało się połączyć z GitHubem: ' + err.message);
  }
  let upstream;
  try {
    upstream = await git(src, ['rev-parse', '@{u}']);
  } catch {
    throw httpError(500, 'Gałąź w ' + src + ' nie śledzi zdalnej gałęzi (git branch -u origin/<gałąź>)');
  }
  const base = current.commit || await git(src, ['rev-parse', 'HEAD']);
  let commits = [];
  try {
    const log = await git(src, ['log', '--format=%h%x09%cI%x09%s', `${base}..${upstream}`]);
    commits = log ? log.split('\n').map((l) => { const [hash, date, subject] = l.split('\t'); return { hash, date, subject }; }) : [];
  } catch {
    // The installed commit is unknown to this checkout (e.g. history rewritten): compare heads.
    commits = base === upstream ? [] : [{ hash: upstream.slice(0, 7), date: '', subject: 'Nowa wersja' }];
  }
  return {
    current: { ...current, commit: current.commit || base },
    latest: upstream,
    sourceDir: src,
    supported: true,
    canInstall: isRoot(),
    available: commits.length > 0,
    commits: commits.slice(0, 50)
  };
}

async function updateApp(cfg) {
  if (!isRoot()) throw httpError(403, 'Aktualizacja z panelu wymaga, aby panel działał jako root. Na serwerze uruchom: cd <folder> && git pull && sudo bash install.sh');
  const src = sourceDir(cfg);
  if (!src) throw httpError(400, 'Nie znam folderu z kodem – zainstaluj ponownie najnowszym install.sh');
  const script = [
    `cd ${shq(src)}`,
    'echo "==> Pobieranie zmian z GitHuba"',
    'git -c safe.directory=* pull --ff-only',
    'echo "==> Instalacja"',
    'WP_FROM_PANEL=1 bash install.sh'
  ].join(' && ');
  return startJob('app', script);
}

// ---------- Ubuntu packages ----------
async function checkSystem() {
  const out = { canInstall: isRoot(), refreshed: false, warnings: [] };
  if (isRoot()) {
    try {
      await run('apt-get', ['update', '-q'], { timeout: 300000 });
      out.refreshed = true;
    } catch (err) {
      // Broken third-party repositories only produce warnings - the list still works.
      out.refreshed = true;
      out.warnings = err.message.split('\n').filter((l) => /^(E|W):/.test(l)).slice(0, 5);
    }
  }
  let list = '';
  try { list = await run('apt', ['list', '--upgradable'], { env: { ...process.env, LANG: 'C' } }); } catch (err) {
    if (err.code === 'ENOENT') throw httpError(501, 'Ten system nie używa apt');
    throw httpError(500, err.message);
  }
  out.packages = list.split('\n').map((l) => l.match(/^([^/\s]+)\/(\S+)\s+(\S+)\s+(\S+)\s+\[upgradable from: ([^\]]+)\]/)).filter(Boolean).map((m) => ({
    name: m[1], suite: m[2], version: m[3], arch: m[4], from: m[5], security: /-security/.test(m[2])
  }));
  out.rebootRequired = fs.existsSync('/var/run/reboot-required');
  out.rebootPackages = (fs.existsSync('/var/run/reboot-required.pkgs') ? fs.readFileSync('/var/run/reboot-required.pkgs', 'utf8') : '').split('\n').filter(Boolean);
  return out;
}

async function upgradeSystem() {
  if (!isRoot()) throw httpError(403, 'Aktualizacja systemu wymaga, aby panel działał jako root');
  const script = [
    'echo "==> apt-get update"',
    'apt-get update -q || true',
    'echo "==> apt-get upgrade"',
    'apt-get -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade',
    'echo "==> Sprzątanie"',
    'apt-get -y -q autoremove'
  ].join(' && ');
  return startJob('system', script, { DEBIAN_FRONTEND: 'noninteractive', NEEDRESTART_MODE: 'l' });
}

async function reboot() {
  if (!isRoot()) throw httpError(403, 'Ponowne uruchomienie wymaga, aby panel działał jako root');
  setTimeout(() => {
    execFile('systemctl', ['reboot'], (err) => {
      if (err) execFile('shutdown', ['-r', 'now'], () => {});
    });
  }, 1500);
}

module.exports = { versionInfo, checkApp, updateApp, checkSystem, upgradeSystem, reboot, jobStatus, isRoot, hostname: os.hostname };
