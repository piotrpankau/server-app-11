'use strict';
/* Valheim specifics: save paths, player lists, who is online, world reset. */
const fs = require('fs');
const path = require('path');

const SAVE_REL = '.config/unity3d/IronGate/Valheim';
const LISTS = { permitted: 'permittedlist.txt', admin: 'adminlist.txt', banned: 'bannedlist.txt' };
const ID_RE = /^(?:[A-Za-z]{3,10}_)?\d{5,20}$/;
const WORLD_RE = /^[\p{L}\p{N} _-]{1,30}$/u;

const saveDir = (home) => path.join(home, SAVE_REL);
const worldsDir = (home) => path.join(saveDir(home), 'worlds_local');

function validWorld(name) { return WORLD_RE.test(String(name || '')) && String(name).trim() === String(name); }

// Valheim refuses a password shorter than 5 chars or one containing the world name.
function checkPassword(password, world, isPublic) {
  const p = String(password || '');
  if (!p) { if (isPublic) throw new Error('Serwer publiczny musi mieć hasło'); return; }
  if (p.length < 5) throw new Error('Hasło serwera musi mieć co najmniej 5 znaków');
  if (world && p.toLowerCase().includes(String(world).toLowerCase())) throw new Error('Hasło nie może zawierać nazwy świata');
  if (/[\r\n\0]/.test(p)) throw new Error('Hasło zawiera niedozwolone znaki');
}

// ----- player lists -----
function readList(home, kind) {
  const file = path.join(saveDir(home), LISTS[kind]);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('//'));
}
function writeList(home, kind, ids) {
  if (!LISTS[kind]) throw Object.assign(new Error('Nieznana lista'), { status: 400 });
  const clean = [];
  for (const raw of ids) {
    const id = String(raw).trim();
    if (!id) continue;
    if (!ID_RE.test(id)) throw Object.assign(new Error(`Nieprawidłowy identyfikator gracza: ${id.slice(0, 40)}`), { status: 400 });
    if (!clean.includes(id)) clean.push(id);
  }
  if (clean.length > 200) throw Object.assign(new Error('Za dużo wpisów (maks. 200)'), { status: 400 });
  fs.mkdirSync(saveDir(home), { recursive: true });
  const file = path.join(saveDir(home), LISTS[kind]);
  const header = '// List of Steam IDs (one per line). Managed by WebPulpit.\n';
  fs.writeFileSync(file, header + clean.join('\n') + (clean.length ? '\n' : ''), { mode: 0o644 });
  return clean;
}

// ----- who is online -----
// From the server log: "Got connection SteamID <id>" / "Closing socket <id>" and the periodic
// "Connections N ZDOS:..." line. The set is rebuilt from the log of the current run, so it
// is a best-effort view; `count` takes the larger of both sources (safe for "nobody online" checks).
function parseOnline(logText) {
  const online = new Set();
  let reported = null;
  for (const line of String(logText).split('\n')) {
    let m = line.match(/Got connection SteamID (\S+)/) || line.match(/Got connection PlayFabID (\S+)/);
    if (m) { online.add(m[1]); continue; }
    m = line.match(/Closing socket (\S+)/);
    if (m) { online.delete(m[1]); continue; }
    m = line.match(/\bConnections (\d+) ZDOS:/);
    if (m) reported = Number(m[1]);
    if (/OnApplicationQuit/.test(line)) online.clear();
  }
  const ids = [...online];
  return { ids, reported, count: Math.max(ids.length, reported || 0) };
}

// ----- worlds -----
function listWorlds(home) {
  let files = [];
  try { files = fs.readdirSync(worldsDir(home)); } catch { return []; }
  return [...new Set(files.filter((f) => f.endsWith('.fwl')).map((f) => f.slice(0, -4)))];
}
// Files that belong to one world (db, fwl, .old and Valheim's own _backup_ copies).
function worldFiles(home, world) {
  let files = [];
  try { files = fs.readdirSync(worldsDir(home)); } catch { return []; }
  return files.filter((f) => f.startsWith(world + '.') || f.startsWith(world + '_backup_'));
}
function deleteWorld(home, world) {
  if (!validWorld(world)) throw Object.assign(new Error('Nieprawidłowa nazwa świata'), { status: 400 });
  const removed = [];
  for (const f of worldFiles(home, world)) {
    try { fs.unlinkSync(path.join(worldsDir(home), f)); removed.push(f); } catch { /* gone */ }
  }
  return removed;
}

module.exports = {
  SAVE_REL, LISTS, ID_RE, validWorld, checkPassword, readList, writeList, parseOnline,
  listWorlds, worldFiles, deleteWorld, saveDir, worldsDir
};
