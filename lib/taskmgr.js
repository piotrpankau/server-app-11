'use strict';
/* Data for the Task Manager: performance counters, processes, services, users.
   Everything is read straight from /proc and /sys, rates are computed from the
   difference between two consecutive samples. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync, spawn } = require('child_process');

function read(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}
function num(p) {
  const v = parseInt(read(p), 10);
  return Number.isFinite(v) ? v : null;
}
function conf(name, def) {
  try { return Number(execFileSync('getconf', [name], { encoding: 'utf8' }).trim()) || def; } catch { return def; }
}
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, timeout: 30000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        err.stdout = stdout;
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

const CLK_TCK = conf('CLK_TCK', 100);
const PAGE = conf('PAGESIZE', 4096);
const BOOT_TIME = (() => {
  const m = read('/proc/stat').match(/^btime (\d+)/m);
  return m ? Number(m[1]) * 1000 : Date.now() - os.uptime() * 1000;
})();

// ---------- users (uid -> name) ----------
let userCache = { t: 0, map: new Map() };
function userName(uid) {
  if (Date.now() - userCache.t > 60000) {
    const map = new Map();
    for (const line of read('/etc/passwd').split('\n')) {
      const p = line.split(':');
      if (p.length > 2) map.set(Number(p[2]), p[0]);
    }
    userCache = { t: Date.now(), map };
  }
  return userCache.map.get(uid) || String(uid);
}

// ---------- CPU ----------
function cpuLines() {
  const out = {};
  for (const line of read('/proc/stat').split('\n')) {
    if (!line.startsWith('cpu')) continue;
    const parts = line.trim().split(/\s+/);
    const vals = parts.slice(1).map(Number);
    // guest time is already included in user time
    const total = vals.slice(0, 8).reduce((a, b) => a + b, 0);
    out[parts[0]] = { idle: vals[3] + (vals[4] || 0), total };
  }
  return out;
}

let cpuInfoCache = null;
function cpuInfo() {
  const text = read('/proc/cpuinfo');
  const blocks = text.split(/\n\s*\n/).filter((b) => b.trim());
  const field = (b, k) => { const m = b.match(new RegExp('^' + k + '\\s*:\\s*(.*)$', 'm')); return m ? m[1].trim() : ''; };
  const mhz = blocks.map((b) => parseFloat(field(b, 'cpu MHz'))).filter((v) => v > 0);
  if (!cpuInfoCache) {
    const sockets = new Set(blocks.map((b) => field(b, 'physical id')));
    const cores = new Set(blocks.map((b) => field(b, 'physical id') + ':' + field(b, 'core id')));
    const flags = field(blocks[0] || '', 'flags');
    const maxMhz = num('/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq');
    cpuInfoCache = {
      model: field(blocks[0] || '', 'model name') || (os.cpus()[0] || {}).model || 'Procesor',
      logical: blocks.length || os.cpus().length,
      cores: cores.size || blocks.length,
      sockets: sockets.size || 1,
      cache: field(blocks[0] || '', 'cache size'),
      baseMhz: maxMhz ? maxMhz / 1000 : null,
      virtual: /\bhypervisor\b/.test(flags),
      virtSupport: /\b(vmx|svm)\b/.test(flags)
    };
  }
  return { ...cpuInfoCache, mhz: mhz.length ? mhz.reduce((a, b) => a + b, 0) / mhz.length : null };
}

// ---------- memory ----------
function memInfo() {
  const m = {};
  for (const line of read('/proc/meminfo').split('\n')) {
    const r = line.match(/^(\w+):\s+(\d+)/);
    if (r) m[r[1]] = Number(r[2]) * 1024;
  }
  const total = m.MemTotal || os.totalmem();
  const available = m.MemAvailable ?? os.freemem();
  const cached = (m.Cached || 0) + (m.SReclaimable || 0) - (m.Shmem || 0);
  return {
    total,
    used: total - available,
    available,
    free: m.MemFree || 0,
    cached: Math.max(0, cached),
    buffers: m.Buffers || 0,
    shared: m.Shmem || 0,
    dirty: m.Dirty || 0,
    slab: m.Slab || 0,
    swapTotal: m.SwapTotal || 0,
    swapUsed: (m.SwapTotal || 0) - (m.SwapFree || 0),
    committed: m.Committed_AS || 0,
    commitLimit: m.CommitLimit || 0
  };
}

// ---------- disks ----------
const DISK_RE = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;
function diskStats() {
  const out = {};
  for (const line of read('/proc/diskstats').split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p.length < 14 || !DISK_RE.test(p[2])) continue;
    out[p[2]] = {
      readBytes: Number(p[5]) * 512,
      writeBytes: Number(p[9]) * 512,
      reads: Number(p[3]),
      writes: Number(p[7]),
      ioMs: Number(p[12])
    };
  }
  return out;
}

function mounts() {
  return new Promise((resolve) => {
    execFile('df', ['-kP'], (err, stdout) => {
      if (err) return resolve([]);
      resolve(stdout.trim().split('\n').slice(1).map((l) => l.split(/\s+/)).filter((r) => r[0].startsWith('/dev/')).map((r) => ({
        dev: path.basename(r[0]),
        total: Number(r[1]) * 1024,
        used: Number(r[2]) * 1024,
        mount: r.slice(5).join(' ')
      })));
    });
  });
}

// ---------- network ----------
function netStats() {
  const out = {};
  for (const line of read('/proc/net/dev').split('\n').slice(2)) {
    const [name, rest] = line.split(':');
    if (!rest) continue;
    const iface = name.trim();
    if (iface === 'lo' || /^(veth|docker|br-|virbr)/.test(iface)) continue;
    const c = rest.trim().split(/\s+/).map(Number);
    out[iface] = { rx: c[0], tx: c[8] };
  }
  return out;
}

// ---------- performance sample ----------
let perfPrev = null;

async function perf() {
  const now = Date.now();
  const cpu = cpuLines();
  const disks = diskStats();
  const net = netStats();
  const prev = perfPrev;
  perfPrev = { t: now, cpu, disks, net };
  const dt = prev ? Math.max(0.1, (now - prev.t) / 1000) : 1;

  const usage = (key) => {
    const a = cpu[key];
    const b = prev && prev.cpu[key];
    if (!a || !b || a.total === b.total) return 0;
    return Math.max(0, Math.min(100, (1 - (a.idle - b.idle) / (a.total - b.total)) * 100));
  };
  const coreKeys = Object.keys(cpu).filter((k) => k !== 'cpu').sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));

  const loadavg = read('/proc/loadavg').trim().split(/\s+/);
  const procCount = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).length;
  const threads = Number((loadavg[3] || '0/0').split('/')[1]) || 0;
  const handles = Number(read('/proc/sys/fs/file-nr').split(/\s+/)[0]) || 0;

  const mountList = await mounts();
  const diskList = Object.entries(disks).map(([name, d]) => {
    const p = prev && prev.disks[name];
    const parts = mountList.filter((m) => m.dev === name || fs.existsSync(`/sys/block/${name}/${m.dev}`));
    const size = (num(`/sys/block/${name}/size`) || 0) * 512;
    return {
      name,
      model: read(`/sys/block/${name}/device/model`).trim() || (name.startsWith('vd') ? 'Dysk wirtualny (virtio)' : ''),
      // virtio/xen disks report "rotational" regardless of the real storage.
      type: /^x?vd/.test(name) ? 'Wirtualny' : read(`/sys/block/${name}/queue/rotational`).trim() === '1' ? 'HDD' : 'SSD',
      size,
      mounts: parts.map((m) => m.mount),
      used: parts.reduce((a, m) => a + m.used, 0),
      fsTotal: parts.reduce((a, m) => a + m.total, 0),
      system: parts.some((m) => m.mount === '/'),
      readRate: p ? Math.max(0, (d.readBytes - p.readBytes) / dt) : 0,
      writeRate: p ? Math.max(0, (d.writeBytes - p.writeBytes) / dt) : 0,
      active: p ? Math.max(0, Math.min(100, ((d.ioMs - p.ioMs) / (dt * 1000)) * 100)) : 0
    };
  }).filter((d) => d.size > 0 && (d.mounts.length || d.readRate || d.writeRate || d.size > 64 * 1024 * 1024))
    .sort((a, b) => (b.system - a.system) || a.name.localeCompare(b.name));

  const ifaces = os.networkInterfaces();
  const netList = Object.entries(net).map(([iface, n]) => {
    const p = prev && prev.net[iface];
    const addrs = (ifaces[iface] || []).filter((a) => !a.internal);
    const speed = num(`/sys/class/net/${iface}/speed`);
    return {
      iface,
      type: fs.existsSync(`/sys/class/net/${iface}/wireless`) ? 'Wi-Fi' : 'Ethernet',
      ipv4: addrs.filter((a) => a.family === 'IPv4').map((a) => a.address),
      ipv6: addrs.filter((a) => a.family === 'IPv6').map((a) => a.address),
      mac: (addrs[0] || {}).mac || read(`/sys/class/net/${iface}/address`).trim(),
      linkSpeed: speed && speed > 0 ? speed : null,
      rxRate: p ? Math.max(0, (n.rx - p.rx) / dt) : 0,
      txRate: p ? Math.max(0, (n.tx - p.tx) / dt) : 0,
      rx: n.rx,
      tx: n.tx
    };
  }).filter((n) => n.rx || n.tx || n.ipv4.length);

  return {
    time: now,
    hostname: os.hostname(),
    os: (read('/etc/os-release').match(/^PRETTY_NAME="?([^"\n]+)"?/m) || [])[1] || os.type(),
    kernel: os.release(),
    uptime: os.uptime(),
    bootTime: BOOT_TIME,
    load: os.loadavg(),
    cpu: {
      ...cpuInfo(),
      usage: usage('cpu'),
      perCore: coreKeys.map(usage),
      processes: procCount,
      threads,
      handles
    },
    memory: memInfo(),
    disks: diskList,
    net: netList
  };
}

// ---------- processes ----------
let procPrev = { t: 0, total: 0, map: new Map() };

function parseStat(text) {
  // comm may contain spaces and parentheses: take everything up to the last ")".
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < 0) return null;
  const f = text.slice(close + 2).split(' ');
  return {
    name: text.slice(open + 1, close),
    state: f[0],
    ppid: Number(f[1]),
    utime: Number(f[11]),
    stime: Number(f[12]),
    priority: Number(f[15]),
    nice: Number(f[16]),
    threads: Number(f[17]),
    starttime: Number(f[19]),
    vsize: Number(f[20]),
    rss: Number(f[21]) * PAGE
  };
}

function processes() {
  const now = Date.now();
  const cpuTotal = (cpuLines().cpu || { total: 0 }).total;
  const dTotal = cpuTotal - procPrev.total;
  const dt = procPrev.t ? Math.max(0.1, (now - procPrev.t) / 1000) : 0;
  const memTotal = memInfo().total;
  const map = new Map();
  const list = [];

  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    const pid = Number(d);
    const st = parseStat(read(`/proc/${pid}/stat`));
    if (!st) continue;
    const status = read(`/proc/${pid}/status`);
    const uidM = status.match(/^Uid:\s+(\d+)/m);
    const uid = uidM ? Number(uidM[1]) : -1;
    const cmdline = read(`/proc/${pid}/cmdline`).replace(/\0+$/, '').split('\0').join(' ');
    const kthread = st.ppid === 2 || pid === 2;
    const io = read(`/proc/${pid}/io`);
    const rb = io ? Number((io.match(/^read_bytes:\s+(\d+)/m) || [])[1] || 0) : null;
    const wb = io ? Number((io.match(/^write_bytes:\s+(\d+)/m) || [])[1] || 0) : null;
    const cpuTime = st.utime + st.stime;

    const key = pid + ':' + st.starttime;
    const prev = procPrev.map.get(key);
    map.set(key, { cpuTime, rb, wb });

    let cpu = 0;
    if (prev && dTotal > 0) cpu = Math.max(0, ((cpuTime - prev.cpuTime) / dTotal) * 100);
    let diskRate = null;
    if (rb != null) diskRate = prev && prev.rb != null && dt ? Math.max(0, (rb - prev.rb + wb - prev.wb) / dt) : 0;

    list.push({
      pid,
      ppid: st.ppid,
      name: st.name,
      cmd: cmdline || `[${st.name}]`,
      user: userName(uid),
      uid,
      state: st.state,
      cpu,
      cpuTime: cpuTime / CLK_TCK,
      mem: st.rss,
      memPct: memTotal ? (st.rss / memTotal) * 100 : 0,
      vsz: st.vsize,
      threads: st.threads,
      nice: st.nice,
      priority: st.priority,
      start: BOOT_TIME + (st.starttime / CLK_TCK) * 1000,
      disk: diskRate,
      kthread
    });
  }
  procPrev = { t: now, total: cpuTotal, map };
  return { self: process.pid, list };
}

function processDetail(pid) {
  pid = Number(pid);
  const base = `/proc/${pid}`;
  if (!fs.existsSync(base)) {
    const e = new Error('Nie ma takiego procesu');
    e.status = 404;
    throw e;
  }
  const st = parseStat(read(`${base}/stat`)) || {};
  const status = read(`${base}/status`);
  const field = (k) => { const m = status.match(new RegExp('^' + k + ':\\s*(.*)$', 'm')); return m ? m[1].trim() : ''; };
  const link = (p) => { try { return fs.readlinkSync(p); } catch { return null; } };
  let fds = null;
  try { fds = fs.readdirSync(`${base}/fd`).length; } catch { /* no permission */ }
  const io = read(`${base}/io`);
  const ioField = (k) => { const m = io.match(new RegExp('^' + k + ':\\s+(\\d+)', 'm')); return m ? Number(m[1]) : null; };
  const uid = Number((field('Uid').split(/\s+/)[0]) || -1);
  const children = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).filter((n) => {
    const s = parseStat(read(`/proc/${n}/stat`));
    return s && s.ppid === pid;
  }).map(Number);
  return {
    pid,
    ppid: st.ppid,
    name: st.name,
    cmdline: read(`${base}/cmdline`).replace(/\0+$/, '').split('\0'),
    exe: link(`${base}/exe`),
    cwd: link(`${base}/cwd`),
    user: userName(uid),
    uid,
    state: st.state,
    threads: st.threads,
    nice: st.nice,
    start: BOOT_TIME + (st.starttime / CLK_TCK) * 1000,
    cpuTime: ((st.utime || 0) + (st.stime || 0)) / CLK_TCK,
    rss: st.rss,
    vsz: st.vsize,
    vmPeak: field('VmPeak'),
    vmSwap: field('VmSwap'),
    fds,
    readBytes: ioField('read_bytes'),
    writeBytes: ioField('write_bytes'),
    ctxSwitches: (Number(field('voluntary_ctxt_switches')) || 0) + (Number(field('nonvoluntary_ctxt_switches')) || 0),
    children
  };
}

// Kills a process and all of its descendants (children first).
function killTree(pid, signal) {
  const kids = new Map();
  for (const n of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(n)) continue;
    const s = parseStat(read(`/proc/${n}/stat`));
    if (!s) continue;
    if (!kids.has(s.ppid)) kids.set(s.ppid, []);
    kids.get(s.ppid).push(Number(n));
  }
  const order = [];
  const walk = (p) => { for (const c of kids.get(p) || []) walk(c); order.push(p); };
  walk(pid);
  let killed = 0;
  for (const p of order) {
    if (p === process.pid || p <= 1) continue;
    try { process.kill(p, signal); killed++; } catch { /* already gone */ }
  }
  return killed;
}

function setPriority(pid, nice) {
  os.setPriority(Number(pid), Math.max(-20, Math.min(19, Number(nice))));
}

// Starts a command in the background, detached from the panel.
function runTask(command, cwd) {
  const child = spawn('/bin/sh', ['-c', command], {
    cwd: cwd && fs.existsSync(cwd) ? cwd : os.userInfo().homedir,
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  return child.pid;
}

// ---------- systemd services ----------
const UNIT_RE = /^[\w@.:\\-]+\.service$/;

async function services() {
  let listing;
  try {
    listing = await run('systemctl', ['list-units', '--type=service', '--all', '--no-legend', '--no-pager', '--plain']);
  } catch (err) {
    const e = new Error(err.code === 'ENOENT' ? 'Ten system nie używa systemd' : 'Nie można odczytać usług: ' + (err.stderr || err.message).trim());
    e.status = 501;
    throw e;
  }
  const units = new Map();
  for (const line of listing.split('\n')) {
    const m = line.trim().match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/);
    if (!m || !m[1].endsWith('.service')) continue;
    units.set(m[1], { name: m[1], load: m[2], active: m[3], sub: m[4], description: m[5], enabled: '', pid: 0, memory: null });
  }
  // Unit files that are not loaded (e.g. disabled services) are listed too.
  try {
    const files = await run('systemctl', ['list-unit-files', '--type=service', '--no-legend', '--no-pager']);
    for (const line of files.split('\n')) {
      const [name, state] = line.trim().split(/\s+/);
      if (!name || !name.endsWith('.service')) continue;
      if (!units.has(name)) {
        if (name.includes('@')) continue; // templates
        units.set(name, { name, load: 'not-loaded', active: 'inactive', sub: 'dead', description: '', enabled: state, pid: 0, memory: null });
      } else {
        units.get(name).enabled = state;
      }
    }
  } catch { /* optional */ }

  const names = [...units.keys()].filter((n) => units.get(n).load !== 'not-found');
  for (let i = 0; i < names.length; i += 150) {
    const chunk = names.slice(i, i + 150);
    try {
      const out = await run('systemctl', ['show', '--no-pager', '-p', 'Id,MainPID,MemoryCurrent,UnitFileState,Description,ActiveEnterTimestamp', '--', ...chunk]);
      for (const block of out.split(/\n\s*\n/)) {
        const props = {};
        for (const l of block.split('\n')) { const k = l.indexOf('='); if (k > 0) props[l.slice(0, k)] = l.slice(k + 1); }
        const u = units.get(props.Id);
        if (!u) continue;
        u.pid = Number(props.MainPID) || 0;
        const mem = Number(props.MemoryCurrent);
        u.memory = Number.isFinite(mem) && mem < 2 ** 60 ? mem : null;
        if (props.UnitFileState) u.enabled = props.UnitFileState;
        if (props.Description && !u.description) u.description = props.Description;
        u.since = props.ActiveEnterTimestamp || '';
      }
    } catch { /* details are optional */ }
  }
  return [...units.values()];
}

async function serviceAction(name, action) {
  if (!UNIT_RE.test(name)) throw Object.assign(new Error('Nieprawidłowa nazwa usługi'), { status: 400 });
  if (!['start', 'stop', 'restart', 'enable', 'disable'].includes(action)) throw Object.assign(new Error('Nieznana akcja'), { status: 400 });
  if (name === 'webpulpit.service' && (action === 'stop' || action === 'disable')) {
    throw Object.assign(new Error('Tej usługi nie da się zatrzymać z panelu – odcięłoby to dostęp do panelu'), { status: 400 });
  }
  try {
    await run('systemctl', action === 'enable' || action === 'disable' ? [action, '--now', name] : [action, name]);
  } catch (err) {
    throw Object.assign(new Error((err.stderr || err.message).trim() || 'Operacja nie powiodła się'), { status: 500 });
  }
}

async function serviceLogs(name) {
  if (!UNIT_RE.test(name)) throw Object.assign(new Error('Nieprawidłowa nazwa usługi'), { status: 400 });
  try {
    return await run('journalctl', ['-u', name, '-n', '300', '--no-pager', '-o', 'short-iso']);
  } catch (err) {
    return (err.stdout || '') + (err.stderr || err.message);
  }
}

// ---------- logged-in users ----------
async function sessions() {
  let out = '';
  try { out = await run('who', []); } catch { /* not available */ }
  return out.trim().split('\n').filter(Boolean).map((l) => {
    const m = l.match(/^(\S+)\s+(\S+)\s+(\S+\s+\S+)\s*(?:\((.*)\))?/);
    return m ? { user: m[1], tty: m[2], since: m[3], from: m[4] || '' } : { user: l, tty: '', since: '', from: '' };
  });
}

module.exports = {
  perf, processes, processDetail, killTree, setPriority, runTask,
  services, serviceAction, serviceLogs, sessions
};
