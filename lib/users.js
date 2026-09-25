'use strict';
/* Panel user accounts. Stored in config.json under `users`.
   Two roles:
   - admin: full access to everything (files, terminal, system, users, all game servers),
   - user: only the Game servers app and the game servers they were given, plus files
     inside those servers' folders. No terminal, no system settings, no user management. */
const crypto = require('crypto');
const config = require('./config');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [algo, saltHex, hashHex] = stored.split('$');
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

// Backward compatibility: older configs had a single username/passwordHash.
function ensure(cfg) {
  if (!Array.isArray(cfg.users) || !cfg.users.length) {
    cfg.users = [{
      id: crypto.randomBytes(6).toString('hex'),
      username: cfg.username || 'admin',
      passwordHash: cfg.passwordHash,
      role: 'admin',
      created: Date.now(),
      games: []
    }];
    persist(cfg);
  }
  return cfg.users;
}

function persist(cfg) {
  const stored = JSON.parse(require('fs').readFileSync(config.CONFIG_PATH, 'utf8'));
  stored.users = cfg.users;
  delete stored.username; // migrated into users[]
  delete stored.passwordHash;
  config.save(stored);
}

const byName = (cfg, name) => ensure(cfg).find((u) => u.username.toLowerCase() === String(name || '').toLowerCase());
const byId = (cfg, id) => ensure(cfg).find((u) => u.id === id);

function verifyLogin(cfg, username, password) {
  const u = byName(cfg, username);
  if (!u || !verifyPassword(password || '', u.passwordHash)) return null;
  return u;
}

const VALID_NAME = /^[a-zA-Z0-9._-]{2,32}$/;

function httpErr(status, msg) { return Object.assign(new Error(msg), { status }); }

function add(cfg, { username, password, role, games }) {
  ensure(cfg);
  username = String(username || '').trim();
  if (!VALID_NAME.test(username)) throw httpErr(400, 'Nazwa użytkownika: 2–32 znaki, tylko litery, cyfry oraz . _ -');
  if (byName(cfg, username)) throw httpErr(409, 'Taki użytkownik już istnieje');
  if (typeof password !== 'string' || password.length < 8) throw httpErr(400, 'Hasło musi mieć co najmniej 8 znaków');
  const u = {
    id: crypto.randomBytes(6).toString('hex'),
    username,
    passwordHash: hashPassword(password),
    role: role === 'admin' ? 'admin' : 'user',
    created: Date.now(),
    games: Array.isArray(games) ? games : []
  };
  cfg.users.push(u);
  persist(cfg);
  return pub(u);
}

function update(cfg, id, patch) {
  const u = byId(cfg, id);
  if (!u) throw httpErr(404, 'Nie ma takiego użytkownika');
  if (patch.password != null) {
    if (String(patch.password).length < 8) throw httpErr(400, 'Hasło musi mieć co najmniej 8 znaków');
    u.passwordHash = hashPassword(patch.password);
  }
  if (patch.role && (patch.role === 'admin' || patch.role === 'user')) {
    if (u.role === 'admin' && patch.role === 'user' && admins(cfg).length <= 1) throw httpErr(400, 'Musi zostać co najmniej jeden administrator');
    u.role = patch.role;
  }
  if (Array.isArray(patch.games)) u.games = patch.games;
  persist(cfg);
  return pub(u);
}

function remove(cfg, id) {
  const u = byId(cfg, id);
  if (!u) return;
  if (u.role === 'admin' && admins(cfg).length <= 1) throw httpErr(400, 'Nie można usunąć jedynego administratora');
  cfg.users = cfg.users.filter((x) => x.id !== id);
  persist(cfg);
}

const admins = (cfg) => ensure(cfg).filter((u) => u.role === 'admin');
const pub = (u) => ({ id: u.id, username: u.username, role: u.role, created: u.created, games: u.games || [] });
const list = (cfg) => ensure(cfg).map(pub);

// Can this user use/see a given game server?
function canUseGame(user, gameId, ownerId) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return (user.games || []).includes(gameId) || ownerId === user.id;
}

module.exports = {
  ensure, verifyLogin, verifyPassword, hashPassword, add, update, remove,
  list, byId, byName, admins, pub, canUseGame
};
