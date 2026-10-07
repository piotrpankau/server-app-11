'use strict';
/* Emperor's Gambit builds: finds every web build served by Caddy (a folder with index.html + index.pck,
   at the site root or in sub-folders like 0.8.2/P) and lets the panel list, open, rename and clean them up.
   Nothing here needs registering: a new deploy shows up on its own. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORE = path.join(__dirname, '..', 'data', 'gambit.json');
const APK = 'emperors-gambit.apk';
const MAX_DEPTH = 3;
let cache = { t: 0, v: [] };

const caddyfile = (cfg) => (cfg.gambit && cfg.gambit.caddyfile) || '/etc/caddy/Caddyfile';

// Minimal Caddyfile reader: "host { ... root * /path ... }" blocks. Snippets "(name) {" are skipped.
function parseSites(text) {
  const sites = [];
  let depth = 0; let cur = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    if (depth === 0) {
      const m = line.match(/^([A-Za-z0-9*._:-]+(?:\s*,\s*[A-Za-z0-9*._:-]+)*)\s*\{$/);
      if (m) cur = { hosts: m[1].split(/\s*,\s*/), root: null };
      else cur = null;
    } else if (depth === 1 && cur) {
      const r = line.match(/^root\s+\S+\s+(\S+)/);
      if (r) cur.root = r[1];
    }
    for (const ch of line) { if (ch === '{') depth++; else if (ch === '}') depth--; }
    if (depth === 0 && cur) { if (cur.root) sites.push(cur); cur = null; }
    if (depth < 0) depth = 0;
  }
  return sites;
}

function isBuild(dir) { return fs.existsSync(path.join(dir, 'index.html')) && fs.existsSync(path.join(dir, 'index.pck')); }

function walk(root, rel, depth, out) {
  const dir = path.join(root, rel);
  if (isBuild(dir)) out.push(rel);
  if (depth >= MAX_DEPTH) return;
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const d of items) {
    if (!d.isDirectory() || d.name.startsWith('.') || d.name === 'node_modules') continue;
    walk(root, rel ? rel + '/' + d.name : d.name, depth + 1, out);
  }
}

function defaultLabel(host, rel) {
  const sub = host.split('.')[0];
  let base;
  if (/^v\d{2,}$/.test(sub)) base = 'v' + sub[1] + '.' + sub.slice(2);
  else if (/^\d/.test(sub)) base = 'Główna';
  else base = sub;
  if (rel && base === 'Główna') return rel.replace(/\//g, ' ');
  return rel ? `${base} · ${rel.replace(/\//g, ' ')}` : base;
}

function loadMeta() { try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { return {}; } }
function saveMeta(m) {
  fs.mkdirSync(path.dirname(STORE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(STORE + '.tmp', JSON.stringify(m, null, 2), { mode: 0o600 });
  fs.renameSync(STORE + '.tmp', STORE);
}
const idOf = (host, rel) => crypto.createHash('sha1').update(host + '|' + rel).digest('hex').slice(0, 10);

function discover(cfg, force) {
  if (!force && Date.now() - cache.t < 4000) return cache.v;
  let text = '';
  try { text = fs.readFileSync(caddyfile(cfg), 'utf8'); } catch { /* no Caddy file: nothing to list */ }
  const meta = loadMeta();
  const seen = new Set();
  const list = [];
  for (const site of parseSites(text)) {
    const host = site.hosts[0].replace(/^https?:\/\//, '');
    const scheme = /:80$/.test(host) ? 'http' : 'https';
    const rels = [];
    walk(site.root, '', 0, rels);
    for (const rel of rels) {
      const id = idOf(host, rel);
      if (seen.has(id)) continue;
      seen.add(id);
      const dir = path.join(site.root, rel);
      const pck = fs.statSync(path.join(dir, 'index.pck'));
      let apk = null;
      try { const a = fs.statSync(path.join(dir, APK)); apk = { size: a.size, mtime: a.mtimeMs }; } catch { /* no apk */ }
      let size = 0;
      try { for (const f of fs.readdirSync(dir, { withFileTypes: true })) if (f.isFile()) size += fs.statSync(path.join(dir, f.name)).size; } catch { /* ignore */ }
      const m = meta[id] || {};
      const url = `${scheme}://${host}${rel ? '/' + rel : ''}/`;
      list.push({
        id, host, rel, url, apkUrl: apk ? url + APK : null, apk,
        label: m.label || defaultLabel(host, rel), custom: !!m.label, note: m.note || '', pinned: !!m.pinned,
        mtime: pck.mtimeMs, size, isRoot: rel === '',
        // Only builds in sub-folders may be removed; a site's root build is what the address serves.
        removable: rel !== ''
      });
    }
  }
  list.sort((a, b) => (b.pinned - a.pinned) || (b.mtime - a.mtime));
  cache = { t: Date.now(), v: list };
  return list;
}

function httpErr(status, msg) { return Object.assign(new Error(msg), { status }); }
function find(cfg, id) {
  const b = discover(cfg, true).find((x) => x.id === id);
  if (!b) throw httpErr(404, 'Nie ma takiej wersji (mogła zostać usunięta)');
  return b;
}

function setMeta(cfg, id, { label, note, pinned }) {
  find(cfg, id);
  const meta = loadMeta();
  const m = meta[id] || {};
  if (label !== undefined) { const l = String(label).trim().slice(0, 60); if (l) m.label = l; else delete m.label; }
  if (note !== undefined) { const n = String(note).trim().slice(0, 300); if (n) m.note = n; else delete m.note; }
  if (pinned !== undefined) { if (pinned) m.pinned = true; else delete m.pinned; }
  if (Object.keys(m).length) meta[id] = m; else delete meta[id];
  saveMeta(meta);
  cache.t = 0;
  return find(cfg, id);
}

function remove(cfg, id) {
  const b = find(cfg, id);
  if (!b.removable) throw httpErr(400, 'Wersji z głównego adresu strony nie można usunąć');
  const site = parseSites(fs.readFileSync(caddyfile(cfg), 'utf8')).find((s) => s.hosts[0].replace(/^https?:\/\//, '') === b.host);
  const dir = path.resolve(site.root, b.rel);
  if (!dir.startsWith(path.resolve(site.root) + path.sep) || !isBuild(dir)) throw httpErr(400, 'To nie jest folder z buildem gry');
  fs.rmSync(dir, { recursive: true, force: true });
  // Drop now-empty parent folders (e.g. 0.8.2/ after its last build), never the site root.
  for (let p = path.dirname(dir); p.startsWith(path.resolve(site.root) + path.sep); p = path.dirname(p)) {
    try { if (fs.readdirSync(p).length === 0) fs.rmdirSync(p); else break; } catch { break; }
  }
  const meta = loadMeta(); delete meta[id]; saveMeta(meta);
  cache.t = 0;
  return { ok: true, removed: b.label };
}

module.exports = { discover, setMeta, remove, parseSites, defaultLabel };
