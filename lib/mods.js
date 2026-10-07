'use strict';
/* Valheim mods (BepInEx) for hosted servers: install BepInEx, install mods from Thunderstore with their
   dependencies, upload a mod zip, switch mods on/off, edit their config files, copy the whole setup
   from another server. Pure file work, no game logic: games.js decides who may call what. */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const TS = 'https://thunderstore.io';
const BEPINEX_PKG = 'denikson-BepInExPack_Valheim';
const MAX_ZIP = 400 * 1024 * 1024;
const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const CONFIG_EXT = /\.(cfg|yaml|yml|json|txt|xml|ini)$/i;
const SKIP_TOP = /^(readme|changelog|license|icon)(\.|$)/i;

function httpErr(status, msg) { return Object.assign(new Error(msg), { status }); }
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, timeout: opts.timeout || 600000 }, (err, stdout, stderr) => {
      if (err) { err.message = (stderr || err.message || '').trim().slice(0, 400); return reject(err); }
      resolve(String(stdout));
    });
  });
}

const paths = (home) => {
  const bep = path.join(home, 'BepInEx');
  return { home, bep, plugins: path.join(bep, 'plugins'), config: path.join(bep, 'config'), registry: path.join(bep, 'wp-mods.json') };
};
const loadReg = (p) => { try { return JSON.parse(fs.readFileSync(p.registry, 'utf8')); } catch { return {}; } };
const saveReg = (p, r) => { fs.mkdirSync(p.bep, { recursive: true }); fs.writeFileSync(p.registry, JSON.stringify(r, null, 2)); };

const libOf = (home) => ['libdoorstop_x64.so', 'libdoorstop.so'].map((f) => path.join(home, 'doorstop_libs', f)).find((f) => fs.existsSync(f)) || null;
function installed(home) {
  const p = paths(home);
  return !!libOf(home) && fs.existsSync(path.join(p.bep, 'core', 'BepInEx.Preloader.dll'));
}

// ---------- Thunderstore ----------
async function tsJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'WebPulpit' }, signal: AbortSignal.timeout(30000) });
  if (r.status === 404) throw httpErr(404, 'Nie ma takiego moda na Thunderstore');
  if (!r.ok) throw httpErr(502, `Thunderstore odpowiedział błędem ${r.status}`);
  return r.json();
}
// "Owner-Name", "Owner/Name" or "Owner-Name-1.2.3" -> { owner, name, version|null }
function parseRef(ref) {
  const s = String(ref || '').trim().replace(/^https?:\/\/thunderstore\.io\/c\/valheim\/p\//, '').replace(/\/+$/, '');
  let m = s.match(/^([A-Za-z0-9_]+)\/([A-Za-z0-9_]+)(?:\/(\d+\.\d+\.\d+))?$/);
  if (!m) m = s.match(/^([A-Za-z0-9_]+)-([A-Za-z0-9_]+)(?:-(\d+\.\d+\.\d+))?$/);
  if (!m) throw httpErr(400, 'Podaj mod jako Autor-Nazwa (np. ValheimModding-Jotunn) albo adres ze strony Thunderstore');
  return { owner: m[1], name: m[2], version: m[3] || null };
}
async function tsInfo(ref) {
  const { owner, name, version } = parseRef(ref);
  const d = await tsJson(`${TS}/api/experimental/package/${owner}/${name}/${version ? version + '/' : ''}`);
  const v = version ? d : d.latest;
  if (!v) throw httpErr(404, 'Nie ma takiego moda na Thunderstore');
  return { owner, name, version: v.version_number, deps: v.dependencies || [], url: v.download_url, full: `${owner}-${name}` };
}

let listCache = { t: 0, v: [] };
async function communityList() {
  if (Date.now() - listCache.t < 6 * 3600e3 && listCache.v.length) return listCache.v;
  const r = await fetch(`${TS}/c/valheim/api/v1/package/`, { headers: { 'User-Agent': 'WebPulpit' }, signal: AbortSignal.timeout(90000) });
  if (!r.ok) throw httpErr(502, `Thunderstore odpowiedział błędem ${r.status}`);
  const all = await r.json();
  listCache = {
    t: Date.now(),
    v: all.filter((p) => !p.is_deprecated && p.versions && p.versions[0]).map((p) => ({
      full: p.full_name, owner: p.owner, name: p.name, rating: p.rating_score || 0, categories: p.categories || [],
      version: p.versions[0].version_number, description: String(p.versions[0].description || '').slice(0, 160),
      downloads: p.versions.reduce((a, x) => a + (x.downloads || 0), 0), size: p.versions[0].file_size || 0,
      updated: p.date_updated, search: `${p.owner} ${p.name} ${p.versions[0].description || ''}`.toLowerCase()
    }))
  };
  return listCache.v;
}
async function search(q) {
  q = String(q || '').trim().toLowerCase();
  const list = await communityList();
  const terms = q.split(/\s+/).filter(Boolean);
  const hits = terms.length ? list.filter((p) => terms.every((t) => p.search.includes(t))) : list.slice();
  hits.sort((a, b) => (b.downloads - a.downloads) || (b.rating - a.rating));
  return hits.slice(0, 25).map(({ search: _s, ...rest }) => ({ ...rest, side: rest.categories.includes('Server-side') ? 'server' : rest.categories.includes('Client-side') ? 'client' : 'both' }));
}

async function download(url, dest, limit = MAX_ZIP) {
  const r = await fetch(url, { headers: { 'User-Agent': 'WebPulpit' }, redirect: 'follow', signal: AbortSignal.timeout(600000) });
  if (!r.ok) throw httpErr(502, `Nie udało się pobrać paczki (${r.status})`);
  let n = 0;
  const body = Readable.fromWeb(r.body);
  body.on('data', (c) => { n += c.length; if (n > limit) body.destroy(new Error('Paczka jest za duża')); });
  await pipeline(body, fs.createWriteStream(dest));
}

// ---------- unzip + placement ----------
async function extractZip(zip, into) {
  // Some Windows-made zips use backslashes; unzip warns (exit code 1) but extracts them as folders.
  const names = (await run('unzip', ['-Z1', zip])).split('\n').filter(Boolean).map((n) => n.replace(/\\/g, '/'));
  if (names.length > 20000) throw httpErr(400, 'Za dużo plików w archiwum');
  for (const n of names) if (n.startsWith('/') || n.split('/').includes('..') || n.includes('\0')) throw httpErr(400, 'Archiwum zawiera niedozwolone ścieżki');
  try { await run('unzip', ['-q', '-o', zip, '-d', into]); } catch (err) { if (err.code !== 1) throw err; }
  await run('find', [into, '-type', 'l', '-delete']);   // no symlinks out of the mod folder
}
const cp = (src, dst, extra = []) => run('cp', ['-a', ...extra, src, dst]);
async function copyContents(srcDir, dstDir, noClobber) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const e of fs.readdirSync(srcDir)) await cp(path.join(srcDir, e), dstDir + '/', noClobber ? ['-n'] : []);
}

// r2modman-style layout: plugins/patchers/monomod/core go to BepInEx/<kind>/<Owner-Name>/, config is merged
// without overwriting, everything else lands in BepInEx/plugins/<Owner-Name>/.
async function place(tmp, folder, p) {
  const routeDir = async (rootDir, name) => {
    const full = path.join(rootDir, name);
    const isDir = fs.statSync(full).isDirectory();
    if (name === 'BepInEx' && isDir) { for (const c of fs.readdirSync(full)) await routeDir(full, c); return; }
    if (isDir && ['plugins', 'patchers', 'monomod', 'core'].includes(name)) { await copyContents(full, path.join(p.bep, name, folder), false); return; }
    if (isDir && name === 'config') { await copyContents(full, p.config, true); return; }
    if (rootDir === tmp && SKIP_TOP.test(name)) return;
    fs.mkdirSync(path.join(p.plugins, folder), { recursive: true });
    await cp(full, path.join(p.plugins, folder) + '/');
  };
  for (const kind of ['plugins', 'patchers', 'monomod', 'core']) fs.rmSync(path.join(p.bep, kind, folder), { recursive: true, force: true });
  for (const e of fs.readdirSync(tmp)) await routeDir(tmp, e);
}

async function installZip(home, zip, folder, regEntry) {
  const p = paths(home);
  const tmp = fs.mkdtempSync(path.join(home, '.wp-mod-'));
  try {
    await extractZip(zip, tmp);
    await place(tmp, folder, p);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  const reg = loadReg(p); reg[folder] = Object.assign({ installed: Date.now() }, regEntry); saveReg(p, reg);
}

async function installBepInEx(home) {
  const info = await tsInfo(BEPINEX_PKG);
  const zip = path.join(home, '.wp-bepinex.zip');
  const tmp = fs.mkdtempSync(path.join(home, '.wp-bep-'));
  try {
    await download(info.url, zip);
    await extractZip(zip, tmp);
    // The pack wraps everything in one folder; its content goes straight into the server folder.
    const wrapper = fs.readdirSync(tmp).find((e) => fs.statSync(path.join(tmp, e)).isDirectory() && e !== 'BepInEx' && (fs.existsSync(path.join(tmp, e, 'BepInEx')) || fs.existsSync(path.join(tmp, e, 'doorstop_libs'))));
    const root = wrapper ? path.join(tmp, wrapper) : tmp;
    for (const e of fs.readdirSync(root)) {
      if (SKIP_TOP.test(e) || e === 'manifest.json') continue;
      // Re-installing must not overwrite the config the customer already tuned.
      const keep = e === 'BepInEx' && fs.existsSync(path.join(home, 'BepInEx', 'config'));
      await cp(path.join(root, e), home + '/', keep ? ['-n'] : []);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(zip, { force: true }); }
  const p = paths(home);
  for (const d of ['plugins', 'config', 'patchers']) fs.mkdirSync(path.join(p.bep, d), { recursive: true });
  if (!installed(home)) throw httpErr(500, 'Instalacja BepInEx nie powiodła się (brak plików doorstop)');
  return info.version;
}

// Install a Thunderstore package and its dependencies (skipping BepInEx itself and what is already there).
async function installPackage(home, ref, { force = false, log = () => {} } = {}) {
  const p = paths(home);
  const done = [];
  const seen = new Set();
  async function one(r, top) {
    const info = await tsInfo(r);
    if (info.full === BEPINEX_PKG || seen.has(info.full)) return;
    seen.add(info.full);
    const folder = info.full;
    const reg = loadReg(p);
    const have = reg[folder] && fs.existsSync(path.join(p.plugins, folder));
    if (have && !(top && force)) { log(`✓ ${folder} już jest (${reg[folder].version})`); }
    else {
      log(`↓ ${folder}-${info.version}`);
      const zip = path.join(home, '.wp-mod.zip');
      try { await download(info.url, zip); await installZip(home, zip, folder, { source: 'thunderstore', owner: info.owner, name: info.name, version: info.version }); }
      finally { fs.rmSync(zip, { force: true }); }
      done.push(`${folder}-${info.version}`);
    }
    for (const d of info.deps) {
      const m = String(d).match(/^(.+)-([^-]+)-(\d+\.\d+\.\d+)$/);
      if (m) await one(`${m[1]}-${m[2]}-${m[3]}`, false);
    }
  }
  await one(ref, true);
  return done;
}

async function installUpload(home, zipPath, originalName) {
  const base = String(originalName || 'mod').replace(/\.(zip|dll)$/i, '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60) || 'mod';
  const folder = 'local-' + base;
  if (/\.dll$/i.test(originalName)) {
    const p = paths(home);
    const dir = path.join(p.plugins, folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(zipPath, path.join(dir, base + '.dll'));
    const reg = loadReg(p); reg[folder] = { source: 'upload', installed: Date.now() }; saveReg(p, reg);
    return folder;
  }
  await installZip(home, zipPath, folder, { source: 'upload' });
  return folder;
}

// ---------- listing and switches ----------
function walkFiles(dir, out = [], depth = 0) {
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const d of items) {
    const f = path.join(dir, d.name);
    if (d.isDirectory() && depth < 6) walkFiles(f, out, depth + 1); else if (d.isFile()) out.push(f);
  }
  return out;
}
async function list(home) {
  const p = paths(home);
  const reg = loadReg(p);
  let sizes = {};
  try {
    const out = await run('du', ['-sb', '--', ...fs.readdirSync(p.plugins).map((e) => path.join(p.plugins, e))], { timeout: 60000 });
    for (const l of out.split('\n')) { const m = l.match(/^(\d+)\t(.+)$/); if (m) sizes[path.basename(m[2])] = Number(m[1]); }
  } catch { /* empty or missing */ }
  const mods = [];
  let entries = [];
  try { entries = fs.readdirSync(p.plugins, { withFileTypes: true }); } catch { /* no plugins yet */ }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(p.plugins, e.name);
    let dlls = 0; let off = 0; let version = (reg[e.name] || {}).version || null;
    if (e.isDirectory()) {
      for (const f of walkFiles(full)) { if (/\.dll$/i.test(f)) dlls++; else if (/\.dll\.old$/i.test(f)) off++; }
      if (!version) { try { version = JSON.parse(fs.readFileSync(path.join(full, 'manifest.json'), 'utf8')).version_number || null; } catch { /* none */ } }
    } else { if (/\.dll$/i.test(e.name)) dlls = 1; else if (/\.dll\.old$/i.test(e.name)) off = 1; else continue; }
    mods.push({
      name: e.name, version, source: (reg[e.name] || {}).source || (/^local-/.test(e.name) ? 'local' : 'unknown'),
      owner: (reg[e.name] || {}).owner || (e.name.includes('-') ? e.name.split('-')[0] : null),
      enabled: dlls > 0 || off === 0, dlls, size: sizes[e.name] || 0
    });
  }
  mods.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return mods;
}

function modPath(home, name) {
  if (!NAME_RE.test(String(name))) throw httpErr(400, 'Nieprawidłowa nazwa moda');
  const p = paths(home);
  const full = path.join(p.plugins, name);
  if (!full.startsWith(p.plugins + path.sep) || !fs.existsSync(full)) throw httpErr(404, 'Nie ma takiego moda');
  return full;
}
function toggle(home, name, enabled) {
  const full = modPath(home, name);
  const files = fs.statSync(full).isDirectory() ? walkFiles(full) : [full];
  for (const f of files) {
    if (enabled && /\.dll\.old$/i.test(f)) fs.renameSync(f, f.replace(/\.old$/i, ''));
    else if (!enabled && /\.dll$/i.test(f)) fs.renameSync(f, f + '.old');
  }
}
function remove(home, name) {
  const full = modPath(home, name);
  const p = paths(home);
  fs.rmSync(full, { recursive: true, force: true });
  for (const kind of ['patchers', 'monomod', 'core']) fs.rmSync(path.join(p.bep, kind, name), { recursive: true, force: true });
  const reg = loadReg(p); delete reg[name]; saveReg(p, reg);
}

// ---------- config files ----------
function configFiles(home) {
  const p = paths(home);
  const out = [];
  for (const f of walkFiles(p.config)) {
    if (!CONFIG_EXT.test(f)) continue;
    const st = fs.statSync(f);
    if (st.size > 2 * 1024 * 1024) continue;
    out.push({ file: path.relative(p.config, f), size: st.size, mtime: st.mtimeMs });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}
function configPath(home, file) {
  const p = paths(home);
  const full = path.resolve(p.config, String(file || ''));
  if (!full.startsWith(p.config + path.sep) || !CONFIG_EXT.test(full) || String(file).includes('\0')) throw httpErr(400, 'Ten plik nie jest edytowalny');
  return full;
}
function readConfig(home, file) {
  const full = configPath(home, file);
  if (fs.statSync(full).size > 2 * 1024 * 1024) throw httpErr(400, 'Plik jest za duży do edycji');
  return fs.readFileSync(full, 'utf8');
}
function writeConfig(home, file, content) {
  const full = configPath(home, file);
  if (!fs.existsSync(full)) throw httpErr(404, 'Nie ma takiego pliku konfiguracyjnego');
  if (Buffer.byteLength(String(content)) > 2 * 1024 * 1024) throw httpErr(400, 'Plik jest za duży');
  fs.writeFileSync(full, String(content));
}

// Lines players need in their own r2modman / Thunderstore profile.
function playerList(home) {
  const p = paths(home);
  const reg = loadReg(p);
  const ts = []; const manual = [];
  let entries = [];
  try { entries = fs.readdirSync(p.plugins, { withFileTypes: true }); } catch { /* none */ }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    let version = (reg[e.name] || {}).version;
    if (!version) { try { version = JSON.parse(fs.readFileSync(path.join(p.plugins, e.name, 'manifest.json'), 'utf8')).version_number; } catch { /* none */ } }
    if (version && !/^local-/.test(e.name)) ts.push(`${e.name}-${version}`); else manual.push(e.name);
  }
  return { thunderstore: ts, manual };
}

// ---------- copy a whole mod setup from another Valheim server folder ----------
async function cloneFrom(srcHome, home, { config = true, skip = [/ValheimEnforcer/i, /ModProfiler/i] } = {}) {
  const src = paths(srcHome);
  if (!fs.existsSync(src.plugins)) throw httpErr(400, 'W folderze źródłowym nie ma BepInEx/plugins');
  const dst = paths(home);
  if (!installed(home)) await installBepInEx(home);
  const kinds = ['plugins', 'patchers', 'monomod'].concat(config ? ['config'] : []);
  for (const k of kinds) {
    const s = path.join(src.bep, k);
    if (!fs.existsSync(s)) continue;
    fs.rmSync(path.join(dst.bep, k), { recursive: true, force: true });
    await cp(s, dst.bep + '/');
  }
  const removed = [];
  for (const k of kinds) {
    const d = path.join(dst.bep, k);
    for (const e of fs.existsSync(d) ? fs.readdirSync(d) : []) if (skip.some((re) => re.test(e))) { fs.rmSync(path.join(d, e), { recursive: true, force: true }); removed.push(`${k}/${e}`); }
  }
  // Config files may carry secrets (webhooks, tokens): tell the admin which ones to check.
  const sensitive = [];
  for (const f of walkFiles(dst.config)) {
    if (!CONFIG_EXT.test(f) || fs.statSync(f).size > 2 * 1024 * 1024) continue;
    const text = fs.readFileSync(f, 'utf8');
    if (/discord(app)?\.com\/api\/webhooks|api[_-]?key|token\s*=|password\s*=/i.test(text)) sensitive.push(path.relative(dst.config, f));
  }
  const reg = loadReg(dst);
  for (const m of await list(home)) if (!reg[m.name]) reg[m.name] = { source: m.source === 'local' ? 'upload' : 'cloned', owner: m.owner || undefined, version: m.version || undefined, installed: Date.now() };
  saveReg(dst, reg);
  return { removed, sensitive };
}

module.exports = {
  paths, installed, installBepInEx, installPackage, installUpload, search, tsInfo, parseRef,
  list, toggle, remove, configFiles, readConfig, writeConfig, playerList, cloneFrom, libOf, MAX_ZIP
};
