'use strict';
/* systemd runtime for hosted game servers.
   Every server gets its own unit (wpsrv-<id>.service) and its own unprivileged Linux user
   (wpg-<id>), so a customer's server cannot touch other servers, the panel or the system.
   Valheim saves the world on SIGINT, so the unit stops it with SIGINT and waits up to 5 minutes.
   Logs go to the journal. Resource limits come from the customer's plan. */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const unitName = (id) => `wpsrv-${id}.service`;
const userName = (id) => `wpg-${id}`;
const unitPath = (id) => `/etc/systemd/system/${unitName(id)}`;
const ID_RE = /^[a-f0-9]{10}$/;

function sh(command, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile('/bin/bash', ['-c', command], { maxBuffer: 8 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; return reject(err); }
      resolve(String(stdout));
    });
  });
}

const available = () => typeof process.getuid === 'function' && process.getuid() === 0 && fs.existsSync('/run/systemd/system');
function checkId(id) { if (!ID_RE.test(String(id))) throw new Error('Nieprawidłowy identyfikator serwera'); }

async function ensureUser(id, dir) {
  checkId(id);
  try { await sh(`id -u ${userName(id)}`); return; } catch { /* create below */ }
  fs.mkdirSync(dir, { recursive: true });
  await sh(`useradd --system --no-create-home --home-dir ${shq(dir)} --shell /usr/sbin/nologin ${userName(id)}`);
}
async function chownDir(id, dir) {
  checkId(id);
  await sh(`chown -R ${userName(id)}:${userName(id)} ${shq(dir)}`, 600000);
}

// The launcher lives outside the server's own folder, so the server user cannot edit it.
function launcherPath(runDir, id) { return path.join(runDir, `${id}.sh`); }

function writeLauncher(runDir, id, dir, env, startCmd) {
  fs.mkdirSync(runDir, { recursive: true, mode: 0o755 });
  const exports = Object.entries(env || {}).map(([k, v]) => `export ${k}=${shq(String(v))}`).join('\n');
  const body = `#!/bin/bash\ncd ${shq(dir)} || exit 1\n${exports}\nexec ${startCmd}\n`;
  const file = launcherPath(runDir, id);
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

function unitText(s, launcher, dir, limits) {
  const id = s.id;
  const lines = [
    '[Unit]',
    `Description=WebPulpit serwer gry: ${String(s.name).replace(/[\r\n%]/g, ' ')}`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `User=${userName(id)}`,
    `Group=${userName(id)}`,
    `WorkingDirectory=${dir}`,
    `ExecStart=/bin/bash ${launcher}`,
    // Valheim writes the world on SIGINT - never SIGKILL it first.
    'KillSignal=SIGINT',
    'TimeoutStopSec=300',
    'SuccessExitStatus=130 143 2',
    'Restart=on-failure',
    'RestartSec=15',
    'LimitNOFILE=100000',
    `SyslogIdentifier=${unitName(id).replace(/\.service$/, '')}`,
    // Do not compete with the main server for CPU, and die first on memory pressure.
    'Nice=5',
    'CPUWeight=100',
    'OOMScoreAdjust=500',
    'CPUAccounting=yes',
    'MemoryAccounting=yes',
    'NoNewPrivileges=yes',
    'PrivateTmp=yes',
    'ProtectHome=yes',
    'ProtectSystem=full'
  ];
  if (limits && limits.memoryMb) {
    lines.push(`MemoryMax=${Math.round(limits.memoryMb)}M`, `MemoryHigh=${Math.round(limits.memoryMb * 0.9)}M`);
  }
  if (limits && limits.cpuQuota) lines.push(`CPUQuota=${Math.round(limits.cpuQuota)}%`);
  lines.push('', '[Install]', 'WantedBy=multi-user.target', '');
  return lines.join('\n');
}

// Writes launcher + unit; reloads systemd only when the unit text changed.
async function install(s, { runDir, dir, env, startCmd, limits }) {
  checkId(s.id);
  const launcher = writeLauncher(runDir, s.id, dir, env, startCmd);
  const text = unitText(s, launcher, dir, limits);
  let old = '';
  try { old = fs.readFileSync(unitPath(s.id), 'utf8'); } catch { /* new */ }
  if (old !== text) {
    fs.writeFileSync(unitPath(s.id), text);
    await sh('systemctl daemon-reload');
  }
}

async function isActive(id) {
  checkId(id);
  try { return (await sh(`systemctl is-active ${unitName(id)}`)).trim() === 'active' || false; } catch (err) {
    return /^(activating|reloading)/.test(String(err.stdout || '').trim());
  }
}
const start = (id) => sh(`systemctl start ${unitName(id)}`, 60000);
const stop = (id) => sh(`systemctl stop ${unitName(id)}`, 330000);
const enable = (id) => sh(`systemctl enable ${unitName(id)} 2>&1`);
const disable = (id) => sh(`systemctl disable ${unitName(id)} 2>&1`).catch(() => {});

async function logs(id, lines = 200) {
  checkId(id);
  try { return await sh(`journalctl -u ${unitName(id)} -n ${Math.max(1, Math.min(5000, lines | 0))} --no-pager -o cat 2>&1`, 15000); } catch { return ''; }
}
async function logsSince(id, sinceIso) {
  checkId(id);
  const since = sinceIso ? `--since ${shq(sinceIso)}` : '';
  try { return await sh(`journalctl -u ${unitName(id)} ${since} --no-pager -o cat 2>&1 | tail -n 20000`, 20000); } catch { return ''; }
}

const lastCpu = new Map();
async function usage(id) {
  checkId(id);
  const out = await sh(`systemctl show ${unitName(id)} -p MemoryCurrent -p MemoryMax -p CPUUsageNSec -p ActiveEnterTimestamp -p ActiveEnterTimestampMonotonic -p NRestarts -p ActiveState`).catch(() => '');
  const kv = {};
  for (const line of out.split('\n')) { const i = line.indexOf('='); if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1); }
  const num = (v) => (v && /^\d+$/.test(v) ? Number(v) : null);
  const mem = num(kv.MemoryCurrent);
  const cpuNs = num(kv.CPUUsageNSec);
  let cpuPct = null;
  const now = Date.now();
  const prev = lastCpu.get(id);
  if (cpuNs != null) {
    if (prev && now - prev.t > 500 && cpuNs >= prev.ns) cpuPct = Math.round(((cpuNs - prev.ns) / 1e6) / (now - prev.t) * 1000) / 10;
    lastCpu.set(id, { t: now, ns: cpuNs });
  }
  return {
    active: kv.ActiveState === 'active', memoryBytes: mem, memoryMax: num(kv.MemoryMax),
    cpuPercent: cpuPct, since: kv.ActiveEnterTimestamp || null, restarts: num(kv.NRestarts)
  };
}

async function remove(id, runDir) {
  checkId(id);
  await sh(`systemctl disable ${unitName(id)} 2>/dev/null; rm -f ${shq(unitPath(id))}; systemctl daemon-reload`).catch(() => {});
  try { fs.unlinkSync(launcherPath(runDir, id)); } catch { /* gone */ }
  lastCpu.delete(id);
  await sh(`id -u ${userName(id)} >/dev/null 2>&1 && userdel ${userName(id)}`).catch(() => {});
}

module.exports = {
  available, unitName, userName, ensureUser, chownDir, install, isActive, start, stop, enable, disable,
  logs, logsSince, usage, remove, sh
};
