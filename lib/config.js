'use strict';
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.WEBPULPIT_CONFIG || path.join(__dirname, '..', 'config.json');

function load() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Brak pliku konfiguracyjnego: ${CONFIG_PATH}`);
    console.error('Uruchom najpierw: node scripts/setup.js  (albo sudo bash install.sh)');
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return Object.assign({
    host: '0.0.0.0',
    port: 8443,
    https: null,
    rootDir: '/',
    sessionHours: 12
  }, cfg);
}

function save(cfg) {
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
}

module.exports = { load, save, CONFIG_PATH };
