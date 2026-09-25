'use strict';
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

function readFile(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function cpuTimes() {
  const line = readFile('/proc/stat').split('\n').find((l) => l.startsWith('cpu '));
  if (!line) {
    // Fallback for non-Linux hosts.
    const t = os.cpus().reduce((a, c) => {
      for (const k of Object.keys(c.times)) a[k] = (a[k] || 0) + c.times[k];
      return a;
    }, {});
    const total = Object.values(t).reduce((a, b) => a + b, 0);
    return { idle: t.idle, total };
  }
  const nums = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = nums[3] + (nums[4] || 0);
  const total = nums.reduce((a, b) => a + b, 0);
  return { idle, total };
}

function netBytes() {
  const out = {};
  for (const line of readFile('/proc/net/dev').split('\n').slice(2)) {
    const [name, rest] = line.split(':');
    if (!rest) continue;
    const cols = rest.trim().split(/\s+/).map(Number);
    const iface = name.trim();
    if (iface === 'lo') continue;
    out[iface] = { rx: cols[0], tx: cols[8] };
  }
  return out;
}

let lastCpu = cpuTimes();
let lastNet = { t: Date.now(), bytes: netBytes() };

function memory() {
  const info = {};
  for (const line of readFile('/proc/meminfo').split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)/);
    if (m) info[m[1]] = Number(m[2]) * 1024;
  }
  const total = info.MemTotal || os.totalmem();
  const available = info.MemAvailable ?? os.freemem();
  return {
    total,
    used: total - available,
    swapTotal: info.SwapTotal || 0,
    swapUsed: (info.SwapTotal || 0) - (info.SwapFree || 0)
  };
}

function disks() {
  return new Promise((resolve) => {
    execFile('df', ['-kP'], (err, stdout) => {
      if (err) return resolve([]);
      const rows = stdout.trim().split('\n').slice(1).map((l) => l.split(/\s+/));
      resolve(rows
        .filter((r) => r[0].startsWith('/dev/') && !r[0].startsWith('/dev/loop'))
        .map((r) => ({
          device: r[0],
          total: Number(r[1]) * 1024,
          used: Number(r[2]) * 1024,
          mount: r.slice(5).join(' ')
        })));
    });
  });
}

function osName() {
  const m = readFile('/etc/os-release').match(/^PRETTY_NAME="?([^"\n]+)"?/m);
  return m ? m[1] : `${os.type()} ${os.release()}`;
}

async function stats() {
  const cpu = cpuTimes();
  const dTotal = cpu.total - lastCpu.total;
  const dIdle = cpu.idle - lastCpu.idle;
  const cpuPercent = dTotal > 0 ? Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100)) : 0;
  lastCpu = cpu;

  const now = Date.now();
  const bytes = netBytes();
  const dt = (now - lastNet.t) / 1000 || 1;
  const net = Object.entries(bytes).map(([iface, b]) => {
    const prev = lastNet.bytes[iface] || b;
    return { iface, rx: b.rx, tx: b.tx, rxRate: (b.rx - prev.rx) / dt, txRate: (b.tx - prev.tx) / dt };
  });
  lastNet = { t: now, bytes };

  const cpus = os.cpus();
  return {
    hostname: os.hostname(),
    os: osName(),
    kernel: os.release(),
    uptime: os.uptime(),
    load: os.loadavg(),
    cpu: { percent: cpuPercent, cores: cpus.length, model: cpus[0] ? cpus[0].model : '' },
    memory: memory(),
    disks: await disks(),
    net
  };
}

function processes() {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-eo', 'pid,user:20,pcpu,pmem,rss,etime,comm', '--sort=-pcpu', '--no-headers'],
      { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout.trim().split('\n').slice(0, 150).map((l) => {
          const c = l.trim().split(/\s+/);
          return {
            pid: Number(c[0]), user: c[1], cpu: Number(c[2]), mem: Number(c[3]),
            rss: Number(c[4]) * 1024, time: c[5], command: c.slice(6).join(' ')
          };
        }));
      });
  });
}

module.exports = { stats, processes };
